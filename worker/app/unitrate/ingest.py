"""Persist a unit-rate BOQ reference: file metadata (pricing model, market, client, package, date), the analysis shown
on the file page, one file_sheets row per sheet (with its layout), and price_items rows with install / supply rates,
rate basis, package, section notes, parsed attributes and the rate-card key. Prelims (weekly / item rates) and
contractor items (monthly / lump sum / delivery %) are price_items too, so the matcher reads one table."""
from __future__ import annotations

import logging
from typing import Callable

from .. import db
from ..matching.text import normalise_text
from .analysis import build_analysis
from .boq import BoqWorkbook
from .ratecard import card_label

log = logging.getLogger(__name__)


def _rows_for_items(wb: BoqWorkbook) -> list[dict]:
    out = []
    for sh in wb.pricing_sheets:
        for r in sh.rows:
            priced = r.install_rate is not None or r.supply_rate is not None or (r.attrs or {}).get("amount")
            if not priced:
                continue
            out.append({
                "sheet": r.sheet, "row": r.row, "section": r.section, "text": r.description,
                "unit": r.uom, "unit_norm": r.uom_norm, "qty": r.qty,
                "install_rate": r.install_rate, "supply_rate": r.supply_rate,
                "rate_basis": r.rate_basis or "install_only",
                "package": r.package if r.kind == "item" else "contractor_items",
                "notes": r.notes, "phase_qty": r.phase_qty,
                "attrs": {**(r.attrs or {}), **({"tag": r.tag} if r.tag else {}), "kind": r.kind,
                          **({"phase": r.phase} if r.phase else {}),
                          **({"input_hint": r.input_hint} if r.input_hint else {}),
                          **({"qty_formula": r.qty_formula} if r.qty_formula else {})},
                "cells": r.cells, "flags": r.flags,
                "rate_key": card_label(r) if r.kind == "item" else r.description.strip()[:80],
            })
    for p in wb.prelims:
        if p["rate"] is None:
            continue
        out.append({"sheet": p["sheet"], "row": p["row"], "section": "Preliminaries", "text": p["description"],
                    "unit": p["uom"], "unit_norm": p["uom"], "qty": p["qty"], "install_rate": p["rate"],
                    "supply_rate": None, "rate_basis": p["rate_basis"], "package": "prelims", "notes": [],
                    "phase_qty": {}, "attrs": {"kind": "prelim", "ref": p.get("ref")}, "cells": p["cells"],
                    "flags": [], "rate_key": p["description"].strip()[:80]})
    return out


def persist_unit_rate(file_id: str, wb: BoqWorkbook, *, file_name: str, work_path: str | None,
                      embed: Callable[[list[str]], list[list[float]] | None] | None = None) -> dict:
    analysis = build_analysis(wb, file_name=file_name)
    items = _rows_for_items(wb)
    vecs = None
    if embed and items:
        try:
            vecs = embed([i["text"] for i in items])
        except Exception:  # noqa: BLE001 - embeddings are optional; unit-rate matching is attribute-based
            log.warning("unit-rate embeddings failed for %s", file_id, exc_info=True)
            vecs = None
    priced_install = sum(1 for i in items if i["install_rate"] is not None and i["package"] not in ("prelims",
                                                                                                    "contractor_items"))
    priced_supply = sum(1 for i in items if i["supply_rate"] is not None)
    stats = {"pricing_model": "unit_rate", "items": len(items), "install_rates": priced_install,
             "supply_rates": priced_supply, "sheets": len(wb.sheets), "model_calls": 0,
             "embeddings": vecs is not None}
    summary = {"description": f"Unit-rate BOQ · {analysis.get('package_label') or 'package'} · "
                              f"{analysis.get('project') or ''}".strip(" ·"),
               "item_count": len(items), "norm_count": 0, "pricing_model": "unit_rate",
               "sheets": [s.name for s in wb.sheets], "currency": wb.currency,
               "per_sheet": {s.name: len([r for r in s.rows if r.kind == "item"]) for s in wb.pricing_sheets},
               "needs_confirmation": []}
    with db.conn() as c:
        status = c.execute("SELECT deleted_at FROM files WHERE id=%s FOR UPDATE", (file_id,)).fetchone()
        if not status or status["deleted_at"] is not None:
            c.rollback()
            return stats
        c.execute("DELETE FROM file_sections WHERE file_id=%s", (file_id,))
        c.execute("DELETE FROM file_sheets WHERE file_id=%s", (file_id,))
        c.execute("DELETE FROM price_items WHERE file_id=%s", (file_id,))
        c.execute("DELETE FROM norms WHERE file_id=%s", (file_id,))
        c.execute("DELETE FROM agent_notes WHERE file_id=%s AND source='model' AND NOT edited", (file_id,))
        c.execute("DELETE FROM file_logic WHERE file_id=%s AND override_sentence IS NULL AND override_numbers IS NULL",
                  (file_id,))
        for idx, sh in enumerate(wb.sheets):
            items_here = [r for r in sh.rows if r.kind == "item"]
            c.execute("""INSERT INTO file_sheets(file_id, idx, name, kind, is_electrical, row_count, col_count,
                             header_row, first_data_row, columns, currency, language, pricing_model, layout)
                         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'unit_rate',%s)""",
                      (file_id, idx, sh.name, {"pricing": "estimate", "prelims": "prices", "summary": "summary"}
                       .get(sh.kind, "other"), True if sh.kind == "pricing" else None, len(sh.rows), 0,
                       sh.header_row, (sh.header_row + 1) if sh.header_row else None,
                       db.jsonb([{"col": v, "meaning": k} for k, v in sh.cols.items()]), wb.currency, wb.language,
                       db.jsonb({"kind": sh.kind, "layout": sh.layout, "cols": sh.cols, "phases": sh.phases,
                                 "buildings": sh.buildings, "areas": sh.areas, "has_supply": sh.has_supply,
                                 "package": sh.package, "input_fill": sh.input_fill, "notes": sh.notes,
                                 "sections": sh.sections, "totals": sh.totals, "total_cells": sh.total_cells,
                                 "items": len(items_here)})))
        if items:
            from ..ingest.pipeline import _vec
            with c.cursor() as cur:
                cur.executemany(
                    """INSERT INTO price_items(file_id, sheet_name, row_idx, section_title, item_text, item_norm, unit,
                           unit_norm, qty, unit_labour, unit_material, currency, attrs, category, source_cells,
                           extracted_by, embedding, pricing_model, install_rate, supply_rate, rate_basis, package,
                           section_notes, phase_qty, rate_key, flags)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'code',%s::vector,'unit_rate',
                               %s,%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (file_id, sheet_name, row_idx) DO NOTHING""",
                    [(file_id, i["sheet"], i["row"], (i["section"] or "")[:500] or None, i["text"],
                      normalise_text(i["text"]), i["unit"], i["unit_norm"], i["qty"],
                      i["install_rate"], i["supply_rate"], wb.currency, db.jsonb(i["attrs"]),
                      i["attrs"].get("product") or i["package"], db.jsonb(i["cells"]),
                      _vec(vecs[n]) if vecs else None, i["install_rate"], i["supply_rate"], i["rate_basis"],
                      i["package"], db.jsonb(i["notes"]), db.jsonb(i["phase_qty"]), i["rate_key"],
                      db.jsonb(i["flags"])) for n, i in enumerate(items)])
        for n, text in enumerate(analysis.get("agent_notes", [])):
            c.execute("INSERT INTO agent_notes(file_id, ord, text, source) VALUES (%s,%s,%s,'model')",
                      (file_id, n, text))
        c.execute("""UPDATE files SET status='analysed', progress=100, fail_reason=NULL, language=%s, summary=%s,
                         stats=%s, analysed_at=now(), updated_at=now(), pricing_model='unit_rate',
                         market=COALESCE(market, %s), client=COALESCE(client, %s), end_client=%s, package=%s,
                         project=%s, doc_date=%s, analysis=%s, work_path=COALESCE(%s, work_path)
                     WHERE id=%s""",
                  (wb.language, db.jsonb(summary), db.jsonb(stats), wb.market, wb.client, wb.end_client, wb.package,
                   wb.project, wb.doc_date, db.jsonb(analysis), work_path, file_id))
        c.commit()
    return stats
