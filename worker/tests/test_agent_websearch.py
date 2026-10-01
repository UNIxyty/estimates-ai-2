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

        def search(self, q, count=5):
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
    row = db.fetchone("SELECT kind, units FROM usage WHERE run_id=%s", (run["id"],))
    assert row["kind"] == "web_search" and row["units"] == 1


def test_search_api_outage_returns_none_instead_of_failing_the_run(monkeypatch):
    fx.migrate()
    calls = []

    class Down(search.Provider):
        name = "fake"

        def configured(self):
            return True

        def search(self, q, count=5):
            calls.append(q)
            raise httpx.ConnectError("[Errno -2] Name or service not known")

    monkeypatch.setattr(search, "provider", lambda: Down())
    monkeypatch.setattr(search.time, "sleep", lambda s: None)
    from app.llm.ledger import Ctx
    assert search.find_price("Kabelis NYM 3x1,5 cena", ctx=Ctx()) is None
    assert len(calls) == 2  # one retry for a transient error, then give up quietly
