"""`ingest_file` job: read -> analyse -> extract -> embed -> notes -> persist (one transaction).

Status flow on `files`: reading -> analysing (progress 0..100) -> analysed | failed (fail_reason).
User overrides survive re-analysis: file_logic override_* (by logic_key), price_items.override and
norms.override (by sheet_name,row_idx; re-applied onto the new row), agent_notes with source='user' or edited.
"""
from __future__ import annotations

import json
import logging
import os
import time
from collections import Counter
from typing import Any, Callable

from .. import db, jobs
from ..config import settings
from ..matching.text import normalise_text
from ..matching.units import normalise_unit
from .extract import NormRecord, PriceRecord, extract_norms, extract_prices
from .logic import LogicRecord, derive_logic
from .readers import IngestError, read_any
from .structure import WorkbookStructure, analyse_workbook

log = logging.getLogger(__name__)

EMBED_BATCH = 256
PRICE_OVERRIDE_COLUMNS = {
    "item_text": "text", "unit": "text", "section_title": "text", "category": "text",
    "qty": "num", "norm_h_per_unit": "num", "unit_labour": "num", "unit_material": "num",
    "total_labour": "num", "total_material": "num", "hourly_rate": "num", "currency": "text",
}
NORM_OVERRIDE_COLUMNS = {"item_text": "text", "unit": "text", "category": "text", "hours": "num",
                         "specificity": "text"}
_TAG_LABEL = {"reference_estimate": "Reference estimate", "hourly_norms": "Hourly norms",
              "price_list": "Price list", "other": "File"}


# ------------------------------------------------------------------ indirection (monkeypatched in tests)

def _llm_client():
    """The LLM client module, or None when it can't be imported."""
    try:
        from ..llm import client as llm
        return llm
    except Exception:  # noqa: BLE001
        return None


def _embed_texts() -> Callable[..., list[list[float]] | None] | None:
    try:
        from ..llm.embeddings import embed_texts
        return embed_texts
    except Exception:  # noqa: BLE001
        return None


# ------------------------------------------------------------------ status helpers

def _abs(path: str | None) -> str | None:
    if not path:
        return path
    return path if os.path.isabs(path) else os.path.join(settings.data_dir, path)


def _rel_like(stored: str, work_abs: str) -> str:
    """Store work_path in the same style (absolute or data_dir-relative) as stored_path."""
    if os.path.isabs(stored):
        return work_abs
    try:
        return os.path.relpath(work_abs, settings.data_dir)
    except ValueError:
        return work_abs


class _Progress:
    def __init__(self, file_id: str):
        self.file_id = file_id
        self.last = -10

    def __call__(self, pct: float, *, force: bool = False) -> None:
        p = max(0, min(99, int(pct)))
        if force or p >= self.last + 5:
            self.last = p
            db.execute("UPDATE files SET progress=%s, updated_at=now() WHERE id=%s AND deleted_at IS NULL",
                       (p, self.file_id))


def _set_status(file_id: str, status: str, progress: int, *, fail_reason: str | None = None) -> None:
    db.execute("""UPDATE files SET status=%s, progress=%s, fail_reason=%s, updated_at=now()
                  WHERE id=%s""", (status, progress, fail_reason, file_id))


def _fail(file_id: str, reason: str, stats: dict | None = None) -> None:
    db.execute("""UPDATE files SET status='failed', progress=0, fail_reason=%s, stats=COALESCE(%s, stats),
                  updated_at=now() WHERE id=%s""",
               (reason[:1000], db.jsonb(stats) if stats is not None else None, file_id))


# ------------------------------------------------------------------ job

@jobs.handler("ingest_file")
def ingest_file(payload: dict) -> dict | None:
    file_id = str(payload["file_id"])
    f = db.fetchone("SELECT * FROM files WHERE id=%s", (file_id,))
    if not f or f.get("deleted_at") is not None:
        log.info("ingest_file: file %s missing or deleted", file_id)
        return None
    t0 = time.monotonic()
    user_id = str(f["uploaded_by"]) if f.get("uploaded_by") else None
    tag = f.get("tag") or "other"
    _set_status(file_id, "reading", 2)
    progress = _Progress(file_id)
    try:
        path = _abs(f["stored_path"])
        doc = read_any(path, ext=f["ext"], work_dir=os.path.dirname(path))
        work_path = None
        if doc.work_path:
            work_path = _rel_like(f["stored_path"], doc.work_path)
            db.execute("UPDATE files SET work_path=%s, updated_at=now() WHERE id=%s", (work_path, file_id))
        _set_status(file_id, "analysing", 15)
        progress.last = 15
        # Unit-rate BOQs (EU subcontract BOQs: Quantity × Rate, no hours) take their own reader; tāmes are unchanged.
        if f["ext"] in ("xlsx", "xls"):
            from ..unitrate.boq import is_unit_rate_workbook, read_boq
            book = doc.work_path or path
            if is_unit_rate_workbook(book):
                from ..unitrate.ingest import persist_unit_rate
                embed_fn = _embed_texts()
                stats = persist_unit_rate(
                    file_id, read_boq(book, file_name=f["original_name"]), file_name=f["original_name"],
                    work_path=work_path,
                    embed=(lambda texts: embed_fn(texts, file_id=file_id, user_id=user_id)) if embed_fn else None)
                stats["seconds"] = round(time.monotonic() - t0, 2)
                db.execute("UPDATE files SET stats = stats || %s WHERE id=%s", (db.jsonb(stats), file_id))
                log.info("ingest_file %s (unit rate): %s", file_id, json.dumps(stats))
                return stats
        llm_fn = _structure_llm(file_id, user_id)
        ws = analyse_workbook(document=doc, llm=llm_fn, tag=tag, progress=lambda p: progress(15 + p * 0.35))
        prices = extract_prices(ws, tag=tag)
        norms = extract_norms(ws, tag=tag)
        logic = derive_logic(ws)
        progress(55)
        price_vecs, norm_vecs = _embed(prices, norms, file_id=file_id, user_id=user_id,
                                       progress=lambda p: progress(55 + p * 0.3))
        progress(85)
        description, notes, model_logic, notes_by_model = _notes(ws, prices, norms, logic, tag=tag, file_id=file_id,
                                                                 user_id=user_id, file_name=f["original_name"])
        logic.extend(model_logic)
        progress(92)
        rows_parsed = sum(len([r for r in s.rows if r.kind != "blank"]) for s in ws.sheets)
        stats = {
            "rows_parsed": rows_parsed,
            "items": len(prices),
            "norms": len(norms),
            "model_calls": ws.model_calls + (1 if notes_by_model else 0),
            "model_cells": ws.model_cells,
            "model_rows": ws.model_rows,
            "embeddings": price_vecs is not None or norm_vecs is not None,
            "seconds": None,
        }
        summary = _summary(ws, prices, norms, description, tag)
        stats["seconds"] = round(time.monotonic() - t0, 2)
        orphaned = _persist(file_id, ws, prices, norms, logic, notes, price_vecs, norm_vecs, stats, summary,
                            work_path=work_path)
        if orphaned:
            stats["overrides_orphaned"] = orphaned
        log.info("ingest_file %s: %s", file_id, json.dumps(stats))
        return stats
    except IngestError as e:
        log.info("ingest_file %s failed: %s", file_id, e.reason)
        _fail(file_id, e.reason, {"seconds": round(time.monotonic() - t0, 2)})
        return None
    except Exception as e:  # noqa: BLE001
        log.exception("ingest_file %s crashed", file_id)
        _fail(file_id, f"Internal error while analysing the file ({type(e).__name__}). Try Re-analyse; "
                       f"if it keeps failing, contact the administrator.")
        raise


@jobs.handler("ingest_file:failed")
def ingest_file_failed(payload: dict) -> None:
    fid = payload.get("file_id")
    if fid:
        db.execute("""UPDATE files SET status='failed', updated_at=now(),
                      fail_reason=COALESCE(fail_reason, 'Analysis failed after several attempts.')
                      WHERE id=%s AND status <> 'analysed'""", (str(fid),))


# ------------------------------------------------------------------ model helpers

_STRUCT_SYSTEM = ("You help parse electrical installation estimates (Latvian 'tāme', Danish 'tilbud', English BoQ). "
                  "Decide spreadsheet column meanings from headers and sample values. Be conservative: use "
                  "'unknown' when unsure.")


def _structure_llm(file_id: str, user_id: str | None):
    llm = _llm_client()
    if llm is None:
        return None
    try:
        if not llm.available():
            return None
    except Exception:  # noqa: BLE001
        return None

    def call(prompt: str, schema: dict) -> dict:
        return llm.complete_json(task="file_analysis", system=_STRUCT_SYSTEM, prompt=prompt, schema=schema,
                                 file_id=file_id, user_id=user_id)
    return call


def _embed(prices: list[PriceRecord], norms: list[NormRecord], *, file_id: str, user_id: str | None,
           progress: Callable[[float], None]) -> tuple[list | None, list | None]:
    fn = _embed_texts()
    if fn is None or (not prices and not norms):
        return None, None
    texts = [p.item_text for p in prices] + [n.item_text for n in norms]
    vecs: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        try:
            part = fn(texts[i:i + EMBED_BATCH], file_id=file_id, user_id=user_id)
        except Exception:  # noqa: BLE001 - embeddings are optional; pricing works without them
            log.warning("embedding failed for file %s; continuing without", file_id, exc_info=True)
            return None, None
        if part is None or len(part) != len(texts[i:i + EMBED_BATCH]):
            return None, None
        vecs.extend(part)
        progress(100 * min(len(texts), i + EMBED_BATCH) / len(texts))
    return vecs[:len(prices)], vecs[len(prices):]


_NOTES_SCHEMA = {
    "type": "object",
    "properties": {
        "description": {"type": "string", "description": "One-sentence description of the file."},
        "notes": {"type": "array", "items": {"type": "string"}, "maxItems": 8,
                  "description": "Short, useful notes for an estimator reusing this file."},
        "logic": {"type": "array", "maxItems": 12, "items": {"type": "object", "properties": {
            "sheet_name": {"type": "string"}, "sentence": {"type": "string"}}, "required": ["sentence"]}},
    },
    "required": ["description", "notes"],
}
_NOTES_SYSTEM = ("You are an electrical estimating assistant. Given the deterministic analysis of a knowledge "
                 "file (columns, hourly rates, sections, markups, calculation logic, sample rows), write a short "
                 "description, up to 8 practical notes (what the file is good for, pricing habits, caveats), and "
                 "optionally one plain-language pricing-logic summary per sheet. Never invent numbers that are not "
                 "in the analysis. Write in English.")


def _deterministic_notes(ws: WorkbookStructure, prices: list[PriceRecord], norms: list[NormRecord],
                         logic: list[LogicRecord], tag: str) -> tuple[str, list[str]]:
    label = _TAG_LABEL.get(tag, "File")
    rates = sorted({round(r["rate"], 2) for s in ws.sheets for r in s.hourly_rates})
    cur = ws.currency or ""
    parts = [label, ws.language, f"{len(ws.sheets)} sheet{'s' if len(ws.sheets) != 1 else ''}"]
    if prices:
        parts.append(f"{len(prices)} priced rows")
    if norms:
        parts.append(f"{len(norms)} norms")
    if rates:
        parts.append("hourly rate " + " / ".join(f"{r:g}" for r in rates) + f" {cur}/h")
    description = ", ".join(p for p in parts if p)
    notes: list[str] = [description]
    for s in ws.sheets:
        if s.kind in ("estimate", "prices"):
            n_items = sum(1 for p in prices if p.sheet_name == s.name)
            bits = [f"Sheet '{s.name}': {s.kind}, {n_items} priced rows"]
            if s.sections:
                bits.append(f"{len(s.sections)} sections")
            sr = sorted({round(r['rate'], 2) for r in s.hourly_rates})
            if sr:
                bits.append("hourly rate " + " / ".join(f"{r:g}" for r in sr) + f" {s.currency or cur}/h")
            pos = [c.letter for c in s.columns if c.source == "position" and c.meaning != "unknown"]
            if pos:
                bits.append(f"columns {', '.join(pos)} had no header and were identified from their position "
                            f"and the row totals")
            notes.append("; ".join(bits) + ".")
            if s.markups:
                mk = []
                for m in s.markups:
                    if m.get("pct") is not None:
                        mk.append(f"{m['name'].split('%')[0].strip()} {m['pct'] * 100:g}%"
                                  if "%" not in (m["name"] or "") else m["name"])
                    else:
                        mk.append(m["name"])
                notes.append(f"Markups on '{s.name}': " + ", ".join(mk) + ".")
        if s.kind in ("estimate", "prices") and s.is_electrical is not True:
            if s.is_electrical is False:
                notes.append(f"Sheet '{s.name}' does not look like electrical work "
                             f"(confidence {s.electrical_confidence:.2f}); its rows were not used for pricing.")
            else:
                notes.append(f"Unsure whether sheet '{s.name}' is electrical work "
                             f"(confidence {s.electrical_confidence:.2f}); please confirm.")
    if norms:
        c = Counter(n.specificity for n in norms)
        notes.append(f"Hourly norms: {len(norms)} ({c.get('parameterised', 0)} parameterised, {c.get('item', 0)} "
                     f"per item, {c.get('category', 0)} per category).")
    combined = sum(1 for p in prices if p.attrs.get("combined_price"))
    if combined:
        notes.append(f"{combined} rows only give a combined unit price (labour + material together); it is stored "
                     f"as the material price.")
    if not prices and not norms:
        notes.append("No priced rows or norms were found in this file.")
    return description, notes[:10]


def _notes(ws: WorkbookStructure, prices: list[PriceRecord], norms: list[NormRecord], logic: list[LogicRecord], *,
           tag: str, file_id: str, user_id: str | None, file_name: str
           ) -> tuple[str, list[str], list[LogicRecord], bool]:
    description, notes = _deterministic_notes(ws, prices, norms, logic, tag)
    llm = _llm_client()
    if llm is None:
        return description, notes, [], False
    try:
        if not llm.available():
            return description, notes, [], False
    except Exception:  # noqa: BLE001
        return description, notes, [], False
    brief = {
        "file_name": file_name, "tag": tag, "language": ws.language, "currency": ws.currency,
        "sheets": [{
            "name": s.name, "kind": s.kind, "is_electrical": s.is_electrical,
            "columns": [f"{c.letter}: {c.header or '(no header)'} -> {c.meaning} ({c.source})" for c in s.columns],
            "hourly_rates": [{"rate": r["rate"], "rows": r["rows"], "source": r["source"]} for r in s.hourly_rates],
            "sections": [x.title for x in s.sections][:30],
            "markups": [{k: m.get(k) for k in ("name", "pct", "value")} for m in s.markups],
        } for s in ws.sheets],
        "logic": [lr.sentence for lr in logic][:40],
        "sample_items": [{"sheet": p.sheet_name, "item": p.item_text, "unit": p.unit, "norm_h": p.norm_h_per_unit,
                          "labour": p.unit_labour, "material": p.unit_material} for p in prices[:30]],
        "sample_norms": [{"item": n.item_text, "unit": n.unit, "hours": n.hours, "specificity": n.specificity}
                         for n in norms[:30]],
        "deterministic_notes": notes,
    }
    try:
        res = llm.complete_json(task="file_analysis", system=_NOTES_SYSTEM,
                                prompt="Analysis:\n" + json.dumps(brief, ensure_ascii=False, default=str)[:60000],
                                schema=_NOTES_SCHEMA, file_id=file_id, user_id=user_id)
    except Exception as e:  # noqa: BLE001 - LLMUnavailable or any model trouble -> deterministic notes
        if type(e).__name__ != "LLMUnavailable":
            log.warning("notes model call failed for %s", file_id, exc_info=True)
        return description, notes, [], False
    if not isinstance(res, dict):
        return description, notes, [], False
    m_notes = [str(n).strip() for n in (res.get("notes") or []) if str(n).strip()][:8]
    m_desc = str(res.get("description") or "").strip() or description
    m_logic: list[LogicRecord] = []
    sheet_names = {s.name for s in ws.sheets}
    seen: set[str] = set()
    for i, item in enumerate(res.get("logic") or []):
        if not isinstance(item, dict) or not str(item.get("sentence") or "").strip():
            continue
        sheet = item.get("sheet_name") if item.get("sheet_name") in sheet_names else None
        key = f"sheet:{sheet}:summary" if sheet else f"file:summary:{i}"
        if key in seen:
            continue
        seen.add(key)
        m_logic.append(LogicRecord(sheet, None, 1000 + i, "other", key, str(item["sentence"]).strip()[:1000], {},
                                   source="model"))
    return m_desc, (m_notes or notes), m_logic, True


def _summary(ws: WorkbookStructure, prices: list[PriceRecord], norms: list[NormRecord], description: str,
             tag: str) -> dict[str, Any]:
    per_sheet = Counter(p.sheet_name for p in prices)
    per_sheet_n = Counter(n.sheet_name for n in norms)
    return {
        "description": description,
        "sheets": [{"name": s.name, "kind": s.kind, "rows": s.row_count,
                    "items": per_sheet.get(s.name, 0) + per_sheet_n.get(s.name, 0),
                    "is_electrical": s.is_electrical, "electrical_confidence": s.electrical_confidence,
                    "hourly_rates": sorted({round(r["rate"], 4) for r in s.hourly_rates}),
                    "sections": len(s.sections)} for s in ws.sheets],
        "currency": ws.currency,
        "language": ws.language,
        "item_count": len(prices),
        "norm_count": len(norms),
        "sections": sum(len(s.sections) for s in ws.sheets),
        "hourly_rates": sorted({round(r["rate"], 4) for s in ws.sheets for r in s.hourly_rates}),
        "needs_confirmation": [s.name for s in ws.sheets if s.kind in ("estimate", "prices")
                               and s.is_electrical is None],
    }


# ------------------------------------------------------------------ persistence

def _vec(v: list[float] | None) -> str | None:
    if v is None:
        return None
    return "[" + ",".join(repr(float(x)) for x in v) + "]"


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _override_sets(ov: dict, allowed: dict[str, str]) -> tuple[list[str], list[Any]]:
    sets, vals = [], []
    for k, v in ov.items():
        typ = allowed.get(k)
        if typ is None:
            continue
        if typ == "num":
            if v is not None and _num(v) is None:
                continue
            vals.append(_num(v))
        else:
            vals.append(None if v is None else str(v))
        sets.append(f"{k}=%s")
        if k == "item_text" and v:
            sets.append("item_norm=%s")
            vals.append(normalise_text(str(v)))
        if k == "unit":
            sets.append("unit_norm=%s")
            vals.append(normalise_unit(v) if v else None)
    return sets, vals


def _persist(file_id: str, ws: WorkbookStructure, prices: list[PriceRecord], norms: list[NormRecord],
             logic: list[LogicRecord], notes: list[str], price_vecs: list | None, norm_vecs: list | None,
             stats: dict, summary: dict, *, work_path: str | None) -> int:
    orphaned = 0
    with db.conn() as c:
        try:
            status = c.execute("SELECT deleted_at FROM files WHERE id=%s FOR UPDATE", (file_id,)).fetchone()
            if not status or status["deleted_at"] is not None:
                c.rollback()
                return 0
            price_ov = c.execute("""SELECT sheet_name, row_idx, override, overridden_by, overridden_at
                                    FROM price_items WHERE file_id=%s AND override IS NOT NULL""",
                                 (file_id,)).fetchall()
            norm_ov = c.execute("""SELECT sheet_name, row_idx, item_norm, override, overridden_by, overridden_at
                                   FROM norms WHERE file_id=%s AND override IS NOT NULL""", (file_id,)).fetchall()
            c.execute("DELETE FROM file_sections WHERE file_id=%s", (file_id,))
            c.execute("DELETE FROM file_sheets WHERE file_id=%s", (file_id,))
            c.execute("DELETE FROM price_items WHERE file_id=%s", (file_id,))
            c.execute("DELETE FROM norms WHERE file_id=%s", (file_id,))
            c.execute("DELETE FROM agent_notes WHERE file_id=%s AND source='model' AND NOT edited", (file_id,))
            c.execute("""DELETE FROM file_logic WHERE file_id=%s AND override_sentence IS NULL
                         AND override_numbers IS NULL""", (file_id,))

            doc = ws.document
            for s in ws.sheets:
                sd = doc.sheet(s.name) if doc is not None else None
                rates = [{**r, "currency": r.get("currency") or s.currency or ws.currency} for r in s.hourly_rates]
                row = c.execute(
                    """INSERT INTO file_sheets(file_id, idx, name, kind, is_electrical, row_count, col_count,
                           header_row, first_data_row, columns, unit_block, total_block, hourly_rates, currency,
                           language)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                    (file_id, s.idx, s.name, s.kind, s.is_electrical, sd.n_rows if sd else s.row_count,
                     sd.n_cols if sd else s.col_count, s.header_row, s.first_data_row,
                     db.jsonb([{"col": col.letter, "idx": col.idx, "header": col.header, "meaning": col.meaning,
                                "source": col.source, "confidence": col.confidence} for col in s.columns]),
                     db.jsonb(s.unit_block or None) if s.unit_block else None,
                     db.jsonb(s.total_block) if s.total_block else None,
                     db.jsonb(rates), s.currency or ws.currency, s.language)).fetchone()
                sheet_id = row["id"]
                if s.sections:
                    with c.cursor() as cur:
                        cur.executemany(
                            """INSERT INTO file_sections(file_id, sheet_id, ord, title, row_start, row_end,
                                   subtotal_row, hourly_rate, kind) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'section')""",
                            [(file_id, sheet_id, i, sec.title[:500], sec.row_start, sec.row_end, sec.subtotal_row,
                              sec.hourly_rate) for i, sec in enumerate(s.sections)])

            if prices:
                with c.cursor() as cur:
                    cur.executemany(
                        """INSERT INTO price_items(file_id, sheet_name, row_idx, section_title, item_text, item_norm,
                               unit, unit_norm, qty, norm_h_per_unit, unit_labour, unit_material, total_labour,
                               total_material, hourly_rate, currency, attrs, category, source_cells, extracted_by,
                               embedding)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::vector)
                           ON CONFLICT (file_id, sheet_name, row_idx) DO NOTHING""",
                        [(file_id, p.sheet_name, p.row_idx, p.section_title, p.item_text, p.item_norm, p.unit,
                          p.unit_norm, p.qty, p.norm_h_per_unit, p.unit_labour, p.unit_material, p.total_labour,
                          p.total_material, p.hourly_rate, p.currency or "EUR",
                          db.jsonb({**p.attrs, **({"derived": p.derived} if p.derived else {}),
                                    **({"unit_total": p.unit_total} if p.unit_total is not None else {}),
                                    **({"unit_mechanisms": p.unit_mechanisms} if p.unit_mechanisms else {})}),
                          p.category, db.jsonb(p.source_cells), p.extracted_by,
                          _vec(price_vecs[i]) if price_vecs else None)
                         for i, p in enumerate(prices)])
            live_prices = {(p.sheet_name, p.row_idx) for p in prices}
            for o in price_ov:
                if (o["sheet_name"], o["row_idx"]) not in live_prices:
                    orphaned += 1
                    continue
                ov = o["override"] if isinstance(o["override"], dict) else {}
                sets, vals = _override_sets(ov, PRICE_OVERRIDE_COLUMNS)
                sets = ["override=%s", "overridden_by=%s", "overridden_at=%s"] + sets
                vals = [db.jsonb(o["override"]), o["overridden_by"], o["overridden_at"]] + vals
                c.execute(f"UPDATE price_items SET {', '.join(sets)} WHERE file_id=%s AND sheet_name=%s "
                          f"AND row_idx=%s", (*vals, file_id, o["sheet_name"], o["row_idx"]))

            if norms:
                with c.cursor() as cur:
                    cur.executemany(
                        """INSERT INTO norms(file_id, sheet_name, row_idx, category, item_text, item_norm, unit,
                               unit_norm, hours, specificity, params, attrs, extracted_by, embedding)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::vector)""",
                        [(file_id, n.sheet_name, n.row_idx, n.category, n.item_text, n.item_norm, n.unit,
                          n.unit_norm, n.hours, n.specificity, db.jsonb(n.params), db.jsonb(n.attrs),
                          n.extracted_by, _vec(norm_vecs[i]) if norm_vecs else None)
                         for i, n in enumerate(norms)])
            live_norms = {(n.sheet_name, n.row_idx) for n in norms}
            for o in norm_ov:
                if (o["sheet_name"], o["row_idx"]) not in live_norms:
                    orphaned += 1
                    continue
                ov = o["override"] if isinstance(o["override"], dict) else {}
                sets, vals = _override_sets(ov, NORM_OVERRIDE_COLUMNS)
                if "hours=%s" in sets and vals[sets.index("hours=%s")] is None:
                    i = sets.index("hours=%s")
                    del sets[i], vals[i]
                sets = ["override=%s", "overridden_by=%s", "overridden_at=%s"] + sets
                vals = [db.jsonb(o["override"]), o["overridden_by"], o["overridden_at"]] + vals
                c.execute(f"UPDATE norms SET {', '.join(sets)} WHERE file_id=%s AND sheet_name IS NOT DISTINCT FROM "
                          f"%s AND row_idx IS NOT DISTINCT FROM %s",
                          (*vals, file_id, o["sheet_name"], o["row_idx"]))

            if logic:
                with c.cursor() as cur:
                    cur.executemany(
                        """INSERT INTO file_logic(file_id, sheet_name, section_title, ord, kind, logic_key, sentence,
                               numbers, source)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (file_id, logic_key) DO UPDATE SET
                               sheet_name=EXCLUDED.sheet_name, section_title=EXCLUDED.section_title,
                               ord=EXCLUDED.ord, kind=EXCLUDED.kind, sentence=EXCLUDED.sentence,
                               numbers=EXCLUDED.numbers, source=EXCLUDED.source""",
                        [(file_id, lr.sheet_name, lr.section_title, lr.ord, lr.kind, lr.logic_key[:300],
                          lr.sentence[:2000], db.jsonb(lr.numbers), lr.source) for lr in _dedupe_logic(logic)])

            if notes:
                with c.cursor() as cur:
                    cur.executemany("INSERT INTO agent_notes(file_id, ord, text, source) VALUES (%s,%s,%s,'model')",
                                    [(file_id, i, t[:2000]) for i, t in enumerate(notes)])

            stats = {**stats, **({"overrides_orphaned": orphaned} if orphaned else {})}
            c.execute("""UPDATE files SET status='analysed', progress=100, fail_reason=NULL, language=%s,
                             summary=%s, stats=%s, analysed_at=now(), updated_at=now(),
                             work_path=COALESCE(%s, work_path)
                         WHERE id=%s""",
                      (ws.language, db.jsonb(summary), db.jsonb(stats), work_path, file_id))
            c.commit()
        except Exception:
            c.rollback()
            raise
    return orphaned


def _dedupe_logic(logic: list[LogicRecord]) -> list[LogicRecord]:
    seen: dict[str, LogicRecord] = {}
    for lr in logic:
        seen.setdefault(lr.logic_key[:300], lr)
    return list(seen.values())
