"""In-memory index of the analysed knowledge base for one run.

All analysed files are loaded (not just the allowed ones) so the pricing engine can tell the agent
"found in unselected file X". It never returns prices from a file outside the run's allowed set;
see PricingEngine and tools.py for that enforcement."""
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

from .. import db
from ..matching.attributes import parse_attributes
from ..matching.text import normalise_text, strip_brands
from ..matching.units import normalise_unit

_STOP = {"un", "and", "og", "ar", "with", "med", "the", "a", "an", "of", "for", "uz", "no", "til", "i", "in",
         "ieskaitot", "incl", "inkl", "komplekts", "kompl", "montaza", "montaža", "uzstadisana", "installation",
         "levering", "montage", "piegade", "supply"}
_TOKEN = re.compile(r"[a-z0-9]+(?:\.[0-9]+)?")


def match_key(text: str) -> str:
    return normalise_text(strip_brands(text or ""))


def tokens(text: str) -> set[str]:
    return {t for t in _TOKEN.findall(match_key(text)) if t not in _STOP and len(t) > 1 or t.isdigit()}


def lexical_similarity(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = a & b
    # numbers carry more signal (sizes, counts)
    w = sum(2.0 if any(ch.isdigit() for ch in t) else 1.0 for t in inter)
    wa = sum(2.0 if any(ch.isdigit() for ch in t) else 1.0 for t in a)
    wb = sum(2.0 if any(ch.isdigit() for ch in t) else 1.0 for t in b)
    return 2 * w / (wa + wb)


def _f(v) -> float | None:
    return None if v is None else float(v)


@dataclass
class KItem:
    id: str
    file_id: str
    file_name: str
    tag: str
    sheet: str
    row: int
    section: str | None
    text: str
    key: str
    unit_norm: str | None
    qty: float | None
    norm_h: float | None
    unit_labour: float | None
    unit_material: float | None
    hourly_rate: float | None
    currency: str
    attrs: dict
    category: str | None
    toks: set[str] = field(default_factory=set)

    def ref(self, similarity: float | None = None) -> dict:
        return {"price_item_id": self.id, "file_id": self.file_id, "file_name": self.file_name,
                "sheet": self.sheet, "row": self.row, "item_text": self.text,
                "unit_labour": self.unit_labour, "unit_material": self.unit_material, "norm_h": self.norm_h,
                "hourly_rate": self.hourly_rate,
                **({"similarity": round(similarity, 3)} if similarity is not None else {})}


@dataclass
class KNorm:
    id: str
    file_id: str
    file_name: str
    text: str
    key: str
    unit_norm: str | None
    hours: float
    specificity: str
    params: dict
    attrs: dict
    category: str | None
    toks: set[str] = field(default_factory=set)

    def ref(self) -> dict:
        return {"norm_id": self.id, "file_id": self.file_id, "file_name": self.file_name, "item_text": self.text,
                "hours": self.hours, "specificity": self.specificity, "params": self.params}


class Knowledge:
    def __init__(self) -> None:
        self.files: dict[str, dict] = {}
        self.items: list[KItem] = []
        self.norms: list[KNorm] = []
        self.by_key: dict[str, list[KItem]] = {}
        self.has_embeddings = False

    @classmethod
    def load(cls) -> "Knowledge":
        kb = cls()
        # hourly-norm knowledge only: unit-rate BOQs (€ per unit, no hours) are a different pricing model and are
        # never mixed into an hourly run (app.unitrate handles them)
        for f in db.fetchall("""SELECT id, original_name, tag, language, summary FROM files
                                WHERE status='analysed' AND deleted_at IS NULL
                                  AND COALESCE(pricing_model, 'hourly_norm') = 'hourly_norm'"""):
            kb.files[str(f["id"])] = {"id": str(f["id"]), "name": f["original_name"], "tag": f["tag"],
                                      "language": f["language"], "summary": f["summary"] or {}}
        if not kb.files:
            return kb
        ids = list(kb.files)
        for r in db.fetchall(
                """SELECT id, file_id, sheet_name, row_idx, section_title, item_text, unit, unit_norm, qty,
                          norm_h_per_unit, unit_labour, unit_material, hourly_rate, currency, attrs, category,
                          override, embedding IS NOT NULL AS has_emb
                   FROM price_items WHERE file_id = ANY(%s)
                     AND COALESCE(pricing_model, 'hourly_norm') = 'hourly_norm'""", (ids,)):
            o = r["override"] or {}
            fid = str(r["file_id"])
            text = o.get("item_text", r["item_text"])
            it = KItem(
                id=str(r["id"]), file_id=fid, file_name=kb.files[fid]["name"], tag=kb.files[fid]["tag"],
                sheet=r["sheet_name"], row=r["row_idx"], section=r["section_title"], text=text,
                key=match_key(text), unit_norm=o.get("unit_norm", r["unit_norm"]) or normalise_unit(r["unit"]),
                qty=_f(o.get("qty", r["qty"])), norm_h=_f(o.get("norm_h_per_unit", r["norm_h_per_unit"])),
                unit_labour=_f(o.get("unit_labour", r["unit_labour"])),
                unit_material=_f(o.get("unit_material", r["unit_material"])),
                hourly_rate=_f(o.get("hourly_rate", r["hourly_rate"])), currency=r["currency"] or "EUR",
                attrs=r["attrs"] or parse_attributes(text), category=r["category"] or (r["attrs"] or {}).get("category"))
            it.toks = tokens(text)
            kb.items.append(it)
            kb.by_key.setdefault(it.key, []).append(it)
            kb.has_embeddings = kb.has_embeddings or r["has_emb"]
        for r in db.fetchall(
                """SELECT id, file_id, item_text, unit, unit_norm, hours, specificity, params, attrs, category, override
                   FROM norms WHERE file_id = ANY(%s)""", (ids,)):
            o = r["override"] or {}
            fid = str(r["file_id"])
            n = KNorm(id=str(r["id"]), file_id=fid, file_name=kb.files[fid]["name"], text=r["item_text"],
                      key=match_key(r["item_text"]), unit_norm=r["unit_norm"] or normalise_unit(r["unit"]),
                      hours=float(o.get("hours", r["hours"])), specificity=r["specificity"],
                      params=r["params"] or {}, attrs=r["attrs"] or {}, category=r["category"])
            n.toks = tokens(n.text)
            kb.norms.append(n)
        return kb

    def file_name(self, file_id: str) -> str:
        return self.files.get(file_id, {}).get("name", file_id)

    def default_hourly_rate(self, allowed: set[str]) -> float | None:
        """Median hourly rate across allowed reference estimates (per-sheet/section rates recorded at
        ingestion). Only a fallback: the blank's or template's own rate wins."""
        rates = [i.hourly_rate for i in self.items if i.file_id in allowed and i.hourly_rate]
        if not rates:
            rows = db.fetchall("""SELECT hourly_rate FROM file_sections WHERE file_id = ANY(%s)
                                  AND hourly_rate IS NOT NULL""", (list(allowed),)) if allowed else []
            rates = [float(r["hourly_rate"]) for r in rows]
        return round(statistics.median(rates), 4) if rates else None

    def language_of(self, file_id: str) -> str | None:
        return self.files.get(file_id, {}).get("language")
