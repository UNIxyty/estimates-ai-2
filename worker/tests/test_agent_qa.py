import agent_fixtures as fx  # noqa: I001  (sets env first)

import json

import pytest

from app import db
from app.agent import run as agent_run
from app.llm import client as llm


@pytest.fixture(autouse=True)
def _env():
    fx.migrate()
    db.execute("DELETE FROM settings WHERE key IN ('routing','budget')")
    llm.config_store.invalidate()
    yield
    llm.set_bedrock_factory(None)
    db.execute("DELETE FROM jobs")


def _conv_with_doc(send_to=None):
    u = fx.make_user(send_to=send_to)
    conv = fx.make_conversation(u)
    prev = fx.make_run(conv, text="fill this")
    doc = db.fetchone("""INSERT INTO documents(run_id, conversation_id, user_id, name, stored_path, mode, totals)
                         VALUES (%s,%s,%s,'Tame.xlsx','/dev/null','fill','{"total": 1000}') RETURNING *""",
                      (prev["id"], conv["id"], u["id"]))
    db.execute("""INSERT INTO estimate_rows(document_id, sheet_name, row_idx, item_text, unit, qty, norm_h_per_unit,
                     hourly_rate, unit_labour, unit_material, total_labour, total_material, price_source, confidence,
                     confidence_pct, reason, matched, flags)
                  VALUES (%s,'Elektro',58,'Sadales skapis 36 moduļi','gab.',1,5.5,20,110,480,110,480,'norm','high',85,
                          'Parameterised norm 5.5 h/unit from Normas.xlsx × 20/h', '[]', '{}')""", (doc["id"],))
    return u, conv, doc


def test_why_is_row_expensive_uses_stored_provenance_and_emits_chips():
    u, conv, doc = _conv_with_doc()
    seen_tool_results = []

    def second(req):
        seen_tool_results.append(req["messages"][-1]["content"][0]["toolResult"])
        return fx.text_response("[[row:Elektro!58]] costs 590 because the 36-module norm is 5.5 h at 20 EUR/h.")

    fake = fx.FakeBedrock([fx.tool_response("get_row_provenance", {"row": 58}, tool_id="tu1"), second])
    llm.set_bedrock_factory(lambda: fake)
    run = fx.make_run(conv, text="Why is row 58 so expensive?")
    agent_run.run_agent({"run_id": str(run["id"])})
    assert db.fetchone("SELECT status FROM runs WHERE id=%s", (run["id"],))["status"] == "done"
    prov = seen_tool_results[0]["content"][0]["json"]["rows"][0]
    assert prov["price_source"] == "norm" and "Parameterised norm" in prov["reason"]
    msg = db.fetchone("SELECT * FROM messages WHERE run_id=%s AND role='assistant'", (run["id"],))
    chip = next(p for p in msg["parts"] if p["type"] == "chip")
    assert chip == {"type": "chip", "kind": "row", "document_id": str(doc["id"]), "sheet": "Elektro", "row": 58,
                    "label": "Row 58"}
    assert msg["tier"] == "advanced"  # "why" + existing document → complex_reasoning
    assert float(msg["cost_usd"]) > 0 and msg["tokens"]["input"] == 2000
    streamed = db.fetchall("SELECT payload FROM run_events WHERE run_id=%s AND type='text.delta' ORDER BY seq", (run["id"],))
    assert "".join(e["payload"]["delta"] for e in streamed).startswith("[[row:Elektro!58]] costs 590")


def test_send_me_this_estimate_calls_send_email_to_profile_address():
    u, conv, doc = _conv_with_doc(send_to="inbox@example.com")
    fake = fx.FakeBedrock([fx.tool_response("send_email", {"to": "someone@else.example"}, tool_id="e1"),
                           fx.text_response("Sent to your inbox.")])
    llm.set_bedrock_factory(lambda: fake)
    run = fx.make_run(conv, text="Send me this estimate")
    agent_run.run_agent({"run_id": str(run["id"])})
    es = db.fetchone("SELECT * FROM email_sends WHERE run_id=%s", (run["id"],))
    assert es["to_email"] == "inbox@example.com"
    card = db.fetchone("SELECT * FROM cards WHERE run_id=%s AND kind='email'", (run["id"],))
    assert card["status"] == "sending" and card["payload"]["to"] == "inbox@example.com"
    assert fake.requests[0]["modelId"] == llm.config_store.routing()["tiers"]["fast"]["model_id"]  # email → Fast
    job = db.fetchone("SELECT * FROM jobs WHERE kind='send_email'")
    assert job["payload"]["email_send_id"] == str(es["id"])


def test_fast_answer_escalates_when_unsure_and_retry_is_logged():
    u, conv, doc = _conv_with_doc()
    fake = fx.FakeBedrock([fx.tool_response("emit", {"task": "simple_question", "confidence": 0.95}),
                           fx.text_response("<<UNSURE>>"), fx.text_response("The total is 1000 EUR.")])
    llm.set_bedrock_factory(lambda: fake)
    run = fx.make_run(conv, text="total?")
    agent_run.run_agent({"run_id": str(run["id"])})
    rows = db.fetchall("SELECT tier, escalated_from FROM usage WHERE run_id=%s ORDER BY id", (run["id"],))
    assert [(r["tier"], r["escalated_from"]) for r in rows] == [("fast", None), ("fast", None), ("standard", "fast")]
    assert db.fetchone("SELECT task FROM usage WHERE run_id=%s ORDER BY id LIMIT 1", (run["id"],))["task"] == "classify"
    msg = db.fetchone("SELECT content FROM messages WHERE run_id=%s AND role='assistant'", (run["id"],))
    assert msg["content"] == "The total is 1000 EUR."


def test_cost_cap_pauses_run_and_posts_card():
    u, conv, doc = _conv_with_doc()
    llm.set_bedrock_factory(lambda: fx.FakeBedrock([fx.text_response("x")]))
    run = fx.make_run(conv, text="Why is row 58 so expensive?", cap=0.0001)
    agent_run.run_agent({"run_id": str(run["id"])})
    assert db.fetchone("SELECT status FROM runs WHERE id=%s", (run["id"],))["status"] == "paused_cost"
    card = db.fetchone("SELECT * FROM cards WHERE run_id=%s AND kind='cost_cap'", (run["id"],))
    assert card and card["status"] == "pending"
    # "continue" raises the cap and resumes
    # what the web API does on "continue": state-guarded card update + cap raised by RUN_COST_CAP_USD
    db.execute("""UPDATE cards SET status='continued', decision='{"action":"continue","data":{}}' WHERE id=%s""",
               (card["id"],))
    db.execute("UPDATE runs SET cost_cap_usd = cost_cap_usd + 2 WHERE id=%s", (run["id"],))
    llm.set_bedrock_factory(lambda: fx.FakeBedrock([fx.text_response("Because of the norm.")]))
    agent_run.resume_run({"run_id": str(run["id"]), "card_id": str(card["id"])})
    r = db.fetchone("SELECT status, cost_cap_usd FROM runs WHERE id=%s", (run["id"],))
    assert r["status"] == "done" and float(r["cost_cap_usd"]) > 1
