"""The usage ledger: one row per model call, embedding call and web search call.
Cost is computed from the token usage Bedrock actually returned × the editable price table."""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from .. import db
from . import config_store


@dataclass
class Ctx:
    """Who/what a call is for. Every ledger row carries these."""
    user_id: str | None = None
    conversation_id: str | None = None
    run_id: str | None = None
    message_id: str | None = None
    file_id: str | None = None


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def add(self, other: "Usage") -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_write_tokens += other.cache_write_tokens

    def as_dict(self) -> dict:
        return {"input": self.input_tokens, "output": self.output_tokens,
                "cache_read": self.cache_read_tokens, "cache_write": self.cache_write_tokens}


def cost_usd(model_id: str, u: Usage) -> float:
    p = config_store.model_price(model_id)
    return round((u.input_tokens * p.get("input", 0) + u.output_tokens * p.get("output", 0)
                  + u.cache_read_tokens * p.get("cache_read", 0)
                  + u.cache_write_tokens * p.get("cache_write", 0)) / 1_000_000, 6)


def record(*, ctx: Ctx, kind: str, task: str, tier: str | None, model_id: str | None,
           usage: Usage | None = None, units: int = 0, cost: float | None = None,
           escalated_from: str | None = None, meta: dict | None = None) -> float:
    usage = usage or Usage()
    if cost is None:
        if kind == "web_search":
            cost = round(units * config_store.prices()["web_search_unit_usd"], 6)
        else:
            cost = cost_usd(model_id or "", usage)
    with db.conn() as c:
        c.execute(
            """INSERT INTO usage(user_id, conversation_id, run_id, message_id, file_id, kind, task, tier, model_id,
                                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, units,
                                 cost_usd, escalated_from, meta)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (ctx.user_id, ctx.conversation_id, ctx.run_id, ctx.message_id, ctx.file_id, kind, task, tier,
             model_id, usage.input_tokens, usage.output_tokens, usage.cache_read_tokens,
             usage.cache_write_tokens, units, Decimal(str(cost)), escalated_from, db.jsonb(meta or {})))
        if ctx.run_id:
            c.execute("UPDATE runs SET cost_usd = cost_usd + %s WHERE id=%s", (Decimal(str(cost)), ctx.run_id))
        c.commit()
    return cost


def run_cost(run_id: str) -> tuple[float, float]:
    """(spent so far, cap) for a run."""
    row = db.fetchone("SELECT cost_usd, cost_cap_usd FROM runs WHERE id=%s", (run_id,))
    if not row:
        return 0.0, float("inf")
    return float(row["cost_usd"]), float(row["cost_cap_usd"])


def conversation_cost(conversation_id: str) -> float:
    row = db.fetchone("SELECT COALESCE(SUM(cost_usd),0) AS c FROM usage WHERE conversation_id=%s",
                      (conversation_id,))
    return float(row["c"]) if row else 0.0
