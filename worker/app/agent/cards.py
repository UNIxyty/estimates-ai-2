"""Cards the agent posts into the chat. Decisions are made through the web API (idempotent,
state-guarded); the worker creates cards, moves them through worker-owned states and expires them."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .. import db
from ..config import settings
from .events import append_event

CARD_COLS = ("id, run_id, conversation_id, message_id, kind, status, payload, decision, decided_at, "
             "expires_at, version, created_at, updated_at")


def serialize(card: dict) -> dict:
    out = dict(card)
    for k, v in out.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif k in ("id", "run_id", "conversation_id", "message_id") and v is not None:
            out[k] = str(v)
    return out


def create(run: dict, kind: str, payload: dict, *, message_id: str | None = None, status: str | None = None,
           expires_minutes: int | None = None) -> dict:
    status = status or {"document": "ready", "web_prices": "ready", "email": "sending"}.get(kind, "pending")
    if kind == "permission" and expires_minutes is None:
        expires_minutes = settings.permission_card_minutes
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=expires_minutes)) if expires_minutes else None
    with db.conn() as c:
        card = c.execute(
            f"""INSERT INTO cards(run_id, conversation_id, message_id, kind, status, payload, expires_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING {CARD_COLS}""",
            (run["id"], run["conversation_id"], message_id, kind, status, db.jsonb(payload), expires_at)).fetchone()
        if message_id:
            c.execute("""UPDATE messages SET parts = parts || %s WHERE id=%s""",
                      (db.jsonb([{"type": "card", "card_id": str(card["id"])}]), message_id))
        append_event(str(run["id"]), "card.created", {"card": serialize(card)}, connection=c)
        c.commit()
    return card


def update(card_id: str, *, status: str | None = None, payload: dict | None = None,
           expect_status: str | tuple[str, ...] | None = None) -> dict | None:
    """Worker-side transition. With expect_status the update is state-guarded (idempotent)."""
    sets, params = ["updated_at=now()", "version=version+1"], []
    if status:
        sets.append("status=%s")
        params.append(status)
    if payload is not None:
        sets.append("payload=%s")
        params.append(db.jsonb(payload))
    where = "id=%s"
    params.append(card_id)
    if expect_status:
        exp = (expect_status,) if isinstance(expect_status, str) else tuple(expect_status)
        where += " AND status = ANY(%s)"
        params.append(list(exp))
    with db.conn() as c:
        card = c.execute(f"UPDATE cards SET {', '.join(sets)} WHERE {where} RETURNING {CARD_COLS}",
                         params).fetchone()
        if card:
            append_event(str(card["run_id"]), "card.updated", {"card": serialize(card)}, connection=c)
        c.commit()
    return card


def decision_data(card: dict | None) -> dict:
    """cards.decision is {"action": ..., "data": {...}} (written by the web API)."""
    d = (card or {}).get("decision") or {}
    return d.get("data") or {}


def get(card_id: str) -> dict | None:
    return db.fetchone(f"SELECT {CARD_COLS} FROM cards WHERE id=%s", (card_id,))


def pending_for_run(run_id: str, kind: str | None = None) -> list[dict]:
    sql = f"SELECT {CARD_COLS} FROM cards WHERE run_id=%s AND status='pending'"
    params: list = [run_id]
    if kind:
        sql += " AND kind=%s"
        params.append(kind)
    return db.fetchall(sql + " ORDER BY created_at", params)


def expire_due() -> int:
    """Pending permission cards older than their expiry become 'expired' (UI shows Ask again)."""
    rows = db.fetchall(
        f"""UPDATE cards SET status='expired', updated_at=now(), version=version+1
            WHERE kind='permission' AND status='pending' AND expires_at < now()
            RETURNING {CARD_COLS}""")
    for card in rows:
        append_event(str(card["run_id"]), "card.updated", {"card": serialize(card)})
    return len(rows)
