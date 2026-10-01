"""Write priced values into a copy of a workbook, editing only value cells.

Never overwritten: formulas, cells inside merged ranges (except their anchor), text already present,
styles, number formats, merged ranges, column widths. Only `.value` of empty numeric cells is set, so
formatting stays exactly as the template had it. Excel recalculates formulas on open
(fullCalcOnLoad) so formula totals reflect the new values.
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from typing import Any

import openpyxl
from openpyxl.utils import column_index_from_string

UNIT_MEANINGS = ("norm_h", "hourly_rate", "unit_labour", "unit_material", "unit_total")
TOTAL_MEANINGS = ("total_norm_h", "total_labour", "total_material", "total")
PRICE_MEANINGS = set(UNIT_MEANINGS) | set(TOTAL_MEANINGS)

# Source-column labels in the blank's own language (the UI stays English).
LABELS: dict[str, dict[str, str]] = {
    "EN": {"exact": "Reference", "semantic": "Reference", "model": "Analogy", "norm": "Norm", "web": "Web",
           "none": "NO PRICE", "pending_permission": "Awaiting permission", "edited": "Edited", "row": "row"},
    "LV": {"exact": "Atsauce", "semantic": "Atsauce", "model": "Analoģija", "norm": "Norma", "web": "Internets",
           "none": "NAV CENAS", "pending_permission": "Gaida atļauju", "edited": "Labots", "row": "r."},
    "DA": {"exact": "Reference", "semantic": "Reference", "model": "Analogi", "norm": "Norm", "web": "Web",
           "none": "INGEN PRIS", "pending_permission": "Afventer tilladelse", "edited": "Rettet", "row": "række"},
    "NO": {"exact": "Referanse", "semantic": "Referanse", "model": "Analogi", "norm": "Norm", "web": "Nett",
           "none": "INGEN PRIS", "pending_permission": "Venter på tillatelse", "edited": "Endret", "row": "rad"},
    "SV": {"exact": "Referens", "semantic": "Referens", "model": "Analogi", "norm": "Norm", "web": "Webb",
           "none": "INGET PRIS", "pending_permission": "Väntar på tillstånd", "edited": "Ändrad", "row": "rad"},
    "LT": {"exact": "Nuoroda", "semantic": "Nuoroda", "model": "Analogija", "norm": "Norma", "web": "Internetas",
           "none": "NĖRA KAINOS", "pending_permission": "Laukiama leidimo", "edited": "Pakeista", "row": "eil."},
    "ET": {"exact": "Viide", "semantic": "Viide", "model": "Analoogia", "norm": "Norm", "web": "Veeb",
           "none": "HIND PUUDUB", "pending_permission": "Ootab luba", "edited": "Muudetud", "row": "rida"},
    "DE": {"exact": "Referenz", "semantic": "Referenz", "model": "Analogie", "norm": "Norm", "web": "Web",
           "none": "KEIN PREIS", "pending_permission": "Wartet auf Freigabe", "edited": "Geändert", "row": "Zeile"},
    "FI": {"exact": "Viite", "semantic": "Viite", "model": "Analogia", "norm": "Normi", "web": "Verkko",
           "none": "EI HINTAA", "pending_permission": "Odottaa lupaa", "edited": "Muokattu", "row": "rivi"},
}


def source_label(row: dict, lang: str | None) -> str:
    L = LABELS.get((lang or "EN").upper(), LABELS["EN"])
    src = row.get("price_source", "none")
    base = L.get(src, src)
    if src in ("exact", "semantic", "model") and row.get("matched"):
        m = row["matched"][0]
        return f"{base}: {m.get('file_name', '')} {L['row']} {m.get('row', '')}".strip()
    if src == "norm" and row.get("norm_ref"):
        return f"{base}: {row['norm_ref'].get('file_name', '')}"
    if src == "web" and row.get("web"):
        return f"{base}: {row['web'].get('url', '')}"
    return base


@dataclass
class SheetLayout:
    name: str
    cols: dict[str, str] = field(default_factory=dict)  # meaning → column letter (unit + total blocks + misc)

    def as_dict(self) -> dict:
        return {"name": self.name, "cols": self.cols}


def layout_from_structure(sheet: Any) -> SheetLayout:
    """Build a writer layout from an ingest SheetStructure (duck-typed)."""
    cols: dict[str, str] = {}
    for c in getattr(sheet, "columns", []) or []:
        meaning = getattr(c, "meaning", None)
        if meaning and meaning != "unknown" and meaning not in cols:
            cols[meaning] = c.letter
    for block in ("unit_block", "total_block"):
        for meaning, letter in (getattr(sheet, block, None) or {}).items():
            cols[meaning] = letter
    return SheetLayout(sheet.name, cols)


def _merged_non_anchor(ws) -> set[str]:
    out: set[str] = set()
    for rng in ws.merged_cells.ranges:
        first = True
        for row in ws.iter_rows(min_row=rng.min_row, max_row=rng.max_row, min_col=rng.min_col, max_col=rng.max_col):
            for cell in row:
                if first:
                    first = False
                    continue
                out.add(cell.coordinate)
    return out


def _is_formula(v: Any) -> bool:
    return isinstance(v, str) and v.startswith("=")


def _empty_for(meaning: str, v: Any) -> bool:
    if v is None or (isinstance(v, str) and not v.strip()):
        return True
    # Blanks often carry 0 placeholders in price cells; quantities are never touched.
    return meaning in PRICE_MEANINGS and isinstance(v, (int, float)) and v == 0


@dataclass
class WriteReport:
    written: int = 0
    skipped_formula: int = 0
    skipped_filled: int = 0
    skipped_merged: int = 0
    formula_totals: int = 0


def row_values(row: dict) -> dict[str, float | None]:
    """Values per meaning for one priced row (dict with qty/norm_h_per_unit/unit_labour/unit_material/...)."""
    qty = row.get("qty")
    nh, ul, um, rate = (row.get("norm_h_per_unit"), row.get("unit_labour"), row.get("unit_material"),
                        row.get("hourly_rate"))
    unit_total = None if ul is None and um is None else round((ul or 0) + (um or 0), 4)
    mul = (lambda v: None if v is None or qty is None else round(float(qty) * float(v), 4))
    tl, tm = mul(ul), mul(um)
    return {"norm_h": nh, "hourly_rate": rate, "unit_labour": ul, "unit_material": um, "unit_total": unit_total,
            "total_norm_h": mul(nh), "total_labour": tl, "total_material": tm,
            "total": None if tl is None and tm is None else round((tl or 0) + (tm or 0), 4)}


def write_rows(src_path: str, dst_path: str, layouts: dict[str, SheetLayout], rows: list[dict],
               lang: str | None, *, overwrite_own: bool = False) -> WriteReport:
    """rows: dicts with sheet_name,row_idx,qty,norm_h_per_unit,hourly_rate,unit_labour,unit_material,
    price_source,matched,norm_ref,web. With overwrite_own=True (viewer edits on our own output) numeric
    cells we wrote earlier may be replaced; formulas and text are still never touched."""
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    if os.path.abspath(src_path) != os.path.abspath(dst_path):
        shutil.copyfile(src_path, dst_path)
    wb = openpyxl.load_workbook(dst_path)  # formulas preserved (data_only=False)
    rep = WriteReport()
    merged_cache: dict[str, set[str]] = {}
    for r in rows:
        lay = layouts.get(r["sheet_name"])
        if lay is None or r["sheet_name"] not in wb.sheetnames:
            continue
        ws = wb[r["sheet_name"]]
        merged = merged_cache.setdefault(ws.title, _merged_non_anchor(ws))
        values = row_values(r)
        # A per-row hourly-rate column only gets a value when the row actually uses one.
        if r.get("unit_labour") is None:
            values["hourly_rate"] = None
        for meaning, value in values.items():
            letter = lay.cols.get(meaning)
            if not letter or value is None:
                continue
            coord = f"{letter}{r['row_idx']}"
            cell = ws[coord]
            if coord in merged:
                rep.skipped_merged += 1
                continue
            if _is_formula(cell.value):
                rep.skipped_formula += 1
                if meaning in TOTAL_MEANINGS:
                    rep.formula_totals += 1
                continue
            if not _empty_for(meaning, cell.value) and not (overwrite_own and isinstance(cell.value, (int, float))):
                rep.skipped_filled += 1
                continue
            cell.value = round(float(value), 4 if meaning in ("norm_h", "total_norm_h") else 2)
            rep.written += 1
        # A viewer edit may change the quantity; a fill never touches quantities.
        q_letter = lay.cols.get("qty")
        if overwrite_own and q_letter and r.get("qty") is not None:
            coord = f"{q_letter}{r['row_idx']}"
            cell = ws[coord]
            if coord not in merged and not _is_formula(cell.value) and (cell.value in (None, "") or isinstance(cell.value, (int, float))):
                if cell.value != r["qty"]:
                    cell.value = float(r["qty"])
                    rep.written += 1
        src_letter = lay.cols.get("source")
        if src_letter:
            coord = f"{src_letter}{r['row_idx']}"
            cell = ws[coord]
            if coord not in merged and not _is_formula(cell.value) and (cell.value in (None, "") or overwrite_own):
                cell.value = source_label(r, lang)
                rep.written += 1
    try:
        wb.calculation.fullCalcOnLoad = True
    except AttributeError:
        pass
    wb.save(dst_path)
    return rep


def col_idx(letter: str) -> int:
    return column_index_from_string(letter)
