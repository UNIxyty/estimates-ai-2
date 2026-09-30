"""Produced estimates: workbook versions on disk + per-row provenance in estimate_rows."""
from __future__ import annotations

import os
from datetime import datetime, timezone

from .. import db
from ..config import settings
from ..matching.units import normalise_unit
from . import writer
from .pricing import PricedRow


def doc_dir(document_id: str) -> str:
    return os.path.join(settings.data_dir, "documents", str(document_id))


def priced_to_row(pr: PricedRow) -> dict:
    return {
        "sheet_name": pr.spec.sheet, "row_idx": pr.spec.row, "section_title": pr.spec.section,
        "item_text": pr.spec.text, "unit": pr.spec.unit, "unit_norm": pr.spec.unit_norm, "qty": pr.spec.qty,
        "norm_h_per_unit": pr.norm_h, "hourly_rate": pr.hourly_rate, "unit_labour": pr.unit_labour,
        "unit_material": pr.unit_material, "total_labour": pr.total_labour, "total_material": pr.total_material,
        "price_source": pr.source, "confidence": pr.confidence, "confidence_pct": pr.confidence_pct,
        "reason": pr.reason, "matched": pr.matched, "norm_ref": pr.norm_ref, "web": pr.web,
        "flags": list(dict.fromkeys(pr.flags)), "model_used": pr.model_used,
        "blocked_file": pr.blocked_file,
    }


def compute_totals(rows: list[dict]) -> dict:
    tl = sum(r["total_labour"] or 0 for r in rows)
    tm = sum(r["total_material"] or 0 for r in rows)
    flags = lambda f: sum(1 for r in rows if f in (r.get("flags") or []))  # noqa: E731
    return {"labour": round(tl, 2), "material": round(tm, 2), "total": round(tl + tm, 2), "rows": len(rows),
            "priced": sum(1 for r in rows if r["unit_labour"] is not None or r["unit_material"] is not None),
            "web": flags("WEB"), "check": flags("CHECK"), "no_price": flags("NO PRICE"), "edited": flags("EDITED"),
            "pending_permission": sum(1 for r in rows if r["price_source"] == "pending_permission")}


def _upsert_rows(c, document_id: str, rows: list[dict]) -> None:
    for r in rows:
        c.execute(
            """INSERT INTO estimate_rows(document_id, sheet_name, row_idx, section_title, item_text, unit, unit_norm,
                   qty, norm_h_per_unit, hourly_rate, unit_labour, unit_material, total_labour, total_material,
                   price_source, confidence, confidence_pct, reason, matched, norm_ref, web, flags, model_used)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (document_id, sheet_name, row_idx) DO UPDATE SET
                   section_title=EXCLUDED.section_title, item_text=EXCLUDED.item_text, unit=EXCLUDED.unit,
                   unit_norm=EXCLUDED.unit_norm, qty=EXCLUDED.qty, norm_h_per_unit=EXCLUDED.norm_h_per_unit,
                   hourly_rate=EXCLUDED.hourly_rate, unit_labour=EXCLUDED.unit_labour,
                   unit_material=EXCLUDED.unit_material, total_labour=EXCLUDED.total_labour,
                   total_material=EXCLUDED.total_material, price_source=EXCLUDED.price_source,
                   confidence=EXCLUDED.confidence, confidence_pct=EXCLUDED.confidence_pct, reason=EXCLUDED.reason,
                   matched=EXCLUDED.matched, norm_ref=EXCLUDED.norm_ref, web=EXCLUDED.web, flags=EXCLUDED.flags,
                   model_used=EXCLUDED.model_used, updated_at=now()
               WHERE estimate_rows.price_source <> 'edited'""",
            (document_id, r["sheet_name"], r["row_idx"], r["section_title"], r["item_text"], r["unit"],
             r["unit_norm"], r["qty"], r["norm_h_per_unit"], r["hourly_rate"], r["unit_labour"], r["unit_material"],
             r["total_labour"], r["total_material"], r["price_source"], r["confidence"], r["confidence_pct"],
             r["reason"], db.jsonb(r["matched"]), db.jsonb(r["norm_ref"]), db.jsonb(r["web"]), r["flags"],
             r.get("model_used", False)))


def _record_usage_links(c, *, run: dict, document_id: str, rows: list[dict]) -> None:
    per_file: dict[str, int] = {}
    for r in rows:
        for m in (r.get("matched") or [])[:1]:
            per_file[m["file_id"]] = per_file.get(m["file_id"], 0) + 1
        if r.get("norm_ref"):
            fid = r["norm_ref"]["file_id"]
            per_file[fid] = per_file.get(fid, 0) + 1
    for fid, n in per_file.items():
        c.execute("""INSERT INTO file_usage(file_id, conversation_id, run_id, document_id, rows_used)
                     VALUES (%s,%s,%s,%s,%s)
                     ON CONFLICT (file_id, run_id) DO UPDATE SET rows_used=EXCLUDED.rows_used,
                                                                 document_id=EXCLUDED.document_id""",
                  (fid, run["conversation_id"], run["id"], document_id, n))


def _record_web(c, *, run: dict, document_id: str, rows: list[dict]) -> list[dict]:
    c.execute("DELETE FROM web_prices WHERE document_id=%s", (document_id,))
    out = []
    for r in rows:
        w = r.get("web")
        if not w:
            continue
        qty = r["qty"]
        total = round(float(qty) * float(w["unit_price"]), 2) if qty is not None else None
        c.execute("""INSERT INTO web_prices(run_id, document_id, sheet_name, row_idx, query, product, unit_price,
                         currency, url, fetched_at, qty, total)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                  (run["id"], document_id, r["sheet_name"], r["row_idx"], r["item_text"], w.get("product"),
                   w["unit_price"], w.get("currency", "EUR"), w.get("url"),
                   w.get("fetched_at") or datetime.now(timezone.utc).isoformat(), qty, total))
        out.append({"product": w.get("product"), "unit_price": w["unit_price"], "currency": w.get("currency", "EUR"),
                    "qty": qty, "total": total, "url": w.get("url"), "sheet": r["sheet_name"], "row": r["row_idx"]})
    return out


def save_document(*, run: dict, name: str, mode: str, src_path: str, layouts: dict[str, writer.SheetLayout],
                  rows: list[dict], language: str | None, currency: str = "EUR", source_upload_id: str | None = None,
                  template_file_id: str | None = None, document_id: str | None = None) -> tuple[dict, list[dict],
                                                                                              writer.WriteReport]:
    """Create (or bump the version of) a document: write the workbook, upsert provenance rows."""
    with db.conn() as c:
        if document_id:
            doc = c.execute("SELECT * FROM documents WHERE id=%s FOR UPDATE", (document_id,)).fetchone()
            version = doc["version"] + 1
        else:
            doc = c.execute(
                """INSERT INTO documents(run_id, conversation_id, user_id, name, stored_path, source_upload_id,
                                         template_file_id, mode, language, currency, layout)
                   VALUES (%s,%s,%s,%s,'',%s,%s,%s,%s,%s,%s) RETURNING *""",
                (run["id"], run["conversation_id"], run["user_id"], name, source_upload_id, template_file_id, mode,
                 language, currency, db.jsonb({k: v.as_dict() for k, v in layouts.items()}))).fetchone()
            version = 1
        document_id = str(doc["id"])
        dst = os.path.join(doc_dir(document_id), f"v{version}.xlsx")
        base = doc["stored_path"] if doc["stored_path"] else src_path
        rep = writer.write_rows(base, dst, layouts, rows, language, overwrite_own=bool(doc["stored_path"]))
        _upsert_rows(c, document_id, rows)
        all_rows = c.execute("SELECT * FROM estimate_rows WHERE document_id=%s", (document_id,)).fetchall()
        totals = compute_totals(all_rows)
        doc = c.execute("""UPDATE documents SET stored_path=%s, version=%s, totals=%s, updated_at=now()
                           WHERE id=%s RETURNING *""", (dst, version, db.jsonb(totals), document_id)).fetchone()
        _record_usage_links(c, run=run, document_id=document_id, rows=rows)
        web = _record_web(c, run=run, document_id=document_id, rows=all_rows)
        c.commit()
    return doc, web, rep


def document_json(doc: dict) -> dict:
    return {"id": str(doc["id"]), "name": doc["name"], "mode": doc["mode"], "language": doc["language"],
            "currency": doc["currency"], "totals": doc["totals"], "version": doc["version"],
            "conversation_id": str(doc["conversation_id"]), "run_id": str(doc["run_id"]) if doc["run_id"] else None,
            "updated_at": doc["updated_at"].isoformat() if doc.get("updated_at") else None}


def update_row(document_id: str, sheet: str, row_idx: int, changes: dict, user_id: str) -> dict:
    """Viewer inspector edit: recalculate the row, mark it EDITED, write a new workbook version.
    Later Q&A reads the edited values from estimate_rows."""
    allowed = {"qty", "unit_labour", "unit_material", "norm_h_per_unit", "hourly_rate", "unit"}
    changes = {k: v for k, v in changes.items() if k in allowed}
    if not changes:
        raise ValueError("nothing to change")
    with db.conn() as c:
        doc = c.execute("SELECT * FROM documents WHERE id=%s FOR UPDATE", (document_id,)).fetchone()
        row = c.execute("SELECT * FROM estimate_rows WHERE document_id=%s AND sheet_name=%s AND row_idx=%s",
                        (document_id, sheet, row_idx)).fetchone()
        if not doc or not row:
            raise LookupError("row not found")
        original = row["original"] or {k: (float(row[k]) if row[k] is not None and k != "unit" else row[k])
                                       for k in allowed}
        new = {k: (float(row[k]) if row[k] is not None and k != "unit" else row[k]) for k in allowed}
        for k, v in changes.items():
            new[k] = v if k == "unit" or v is None else float(v)
        if "norm_h_per_unit" in changes or "hourly_rate" in changes:
            if new["norm_h_per_unit"] is not None and new["hourly_rate"] is not None and "unit_labour" not in changes:
                new["unit_labour"] = round(new["norm_h_per_unit"] * new["hourly_rate"], 4)
        qty = new["qty"]
        tl = None if new["unit_labour"] is None or qty is None else round(qty * new["unit_labour"], 2)
        tm = None if new["unit_material"] is None or qty is None else round(qty * new["unit_material"], 2)
        flags = [f for f in (row["flags"] or []) if f not in ("NO PRICE", "CHECK")]
        if "EDITED" not in flags:
            flags.append("EDITED")
        c.execute("""UPDATE estimate_rows SET qty=%s, unit=%s, unit_norm=%s, norm_h_per_unit=%s, hourly_rate=%s,
                         unit_labour=%s, unit_material=%s, total_labour=%s, total_material=%s, flags=%s,
                         original=%s, edited_by=%s, edited_at=now(), price_source='edited', updated_at=now(),
                         reason = reason || ' (edited by user)'
                     WHERE id=%s""",
                  (qty, new["unit"], normalise_unit(new["unit"]), new["norm_h_per_unit"], new["hourly_rate"],
                   new["unit_labour"], new["unit_material"], tl, tm, flags, db.jsonb(original), user_id, row["id"]))
        c.commit()
    layouts = {k: writer.SheetLayout(v["name"], v["cols"]) for k, v in (doc["layout"] or {}).items()}
    out_row = {"sheet_name": sheet, "row_idx": row_idx, "qty": qty, "norm_h_per_unit": new["norm_h_per_unit"],
               "hourly_rate": new["hourly_rate"], "unit_labour": new["unit_labour"],
               "unit_material": new["unit_material"], "price_source": "edited", "matched": row["matched"],
               "norm_ref": row["norm_ref"], "web": row["web"]}
    version = doc["version"] + 1
    dst = os.path.join(doc_dir(document_id), f"v{version}.xlsx")
    writer.write_rows(doc["stored_path"], dst, layouts, [out_row], doc["language"], overwrite_own=True)
    with db.conn() as c:
        all_rows = c.execute("SELECT * FROM estimate_rows WHERE document_id=%s", (document_id,)).fetchall()
        doc = c.execute("""UPDATE documents SET stored_path=%s, version=%s, totals=%s, updated_at=now()
                           WHERE id=%s RETURNING *""",
                        (dst, version, db.jsonb(compute_totals(all_rows)), document_id)).fetchone()
        updated = c.execute("SELECT * FROM estimate_rows WHERE document_id=%s AND sheet_name=%s AND row_idx=%s",
                            (document_id, sheet, row_idx)).fetchone()
        c.commit()
    return {"document": document_json(doc), "row": updated}
