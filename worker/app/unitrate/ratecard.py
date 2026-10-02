"""Rate card of a unit-rate reference: install and supply €/unit grouped by what determines the rate
(component + product + size / rating), with every source row kept for provenance and spread."""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from .boq import BoqRow, BoqWorkbook

_W_BANDS = [(0, 300, "≤300"), (301, 450, "400–450"), (451, 600, "500–600"), (601, 900, "700–900"),
            (901, 1300, "1000–1300")]


def _band(w: int | None) -> str | None:
    if not w:
        return None
    for lo, hi, lab in _W_BANDS:
        if lo <= w <= hi:
            return lab
    return f"{w}"


def card_label(r: BoqRow) -> str:
    """Human label of the rate-determining key, e.g. 'Tray/ladder straight · 300 mm', 'Cable 3×2.5 mm²'."""
    a = r.attrs or {}
    comp, prod = a.get("component"), a.get("product")
    d = r.description.lower()
    if prod in ("ladder", "tray", "basket", "panduit", "trunking") or comp in ("straight", "bend", "tee", "offset",
                                                                                  "reducer", "riser_bend", "4way",
                                                                                  "db_header", "5m_drop"):
        name = {"straight": "straight", "bend": "bend", "tee": "tee", "offset": "offset", "reducer": "reducer",
                "riser_bend": "riser bend", "4way": "4-way intersection", "db_header": "DB/equip header",
                "5m_drop": "5 m drop"}.get(comp or "straight", (comp or "").replace("_", " "))
        w = a.get("width_mm")
        size = f" · {w} mm" if comp in ("straight", None) and w else ""
        return f"{(prod or 'containment').title()} {name}{size}" + (" (EXT)" if a.get("finish") == "EXT" else "")
    if comp and "cover_lid" in comp:
        return "Cover lid" + ("" if comp == "cover_lid" else f" ({comp.replace('_cover_lid', '').replace('4way', '4-way')})")
    if comp == "divider_fillet":
        return "Divider fillet"
    if comp == "trapeze":
        return f"Trapeze bracket · {a.get('width_mm') or '?'} mm"
    if comp == "tier_bracket" or (comp == "bracket" and a.get("tiers")):
        return f"Bracket {a.get('width_mm') or '?'} mm · {a.get('tiers') or 1} tier"
    if comp == "unistrut":
        return "Unistrut (double)" if "double" in d else "Unistrut"
    if prod == "termination":
        return f"Termination {a['mm2']:g} mm²" if a.get("mm2") else "Termination"
    if prod == "connection":
        ph = f" {a['phases']}PH" if a.get("phases") else ""
        return f"Connection {a.get('amps') or '?'} A{ph}"
    if prod == "tie":
        return "Cable tie (SS)" if re.search(r"\bss\b|stainless", d) else "Cable tie"
    if a.get("mm2") and (prod == "cable" or "cable" in d or "conductor" in d or "core" in d):
        fp = " FP" if a.get("fire_rated") else ""
        kind = "Flex" if re.search(r"\bflex\b", d) else "Cable"
        return f"{kind} {a.get('cores') or '?'}×{a['mm2']:g} mm²{fp}"
    if prod == "isolator" or "isolator" in d:
        ph = f" {a['phases']}PH" if a.get("phases") else ""
        return f"Isolator {a.get('amps') or '?'} A{ph}"
    if "bracket" in d and "luminaire" in d:
        return "Luminaire bracket"
    if re.search(r"exit\s*sign", d):
        return "Exit sign"
    if prod == "luminaire":
        return f"Luminaire {a.get('type_code') or ''}".strip() if a.get("type_code") else "Luminaire / fitting"
    if prod == "socket":
        if re.search(r"combination|wall\s*box\s*unit", d):
            return "Socket combination unit"
        kind = ("CEE 3PH" if re.search(r"\bcee\b|400\s*v|3p\+n", d) else "double" if re.search(r"double|twin", d)
                else "single" if "single" in d else "")
        return f"Socket {kind}".strip()
    if prod == "junction_box":
        return "Fire-rated JB" if a.get("fire_rated") else "Junction box"
    for k, lab in (("busbar", "Lighting busbar / track"), ("sensor", "Motion sensor"), ("switch", "Switch / pushbutton"),
                   ("gland", "Gland"), ("label", "Label"), ("tie", "Cable tie"), ("socket", "Socket"),
                   ("fcu", "Fused connection unit"), ("data_outlet", "Data outlet"), ("floor_box", "Floor box"),
                   ("connection", "Connection")):
        if prod == k:
            extra = f" {a['amps']} A" if k in ("socket", "connection") and a.get("amps") else ""
            return lab + extra
    if "conduit" in d:
        m = re.search(r"(\d{2})\s*mm", d)
        return f"Conduit {m.group(1)} mm" if m else "Conduit"
    if re.search(r"saddle", d):
        return "Saddle"
    if re.search(r"\bbush", d):
        return "Bush"
    if "end box" in d:
        return "End box"
    if re.search(r"\blid\b", d):
        return "Box lid"
    if "screw" in d:
        return "Screw"
    if "fuse" in d:
        return "Inline fuse"
    if "flex" in d:
        return "Flex"
    return re.sub(r"\s*\([^)]*\)", "", r.description)[:48]


def rate_card(wb: BoqWorkbook, file_label: str | None = None) -> list[dict[str, Any]]:
    """[{label, install: [..], supply: [..], sources: [{sheet,row,description,install,supply,section,notes}]}]"""
    groups: dict[str, dict[str, Any]] = defaultdict(lambda: {"install": [], "supply": [], "sources": []})
    for sh in wb.pricing_sheets:
        for r in sh.rows:
            if r.kind != "item" or (r.install_rate is None and r.supply_rate is None):
                continue
            g = groups[card_label(r)]
            if r.install_rate is not None:
                g["install"].append(r.install_rate)
            if r.supply_rate is not None:
                g["supply"].append(r.supply_rate)
            g["sources"].append({"file": file_label, "sheet": r.sheet, "row": r.row, "description": r.description,
                                 "uom": r.uom_norm, "install": r.install_rate, "supply": r.supply_rate,
                                 "section": r.section, "basis": r.rate_basis, "notes": r.notes, "flags": r.flags})
    out = []
    for label, g in groups.items():
        out.append({"label": label, "install": sorted(set(g["install"])), "supply": sorted(set(g["supply"])),
                    "n": len(g["sources"]), "sources": g["sources"]})
    return sorted(out, key=lambda x: x["label"])


def fmt_range(vals: list[float]) -> str:
    if not vals:
        return "–"
    lo, hi = min(vals), max(vals)
    f = (lambda v: f"{v:g}")
    return f(lo) if lo == hi else f"{f(lo)}–{f(hi)}"
