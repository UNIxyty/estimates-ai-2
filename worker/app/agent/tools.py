"""Server-side agent tools. The model never touches the filesystem or DB directly: it can only call
these, and each one enforces the run's permissions itself (allowed files, own documents, own email).

Tool names/specs follow the brief: list_allowed_files, read_file_summary, search_items, get_norm,
price_rows_batch, request_file_permission, web_search_price, propose_structure,
ask_clarifying_questions, write_estimate, get_row_provenance, update_row, send_email.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Callable

from .. import db, jobs
from ..matching.attributes import attributes_compatible, parse_attributes
from ..matching.units import normalise_unit
from ..websearch import search as websearch
from . import cards, documents
from .context import RunContext
from .knowledge import lexical_similarity, tokens
from .pricing import PricingEngine, RowSpec


class ToolError(Exception):
    pass


def _allowed_or_error(rc: RunContext, file_id: str) -> dict:
    f = rc.kb.files.get(file_id)
    if not f:
        raise ToolError(f"Unknown or not analysed file {file_id}")
    if file_id not in rc.allowed:
        # The file exists, but this run may not read it: say so, without revealing its contents.
        raise ToolError(f"found in unselected file {f['name']} (file_id {file_id}); "
                        f"ask the user with request_file_permission before using it")
    return f


# ------------------------------------------------------------------ knowledge tools

def list_allowed_files(rc: RunContext) -> dict:
    out = []
    for fid in rc.allowed:
        f = rc.kb.files.get(fid)
        if f:
            s = f["summary"] or {}
            out.append({"file_id": fid, "name": f["name"], "tag": f["tag"], "language": f["language"],
                        "items": s.get("item_count"), "norms": s.get("norm_count"), "description": s.get("description")})
    return {"files": out}


def read_file_summary(rc: RunContext, file_id: str) -> dict:
    f = _allowed_or_error(rc, file_id)
    logic = db.fetchall("""SELECT kind, sheet_name, section_title, COALESCE(override_sentence, sentence) AS sentence,
                                  COALESCE(override_numbers, numbers) AS numbers, override_sentence IS NOT NULL AS edited
                           FROM file_logic WHERE file_id=%s ORDER BY ord""", (file_id,))
    notes = db.fetchall("SELECT text, source FROM agent_notes WHERE file_id=%s ORDER BY ord, created_at", (file_id,))
    sheets = db.fetchall("""SELECT name, kind, is_electrical, row_count, hourly_rates, currency, language
                            FROM file_sheets WHERE file_id=%s ORDER BY idx""", (file_id,))
    return {"file_id": file_id, "name": f["name"], "tag": f["tag"], "language": f["language"],
            "summary": f["summary"], "sheets": sheets, "logic": logic, "notes": notes}


def search_items(rc: RunContext, query: str, unit: str | None = None, limit: int = 8) -> dict:
    spec = RowSpec(sheet="?", row=0, text=query, unit=unit)
    qt = tokens(query)
    scored = []
    for it in rc.kb.items:
        if it.file_id in rc.denied:
            continue
        if not attributes_compatible(spec.attrs, it.attrs):
            continue
        s = lexical_similarity(qt, it.toks)
        if s > 0.3:
            scored.append((s, it))
    scored.sort(key=lambda t: -t[0])
    allowed = [(s, it) for s, it in scored if it.file_id in rc.allowed][:limit]
    other = next(((s, it) for s, it in scored if it.file_id not in rc.allowed), None)
    res: dict[str, Any] = {"results": [{**it.ref(s), "unit": it.unit_norm, "section": it.section}
                                       for s, it in allowed]}
    if other and (not allowed or other[0] > allowed[0][0] + 0.05):
        res["better_match_in_unselected_file"] = {"file_id": other[1].file_id, "file_name": other[1].file_name,
                                                  "message": f"found in unselected file {other[1].file_name}"}
    return res


def get_norm(rc: RunContext, text: str, unit: str | None = None) -> dict:
    eng = PricingEngine(rc.kb, allowed=rc.allowed, denied=rc.denied, ctx=rc.ctx, use_model=False)
    hit = eng._norm_for(RowSpec(sheet="?", row=0, text=text, unit=unit))
    if not hit:
        return {"norm": None}
    n, pct, level = hit
    return {"norm": {**n.ref(), "specificity": level, "confidence_pct": pct}}


def price_rows_batch(rc: RunContext, rows: list[dict]) -> dict:
    specs = [RowSpec(sheet="adhoc", row=i + 1, text=r["text"], unit=r.get("unit"), qty=r.get("qty"))
             for i, r in enumerate(rows[:200])]
    eng = PricingEngine(rc.kb, allowed=rc.allowed, denied=rc.denied, ctx=rc.ctx, task="fill_blank",
                        forced_tier=rc.forced_tier, should_stop=rc.should_stop)
    priced = eng.price(specs)
    return {"rows": [{k: v for k, v in documents.priced_to_row(p).items()
                      if k not in ("sheet_name", "row_idx")} for p in priced], "stats": eng.stats}


def request_file_permission(rc: RunContext, file_id: str, rows: list[dict], reason: str = "",
                            message_id: str | None = None) -> dict:
    f = rc.kb.files.get(file_id)
    if not f:
        raise ToolError("unknown file")
    if file_id in rc.allowed:
        return {"status": "already_allowed"}
    existing = db.fetchone("""SELECT id, status FROM cards WHERE run_id=%s AND kind='permission'
                              AND payload->>'file_id'=%s AND status IN ('pending','approved','denied')""",
                           (rc.run_id, file_id))
    if existing:
        return {"card_id": str(existing["id"]), "status": existing["status"]}
    card = cards.create(rc.run, "permission",
                        {"file_id": file_id, "file_name": f["name"], "file_tag": f["tag"], "rows": rows[:200],
                         "row_count": len(rows),
                         "reason": reason or f"The closest prices for {len(rows)} row(s) are in {f['name']}, "
                                              f"which isn't selected for this chat."},
                        message_id=message_id)
    return {"card_id": str(card["id"]), "status": "pending"}


def web_search_price(rc: RunContext, query: str) -> dict:
    try:
        found = websearch.find_price(query, ctx=rc.ctx, must_tokens={t for t in tokens(query) if len(t) > 3} or None,
                                     row_text=query)
    except websearch.SearchUnavailable as e:
        return {"found": False, "web_search_unavailable": True, "reason": str(e),
                "note": "Web search is not working right now. Tell the user this plainly (it is not a 'no results'); "
                        "do not retry."}
    if not found:
        return {"found": False, "searched_suppliers": sorted(websearch.allowed_domains()),
                "note": "Nothing on the allowlisted supplier sites matched every attribute of the item."}
    return {"found": True, "flag": "WEB", "note": "Retail web price; never stored as a reference price", **found}


def ask_clarifying_questions(rc: RunContext, questions: list[dict], message_id: str | None = None) -> dict:
    qs = [{"id": q.get("id") or f"q{i + 1}", "text": q["text"], "options": q.get("options") or []}
          for i, q in enumerate(questions[:8])]
    card = cards.create(rc.run, "clarify", {"questions": qs}, message_id=message_id)
    return {"card_id": str(card["id"]), "status": "pending"}


def propose_structure(rc: RunContext, proposal: dict, message_id: str | None = None) -> dict:
    card = cards.create(rc.run, "structure", proposal, message_id=message_id)
    return {"card_id": str(card["id"]), "status": "pending"}


def write_estimate(rc: RunContext, **kw) -> dict:
    doc, web, rep = documents.save_document(run=rc.run, **kw)
    return {"document": documents.document_json(doc), "web": web, "report": rep.__dict__}


# ------------------------------------------------------------------ document tools (own documents only)

def _own_document(rc: RunContext, document_id: str | None) -> dict:
    doc = (db.fetchone("SELECT * FROM documents WHERE id=%s AND conversation_id=%s", (document_id, rc.conversation_id))
           if document_id else rc.latest_document())
    if not doc or str(doc["user_id"]) != str(rc.run["user_id"]):
        raise ToolError("No estimate in this conversation yet" if not document_id else "Unknown document")
    return doc


def get_row_provenance(rc: RunContext, row: int, sheet: str | None = None, document_id: str | None = None) -> dict:
    doc = _own_document(rc, document_id)
    sql = "SELECT * FROM estimate_rows WHERE document_id=%s AND row_idx=%s"
    params: list = [doc["id"], row]
    if sheet:
        sql += " AND sheet_name=%s"
        params.append(sheet)
    rows = db.fetchall(sql, params)
    if not rows:
        raise ToolError(f"Row {row} is not a priced row in {doc['name']}")
    keep = ("sheet_name", "row_idx", "section_title", "item_text", "unit", "qty", "norm_h_per_unit", "hourly_rate",
            "unit_labour", "unit_material", "total_labour", "total_material", "price_source", "confidence",
            "confidence_pct", "reason", "matched", "norm_ref", "web", "flags", "original", "edited_at")
    return {"document_id": str(doc["id"]), "document": doc["name"],
            "rows": [{k: (float(v) if hasattr(v, "as_tuple") else v) for k, v in r.items() if k in keep}
                     for r in rows]}


def update_row(rc: RunContext, row: int, changes: dict, sheet: str | None = None,
               document_id: str | None = None) -> dict:
    doc = _own_document(rc, document_id)
    if not sheet:
        r = db.fetchone("SELECT sheet_name FROM estimate_rows WHERE document_id=%s AND row_idx=%s", (doc["id"], row))
        if not r:
            raise ToolError(f"Row {row} not found")
        sheet = r["sheet_name"]
    out = documents.update_row(str(doc["id"]), sheet, row, changes, str(rc.run["user_id"]))
    rc.emitter.emit("document.ready", {"document": out["document"]})
    return {"updated": True, "document": out["document"]}


def send_email(rc: RunContext, document_id: str | None = None, message_id: str | None = None) -> dict:
    """Recipient is ALWAYS the requesting user's Profile "Send estimates to" (fallback: login email).
    The tool takes no recipient argument, so the model cannot redirect it."""
    doc = _own_document(rc, document_id)
    to = rc.user["send_estimates_to"] or rc.user["email"]
    key = hashlib.sha256(f"{rc.run_id}:{doc['id']}:{doc['version']}".encode()).hexdigest()
    with db.conn() as c:
        es = c.execute("""INSERT INTO email_sends(run_id, document_id, user_id, to_email, idempotency_key)
                          VALUES (%s,%s,%s,%s,%s)
                          ON CONFLICT (idempotency_key) DO UPDATE SET updated_at=now() RETURNING *""",
                       (rc.run_id, doc["id"], rc.run["user_id"], to, key)).fetchone()
        c.commit()
    if es["card_id"]:
        return {"status": es["status"], "to": to, "card_id": str(es["card_id"])}
    card = cards.create(rc.run, "email", {"document_id": str(doc["id"]), "document_name": doc["name"], "to": to,
                                          "email_send_id": str(es["id"])}, message_id=message_id, status="sending")
    db.execute("UPDATE email_sends SET card_id=%s WHERE id=%s", (card["id"], es["id"]))
    jobs.enqueue("send_email", {"email_send_id": str(es["id"])}, dedupe_key=f"email:{es['id']}")
    return {"status": "sending", "to": to, "card_id": str(card["id"])}


# ------------------------------------------------------------------ registry for the model

def _schema(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


SPECS: dict[str, dict] = {
    "list_allowed_files": {"description": "List the knowledge files this chat may use.", "input_schema": _schema({}, [])},
    "read_file_summary": {"description": "Read a file's structure, calculation logic and notes. Only allowed files.",
                          "input_schema": _schema({"file_id": {"type": "string"}}, ["file_id"])},
    "search_items": {"description": "Search priced rows in allowed reference files. Reports if a better match "
                                    "exists in an unselected file.",
                     "input_schema": _schema({"query": {"type": "string"}, "unit": {"type": "string"},
                                              "limit": {"type": "integer"}}, ["query"])},
    "get_norm": {"description": "Find the most specific hourly norm (parameterised > item > category).",
                 "input_schema": _schema({"text": {"type": "string"}, "unit": {"type": "string"}}, ["text"])},
    "price_rows_batch": {"description": "Price several ad-hoc rows at once with the deterministic-first pipeline.",
                         "input_schema": _schema({"rows": {"type": "array", "items": _schema(
                             {"text": {"type": "string"}, "unit": {"type": "string"}, "qty": {"type": "number"}},
                             ["text"])}}, ["rows"])},
    "request_file_permission": {"description": "Ask the user to allow an unselected file for some rows.",
                                "input_schema": _schema({"file_id": {"type": "string"}, "reason": {"type": "string"},
                                                         "rows": {"type": "array", "items": {"type": "object"}}},
                                                        ["file_id", "rows"])},
    "web_search_price": {"description": "Look up a retail price on the allowlisted Latvian supplier sites. Write the "
                                        "query in Latvian like a shop listing: product type + brand + series + key "
                                        "specs (e.g. 'Siemens Delta kontaktligzda 2P+E 16A balta'). One item per call. "
                                        "Result is flagged WEB and never saved as a reference price. If the result "
                                        "says web_search_unavailable, tell the user web search is not working and why.",
                         "input_schema": _schema({"query": {"type": "string"}}, ["query"])},
    "ask_clarifying_questions": {"description": "Ask the user questions instead of guessing.",
                                 "input_schema": _schema({"questions": {"type": "array", "items": _schema(
                                     {"text": {"type": "string"}, "options": {"type": "array",
                                                                              "items": {"type": "string"}}},
                                     ["text"])}}, ["questions"])},
    "get_row_provenance": {"description": "Stored provenance for a row of the current estimate: matched reference "
                                          "rows, norm, source, confidence, reason, edits.",
                           "input_schema": _schema({"row": {"type": "integer"}, "sheet": {"type": "string"}},
                                                   ["row"])},
    "update_row": {"description": "Change qty / unit_labour / unit_material / norm_h_per_unit / hourly_rate of a row "
                                  "in the current estimate. Recalculates and marks it EDITED.",
                   "input_schema": _schema({"row": {"type": "integer"}, "sheet": {"type": "string"},
                                            "changes": {"type": "object"}}, ["row", "changes"])},
    "send_email": {"description": "Email the current estimate (xlsx) to the requesting user's own "
                                  "'Send estimates to' address. No other recipients are possible.",
                   "input_schema": _schema({}, [])},
    "propose_structure": {"description": "Post the structure proposal card (generate flow).",
                          "input_schema": _schema({"proposal": {"type": "object"}}, ["proposal"])},
    "write_estimate": {"description": "Write the estimate workbook (generate/fill flows).",
                       "input_schema": _schema({}, [])},
}

FUNCS: dict[str, Callable[..., dict]] = {
    "list_allowed_files": list_allowed_files, "read_file_summary": read_file_summary, "search_items": search_items,
    "get_norm": get_norm, "price_rows_batch": price_rows_batch, "request_file_permission": request_file_permission,
    "web_search_price": web_search_price, "ask_clarifying_questions": ask_clarifying_questions,
    "get_row_provenance": get_row_provenance, "update_row": update_row, "send_email": send_email,
    "propose_structure": propose_structure, "write_estimate": write_estimate,
}

QA_TOOLS = ["list_allowed_files", "read_file_summary", "search_items", "get_norm", "price_rows_batch",
            "request_file_permission", "web_search_price", "ask_clarifying_questions", "get_row_provenance",
            "update_row", "send_email"]


def specs_for(names: list[str]) -> list[dict]:
    return [{"name": n, **SPECS[n]} for n in names]


def call(rc: RunContext, name: str, args: dict, *, message_id: str | None = None) -> tuple[dict, bool]:
    """Execute a model tool call. Returns (result, is_error). Unknown/forbidden tools are errors."""
    if name not in QA_TOOLS:
        return {"error": f"tool {name} is not available here"}, True
    fn = FUNCS[name]
    kwargs = dict(args or {})
    if name in ("request_file_permission", "ask_clarifying_questions", "send_email"):
        kwargs["message_id"] = message_id
    if name == "send_email":
        kwargs = {"message_id": message_id}  # never accept a recipient or other document from the model
    try:
        return json.loads(json.dumps(fn(rc, **kwargs), default=str)), False
    except ToolError as e:
        return {"error": str(e)}, True
    except TypeError as e:
        return {"error": f"bad arguments: {e}"}, True
