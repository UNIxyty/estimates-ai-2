"""Chat Q&A and follow-ups: a Converse tool loop over the permission-checked tools.

Answers about rows use stored run provenance (get_row_provenance), not re-derivation. Row and file
references are emitted by the model as [[row:Sheet!58]] / [[file:<id>]] markers and turned into
structured chips. Email requests make the agent call send_email (recipient fixed server-side)."""
from __future__ import annotations

import re

from .. import db
from ..llm import client as llm
from ..llm import router
from . import tools
from .context import RunContext

MAX_TURNS = 8
UNSURE = "<<UNSURE>>"
_CHIP = re.compile(r"\[\[(row|file):([^\]]+)\]\]")

SYSTEM = """You are the estimating assistant of an electrical contractor. You answer questions about the \
user's estimates and knowledge files, change rows when asked, and email estimates.

Rules:
- Use the tools; never guess numbers. For "why is row N …" questions call get_row_provenance and explain \
from the stored source, norm, hourly rate, confidence and reason.
- Only files returned by list_allowed_files may be used. If a tool says a match was "found in unselected \
file X", call request_file_permission for those rows instead of using it.
- Web prices are retail (can be ~40% above contract prices); say so when you use one.
- To email the estimate call send_email. It always goes to the user's own "Send estimates to" address.
- Refer to estimate rows as [[row:SHEET!ROW]] and to knowledge files as [[file:FILE_ID]]; the UI turns these \
into clickable chips. Write in English, plain text, short paragraphs, no tables.
"""


def _history(rc: RunContext, limit: int = 12) -> list[dict]:
    rows = db.fetchall("""SELECT role, content FROM messages WHERE conversation_id=%s AND content <> ''
                          ORDER BY created_at DESC LIMIT %s""", (rc.conversation_id, limit))
    msgs: list[dict] = []
    for r in reversed(rows):
        if msgs and msgs[-1]["role"] == r["role"]:
            msgs[-1]["content"][0]["text"] += "\n\n" + r["content"]
        else:
            msgs.append({"role": r["role"], "content": [{"text": r["content"]}]})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


def _context_block(rc: RunContext) -> str:
    doc = rc.latest_document()
    files = tools.list_allowed_files(rc)["files"]
    lines = ["Knowledge files allowed in this chat:"]
    lines += [f"- {f['name']} (file_id {f['file_id']}, {f['tag']}, {f['language']})" for f in files] or ["- none"]
    if doc:
        t = doc["totals"] or {}
        lines += ["", f"Current estimate: {doc['name']} (document_id {doc['id']}, version {doc['version']}, "
                      f"language {doc['language']}). Totals: labour {t.get('labour')}, material {t.get('material')}, "
                      f"total {t.get('total')} {doc['currency']}; rows {t.get('rows')}, flagged CHECK {t.get('check')}, "
                      f"NO PRICE {t.get('no_price')}, WEB {t.get('web')}, EDITED {t.get('edited')}."]
    return "\n".join(lines)


def to_parts(rc: RunContext, text: str) -> list[dict]:
    doc = rc.latest_document()
    parts: list[dict] = []
    pos = 0
    for m in _CHIP.finditer(text):
        if m.start() > pos:
            parts.append({"type": "text", "text": text[pos:m.start()]})
        kind, ref = m.group(1), m.group(2).strip()
        if kind == "row" and doc:
            sheet, _, row = ref.rpartition("!")
            try:
                parts.append({"type": "chip", "kind": "row", "document_id": str(doc["id"]), "sheet": sheet or None,
                              "row": int(row), "label": f"Row {int(row)}"})
            except ValueError:
                parts.append({"type": "text", "text": m.group(0)})
        elif kind == "file" and ref in rc.kb.files:
            parts.append({"type": "chip", "kind": "file", "file_id": ref, "label": rc.kb.file_name(ref)})
        else:
            parts.append({"type": "text", "text": m.group(0)})
        pos = m.end()
    if pos < len(text):
        parts.append({"type": "text", "text": text[pos:]})
    return parts


def _plain(parts: list[dict]) -> str:
    return "".join(p["text"] if p["type"] == "text" else p["label"] for p in parts)


def _fallback(rc: RunContext, task: str, question: str, message_id: str) -> str:
    """No model configured: still do the deterministic things."""
    if task == "email":
        try:
            r = tools.send_email(rc, message_id=message_id)
            return f"Sending the estimate to {r['to']}."
        except tools.ToolError as e:
            return str(e)
    m = re.search(r"\b(?:row|rinda|rindu|række|rad)\s*(\d+)", question, re.I)
    if m:
        try:
            prov = tools.get_row_provenance(rc, int(m.group(1)))["rows"][0]
            return (f"[[row:{prov['sheet_name']}!{prov['row_idx']}]] “{prov['item_text']}”: qty {prov['qty']} "
                    f"{prov['unit'] or ''}, labour {prov['unit_labour']}/unit, material {prov['unit_material']}/unit. "
                    f"Source: {prov['price_source']} ({prov['confidence'] or 'n/a'} "
                    f"{prov['confidence_pct'] or ''}%). {prov['reason']}")
        except tools.ToolError as e:
            return str(e)
    return "The language model isn't configured on this server, so I can only answer row questions and send emails."


def run(rc: RunContext, question: str, task: str) -> None:
    msg = rc.new_assistant_message()
    mid = str(msg["id"])
    if not llm.available():
        text = _fallback(rc, task, question, mid)
        parts = to_parts(rc, text)
        rc.complete_message(mid, content=_plain(parts), parts=parts)
        return

    route = router.resolve(task, forced_tier=rc.forced_tier)
    system = [SYSTEM, _context_block(rc)]
    if route.tier == "fast":
        system.append(f"If you cannot answer confidently and completely, reply with exactly {UNSURE} and nothing else.")
    messages = _history(rc)
    if not messages or messages[-1]["role"] != "user":
        messages.append({"role": "user", "content": [{"text": question}]})
    specs = tools.specs_for(tools.QA_TOOLS)
    final_text = ""
    ctx = rc.ctx_for(mid)

    def on_text(delta: str) -> None:
        if UNSURE not in delta:
            rc.emitter.text_delta(mid, delta)

    for _ in range(MAX_TURNS):
        rc.check()
        res = llm.converse(task=task, messages=messages, ctx=ctx, system=system, tools=specs, max_tokens=4096,
                           forced_tier=rc.forced_tier, on_text=on_text, should_stop=rc.should_stop,
                           unsure=(lambda r: UNSURE in r.text) if route.tier == "fast" else None)
        messages.append({"role": "assistant", "content": res.content})
        final_text += res.text.replace(UNSURE, "")
        if res.stop_reason != "tool_use" or not res.tool_uses:
            break
        results = []
        for tu in res.tool_uses:
            rc.emitter.step_started(f"tool:{tu['id']}", tu["name"].replace("_", " "))
            out, is_err = tools.call(rc, tu["name"], tu["input"], message_id=mid)
            rc.emitter.step_done(f"tool:{tu['id']}", "error" if is_err else None)
            block = {"toolUseId": tu["id"], "content": [{"json": out}]}
            if is_err:
                block["status"] = "error"
            results.append({"toolResult": block})
        messages.append({"role": "user", "content": results})
    rc.emitter.flush()
    parts = to_parts(rc, final_text.strip())
    rc.complete_message(mid, content=_plain(parts), parts=parts)
