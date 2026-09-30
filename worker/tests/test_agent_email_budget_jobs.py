import agent_fixtures as fx  # noqa: I001  (sets env first)

import os
import tempfile
import threading

import httpx
import pytest

from app import db, jobs
from app.agent import run as agent_run
from app.agent import tools
from app.agent.context import RunContext
from app.llm import client as llm
from app.mail import resend


@pytest.fixture(autouse=True)
def _env():
    fx.migrate()
    db.execute("DELETE FROM jobs")
    db.execute("DELETE FROM settings WHERE key='budget'")
    yield
    db.execute("DELETE FROM jobs")
    db.execute("DELETE FROM settings WHERE key='budget'")
    llm.set_bedrock_factory(None)


def _doc_run():
    u = fx.make_user(send_to="me@example.com")
    conv = fx.make_conversation(u)
    run = fx.make_run(conv)
    path = os.path.join(tempfile.mkdtemp(), "est.xlsx")
    open(path, "wb").write(b"PK fake xlsx")
    doc = db.fetchone("""INSERT INTO documents(run_id, conversation_id, user_id, name, stored_path, mode, totals)
                         VALUES (%s,%s,%s,'Tame.xlsx',%s,'fill','{"total": 10}') RETURNING *""",
                      (run["id"], conv["id"], u["id"], path))
    return RunContext(str(run["id"])), doc


# ------------------------------------------------------------------ email idempotency

def test_send_email_twice_creates_one_send_and_one_job():
    rc, doc = _doc_run()
    a = tools.send_email(rc)
    b = tools.send_email(rc)
    assert a["card_id"] == b["card_id"]
    assert db.fetchone("SELECT COUNT(*) AS n FROM email_sends WHERE run_id=%s", (rc.run_id,))["n"] == 1
    assert db.fetchone("SELECT COUNT(*) AS n FROM jobs WHERE kind='send_email'")["n"] == 1


def test_email_failure_then_retry_uses_same_idempotency_key(monkeypatch):
    rc, doc = _doc_run()
    object.__setattr__(resend.settings, "resend_api_key", "re_test")
    sent: list[dict] = []
    fail = {"on": True}

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.append({"to": json["to"], "key": headers.get("Idempotency-Key")})
        if fail["on"]:
            return httpx.Response(500, text="boom", request=httpx.Request("POST", url))
        return httpx.Response(200, json={"id": "re_123"}, request=httpx.Request("POST", url))

    monkeypatch.setattr(resend.httpx, "post", fake_post)
    try:
        out = tools.send_email(rc)
        es = db.fetchone("SELECT * FROM email_sends WHERE run_id=%s", (rc.run_id,))
        resend.send_estimate_email({"email_send_id": str(es["id"])})
        card = db.fetchone("SELECT status FROM cards WHERE id=%s", (out["card_id"],))
        assert card["status"] == "failed"
        # web "Retry" flips the row to queued and enqueues again; worker sends with the SAME key
        db.execute("UPDATE email_sends SET status='queued' WHERE id=%s", (es["id"],))
        fail["on"] = False
        resend.send_estimate_email({"email_send_id": str(es["id"])})
        resend.send_estimate_email({"email_send_id": str(es["id"])})  # duplicate delivery → no-op
        assert db.fetchone("SELECT status FROM cards WHERE id=%s", (out["card_id"],))["status"] == "done"
        assert len(sent) == 2 and sent[0]["key"] == sent[1]["key"] == es["idempotency_key"]
        assert all(s["to"] == ["me@example.com"] for s in sent)
    finally:
        object.__setattr__(resend.settings, "resend_api_key", "")


# ------------------------------------------------------------------ budget block (worker defence in depth)

def _set_budget(amount, action):
    db.execute("""INSERT INTO settings(key, value) VALUES ('budget', %s)
                  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value""",
               (db.jsonb({"monthly_usd": amount, "alert_pct": 80, "over_action": action}),))


def test_budget_pause_blocks_run_before_any_model_call():
    u = fx.make_user()
    conv = fx.make_conversation(u)
    db.execute("INSERT INTO usage(kind, task, cost_usd) VALUES ('llm','generate', 5.0)")
    _set_budget(1.0, "pause")
    fake = fx.FakeBedrock()
    llm.set_bedrock_factory(lambda: fake)
    try:
        run = fx.make_run(conv, text="why is row 5 expensive?")
        agent_run.run_agent({"run_id": str(run["id"])})
        r = db.fetchone("SELECT status, error FROM runs WHERE id=%s", (run["id"],))
        assert (r["status"], r["error"]) == ("failed", "budget_paused")
        assert fake.requests == []
    finally:
        db.execute("DELETE FROM usage WHERE task='generate' AND user_id IS NULL AND cost_usd=5.0")


def test_budget_fast_only_forces_fast_tier():
    u = fx.make_user()
    conv = fx.make_conversation(u)
    db.execute("INSERT INTO usage(kind, task, cost_usd) VALUES ('llm','generate', 5.0)")
    _set_budget(1.0, "fast_only")
    fake = fx.FakeBedrock([fx.text_response("Hello!")])
    llm.set_bedrock_factory(lambda: fake)
    try:
        run = fx.make_run(conv, text="thanks")
        agent_run.run_agent({"run_id": str(run["id"])})
        r = db.fetchone("SELECT status, tier_override FROM runs WHERE id=%s", (run["id"],))
        assert r["tier_override"] == "fast" and r["status"] == "done"
        assert all(req["modelId"] == llm.config_store.routing()["tiers"]["fast"]["model_id"] for req in fake.requests)
    finally:
        db.execute("DELETE FROM usage WHERE task='generate' AND user_id IS NULL AND cost_usd=5.0")


# ------------------------------------------------------------------ job queue

def test_dedupe_key_and_skip_locked_claims():
    a = jobs.enqueue("noop_test", {"i": 1}, dedupe_key="k1")
    assert jobs.enqueue("noop_test", {"i": 2}, dedupe_key="k1") is None
    for i in range(20):
        jobs.enqueue("noop_test", {"i": i})
    claimed: list[int] = []
    lock = threading.Lock()

    def worker():
        while True:
            j = jobs.claim(["noop_test"])
            if not j:
                return
            with lock:
                claimed.append(j["id"])

    ts = [threading.Thread(target=worker) for _ in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(claimed) == 21 == len(set(claimed)) and a in claimed


def test_failing_job_retries_with_backoff_then_fails():
    calls = []

    @jobs.handler("boom_test")
    def boom(p):
        calls.append(p)
        raise RuntimeError("nope")

    jid = jobs.enqueue("boom_test", {}, max_attempts=2)
    jobs.run_one(["boom_test"])
    j = db.fetchone("SELECT status, attempts, run_after > now() AS later FROM jobs WHERE id=%s", (jid,))
    assert j["status"] == "queued" and j["attempts"] == 1 and j["later"]
    db.execute("UPDATE jobs SET run_after=now() WHERE id=%s", (jid,))
    jobs.run_one(["boom_test"])
    assert db.fetchone("SELECT status FROM jobs WHERE id=%s", (jid,))["status"] == "failed"
