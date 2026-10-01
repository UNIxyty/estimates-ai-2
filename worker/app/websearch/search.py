"""Supplier price lookup on the web: pluggable search provider (Brave Search API or Tavily) plus a
polite page fetch.

* robots.txt is honoured for every page fetched (our own User-Agent; unreachable robots → skip host).
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
from ..llm.ledger import Ctx

log = logging.getLogger(__name__)
HOST_INTERVAL = 2.0
TIMEOUT = 12.0
MAX_PAGE_BYTES = 2_000_000


@dataclass
class SearchHit:
    title: str
    url: str
    snippet: str = ""


class Provider:
    name = "none"

    def configured(self) -> bool:
        return False

    def search(self, query: str, count: int = 5) -> list[SearchHit]:
        raise NotImplementedError


class BraveProvider(Provider):
    name = "brave"

    def configured(self) -> bool:
        return bool(settings.brave_api_key)

    def search(self, query: str, count: int = 5) -> list[SearchHit]:
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

    def search(self, query: str, count: int = 5) -> list[SearchHit]:
        r = httpx.post("https://api.tavily.com/search",
                       json={"api_key": settings.tavily_api_key, "query": query, "max_results": count},
                       timeout=TIMEOUT)
        r.raise_for_status()
        return [SearchHit(h.get("title", ""), h["url"], h.get("content", "")[:300])
                for h in r.json().get("results", []) if h.get("url")]


_PROVIDERS = {"brave": BraveProvider, "tavily": TavilyProvider}


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
                                "currency": o.get("priceCurrency") or "EUR"})
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
                "currency": metas.get("product:price:currency") or metas.get("pricecurrency") or "EUR"}
    m = _TEXT_PRICE.search(re.sub(r"<[^>]+>", " ", html))
    if m:
        return {"product": title, "unit_price": _num(m.group(1) or m.group(2)), "currency": "EUR",
                "extracted": "text"}
    return None


# ------------------------------------------------------------------ public

def find_price(query: str, *, ctx: Ctx, must_tokens: set[str] | None = None) -> dict | None:
    """Search, fetch up to 3 allowed pages, return the first structured price whose product name shares
    the query's key tokens. Returns {product, unit_price, currency, url, fetched_at} or None."""
    prov = provider()
    if not prov.configured():
        return None
    hits: list[SearchHit] = []
    try:
        # One retry for transient failures (DNS, timeouts, 429/5xx). If the search API stays down, this row
        # simply has no web price; it must never fail the whole run.
        for attempt in (1, 2):
            try:
                hits = prov.search(query, count=6)
                break
            except httpx.HTTPError as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                transient = status is None or status == 429 or status >= 500
                if attempt == 2 or not transient:
                    log.warning("web search failed for %r: %s", query[:80], e)
                    return None
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
            return {**got, "product": got.get("product") or h.title, "url": h.url,
                    "fetched_at": datetime.now(timezone.utc).isoformat()}
    return None
