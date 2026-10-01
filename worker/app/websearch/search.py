"""Supplier price lookup on the web: pluggable search provider (Brave Search API or Tavily) plus a
polite page fetch.

* Only allowlisted supplier domains (WEB_SEARCH_DOMAINS, Baltic/EU shops) are searched and fetched.
* robots.txt is honoured for every page fetched (our own User-Agent; unreachable robots → skip host).
  A site that refuses our honest User-Agent (403) is skipped; we never pretend to be a browser.
* Prices must be explicitly in EUR, and every technical attribute of the row (cores, cross-section, IP,
  modules, gangs, poles, amps, diameter, size, mA, volts) must be confirmed by the product title, else the row
  stays NO PRICE.
* Search result pages of other sites are never scraped; only the provider API is queried.
* One request per host every HOST_INTERVAL seconds.
* Prices are extracted from structured data first (JSON-LD Product/Offer, microdata, OpenGraph), then
  a conservative text pattern. Every search call is logged in the usage ledger (kind='web_search').

Web prices are retail and can run ~40% above contract prices: callers mark them WEB and they are never
written into the knowledge base."""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import httpx

from ..config import settings
from ..llm import ledger
from ..matching.attributes import _EQUAL_KEYS, parse_attributes
from ..llm.ledger import Ctx

log = logging.getLogger(__name__)
HOST_INTERVAL = 2.0
TIMEOUT = 12.0
MAX_PAGE_BYTES = 2_000_000


class SearchUnavailable(RuntimeError):
    """The search provider refused or failed (blocked IP, bad key, quota, outage) — not "nothing found"."""


# Last provider failure, for /health and the UI: {"provider", "error", "at"} or None.
last_error: dict | None = None


def _provider_error_text(e: Exception, provider_name: str) -> str:
    status = getattr(getattr(e, "response", None), "status_code", None)
    hint = {401: "the API key was rejected", 403: "the provider refuses requests from this server (blocked IP or key)",
            429: "rate limit or monthly quota reached", 432: "monthly plan limit reached",
            433: "pay-as-you-go limit reached"}.get(status, "network or provider error")
    return f"{provider_name} search failed ({status or type(e).__name__}): {hint}"


@dataclass
class SearchHit:
    title: str
    url: str
    snippet: str = ""


class Provider:
    name = "none"

    def configured(self) -> bool:
        return False

    def search(self, query: str, count: int = 5, domains: list[str] | None = None) -> list[SearchHit]:
        raise NotImplementedError


class BraveProvider(Provider):
    name = "brave"

    def configured(self) -> bool:
        return bool(settings.brave_api_key)

    def search(self, query: str, count: int = 5, domains: list[str] | None = None) -> list[SearchHit]:
        if domains:
            query = f"{query} ({' OR '.join(f'site:{d}' for d in domains)})"
        r = httpx.get("https://api.search.brave.com/res/v1/web/search",
                      params={"q": query, "count": count},
                      headers={"X-Subscription-Token": settings.brave_api_key, "Accept": "application/json"},
                      timeout=TIMEOUT)
        r.raise_for_status()
        return [SearchHit(h.get("title", ""), h["url"], h.get("description", ""))
                for h in (r.json().get("web", {}) or {}).get("results", []) if h.get("url")]


class TavilyProvider(Provider):
    name = "tavily"

    def configured(self) -> bool:
        return bool(settings.tavily_api_key)

    def search(self, query: str, count: int = 5, domains: list[str] | None = None) -> list[SearchHit]:
        body = {"api_key": settings.tavily_api_key, "query": query, "max_results": count}
        if domains:
            body["include_domains"] = domains
        r = httpx.post("https://api.tavily.com/search", json=body,
                       timeout=TIMEOUT)
        r.raise_for_status()
        return [SearchHit(h.get("title", ""), h["url"], h.get("content", "")[:300])
                for h in r.json().get("results", []) if h.get("url")]


_PROVIDERS = {"brave": BraveProvider, "tavily": TavilyProvider}

_TLD_COUNTRY = {"lv": "LV", "lt": "LT", "ee": "EE", "fi": "FI", "de": "DE", "pl": "PL", "se": "SE", "dk": "DK",
                "nl": "NL", "at": "AT", "be": "BE", "fr": "FR", "es": "ES", "it": "IT", "ie": "IE", "eu": "EU"}


def allowed_domains() -> dict[str, str]:
    """WEB_SEARCH_DOMAINS → {domain: country}. "elektrika.lv:LV, prof.lv" → {"elektrika.lv": "LV", "prof.lv": "LV"}."""
    out: dict[str, str] = {}
    for part in (settings.web_search_domains or "").split(","):
        part = part.strip().lower()
        if not part:
            continue
        dom, _, cc = part.partition(":")
        dom = dom.strip().removeprefix("www.")
        out[dom] = (cc.strip().upper() or _TLD_COUNTRY.get(dom.rsplit(".", 1)[-1], "EU"))
    return out


def domain_of(url: str, allow: dict[str, str]) -> tuple[str, str] | None:
    """(domain, country) when the URL's host is an allowlisted domain or one of its subdomains."""
    host = (urlparse(url).hostname or "").lower()
    for dom, cc in allow.items():
        if host == dom or host.endswith("." + dom):
            return dom, cc
    return None


def web_attributes_match(row_text: str, product: str) -> bool:
    """HARD filter for web prices: same category, and every technical attribute of the row is present in the
    product title with the same value. A higher-voltage product never stands in for a row that doesn't ask for it."""
    want, have = parse_attributes(row_text), parse_attributes(product)
    cw, ch = want.get("category"), have.get("category")
    if cw and cw != "other" and cw != ch:
        return False
    for k in (*_EQUAL_KEYS, "volts"):
        if k in want and (k not in have or str(have[k]).lower() != str(want[k]).lower()):
            if not (isinstance(want[k], (int, float)) and isinstance(have.get(k), (int, float))
                    and abs(float(want[k]) - float(have[k])) < 1e-6):
                return False
    if "volts" not in want and have.get("volts", 0) >= 380:
        return False
    return True


def provider() -> Provider:
    return _PROVIDERS.get(settings.web_search_provider, BraveProvider)()


# ------------------------------------------------------------------ politeness

_robots: dict[str, RobotFileParser | None] = {}
_last_hit: dict[str, float] = {}
_polite_lock = threading.Lock()


def _robots_for(origin: str, client: httpx.Client) -> RobotFileParser | None:
    if origin in _robots:
        return _robots[origin]
    rp: RobotFileParser | None = RobotFileParser()
    try:
        r = client.get(origin + "/robots.txt", timeout=TIMEOUT)
        if r.status_code in (401, 403):
            rp.disallow_all = True  # type: ignore[union-attr]
        elif r.status_code >= 400:
            rp.allow_all = True  # type: ignore[union-attr]
        else:
            rp.parse(r.text.splitlines())  # type: ignore[union-attr]
    except httpx.HTTPError:
        rp = None  # can't verify robots → don't fetch from this host
    _robots[origin] = rp
    return rp


def allowed_by_robots(url: str, client: httpx.Client) -> bool:
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.netloc:
        return False
    rp = _robots_for(f"{u.scheme}://{u.netloc}", client)
    return bool(rp and rp.can_fetch(settings.web_user_agent, url))


def _wait_turn(host: str) -> None:
    with _polite_lock:
        now = time.monotonic()
        wait = _last_hit.get(host, 0) + HOST_INTERVAL - now
        _last_hit[host] = max(now, _last_hit.get(host, 0) + HOST_INTERVAL)
    if wait > 0:
        time.sleep(wait)


# ------------------------------------------------------------------ extraction

_LD = re.compile(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', re.S | re.I)
_META = re.compile(r'<meta[^>]+(?:property|itemprop|name)=["\']([^"\']+)["\'][^>]+content=["\']([^"\']+)["\']', re.I)
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)
_TEXT_PRICE = re.compile(r"(?:€|EUR|eur)\s*(\d{1,5}(?:[ .]\d{3})*(?:[.,]\d{2}))|(\d{1,5}(?:[ .]\d{3})*(?:[.,]\d{2}))\s*(?:€|EUR|eur)")


def _num(s) -> float | None:
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    t = str(s).strip().replace("\xa0", "").replace(" ", "")
    if "," in t and "." in t:
        t = t.replace(".", "").replace(",", ".") if t.rfind(",") > t.rfind(".") else t.replace(",", "")
    elif "," in t:
        t = t.replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return None


def _walk_ld(node, out: list[dict]) -> None:
    if isinstance(node, list):
        for n in node:
            _walk_ld(n, out)
    elif isinstance(node, dict):
        types = node.get("@type")
        types = types if isinstance(types, list) else [types]
        if "Product" in types:
            offers = node.get("offers") or {}
            offers = offers if isinstance(offers, list) else [offers]
            for o in offers:
                price = _num(o.get("price") or o.get("lowPrice"))
                if price is not None:
                    out.append({"product": node.get("name"), "unit_price": price,
                                "currency": (o.get("priceCurrency") or "").upper() or None})
        for v in node.values():
            if isinstance(v, (dict, list)):
                _walk_ld(v, out)


def extract_price(html: str) -> dict | None:
    found: list[dict] = []
    for block in _LD.findall(html):
        try:
            _walk_ld(json.loads(block.strip()), found)
        except json.JSONDecodeError:
            continue
    if found:
        return found[0]
    metas = {k.lower(): v for k, v in _META.findall(html)}
    price = _num(metas.get("product:price:amount") or metas.get("og:price:amount") or metas.get("price"))
    title = unescape((_TITLE.search(html) or [None, ""])[1]).strip() if _TITLE.search(html) else ""
    if price is not None:
        return {"product": metas.get("og:title") or title, "unit_price": price,
                "currency": (metas.get("product:price:currency") or metas.get("pricecurrency") or "").upper() or None}
    m = _TEXT_PRICE.search(re.sub(r"<[^>]+>", " ", html))
    if m:
        return {"product": title, "unit_price": _num(m.group(1) or m.group(2)), "currency": "EUR",
                "extracted": "text"}
    return None


# ------------------------------------------------------------------ public

def find_price(query: str, *, ctx: Ctx, must_tokens: set[str] | None = None,
               row_text: str | None = None) -> dict | None:
    """See _find_price. Tells the chat the agent is searching (agent.state) while it runs."""
    from ..llm.client import agent_state
    agent_state(ctx, "searching", query=query[:120], suppliers=sorted(allowed_domains()))
    try:
        return _find_price(query, ctx=ctx, must_tokens=must_tokens, row_text=row_text)
    finally:
        agent_state(ctx, "idle")


def _find_price(query: str, *, ctx: Ctx, must_tokens: set[str] | None = None,
                row_text: str | None = None) -> dict | None:
    """Search the allowlisted suppliers, fetch up to 3 allowed pages, return the first EUR price whose product
    shares the query's key tokens and passes the attribute filter for `row_text`.
    Returns {product, unit_price, currency, url, domain, country, fetched_at} or None."""
    prov = provider()
    allow = allowed_domains()
    if not prov.configured() or not allow:
        return None
    global last_error
    hits: list[SearchHit] = []
    try:
        # One retry for transient failures (DNS, timeouts, 429/5xx). A provider that keeps failing raises
        # SearchUnavailable so callers say so (and stop asking) instead of reporting "nothing found".
        for attempt in (1, 2):
            try:
                hits = prov.search(query, count=6, domains=list(allow))
                last_error = None
                break
            except httpx.HTTPError as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                transient = status is None or status == 429 or status >= 500
                if attempt == 2 or not transient:
                    msg = _provider_error_text(e, prov.name)
                    log.warning("web search failed for %r: %s", query[:80], msg)
                    last_error = {"provider": prov.name, "error": msg, "at": datetime.now(timezone.utc).isoformat()}
                    raise SearchUnavailable(msg) from e
                time.sleep(1.5)
    finally:
        ledger.record(ctx=ctx, kind="web_search", task="web_search", tier=None, model_id=prov.name, units=1,
                      meta={"query": query})
    headers = {"User-Agent": settings.web_user_agent, "Accept": "text/html,application/xhtml+xml"}
    fetched = 0
    with httpx.Client(headers=headers, follow_redirects=True, timeout=TIMEOUT) as client:
        for h in hits:
            if fetched >= 3:
                break
            where = domain_of(h.url, allow)
            if where is None:
                continue
            if not allowed_by_robots(h.url, client):
                log.info("robots.txt disallows %s", h.url)
                continue
            _wait_turn(urlparse(h.url).netloc)
            try:
                with client.stream("GET", h.url) as r:
                    if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
                        continue
                    body = b""
                    for chunk in r.iter_bytes():
                        body += chunk
                        if len(body) > MAX_PAGE_BYTES:
                            break
            except httpx.HTTPError:
                continue
            fetched += 1
            got = extract_price(body.decode("utf-8", errors="replace"))
            if not got or not got.get("unit_price"):
                continue
            name = (got.get("product") or h.title or "").lower()
            if must_tokens and not any(t in name for t in must_tokens):
                continue
            if got.get("currency") != "EUR":
                continue
            product = got.get("product") or h.title
            if row_text and not web_attributes_match(row_text, product):
                log.info("web price rejected by attribute filter: %r for %r", product[:80], row_text[:80])
                continue
            return {**got, "product": product, "url": h.url, "domain": where[0], "country": where[1],
                    "fetched_at": datetime.now(timezone.utc).isoformat()}
    return None
