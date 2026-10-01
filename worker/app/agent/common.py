"""Shared steps of the fill / generate flows: pricing with live step events, permission cards for rows
whose best match is in an unselected file, writing the document, posting summary + cards, and
re-pricing parked rows after Allow / Deny."""
from __future__ import annotations

import os
import subprocess
import tempfile
import uuid

from .. import db
from ..config import settings
from ..llm import embeddings
from ..websearch import search as websearch
from . import cards, documents, tools
from .context import RunContext
from .knowledge import tokens
from .pricing import PricedRow, PricingEngine, RowSpec
from .writer import SheetLayout

PRICE_WORDS = {"LV": "cena", "LT": "kaina", "ET": "hind", "DA": "pris", "NO": "pris", "SV": "pris", "DE": "Preis",
               "FI": "hinta", "PL": "cena"}
STAGE_LABELS = {"exact": "Matching reference rows", "semantic": "Finding closest matches",
                "model": "Deciding ambiguous rows", "web": "Looking up supplier prices"}


def ensure_xlsx(path: str) -> str:
    """xls blanks are converted with LibreOffice headless (the original is kept)."""
    if not path.lower().endswith(".xls"):
        return path
    out_dir = os.path.join(os.path.dirname(path), "converted")
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, os.path.splitext(os.path.basename(path))[0] + ".xlsx")
    if os.path.exists(target):
        return target
    profile = os.path.join(tempfile.gettempdir(), f"lo_{uuid.uuid4().hex}")
    subprocess.run(["soffice", f"-env:UserInstallation=file://{profile}", "--headless", "--convert-to", "xlsx",
                    "--outdir", out_dir, path], check=True, timeout=180, capture_output=True)
    return target


def spec_json(s: RowSpec) -> dict:
    return {"sheet": s.sheet, "row": s.row, "text": s.text, "unit": s.unit, "qty": s.qty, "section": s.section}


def spec_from(d: dict) -> RowSpec:
    return RowSpec(sheet=d["sheet"], row=d["row"], text=d["text"], unit=d.get("unit"), qty=d.get("qty"),
                   section=d.get("section"))


def price_with_events(rc: RunContext, specs: list[RowSpec], *, task: str, target_rate: float | None,
                      step_prefix: str = "price", denied_rows: set[str] | None = None,
                      ) -> tuple[list[PricedRow], dict]:
    em = rc.emitter
    started: set[str] = set()

    def progress(stage: str, done: int, total: int) -> None:
        sid = f"{step_prefix}:{stage}"
        if sid not in started:
            started.add(sid)
            em.step_started(sid, STAGE_LABELS.get(stage, stage), total)
        em.step_progress(sid, done, total)
        rc.check()

    last: dict[str, tuple[int, int]] = {}

    def progress_tracked(stage: str, done: int, total: int) -> None:
        last[stage] = (done, total)
        progress(stage, done, total)

    def current(stage: str, text: str) -> None:
        # The item being priced right now ("Now: …" under the step); only the slow web stage reports it.
        sid = f"{step_prefix}:{stage}"
        done, total = last.get(stage, (0, 0))
        if sid not in started:
            started.add(sid)
            em.step_started(sid, STAGE_LABELS.get(stage, stage), total or None)
        em.emit("step.progress", {"step_id": sid, "done": done, "total": total or None, "current": text[:120]})

    emb = None
    if rc.kb.has_embeddings:
        em.step_started(f"{step_prefix}:embed", "Embedding row texts", len(specs))
        vecs = embeddings.embed_texts([s.text for s in specs], input_type="search_query", ctx=rc.ctx)
        emb = {s.rid: v for s, v in zip(specs, vecs)} if vecs else None
        em.step_done(f"{step_prefix}:embed", f"{len(specs)} rows" if vecs else "embeddings unavailable")

    price_word = PRICE_WORDS.get((rc.state.get("lang") or "").upper(), "price")

    def web_lookup(spec: RowSpec) -> dict | None:
        return websearch.find_price(f"{spec.text} {price_word}", ctx=rc.ctx,
                                    must_tokens={t for t in tokens(spec.text) if len(t) > 3} or None)

    eng = PricingEngine(rc.kb, allowed=rc.allowed, denied=rc.denied, ctx=rc.ctx, target_rate=target_rate,
                        task=task, forced_tier=rc.forced_tier, progress=progress_tracked, current=current,
                        web_lookup=web_lookup if websearch.provider().configured() else None,
                        should_stop=rc.should_stop)
    priced = eng.price(specs, embeddings=emb, denied_rows=denied_rows)
    for sid in started:
        em.step_done(sid)
    s = eng.stats
    em.step_done(f"{step_prefix}:exact",
                 f"{s['exact']} exact · {s['semantic']} close · {s['norm']} norm · {s['model']} model · "
                 f"{s['web']} web · {s['none']} no price")
    if s.get("model_error"):
        em.step_warn(f"{step_prefix}:model", "The pricing model could not be used, so unclear rows were matched "
                                              f"without it: {s['model_error'][:160]}")
    if s["none"]:
        em.step_warn(f"{step_prefix}:none", f"{s['none']} row(s) have no price in any allowed file, norm or web source",
                     rows=[{"sheet": p.spec.sheet, "row": p.spec.row, "label": p.spec.text[:60]}
                           for p in priced if p.source == "none"][:50])
    return priced, s


def request_permissions(rc: RunContext, priced: list[PricedRow], message_id: str | None) -> list[dict]:
    """One permission card per unselected file that holds the best match for some rows."""
    by_file: dict[str, list[PricedRow]] = {}
    for p in priced:
        if p.source == "pending_permission" and p.blocked_file:
            by_file.setdefault(p.blocked_file["file_id"], []).append(p)
    out = []
    for fid, rows in by_file.items():
        res = tools.request_file_permission(
            rc, fid, [{"sheet": p.spec.sheet, "row": p.spec.row, "item": p.spec.text[:80]} for p in rows],
            message_id=message_id)
        out.append({"file_id": fid, **res})
        rc.emitter.step_warn("permission", f"{len(rows)} row(s) wait for permission to use "
                                           f"{rows[0].blocked_file['file_name']}")
    return out


def _chips(doc_id: str, priced: list[PricedRow], flag: str, limit: int = 8) -> list[dict]:
    return [{"type": "chip", "kind": "row", "document_id": doc_id, "sheet": p.spec.sheet, "row": p.spec.row,
             "label": f"{p.spec.sheet} · row {p.spec.row}"}
            for p in priced if flag in p.flags or (flag == "PENDING" and p.source == "pending_permission")][:limit]


def summary_parts(doc: dict, priced: list[PricedRow], stats: dict, *, lang: str | None, sheets: list[str],
                  lead: str) -> tuple[str, list[dict]]:
    t = doc["totals"] or {}
    cur = doc["currency"] or "EUR"
    lines = [lead,
             f"Sheets: {', '.join(sheets)} · Language: {lang or '—'} (values written in the file's own language).",
             f"{stats['exact']} rows matched a reference exactly, {stats['semantic']} by closest match, "
             f"{stats['norm']} from hourly norms, {stats['model']} decided by the model, {stats['web']} from web "
             f"prices (marked WEB).",
             f"Labour {t.get('labour', 0):,.2f} {cur} · Material {t.get('material', 0):,.2f} {cur} · "
             f"Total {t.get('total', 0):,.2f} {cur}."]
    parts: list[dict] = [{"type": "text", "text": "\n".join(lines)}]
    doc_id = str(doc["id"])
    no_price = sum(1 for p in priced if "NO PRICE" in p.flags)
    for flag, label in (("CHECK", "Please check (low confidence):"),
                        ("NO PRICE", f"I couldn't find a price for {no_price} row{'s' if no_price != 1 else ''} in your "
                                     f"references, norms or on supplier sites. {'They are' if no_price != 1 else 'It is'} "
                                     f"left empty and marked NO PRICE. Type a price in the viewer, or send me a supplier "
                                     f"link and I'll use it:"),
                        ("PENDING", "Waiting for your permission:")):
        chips = _chips(doc_id, priced, flag)
        if chips:
            # tone "warn": the UI shows this paragraph as an amber note ("nothing found").
            parts.append({"type": "text", "text": label, **({"tone": "warn"} if flag == "NO PRICE" else {})})
            parts.extend(chips)
    text = "\n".join(p["text"] for p in parts if p["type"] == "text")
    return text, parts


def publish_document(rc: RunContext, *, message_id: str, doc: dict, web: list[dict]) -> None:
    dj = documents.document_json(doc)
    rc.emitter.emit("document.ready", {"document": dj})
    existing = db.fetchone("""SELECT id, payload FROM cards WHERE conversation_id=%s AND kind='document'
                              AND payload->>'document_id'=%s""", (rc.conversation_id, str(doc["id"])))
    payload = {"document_id": str(doc["id"]), "name": doc["name"], "totals": doc["totals"],
               "currency": doc["currency"], "version": doc["version"], "language": doc["language"],
               "sheets": list((doc.get("layout") or {}).keys())}
    if existing:
        cards.update(str(existing["id"]), payload=payload)
    else:
        cards.create(rc.run, "document", payload, message_id=message_id)
    if web:
        wexisting = db.fetchone("""SELECT id FROM cards WHERE conversation_id=%s AND kind='web_prices'
                                   AND payload->>'document_id'=%s""", (rc.conversation_id, str(doc["id"])))
        wp = {"document_id": str(doc["id"]), "rows": web,
              "note": "Retail web prices can run ~40% above contract prices. They are not saved as references."}
        if wexisting:
            cards.update(str(wexisting["id"]), payload=wp)
        else:
            cards.create(rc.run, "web_prices", wp, message_id=message_id)


def finish_priced(rc: RunContext, *, priced: list[PricedRow], stats: dict, layouts: dict[str, SheetLayout],
                  src_path: str, name: str, mode: str, lang: str | None, currency: str, sheets: list[str],
                  source_upload_id: str | None = None, template_file_id: str | None = None) -> None:
    rc.emitter.step_started("write", "Writing the workbook")
    rows = [documents.priced_to_row(p) for p in priced]
    doc, web, rep = documents.save_document(run=rc.run, name=name, mode=mode, src_path=src_path, layouts=layouts,
                                            rows=rows, language=lang, currency=currency,
                                            source_upload_id=source_upload_id, template_file_id=template_file_id)
    rc.emitter.step_done("write", f"{rep.written} cells written · {rep.skipped_formula} formula cells left intact")
    msg = rc.new_assistant_message()
    rc.save_state(document_id=str(doc["id"]),
                  pending=[{**spec_json(p.spec), "file_id": p.blocked_file["file_id"]}
                           for p in priced if p.source == "pending_permission"],
                  layouts={k: v.as_dict() for k, v in layouts.items()}, src_path=src_path, lang=lang,
                  stats={**stats, "cells_written": rep.written})
    db.execute("UPDATE runs SET stats=%s WHERE id=%s", (db.jsonb(rc.state["stats"]), rc.run_id))
    priced_n = sum(1 for p in priced if p.priced)
    text, parts = summary_parts(doc, priced, stats, lang=lang, sheets=sheets,
                                lead=f"Priced {priced_n} of {len(priced)} rows in {name}.")
    publish_document(rc, message_id=str(msg["id"]), doc=doc, web=web)
    request_permissions(rc, priced, str(msg["id"]))
    rc.complete_message(str(msg["id"]), content=text, parts=parts)


def resume_after_permission(rc: RunContext, card: dict) -> None:
    """Allow → the file joined the run's allowed set; Deny → it's in the denied set and those rows go to
    web search. Re-price only the rows parked on this file, then write a new document version."""
    fid = card["payload"]["file_id"]
    pending = [p for p in rc.state.get("pending", []) if p["file_id"] == fid]
    if not pending:
        return
    rc.reload_kb()
    specs = [spec_from(p) for p in pending]
    decision = "Allowed" if card["status"] == "approved" else "Denied"
    rc.emitter.step_started(f"perm:{card['id']}", f"{decision} {card['payload']['file_name']}: re-pricing "
                                                 f"{len(specs)} row(s)", len(specs))
    task = "generate" if rc.run["kind"] == "generate" else "fill_blank"
    priced, stats = price_with_events(rc, specs, task=task, target_rate=rc.state.get("target_rate"),
                                      step_prefix=f"perm:{card['id']}",
                                      denied_rows={s.rid for s in specs} if decision == "Denied" else None)
    layouts = {k: SheetLayout(v["name"], v["cols"]) for k, v in rc.state["layouts"].items()}
    doc, web, rep = documents.save_document(run=rc.run, name="", mode=rc.run["kind"], src_path=rc.state["src_path"],
                                            layouts=layouts, rows=[documents.priced_to_row(p) for p in priced],
                                            language=rc.state.get("lang"), document_id=rc.state["document_id"])
    rc.emitter.step_done(f"perm:{card['id']}", f"{sum(1 for p in priced if p.priced)} priced")
    remaining = [p for p in rc.state.get("pending", []) if p["file_id"] != fid]
    remaining += [{**spec_json(p.spec), "file_id": p.blocked_file["file_id"]}
                  for p in priced if p.source == "pending_permission"]
    rc.save_state(pending=remaining)
    msg = rc.new_assistant_message()
    text, parts = summary_parts(doc, priced, stats, lang=rc.state.get("lang"), sheets=sorted({s.sheet for s in specs}),
                                lead=(f"{decision} {card['payload']['file_name']}. Updated {len(specs)} row(s) in "
                                      f"{doc['name']} (version {doc['version']})."))
    publish_document(rc, message_id=str(msg["id"]), doc=doc, web=web)
    request_permissions(rc, priced, str(msg["id"]))
    rc.complete_message(str(msg["id"]), content=text, parts=parts)
