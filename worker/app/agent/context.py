"""Per-run context shared by the flows and tools."""
from __future__ import annotations

import time
from datetime import datetime
from decimal import Decimal
from functools import cached_property

from .. import db
from ..llm.ledger import Ctx
from .events import Emitter
from .knowledge import Knowledge


class RunCancelled(Exception):
    pass


class RunWaiting(Exception):
    """Raised to end the current job while the run waits on a card (structure/clarify/permission)."""


def _jsonable(v):
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return str(v) if v is not None and not isinstance(v, (str, int, float, bool, list, dict)) else v


def message_json(m: dict) -> dict:
    return {k: _jsonable(v) if not isinstance(v, list) else [_jsonable(x) for x in v] for k, v in m.items()}


class RunContext:
    def __init__(self, run_id: str):
        self.run_id = run_id
        self.run = self._load()
        self.conversation_id = str(self.run["conversation_id"])
        self.user = db.fetchone("SELECT id, email, name, role, send_estimates_to FROM users WHERE id=%s",
                                (self.run["user_id"],))
        self.emitter = Emitter(run_id)
        self.state: dict = dict(self.run["state"] or {})
        self._last_cancel_check = 0.0
        self._cancelled = False

    def _load(self) -> dict:
        run = db.fetchone("SELECT * FROM runs WHERE id=%s", (self.run_id,))
        if not run:
            raise LookupError(f"run {self.run_id} not found")
        return run

    def refresh(self) -> None:
        self.run = self._load()

    @property
    def ctx(self) -> Ctx:
        return Ctx(user_id=str(self.run["user_id"]), conversation_id=self.conversation_id, run_id=self.run_id)

    def ctx_for(self, message_id: str | None) -> Ctx:
        c = self.ctx
        c.message_id = message_id
        return c

    @property
    def allowed(self) -> set[str]:
        return {str(x) for x in self.run["allowed_file_ids"] or []}

    @property
    def denied(self) -> set[str]:
        return {str(x) for x in self.run["denied_file_ids"] or []}

    @property
    def forced_tier(self) -> str | None:
        return self.run.get("tier_override")

    @cached_property
    def kb(self) -> Knowledge:
        return Knowledge.load()

    def reload_kb(self) -> Knowledge:
        self.__dict__.pop("kb", None)
        return self.kb

    # ------------------------------------------------------------ control
    def should_stop(self) -> bool:
        if self._cancelled:
            return True
        now = time.monotonic()
        if now - self._last_cancel_check >= 1.0:
            self._last_cancel_check = now
            row = db.fetchone("SELECT cancel_requested FROM runs WHERE id=%s", (self.run_id,))
            self._cancelled = bool(row and row["cancel_requested"])
        return self._cancelled

    def check(self) -> None:
        if self.should_stop():
            raise RunCancelled()

    def save_state(self, **updates) -> None:
        self.state.update(updates)
        db.execute("UPDATE runs SET state=%s WHERE id=%s", (db.jsonb(self.state), self.run_id))

    def set_status(self, status: str, error: str | None = None) -> None:
        terminal = status in ("done", "failed", "cancelled")
        db.execute(f"""UPDATE runs SET status=%s, error=%s
                       {', finished_at=now()' if terminal else ''}
                       {", started_at=COALESCE(started_at, now())" if status == 'running' else ''}
                       WHERE id=%s""", (status, error, self.run_id))
        self.run["status"] = status
        self.emitter.status(status, error)

    # ------------------------------------------------------------ messages
    def user_message(self) -> dict | None:
        return db.fetchone("""SELECT * FROM messages WHERE run_id=%s AND role='user' ORDER BY created_at LIMIT 1""",
                           (self.run_id,))

    def new_assistant_message(self, content: str = "", parts: list | None = None) -> dict:
        m = db.fetchone("""INSERT INTO messages(conversation_id, run_id, role, content, parts)
                           VALUES (%s,%s,'assistant',%s,%s) RETURNING *""",
                        (self.conversation_id, self.run_id, content, db.jsonb(parts or [])))
        db.execute("UPDATE conversations SET updated_at=now() WHERE id=%s", (self.conversation_id,))
        self.emitter.emit("message.created", {"message": message_json(m)})
        return m

    def complete_message(self, message_id: str, *, content: str, parts: list | None = None) -> None:
        """Finalise an assistant message; footer tier/cost/tokens come from the ledger rows for it."""
        agg = db.fetchone("""SELECT COALESCE(SUM(cost_usd),0) AS cost,
                                    COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
                                    COALESCE(SUM(cache_read_tokens),0) AS cache_read,
                                    COALESCE(SUM(cache_write_tokens),0) AS cache_write,
                                    (ARRAY_AGG(tier ORDER BY id DESC) FILTER (WHERE tier IS NOT NULL))[1] AS tier,
                                    (ARRAY_AGG(model_id ORDER BY id DESC) FILTER (WHERE kind='llm'))[1] AS model_id
                             FROM usage WHERE message_id=%s""", (message_id,))
        tokens = {k: int(agg[k]) for k in ("input", "output", "cache_read", "cache_write")}
        existing = db.fetchone("SELECT parts FROM messages WHERE id=%s", (message_id,))
        card_parts = [p for p in (existing["parts"] if existing else []) if p.get("type") == "card"]
        all_parts = (parts if parts is not None else [{"type": "text", "text": content}]) + card_parts
        db.execute("""UPDATE messages SET content=%s, parts=%s, tier=%s, model_id=%s, cost_usd=%s, tokens=%s
                      WHERE id=%s""",
                   (content, db.jsonb(all_parts), agg["tier"], agg["model_id"], agg["cost"], db.jsonb(tokens),
                    message_id))
        self.emitter.emit("message.completed", {"message_id": message_id, "content": content, "parts": all_parts,
                                                "tier": agg["tier"], "model_id": agg["model_id"],
                                                "cost_usd": float(agg["cost"]), "tokens": tokens})
        self.emitter.cost(self.conversation_id)

    def latest_document(self) -> dict | None:
        return db.fetchone("""SELECT * FROM documents WHERE conversation_id=%s ORDER BY created_at DESC LIMIT 1""",
                           (self.conversation_id,))
