"""Run events: persisted in run_events (so a reload replays them) and announced with
NOTIFY run_events '<run_id>' (so live SSE streams tail them). Seq is allocated under a row lock on
the run, the same way web appends card.updated events, so both writers interleave safely."""
from __future__ import annotations

import threading
import time
from typing import Any

from .. import db


def append_event(run_id: str, type_: str, payload: dict, connection=None) -> int:
    def _do(c) -> int:
        c.execute("SELECT id FROM runs WHERE id=%s FOR UPDATE", (run_id,))
        row = c.execute(
            """INSERT INTO run_events(run_id, seq, type, payload)
               VALUES (%s, (SELECT COALESCE(MAX(seq),0)+1 FROM run_events WHERE run_id=%s), %s, %s)
               RETURNING seq""", (run_id, run_id, type_, db.jsonb(payload))).fetchone()
        c.execute("SELECT pg_notify('run_events', %s)", (run_id,))
        return row["seq"]
    if connection is not None:
        return _do(connection)
    with db.conn() as c:
        seq = _do(c)
        c.commit()
        return seq


class Emitter:
    """Convenience wrapper used by the agent flows. Text deltas are coalesced (≥48 chars or 120 ms)
    so a streamed answer is tens of rows, not thousands."""

    FLUSH_CHARS = 48
    FLUSH_SECONDS = 0.12

    def __init__(self, run_id: str):
        self.run_id = run_id
        self._buf: dict[str, str] = {}
        self._last_flush = time.monotonic()
        self._lock = threading.Lock()
        self._step_totals: dict[str, int] = {}

    def emit(self, type_: str, payload: dict[str, Any]) -> int:
        self.flush()
        return append_event(self.run_id, type_, payload)

    # steps -----------------------------------------------------------------
    def step_started(self, step_id: str, label: str, total: int | None = None) -> None:
        if total is not None:
            self._step_totals[step_id] = total
        self.emit("step.started", {"step_id": step_id, "label": label, "total": total})

    def step_progress(self, step_id: str, done: int, total: int | None = None, label: str | None = None) -> None:
        total = total if total is not None else self._step_totals.get(step_id)
        self.emit("step.progress", {"step_id": step_id, "done": done, "total": total, "label": label})

    def step_done(self, step_id: str, summary: str | None = None) -> None:
        self.emit("step.done", {"step_id": step_id, "summary": summary})

    def step_warn(self, step_id: str, message: str, rows: list[dict] | None = None) -> None:
        self.emit("step.warn", {"step_id": step_id, "message": message, "rows": rows or []})

    # text ------------------------------------------------------------------
    def text_delta(self, message_id: str, delta: str) -> None:
        with self._lock:
            self._buf[message_id] = self._buf.get(message_id, "") + delta
            due = (len(self._buf[message_id]) >= self.FLUSH_CHARS
                   or time.monotonic() - self._last_flush >= self.FLUSH_SECONDS)
        if due:
            self.flush()

    def flush(self) -> None:
        with self._lock:
            pending, self._buf = self._buf, {}
            self._last_flush = time.monotonic()
        for mid, text in pending.items():
            if text:
                append_event(self.run_id, "text.delta", {"message_id": mid, "delta": text})

    # misc ------------------------------------------------------------------
    def status(self, status: str, error: str | None = None) -> None:
        self.emit("run.status", {"status": status, **({"error": error} if error else {})})

    def cost(self, conversation_id: str) -> None:
        from ..llm import ledger
        spent, _ = ledger.run_cost(self.run_id)
        self.emit("cost.update", {"run_cost_usd": round(spent, 6),
                                  "conversation_cost_usd": round(ledger.conversation_cost(conversation_id), 6)})
