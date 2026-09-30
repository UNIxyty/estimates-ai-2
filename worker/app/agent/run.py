"""Job handlers for agent runs: `run_agent` (a new user message) and `resume_run` (a card decision)."""
from __future__ import annotations

import logging

from .. import db, jobs
from ..config import settings
from ..llm import client as llm
from ..llm import router
from . import cards, common, fill, generate, qa
from .context import RunCancelled, RunContext, RunWaiting

log = logging.getLogger(__name__)
BLANK_EXT = {"xlsx", "xls"}
LIST_EXT = {"docx", "pdf", "txt", "csv"}


def _attachments(rc: RunContext) -> list[dict]:
    ids = [str(x) for x in rc.run["attachment_ids"] or []]
    if not ids:
        return []
    return db.fetchall("SELECT * FROM uploads WHERE id = ANY(%s) AND user_id=%s", (ids, rc.run["user_id"]))


def _budget_gate(rc: RunContext) -> str | None:
    """Defence in depth: web checks before creating the run; the worker checks again before spending."""
    b = db.fetchone("SELECT * FROM budget_status()")
    if b and b["state"] == "over":
        if b["action"] == "pause":
            return "Monthly budget reached; new requests are paused by the admin's budget settings."
        if b["action"] == "fast_only" and not rc.run.get("tier_override"):
            db.execute("UPDATE runs SET tier_override='fast' WHERE id=%s", (rc.run_id,))
            rc.run["tier_override"] = "fast"
    return None


def _classify(rc: RunContext, text: str, atts: list[dict]) -> str:
    has_doc = rc.latest_document() is not None
    task = router.classify_rules(text, has_xlsx_attachment=any(a["ext"] in BLANK_EXT for a in atts),
                                 has_list_attachment=any(a["ext"] in LIST_EXT for a in atts), has_document=has_doc)
    if task:
        return task
    if not llm.available():
        return "simple_question"
    try:
        out = llm.complete_json("classify", router.CLASSIFY_SYSTEM, f"Message:\n{text[:4000]}\n\nAn estimate exists "
                                f"in this chat: {'yes' if has_doc else 'no'}.", router.CLASSIFY_SCHEMA, ctx=rc.ctx,
                                max_tokens=200, forced_tier=rc.forced_tier)
    except llm.LLMError:
        return "simple_question"  # unclassifiable → cheapest sensible route (Fast answers still escalate)
    task = out.get("task")
    return task if task in ("simple_question", "short_reply", "complex_reasoning", "generate", "email") \
        else "simple_question"


def _dispatch(rc: RunContext, card: dict | None = None) -> None:
    atts = _attachments(rc)
    um = rc.user_message()
    text = (um or {}).get("content") or ""
    kind = rc.state.get("task")
    if not kind:
        kind = _classify(rc, text, atts)
        rc.save_state(task=kind)
        db.execute("UPDATE runs SET kind=%s WHERE id=%s",
                   ({"fill_blank": "fill_blank", "generate": "generate", "email": "email"}.get(kind, "qa"), rc.run_id))
        rc.refresh()
    if kind == "fill_blank":
        blank = next(a for a in atts if a["ext"] in BLANK_EXT)
        fill.run(rc, blank)
    elif kind == "generate":
        generate.run(rc, [a for a in atts if a["ext"] in LIST_EXT], text, card)
    else:
        qa.run(rc, text, kind)


def _execute(rc: RunContext, fn) -> None:
    try:
        fn()
        rc.emitter.flush()
        rc.set_status("waiting" if rc.state.get("pending") else "done")
    except RunWaiting:
        rc.emitter.flush()
        rc.set_status("waiting")
    except (RunCancelled, llm.Cancelled):
        rc.emitter.flush()
        rc.set_status("cancelled")
    except llm.CostCapReached as e:
        rc.emitter.flush()
        msg = rc.new_assistant_message()
        cards.create(rc.run, "cost_cap", {"run_cost_usd": round(e.spent, 4), "cap_usd": round(e.cap, 2),
                                          "next_call_usd": round(e.estimate, 4),
                                          "increment_usd": settings.run_cost_cap_usd}, message_id=str(msg["id"]))
        rc.complete_message(str(msg["id"]), content=f"This request has cost ${e.spent:.2f} so far and the next step "
                                                    f"would pass the ${e.cap:.2f} safety cap. Continue?")
        rc.set_status("paused_cost")
    except llm.LLMUnavailable as e:
        rc.emitter.flush()
        msg = rc.new_assistant_message()
        rc.complete_message(str(msg["id"]), content=f"The model service isn't available ({e}). Deterministic "
                                                    f"steps ran; please ask an admin to check Bedrock settings.")
        rc.set_status("failed", "llm_unavailable")
    except Exception as e:  # noqa: BLE001
        log.exception("run %s failed", rc.run_id)
        rc.emitter.flush()
        msg = rc.new_assistant_message()
        rc.complete_message(str(msg["id"]), content=f"Something went wrong: {type(e).__name__}: {e}")
        rc.set_status("failed", f"{type(e).__name__}: {e}"[:500])


@jobs.handler("run_agent")
def run_agent(payload: dict) -> None:
    rc = RunContext(payload["run_id"])
    if rc.run["status"] not in ("queued", "running"):
        return  # already handled (idempotent)
    if rc.run["cancel_requested"]:
        rc.set_status("cancelled")
        return
    blocked = _budget_gate(rc)
    if blocked:
        msg = rc.new_assistant_message()
        rc.complete_message(str(msg["id"]), content=blocked)
        rc.set_status("failed", "budget_paused")
        return
    rc.set_status("running")
    _execute(rc, lambda: _dispatch(rc))


@jobs.handler("resume_run")
def resume_run(payload: dict) -> None:
    rc = RunContext(payload["run_id"])
    card = cards.get(payload["card_id"]) if payload.get("card_id") else None
    if rc.run["status"] in ("done", "failed", "cancelled") and not (card and card["kind"] == "permission"):
        return
    if rc.run["cancel_requested"]:
        rc.set_status("cancelled")
        return
    if not card:
        return
    action = (card.get("decision") or {}).get("action")
    if card["kind"] == "cost_cap":
        if action == "stop" or card["status"] == "stopped":
            rc.set_status("cancelled")
            return
        # The web API already raised runs.cost_cap_usd by RUN_COST_CAP_USD under its state guard.
        rc.refresh()
    elif card["kind"] == "permission" and card["status"] not in ("approved", "denied"):
        return  # undone or expired meanwhile
    blocked = _budget_gate(rc)
    if blocked:
        rc.set_status("failed", "budget_paused")
        return
    rc.set_status("running")
    if card["kind"] == "permission":
        _execute(rc, lambda: common.resume_after_permission(rc, card))
    elif card["kind"] in ("structure", "clarify"):
        _execute(rc, lambda: _dispatch(rc, card))
    else:
        _execute(rc, lambda: _dispatch(rc))


@jobs.handler("run_agent:failed")
def run_agent_failed(payload: dict) -> None:
    try:
        rc = RunContext(payload["run_id"])
        if rc.run["status"] not in ("done", "failed", "cancelled"):
            rc.set_status("failed", payload.get("error", "job failed")[:500])
    except LookupError:
        pass
