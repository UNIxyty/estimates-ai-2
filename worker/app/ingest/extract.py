"""Turn an analysed workbook into price records (estimate / price-list rows) and norm records (norm files).

Missing per-unit values are derived from row totals ÷ qty; norm hours from unit labour ÷ hourly rate when
the rate is known; the hourly rate from unit labour ÷ norm otherwise.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from ..matching.attributes import detect_category, parse_attributes
from ..matching.text import normalise_text
from ..matching.units import normalise_unit
from .structure import RowInfo, SheetStructure, WorkbookStructure

PARAM_KEYS = ("cores", "cross_section_mm2", "modules", "gangs", "poles", "amps", "ip", "diameter_mm", "size",
              "sensitivity_ma", "pairs")

# words that don't make a norm more specific than its category ("montāža", "average", ...)
_FILLER = re.compile(
    r"\b(montaza|montazas|montaz|uzstadisana|ierikosana|ievilksana|izbuve|vidēji|videji|vid|average|avg|general|"
    r"generic|install\w*|mounting|montering|montage|installation|visi|all|citi|other|dazadi|various|parejie|"
    r"u c|utt|etc|un|and|og|und|ir|ja|caurule|caurules|in|i|pa|uz)\b")


@dataclass
class PriceRecord:
    item_text: str
    item_norm: str
    unit: str | None
    unit_norm: str | None
    qty: float | None
    norm_h_per_unit: float | None
    unit_labour: float | None
    unit_material: float | None
    total_labour: float | None
    total_material: float | None
    hourly_rate: float | None
    currency: str | None
    attrs: dict[str, Any]
    category: str | None
    section_title: str | None
    sheet_name: str
    row_idx: int
    source_cells: dict[str, str]
    unit_mechanisms: float | None = None
    unit_total: float | None = None
    source_ref: str | None = None
    extracted_by: str = "code"
    derived: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class NormRecord:
    item_text: str
    item_norm: str
    unit: str | None
    unit_norm: str | None
    hours: float
    specificity: str                 # parameterised | item | category
    params: dict[str, Any]
    attrs: dict[str, Any]
    category: str | None
    sheet_name: str | None
    row_idx: int | None
    extracted_by: str = "code"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _pos(x: float | None) -> bool:
    return x is not None and x > 0


def _r(x: float | None, nd: int = 4) -> float | None:
    return None if x is None else round(float(x), nd)


def _rate_for(ss: SheetStructure, row: RowInfo) -> float | None:
    for s in ss.sections:
        if s.row_start <= row.row <= s.row_end and s.hourly_rate:
            return s.hourly_rate
    rates = [x for x in ss.hourly_rates if x["rows"][0] <= row.row <= x["rows"][1]]
    if rates:
        return max(rates, key=lambda x: x.get("count", 0))["rate"]
    if len(ss.hourly_rates) == 1:
        return ss.hourly_rates[0]["rate"]
    return None


def price_record(ss: SheetStructure, row: RowInfo, currency: str | None, *,
                 tag: str | None = None) -> PriceRecord | None:
    text = (row.text or "").strip()
    if not text:
        return None
    v = row.values
    q = row.qty
    derived: list[str] = []
    ul, um, umech, ut = v.get("unit_labour"), v.get("unit_material"), v.get("unit_mechanisms"), v.get("unit_total")
    tl, tm, tmech, tt = v.get("total_labour"), v.get("total_material"), v.get("total_mechanisms"), v.get("total")
    nh, tnh = v.get("norm_h"), v.get("total_norm_h")
    rate = v.get("hourly_rate")
    if _pos(q):
        if ul is None and tl is not None:
            ul = tl / q
            derived.append("unit_labour")
        if um is None and tm is not None:
            um = tm / q
            derived.append("unit_material")
        if umech is None and tmech is not None:
            umech = tmech / q
        if ut is None and tt is not None:
            ut = tt / q
            derived.append("unit_total")
        if nh is None and tnh is not None:
            nh = tnh / q
            derived.append("norm_h")
        if tl is None and ul is not None:
            tl = ul * q
            derived.append("total_labour")
        if tm is None and um is not None:
            tm = um * q
            derived.append("total_material")
    if rate is None:
        rate = _rate_for(ss, row)
    if nh is None and _pos(ul) and _pos(rate):
        nh = ul / rate
        derived.append("norm_h")
    if ul is None and _pos(nh) and _pos(rate) and (um is not None or ut is not None):
        ul = nh * rate
        derived.append("unit_labour")
        if tl is None and _pos(q):
            tl = ul * q
    if rate is None and _pos(ul) and _pos(nh):
        rate = ul / nh
        derived.append("hourly_rate")
    # split of a combined unit price when one part is known
    if ut is not None and ul is not None and um is None and ut - ul - (umech or 0) >= -0.005:
        um = ut - ul - (umech or 0)
        derived.append("unit_material")
    elif ut is not None and um is not None and ul is None and ut - um - (umech or 0) >= -0.005 and \
            ("unit_labour" in ss.unit_block or "total_labour" in ss.total_block):
        ul = ut - um - (umech or 0)
        derived.append("unit_labour")
    attrs = parse_attributes(text)
    combined = False
    if ul is None and um is None and ut is not None:
        # only a combined price (price lists / simple offers): keep it as the material price, flagged
        um = ut
        combined = True
        if tm is None and tt is not None:
            tm = tt
    priced = any(_pos(x) for x in (ul, um, nh, tl, tm, ut))
    if not priced:
        return None
    if combined:
        attrs["combined_price"] = True
    if row.source_ref:
        attrs["source_ref"] = row.source_ref
    if row.code:
        attrs["code"] = row.code
    category = attrs.get("category")
    unit_norm = normalise_unit(row.unit, ss.language)
    return PriceRecord(
        item_text=text[:2000], item_norm=normalise_text(text)[:2000], unit=row.unit, unit_norm=unit_norm, qty=_r(q),
        norm_h_per_unit=_r(nh, 6), unit_labour=_r(ul), unit_material=_r(um), total_labour=_r(tl),
        total_material=_r(tm), hourly_rate=_r(rate), currency=currency or ss.currency, attrs=attrs,
        category=category, section_title=row.section_title, sheet_name=ss.name, row_idx=row.row,
        source_cells=dict(row.cells), unit_mechanisms=_r(umech), unit_total=_r(ut), source_ref=row.source_ref,
        derived=derived)


def extract_prices(ws: WorkbookStructure, *, tag: str | None = None,
                   include_non_electrical: bool = False) -> list[PriceRecord]:
    out: list[PriceRecord] = []
    for ss in ws.sheets:
        if ss.kind not in ("estimate", "prices"):
            continue
        if ss.is_electrical is False and not include_non_electrical:
            continue
        for row in ss.rows:
            if row.kind != "item":
                continue
            rec = price_record(ss, row, ss.currency or ws.currency, tag=tag)
            if rec is not None:
                out.append(rec)
    return out


def _specificity(row: RowInfo, text: str, attrs: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    params = {k: attrs[k] for k in PARAM_KEYS if k in attrs}
    item_col_empty = row.category_label is not None and row.text_col is not None and row.text == row.category_label
    if item_col_empty:
        return "category", {}
    if params:
        return "parameterised", params
    n = normalise_text(text)
    rest = _FILLER.sub(" ", n)
    rest = re.sub(r"\(.*?\)", " ", rest)
    words = [w for w in rest.split() if len(w) > 1]
    cat = attrs.get("category")
    if cat and cat != "other" and len(words) <= 1:
        return "category", {}
    return "item", {}


def extract_norms(ws: WorkbookStructure, *, tag: str | None = None) -> list[NormRecord]:
    out: list[NormRecord] = []
    for ss in ws.sheets:
        norms_sheet = ss.kind == "norms" or (tag == "hourly_norms" and ss.kind in ("estimate", "prices"))
        if not norms_sheet:
            continue
        for row in ss.rows:
            if row.kind != "item":
                continue
            text = (row.text or "").strip()
            if not text:
                continue
            h = row.values.get("norm_h")
            if h is None and row.values.get("total_norm_h") is not None:
                h = row.values["total_norm_h"] / row.qty if row.qty else row.values["total_norm_h"]
            if h is None or h <= 0:
                continue
            attrs = parse_attributes(text)
            if row.category_label:
                label_cat = detect_category(row.category_label)
                if label_cat and (attrs.get("category") in (None, "other")):
                    attrs["category"] = label_cat
                attrs["category_label"] = row.category_label
            spec, params = _specificity(row, text, attrs)
            display = text
            if spec == "category" and row.category_label and text == row.category_label:
                display = row.category_label
            out.append(NormRecord(
                item_text=display[:2000], item_norm=normalise_text(display)[:2000], unit=row.unit,
                unit_norm=normalise_unit(row.unit, ss.language), hours=round(float(h), 6), specificity=spec,
                params=params, attrs=attrs, category=attrs.get("category"), sheet_name=ss.name, row_idx=row.row))
    return out
