"""Unit-rate matching: a blank line's install / supply €-per-unit from unit-rate references only.

Order (cheapest and surest first), install and supply independently:
  1. same attributes   component + product + size / rating + finish (brand / SKU text ignored for install rates, used
                       to prefer a supply rate)
  2. same rate-card item  e.g. any "Ladder bend" (fittings are priced per item regardless of width)
  3. band rule          the preferred reference's own rule, row marked CHECK "interpolated from band …":
                        width bands (ladder / tray / basket / trapeze / headers), tier steps (brackets: base + €/tier),
                        current bands (connections, isolators)
  4. same text          normalised description equal
  5. similar text       token overlap within the same product family (CHECK)
  else NO PRICE.
When references disagree, the preferred one wins: same market, then same main contractor, then same package, then the
most recent; the others are kept as alternatives (shown with their spread in the row inspector).
Web search is for supply rates only and happens outside this module; install rates never come from the web."""
from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable

from ..matching.text import normalise_text, tokens
from .attributes import install_key, section_kind, unit_rate_attributes
from .boq import BoqWorkbook
from .ratecard import card_label

CONTAINMENT = ("ladder", "tray", "basket", "panduit", "trunking")


@dataclass
class RefMeta:
    file_id: str
    file_name: str
    market: str | None = None
    client: str | None = None
    end_client: str | None = None
    package: str | None = None
    doc_date: str | None = None
    pricing_model: str = "unit_rate"   # hourly_norm only when the user allowed a different-model reference


@dataclass
class RefRow:
    meta: RefMeta
    sheet: str
    row: int
    description: str
    attrs: dict[str, Any]
    uom: str | None
    install_rate: float | None
    supply_rate: float | None
    rate_basis: str | None
    package: str | None
    section: str | None
    notes: list[str]
    flags: list[str]
    rate_key: str
    norm: str = ""

    @property
    def kind(self) -> str:
        return section_kind(self.section, self.sheet)

    def ref(self) -> dict:
        return {"file_id": self.meta.file_id, "file_name": self.meta.file_name, "sheet": self.sheet, "row": self.row,
                "description": self.description, "install_rate": self.install_rate, "supply_rate": self.supply_rate,
                "section": self.section, "notes": self.notes[:3], "market": self.meta.market,
                "client": self.meta.client, "doc_date": self.meta.doc_date}


@dataclass
class Quote:
    rate: float | None
    method: str | None = None            # exact | item | band | text | similar
    confidence: str = "low"             # high | medium | low
    source: RefRow | None = None
    alternatives: list[dict] = field(default_factory=list)   # [{file_name, rate, sheet, row}]
    note: str | None = None             # "interpolated from band 300–400 mm (€25–35)"
    check: bool = False


@dataclass
class Want:
    """What the run prefers among references (from the blank: market, main contractor, package, end client)."""
    market: str | None = None
    client: str | None = None
    package: str | None = None
    end_client: str | None = None


def rows_from_workbook(wb: BoqWorkbook, meta: RefMeta) -> list[RefRow]:
    out = []
    for sh in wb.pricing_sheets:
        for r in sh.rows:
            if r.kind != "item" or (r.install_rate is None and r.supply_rate is None):
                continue
            out.append(RefRow(meta=meta, sheet=r.sheet, row=r.row, description=r.description, attrs=r.attrs or {},
                              uom=r.uom_norm, install_rate=r.install_rate, supply_rate=r.supply_rate,
                              rate_basis=r.rate_basis, package=r.package or sh.package, section=r.section,
                              notes=r.notes, flags=r.flags, rate_key=card_label(r), norm=normalise_text(r.description)))
    return out


def rows_from_db(rows: Iterable[dict], metas: dict[str, RefMeta]) -> list[RefRow]:
    out = []
    for d in rows:
        meta = metas.get(str(d["file_id"]))
        if meta is None or d.get("package") in ("prelims", "contractor_items"):
            continue
        ov = d.get("override") or {}
        ir = ov.get("install_rate", d.get("install_rate"))
        sr = ov.get("supply_rate", d.get("supply_rate"))
        out.append(RefRow(meta=meta, sheet=d["sheet_name"], row=d["row_idx"], description=d["item_text"],
                          attrs=d.get("attrs") or {}, uom=d.get("unit_norm"),
                          install_rate=float(ir) if ir is not None else None,
                          supply_rate=float(sr) if sr is not None else None, rate_basis=d.get("rate_basis"),
                          package=d.get("package"), section=d.get("section_title"),
                          notes=list(d.get("section_notes") or []), flags=list(d.get("flags") or []),
                          rate_key=d.get("rate_key") or "", norm=d.get("item_norm") or normalise_text(d["item_text"])))
    return out


def _newest(m: RefMeta) -> int:
    """Sort key: newer documents first (no date = oldest)."""
    d = re.sub(r"\D", "", m.doc_date or "")[:8]
    return -int(d) if d else 0


def _uom_ok(a: str | None, b: str | None) -> bool:
    return not a or not b or a == b


class UnitRateKB:
    def __init__(self, rows: list[RefRow], want: Want | None = None):
        self.rows = rows
        self.want = want or Want()
        self.by_key: dict[tuple, list[RefRow]] = defaultdict(list)
        self.by_label: dict[str, list[RefRow]] = defaultdict(list)
        self.by_norm: dict[str, list[RefRow]] = defaultdict(list)
        for r in rows:
            self.by_key[install_key(r.attrs)].append(r)
            self.by_label[r.rate_key].append(r)
            self.by_norm[r.norm].append(r)

    # ------------------------------------------------------------- preference
    def rank(self, m: RefMeta, which: str = "install_rate") -> tuple:
        w = self.want
        return (0 if w.market and m.market == w.market else 1,
                0 if w.client and m.client == w.client else 1,
                0 if w.package and m.package in (w.package, "electrical") else 1,
                0 if w.end_client and m.end_client == w.end_client else 1,
                _newest(m))

    def _pick(self, cands: list[RefRow], which: str) -> tuple[RefRow, list[dict]]:
        """Preferred reference's most common rate (rows from the same kind of section first: a bracket in emergency
        cabling is priced differently from one in standard cabling); every reference's rate as alternatives."""
        kind = getattr(self, "_kind", None)
        same_kind = [c for c in cands if c.kind == kind]
        if same_kind:
            cands = same_kind
        per_file: dict[str, list[RefRow]] = defaultdict(list)
        for c in cands:
            per_file[c.meta.file_id].append(c)
        alts = []
        best: tuple | None = None
        for fid, rs in per_file.items():
            vals = [getattr(r, which) for r in rs]
            mode = Counter(vals).most_common(1)[0][0]
            rep = next(r for r in rs if getattr(r, which) == mode)
            alts.append({"file_name": rep.meta.file_name, "rate": mode, "sheet": rep.sheet, "row": rep.row,
                         "market": rep.meta.market, "doc_date": rep.meta.doc_date})
            key = self.rank(rep.meta, which)
            if best is None or key < best[0]:
                best = (key, rep)
        alts.sort(key=lambda a: (a["rate"], a["file_name"]))
        return best[1], alts  # type: ignore[index]

    # ------------------------------------------------------------- public
    def quote(self, description: str, *, uom: str | None, section: str | None = None, which: str = "install_rate",
              attrs: dict | None = None, finish: str | None = None, sheet: str | None = None) -> Quote:
        a = attrs or unit_rate_attributes(description, finish=finish, section=section)
        self._kind = section_kind(section, sheet)
        pool = [r for r in self.rows if getattr(r, which) is not None
                and not (which == "supply_rate" and "CONFLICTING_DESCRIPTION" in r.flags)]
        if not pool:
            return Quote(None)
        pool_ids = {id(r) for r in pool}
        # 1. same attributes (only when the attributes say something specific)
        key = install_key(a)
        from .boq import BoqRow as _B
        label = card_label(_B(sheet="", row=0, kind="item", description=description, attrs=a))
        # a luminaire type code ("Type C1") is a different fitting on every project, so it is not a rate-card item
        is_fitting = label == "Luminaire / fitting" or (label.startswith("Luminaire ") and bool(a.get("type_code")))
        specific = not is_fitting and (a.get("component") or a.get("product")) and any(
            a.get(k) is not None for k in ("width_mm", "tiers", "mm2", "amps"))
        if specific:
            cands = [r for r in self.by_key.get(key, []) if id(r) in pool_ids and _uom_ok(r.uom, uom)]
            if which == "supply_rate" and a.get("brand_text"):
                same_brand = [r for r in cands if (r.attrs.get("brand_text") or "").lower() == a["brand_text"].lower()]
                cands = same_brand or cands
            if cands:
                src, alts = self._pick(cands, which)
                return Quote(getattr(src, which), "exact", "high", src, alts)
        # 2. same rate-card item (fittings priced per item regardless of width, same cable size, …)
        cands = [r for r in self.by_label.get(label, []) if id(r) in pool_ids and _uom_ok(r.uom, uom)]
        if cands and not is_fitting and not label.startswith(("Connection ?", "Isolator ?")):
            src, alts = self._pick(cands, which)
            rates = {x["rate"] for x in alts}
            return Quote(getattr(src, which), "item", "high" if len(rates) == 1 else "medium", src, alts)
        if is_fitting and a.get("type_code") and self.want.end_client:
            same_proj = [r for r in pool if r.attrs.get("type_code") == a["type_code"]
                         and r.meta.end_client == self.want.end_client and r.attrs.get("product") == "luminaire"]
            if same_proj:
                src, alts = self._pick(same_proj, which)
                return Quote(getattr(src, which), "exact", "medium", src, alts,
                             f"same luminaire type {a['type_code']} on another {self.want.end_client} project")
        if is_fitting:
            lum = [r for r in pool if r.rate_key.startswith("Luminaire ") and r.rate_key != "Luminaire bracket"
                   and _uom_ok(r.uom, uom)]
            if lum:
                src, alts = self._pick(lum, which)
                return Quote(getattr(src, which), "item", "low", src, alts,
                             f"typical luminaire install rate in {src.meta.file_name} — check the fitting type",
                             check=True)
        # 3. band rules from the preferred reference
        q = self._band(a, uom, which, pool_ids)
        if q:
            return q
        # 4. same text
        n = normalise_text(description)
        cands = [r for r in self.by_norm.get(n, []) if id(r) in pool_ids and _uom_ok(r.uom, uom)]
        if cands:
            src, alts = self._pick(cands, which)
            return Quote(getattr(src, which), "text", "medium", src, alts)
        # 5. similar text within the same product family
        q = self._similar(description, a, uom, which, pool)
        if q:
            return q
        return Quote(None)

    # ------------------------------------------------------------- band rules
    def _band(self, a: dict, uom: str | None, which: str, pool_ids: set[int]) -> Quote | None:
        prod, comp = a.get("product"), a.get("component")
        w, tiers, amps = a.get("width_mm"), a.get("tiers"), a.get("amps")
        if comp in ("tier_bracket", "bracket") and w:
            return self._bracket_band(w, tiers or 1, which, pool_ids)
        if w and (prod in CONTAINMENT or comp in ("trapeze", "db_header", "5m_drop")):
            same = [r for r in self.rows if id(r) in pool_ids and r.attrs.get("width_mm")
                    and r.attrs.get("component") == comp and (r.attrs.get("product") == prod or comp == "trapeze")
                    and r.attrs.get("finish") == a.get("finish") and _uom_ok(r.uom, uom)]
            if not same and a.get("finish"):
                same = [r for r in self.rows if id(r) in pool_ids and r.attrs.get("width_mm")
                        and r.attrs.get("component") == comp and r.attrs.get("product") == prod and _uom_ok(r.uom, uom)]
            return self._interpolate(same, "width_mm", w, which, "mm")
        if amps and prod in ("connection", "isolator", "socket"):
            same = [r for r in self.rows if id(r) in pool_ids and r.attrs.get("product") == prod and r.attrs.get("amps")
                    and (not a.get("phases") or r.attrs.get("phases") in (None, a.get("phases")))
                    and _uom_ok(r.uom, uom)]
            return self._interpolate(same, "amps", amps, which, "A", prefer_higher=True)
        return None

    def _interpolate(self, same: list[RefRow], dim: str, v: float, which: str, unit: str,
                     prefer_higher: bool = False) -> Quote | None:
        if not same:
            return None
        src_file, _ = self._pick(same, which)
        mine = [r for r in same if r.meta.file_id == src_file.meta.file_id]
        pts: dict[float, list[float]] = defaultdict(list)
        for r in mine:
            pts[float(r.attrs[dim])].append(getattr(r, which))
        xs = sorted(pts)
        rate_at = {x: Counter(pts[x]).most_common(1)[0][0] for x in xs}
        lo = max((x for x in xs if x <= v), default=None)
        hi = min((x for x in xs if x >= v), default=None)
        if lo is not None and lo == hi:
            r0 = next(r for r in mine if float(r.attrs[dim]) == lo and getattr(r, which) == rate_at[lo])
            return Quote(rate_at[lo], "exact", "high", r0, [])
        if lo is not None and hi is not None:
            if rate_at[lo] == rate_at[hi]:
                rate, at = rate_at[lo], lo
            else:
                # ratings round up to the next size when it is close (a 20 A connection costs what a 32 A one
                # does), but never jump from a 125 A enclosure isolator to a 630 A panel one
                if prefer_higher and hi <= 2 * v:
                    at = hi
                else:
                    at = hi if (hi / v if dim == "amps" else hi - v) <= (v / lo if dim == "amps" else v - lo) else lo
                rate = rate_at[at]
            note = (f"interpolated from band {lo:g}–{hi:g} {unit} (€{rate_at[lo]:g}–{rate_at[hi]:g}) "
                    f"in {src_file.meta.file_name}")
        else:
            at = lo if lo is not None else hi
            rate = rate_at[at]
            note = f"nearest size {at:g} {unit} in {src_file.meta.file_name} (outside its range)"
        r0 = next(r for r in mine if float(r.attrs[dim]) == at and getattr(r, which) == rate)
        alts = [{"file_name": src_file.meta.file_name, "rate": rate_at[x], "sheet": "", "row": 0,
                 "at": f"{x:g} {unit}"} for x in xs]
        return Quote(rate, "band", "medium", r0, alts, note, check=True)

    def _bracket_band(self, w: int, tiers: int, which: str, pool_ids: set[int]) -> Quote | None:
        same = [r for r in self.rows if id(r) in pool_ids and r.attrs.get("component") in ("tier_bracket", "bracket")
                and r.attrs.get("width_mm") and r.attrs.get("tiers")]
        if not same:
            return None
        src_file, _ = self._pick(same, which)
        mine = [r for r in same if r.meta.file_id == src_file.meta.file_id]
        grid = {(int(r.attrs["width_mm"]), int(r.attrs["tiers"])): getattr(r, which) for r in mine}
        steps = [grid[(ww, t + 1)] - grid[(ww, t)] for (ww, t) in grid if (ww, t + 1) in grid]
        step = statistics.median(steps) if steps else 10.0
        widths = sorted({ww for ww, _ in grid})
        # same width, other tier count: base + step per extra tier
        same_w = [(t, rate) for (ww, t), rate in grid.items() if ww == w]
        if same_w:
            t0, r0 = min(same_w, key=lambda x: abs(x[0] - tiers))
            rate = r0 + step * (tiers - t0)
            src = next(r for r in mine if int(r.attrs["width_mm"]) == w and int(r.attrs["tiers"]) == t0)
            return Quote(rate, "band", "medium", src, [], f"tier rule in {src_file.meta.file_name}: {w} mm "
                         f"{t0} tier €{r0:g} + €{step:g} per extra tier", check=True)
        # nearest width band at or above, then tiers
        above = [ww for ww in widths if ww >= w] or [max(widths)]
        wb = min(above)
        t0, r0 = min(((t, rate) for (ww, t), rate in grid.items() if ww == wb), key=lambda x: abs(x[0] - tiers))
        rate = r0 + step * (tiers - t0)
        src = next(r for r in mine if int(r.attrs["width_mm"]) == wb and int(r.attrs["tiers"]) == t0)
        return Quote(rate, "band", "medium", src, [], f"interpolated from band ≤{wb} mm in "
                     f"{src_file.meta.file_name} ({t0} tier €{r0:g} + €{step:g}/tier)", check=True)

    # ------------------------------------------------------------- similar text
    def _similar(self, description: str, a: dict, uom: str | None, which: str, pool: list[RefRow]) -> Quote | None:
        want = set(tokens(re.sub(r"\([^)]*\)", " ", description)))
        if not want:
            return None
        best: tuple[float, RefRow] | None = None
        for r in pool:
            if not _uom_ok(r.uom, uom):
                continue
            if a.get("product") and r.attrs.get("product") and a.get("product") != r.attrs.get("product"):
                continue
            if (a.get("component") or r.attrs.get("component")) and a.get("component") != r.attrs.get("component"):
                continue
            have = set(tokens(re.sub(r"\([^)]*\)", " ", r.description)))
            if not have:
                continue
            s = len(want & have) / len(want | have)
            if best is None or s > best[0] or (s == best[0] and self.rank(r.meta) < self.rank(best[1].meta)):
                best = (s, r)
        if best and best[0] >= 0.5:
            r = best[1]
            return Quote(getattr(r, which), "similar", "low", r, [], f"closest description "
                         f"({best[0]:.0%} word overlap): “{r.description[:60]}”", check=True)
        return None
