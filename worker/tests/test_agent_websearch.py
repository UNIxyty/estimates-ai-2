import agent_fixtures as fx  # noqa: I001  (sets env first)

import httpx

from app.websearch import search


def test_extracts_json_ld_product_offer():
    html = """<html><head><title>Shop</title><script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Kabelis NYM-J 3x1,5 100m",
       "offers":{"@type":"Offer","price":"119.90","priceCurrency":"EUR"}}</script></head></html>"""
    assert search.extract_price(html) == {"product": "Kabelis NYM-J 3x1,5 100m", "unit_price": 119.9, "currency": "EUR"}


def test_extracts_meta_then_text_price_with_comma_decimal():
    assert search.extract_price('<meta property="product:price:amount" content="1 234,50">')["unit_price"] == 1234.5
    assert search.extract_price("<title>X</title><p>Cena: 12,34 €</p>")["unit_price"] == 12.34
    assert search.extract_price("<p>no price here</p>") is None


def test_robots_disallow_is_respected():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nDisallow: /products/\n")
        return httpx.Response(200, text="<p>12,00 €</p>", headers={"content-type": "text/html"})

    search._robots.clear()
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        assert not search.allowed_by_robots("https://shop.example/products/nym", c)
        assert search.allowed_by_robots("https://shop.example/about", c)


def test_unreachable_robots_means_do_not_fetch():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    search._robots.clear()
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        assert not search.allowed_by_robots("https://down.example/p", c)


def test_find_price_skips_disallowed_pages_and_logs_search(monkeypatch):
    fx.migrate()

    class P(search.Provider):
        name = "fake"

        def configured(self):
            return True

        def search(self, q, count=5, domains=None):
            return [search.SearchHit("blocked", "https://a.example/products/1"),
                    search.SearchHit("ok", "https://b.example/nym-3x15")]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nDisallow: /products/\n")
        return httpx.Response(200, headers={"content-type": "text/html"}, text=(
            '<script type="application/ld+json">{"@type":"Product","name":"NYM-J 3x1,5",'
            '"offers":{"price":"0.95","priceCurrency":"EUR"}}</script>'))

    real_client = httpx.Client
    monkeypatch.setattr(search, "provider", lambda: P())
    monkeypatch.setattr(search, "allowed_domains", lambda: {"a.example": "LV", "b.example": "LV"})
    monkeypatch.setattr(search.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(search, "HOST_INTERVAL", 0)
    search._robots.clear()
    from app import db
    from app.llm.ledger import Ctx
    u = fx.make_user()
    conv = fx.make_conversation(u)
    run = fx.make_run(conv)
    got = search.find_price("NYM-J 3x1,5 cena", ctx=Ctx(run_id=str(run["id"])), must_tokens={"nym"})
    assert got["url"] == "https://b.example/nym-3x15" and got["unit_price"] == 0.95
    assert got["domain"] == "b.example" and got["country"] == "LV"
    row = db.fetchone("SELECT kind, units FROM usage WHERE run_id=%s", (run["id"],))
    assert row["kind"] == "web_search" and row["units"] == 1


def test_search_api_outage_returns_none_instead_of_failing_the_run(monkeypatch):
    fx.migrate()
    calls = []

    class Down(search.Provider):
        name = "fake"

        def configured(self):
            return True

        def search(self, q, count=5, domains=None):
            calls.append(q)
            raise httpx.ConnectError("[Errno -2] Name or service not known")

    monkeypatch.setattr(search, "provider", lambda: Down())
    monkeypatch.setattr(search, "allowed_domains", lambda: {"shop.example": "LV"})
    monkeypatch.setattr(search.time, "sleep", lambda s: None)
    from app.llm.ledger import Ctx
    assert search.find_price("Kabelis NYM 3x1,5 cena", ctx=Ctx()) is None
    assert len(calls) == 2  # one retry for a transient error, then give up quietly


_REAL_CLIENT = httpx.Client


def _page(name: str, price: str, currency: str | None = "EUR") -> str:
    cur = f',"priceCurrency":"{currency}"' if currency else ""
    return (f'<script type="application/ld+json">{{"@type":"Product","name":"{name}",'
            f'"offers":{{"price":"{price}"{cur}}}}}</script>')


def _shop(monkeypatch, hits, pages, allow=None, robots="User-agent: *\nDisallow: /lv/search\n"):
    """hits: [(title, url)], pages: {url_path: html | status}; returns the domains the provider was asked for."""
    asked = {}

    class P(search.Provider):
        name = "fake"

        def configured(self):
            return True

        def search(self, q, count=5, domains=None):
            asked["domains"] = domains
            return [search.SearchHit(t, u) for t, u in hits]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=robots)
        page = pages.get(request.url.path)
        if isinstance(page, int):
            return httpx.Response(page, headers={"content-type": "text/html"}, text="<title>blocked</title>")
        if page is None:
            return httpx.Response(404)
        return httpx.Response(200, headers={"content-type": "text/html"}, text=page)

    monkeypatch.setattr(search, "provider", lambda: P())
    monkeypatch.setattr(search, "allowed_domains", lambda: allow or {"shop.lv": "LV"})
    monkeypatch.setattr(search.httpx, "Client", lambda **kw: _REAL_CLIENT(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(search, "HOST_INTERVAL", 0)
    search._robots.clear()
    return asked


def test_only_allowlisted_domains_are_searched_and_fetched(monkeypatch):
    fx.migrate()
    from app.llm.ledger import Ctx
    asked = _shop(monkeypatch, [("NYM", "https://other.com/p/1"), ("NYM", "https://www.shop.lv/p/2")],
                  {"/p/1": _page("Kabelis NYM 3x2,5", "0.50"), "/p/2": _page("Kabelis NYM-J 3x2,5", "1.10")})
    got = search.find_price("Kabelis NYM 3x2,5 cena", ctx=Ctx(), row_text="Kabelis NYM-J 3x2,5 mm2")
    assert asked["domains"] == ["shop.lv"]
    assert got["url"] == "https://www.shop.lv/p/2" and got["domain"] == "shop.lv" and got["country"] == "LV"


def test_robots_disallowed_search_pages_and_403_sites_are_skipped(monkeypatch):
    fx.migrate()
    from app.llm.ledger import Ctx
    _shop(monkeypatch, [("search", "https://shop.lv/lv/search?q=nym"), ("blocked", "https://shop.lv/p/9")],
          {"/lv/search": _page("Kabelis NYM 3x2,5", "1.00"), "/p/9": 403})
    assert search.find_price("Kabelis NYM 3x2,5 cena", ctx=Ctx(), row_text="Kabelis NYM 3x2,5") is None


def test_non_eur_or_unknown_currency_is_rejected(monkeypatch):
    fx.migrate()
    from app.llm.ledger import Ctx
    _shop(monkeypatch, [("a", "https://shop.lv/p/1"), ("b", "https://shop.lv/p/2")],
          {"/p/1": _page("Kabelis NYM 3x2,5", "9.90", "SEK"), "/p/2": _page("Kabelis NYM 3x2,5", "1.00", None)})
    assert search.find_price("Kabelis NYM 3x2,5 cena", ctx=Ctx(), row_text="Kabelis NYM 3x2,5") is None


def test_attribute_filter_rejects_wrong_products_so_the_row_stays_unpriced(monkeypatch):
    fx.migrate()
    from app.llm.ledger import Ctx
    # A 400 V single socket must not price a double 230 V socket; a matching double socket may.
    _shop(monkeypatch, [("ide", "https://shop.lv/p/1")], {"/p/1": _page("Kontaktligzda Ide 2P+E 400V 16A IP44", "6.59")})
    assert search.find_price("Kontaktligzda 2P+E 16A dubultā cena", ctx=Ctx(),
                             row_text="Kontaktligzda 2P+E, 16A, dubultā, z/a") is None
    _shop(monkeypatch, [("renova", "https://shop.lv/p/2")],
          {"/p/2": _page("Renova dubultā kontaktligzda, 2P + E, 16 A, 250 V AC", "5.49")})
    got = search.find_price("Kontaktligzda 2P+E 16A dubultā cena", ctx=Ctx(), row_text="Kontaktligzda 2P+E, 16A, dubultā, z/a")
    assert got and got["unit_price"] == 5.49


def test_allowed_domains_parse_country_from_entry_or_tld(monkeypatch):
    object.__setattr__(search.settings, "web_search_domains", " elektrika.lv:LV, www.prof.lv ,shop.ee, x.com:de ")
    try:
        assert search.allowed_domains() == {"elektrika.lv": "LV", "prof.lv": "LV", "shop.ee": "EE", "x.com": "DE"}
    finally:
        object.__setattr__(search.settings, "web_search_domains", "elektrika.lv:LV")
