import agent_fixtures as fx  # noqa: I001  (sets env first)

import os
import threading
import time

import pytest
from fastapi.testclient import TestClient

os.environ["SKIP_MIGRATIONS"] = "1"
os.environ["DISABLE_JOB_LOOP"] = "1"

from app import db  # noqa: E402
from app.agent.events import Emitter, append_event  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    fx.migrate()
    with TestClient(app) as c:
        yield c


def _events(text: str) -> list[tuple[str, str]]:
    out, cur = [], {}
    for line in text.splitlines():
        if line.startswith("id: "):
            cur["id"] = line[4:]
        elif line.startswith("event: "):
            cur["event"] = line[7:]
        elif line == "" and cur:
            out.append((cur.get("id"), cur.get("event")))
            cur = {}
    return out


def test_replay_after_last_event_id_then_close_on_terminal(client):
    u = fx.make_user()
    run = fx.make_run(fx.make_conversation(u))
    rid = str(run["id"])
    em = Emitter(rid)
    em.step_started("price", "Pricing", 3)
    em.step_progress("price", 2, 3)
    em.step_done("price")
    em.status("done")
    db.execute("UPDATE runs SET status='done' WHERE id=%s", (rid,))
    r = client.get(f"/internal/runs/{rid}/events", headers={"Last-Event-ID": "2"})
    evs = _events(r.text)
    assert [e for _, e in evs] == ["step.done", "run.status", "end"]
    assert evs[0][0] == "3"


def test_live_tail_receives_new_events(client):
    u = fx.make_user()
    run = fx.make_run(fx.make_conversation(u))
    rid = str(run["id"])
    db.execute("UPDATE runs SET status='running' WHERE id=%s", (rid,))

    def later():
        time.sleep(0.5)
        append_event(rid, "text.delta", {"message_id": "m", "delta": "hel"})
        time.sleep(0.2)
        db.execute("UPDATE runs SET status='done' WHERE id=%s", (rid,))
        append_event(rid, "run.status", {"status": "done"})

    threading.Thread(target=later).start()
    t0 = time.time()
    r = client.get(f"/internal/runs/{rid}/events?after=0")
    assert [e for _, e in _events(r.text)] == ["text.delta", "run.status", "end"]
    assert time.time() - t0 < 10


def test_text_deltas_are_coalesced():
    u = fx.make_user()
    run = fx.make_run(fx.make_conversation(u))
    em = Emitter(str(run["id"]))
    for ch in "coalesce me please " * 20:
        em.text_delta("m1", ch)
    em.flush()
    rows = db.fetchall("SELECT payload FROM run_events WHERE run_id=%s AND type='text.delta'", (run["id"],))
    assert "".join(r["payload"]["delta"] for r in rows) == "coalesce me please " * 20
    assert len(rows) < 20


def test_internal_endpoints_require_token(client, monkeypatch):
    monkeypatch.delenv("ALLOW_NO_INTERNAL_TOKEN", raising=False)
    r = client.get("/internal/runs/00000000-0000-0000-0000-000000000000/events")
    assert r.status_code in (401, 503)
    assert client.get("/health").status_code == 200
