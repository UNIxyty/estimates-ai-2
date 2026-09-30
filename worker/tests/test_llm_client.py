import agent_fixtures as fx  # noqa: I001  (sets env first)

import pytest

from app import db
from app.llm import client as llm, config_store, ledger, router
from app.llm.ledger import Ctx, Usage


@pytest.fixture(autouse=True)
def _setup():
    fx.migrate()
    db.execute("DELETE FROM settings WHERE key IN ('routing','prices','budget')")
    config_store.invalidate()
    yield
    llm.set_bedrock_factory(None)
    db.execute("DELETE FROM settings WHERE key IN ('routing','prices','budget')")
    config_store.invalidate()


def _run(cap=2.0):
    u = fx.make_user()
    conv = fx.make_conversation(u)
    return fx.make_run(conv, cap=cap), conv, u


def test_cost_from_actual_usage_and_price_table():
    cost = ledger.cost_usd("eu.anthropic.claude-sonnet-5-5", Usage(1_000_000, 100_000, 2_000_000, 0))
    # 1M in × $2 + 0.1M out × $10 + 2M cache-read × $0.20
    assert cost == pytest.approx(2.0 + 1.0 + 0.4)


def test_converse_logs_ledger_row_with_tokens_and_cost():
    fake = fx.FakeBedrock([fx.text_response("hello", i=1200, o=300, cr=5000, cw=100)])
    llm.set_bedrock_factory(lambda: fake)
    run, conv, u = _run()
    res = llm.converse(task="simple_question", messages=[{"role": "user", "content": [{"text": "hi"}]}],
                       ctx=Ctx(user_id=str(u["id"]), conversation_id=str(conv["id"]), run_id=str(run["id"])))
    assert res.text == "hello" and res.tier == "fast"
    row = db.fetchone("SELECT * FROM usage WHERE run_id=%s", (run["id"],))
    assert (row["input_tokens"], row["output_tokens"], row["cache_read_tokens"], row["cache_write_tokens"]) == \
        (1200, 300, 5000, 100)
    assert float(row["cost_usd"]) == pytest.approx(ledger.cost_usd(res.model_id, res.usage))
    assert row["tier"] == "fast" and row["task"] == "simple_question"
    assert float(db.fetchone("SELECT cost_usd FROM runs WHERE id=%s", (run["id"],))["cost_usd"]) > 0


def test_prompt_cache_points_on_big_system_and_tools():
    fake = fx.FakeBedrock([fx.text_response("x")])
    llm.set_bedrock_factory(lambda: fake)
    llm.converse(task="file_analysis", messages=[{"role": "user", "content": [{"text": "q"}]}], ctx=Ctx(),
                 system="S" * 6000, tools=[{"name": "t", "description": "d", "input_schema": {"type": "object"}}])
    req = fake.requests[0]
    assert {"cachePoint": {"type": "default"}} in req["system"]
    assert req["toolConfig"]["tools"][-1] == {"cachePoint": {"type": "default"}}
    assert req["toolConfig"]["toolChoice"] == {"auto": {}}  # forced tool choice is rejected by new models


def test_small_system_gets_no_cache_point():
    fake = fx.FakeBedrock([fx.text_response("x")])
    llm.set_bedrock_factory(lambda: fake)
    llm.converse(task="short_reply", messages=[{"role": "user", "content": [{"text": "q"}]}], ctx=Ctx(), system="short")
    assert all("cachePoint" not in b for b in fake.requests[0]["system"])


def test_escalates_unsure_fast_answer_and_logs_it():
    fake = fx.FakeBedrock([fx.text_response("<<UNSURE>>"), fx.text_response("a real answer")])
    llm.set_bedrock_factory(lambda: fake)
    run, conv, u = _run()
    streamed = []
    res = llm.converse(task="simple_question", messages=[{"role": "user", "content": [{"text": "q"}]}],
                       ctx=Ctx(run_id=str(run["id"])), on_text=streamed.append,
                       unsure=lambda r: "<<UNSURE>>" in r.text)
    assert res.text == "a real answer" and res.tier == "standard" and res.escalated_from == "fast"
    rows = db.fetchall("SELECT tier, escalated_from FROM usage WHERE run_id=%s ORDER BY id", (run["id"],))
    assert [(r["tier"], r["escalated_from"]) for r in rows] == [("fast", None), ("standard", "fast")]
    assert "".join(streamed) == "a real answer"
    assert fake.requests[1]["modelId"] == config_store.routing()["tiers"]["standard"]["model_id"]


def test_escalation_toggle_off_keeps_fast():
    db.execute("INSERT INTO settings(key,value) VALUES ('routing', %s)", (db.jsonb({"escalate_when_unsure": False}),))
    config_store.invalidate()
    fake = fx.FakeBedrock([fx.text_response("<<UNSURE>>")])
    llm.set_bedrock_factory(lambda: fake)
    res = llm.converse(task="simple_question", messages=[{"role": "user", "content": [{"text": "q"}]}], ctx=Ctx(),
                       unsure=lambda r: True)
    assert res.tier == "fast" and len(fake.requests) == 1


def test_cost_cap_stops_before_the_call():
    fake = fx.FakeBedrock([fx.text_response("x")])
    llm.set_bedrock_factory(lambda: fake)
    run, _, _ = _run(cap=0.01)
    db.execute("UPDATE runs SET cost_usd=0.0099 WHERE id=%s", (run["id"],))
    with pytest.raises(llm.CostCapReached):
        llm.converse(task="generate", messages=[{"role": "user", "content": [{"text": "x" * 20000}]}],
                     ctx=Ctx(run_id=str(run["id"])), max_tokens=8000)
    assert fake.requests == []  # never called Bedrock


def test_router_disabled_tier_moves_up_and_override_marked():
    cfg = config_store.default_routing()
    cfg["tiers"]["fast"]["enabled"] = False
    r = router.resolve("email", routing=cfg)
    assert r.tier == "standard" and r.moved_from == "fast"
    cfg["overrides"] = {"fill_blank": "advanced"}
    r = router.resolve("fill_blank", routing=cfg)
    assert r.tier == "advanced" and r.overridden
    cfg["tiers"]["advanced"]["enabled"] = False
    assert router.resolve("generate", routing=cfg).tier == "standard"  # nothing above → nearest below
    assert router.resolve("generate", forced_tier="fast", routing=cfg).tier == "fast"  # budget fast-only


def test_default_task_routing_matches_design():
    cfg = config_store.default_routing()
    tiers = {t: router.resolve(t, routing=cfg).tier for t in config_store.DEFAULT_TASKS}
    assert tiers["simple_question"] == tiers["short_reply"] == tiers["email"] == "fast"
    assert tiers["file_analysis"] == tiers["fill_blank"] == tiers["web_search"] == "standard"
    assert tiers["generate"] == tiers["complex_reasoning"] == "advanced"


def test_complete_json_via_emit_tool_and_low_confidence_escalation():
    schema = {"type": "object", "properties": {"task": {"type": "string"}, "confidence": {"type": "number"}},
              "required": ["task", "confidence"]}
    fake = fx.FakeBedrock([fx.tool_response("emit", {"task": "generate", "confidence": 0.3}),
                           fx.tool_response("emit", {"task": "complex_reasoning", "confidence": 0.9})])
    llm.set_bedrock_factory(lambda: fake)
    out = llm.complete_json("classify", "sys", "msg", schema, ctx=Ctx())
    assert out["task"] == "complex_reasoning" and len(fake.requests) == 2


def test_streaming_rebuilds_tool_use_blocks():
    fake = fx.FakeBedrock([fx.tool_response("get_row_provenance", {"row": 58}, tool_id="abc")])
    llm.set_bedrock_factory(lambda: fake)
    got = []
    res = llm.converse(task="complex_reasoning", messages=[{"role": "user", "content": [{"text": "why"}]}],
                       ctx=Ctx(), on_text=got.append,
                       tools=[{"name": "get_row_provenance", "description": "d", "input_schema": {"type": "object"}}])
    assert res.stop_reason == "tool_use"
    assert res.tool_uses == [{"id": "abc", "name": "get_row_provenance", "input": {"row": 58}}]


def test_unavailable_when_disabled(monkeypatch):
    llm.set_bedrock_factory(None)
    monkeypatch.setattr(llm.settings.__class__, "llm_enabled", False, raising=False)
    object.__setattr__(llm.settings, "llm_enabled", False)
    try:
        assert not llm.available()
        with pytest.raises(llm.LLMUnavailable):
            llm.converse(task="short_reply", messages=[], ctx=Ctx())
    finally:
        object.__setattr__(llm.settings, "llm_enabled", True)
