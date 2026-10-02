"""What the file page shows for a unit-rate reference, and the agent's plain-language notes about it."""
from __future__ import annotations

import re
import statistics
from typing import Any

from .boq import BoqWorkbook
from .ratecard import fmt_range, rate_card

PACKAGE_LABEL = {"containment": "Containment", "lighting": "Lighting", "gs_sp": "General services / small power",
                 "cable": "Cable", "electrical": "Electrical services (several packages)", "prelims": "Preliminaries",
                 "contractor_items": "Contractor items"}
BASIS_LABEL = {"install_only": "Install only (free issue)", "supply_only": "Supply only",
               "supply_and_install": "Supply & install", "lump_sum": "Lump sum", "weekly": "Per week",
               "monthly": "Per month", "percent": "Percent"}


def delivery_info(wb: BoqWorkbook) -> list[dict]:
    """Materials delivery: the % typed in (if any) and the amount ÷ that sheet's material-supply items
    (the supply-total cell usually already includes the delivery line, so it is not the base)."""
    out = []
    for sh in wb.pricing_sheets:
        items = _supply_items(sh) or None
        for r in sh.rows:
            if r.kind != "delivery":
                continue
            amount = (r.attrs or {}).get("amount")
            st = sh.totals.get("supply_total")
            # the supply-total cell includes the delivery line (and supply-side lump sums such as fixation
            # materials): the base is that total without the delivery amount
            base = st - amount if st and amount and st > amount else items
            pct = round(100 * amount / base, 2) if amount and base else None
            out.append({"sheet": sh.name, "row": r.row, "description": r.description,
                        "typed_percent": (r.attrs or {}).get("percent"), "amount": amount, "supply_total": base,
                        "computed_percent": pct})
    return out


def _supply_items(sh) -> float:
    return sum((r.supply_rate or 0) * (r.qty or 0) for r in sh.rows if r.kind == "item")


def build_analysis(wb: BoqWorkbook, *, file_name: str | None = None) -> dict[str, Any]:
    card = rate_card(wb, file_name)
    install_card = [{"label": g["label"], "install": fmt_range(g["install"]), "n": g["n"],
                     "rows": [{"sheet": s["sheet"], "row": s["row"], "description": s["description"],
                               "rate": s["install"], "uom": s["uom"]} for s in g["sources"] if s["install"] is not None][:12]}
                    for g in card if g["install"]]
    supply_card = [{"label": g["label"], "supply": fmt_range(g["supply"]), "n": g["n"],
                    "rows": [{"sheet": s["sheet"], "row": s["row"], "description": s["description"],
                              "rate": s["supply"], "uom": s["uom"], "flags": s["flags"]}
                             for s in g["sources"] if s["supply"] is not None][:12]}
                   for g in card if g["supply"]]
    sheets = []
    for sh in wb.sheets:
        if sh.kind != "pricing":
            sheets.append({"name": sh.name, "kind": sh.kind})
            continue
        bases = {}
        for sec in sh.sections:
            if sec.get("basis"):
                bases.setdefault(sec["basis"], []).append(sec["title"])
        priced = sum(1 for r in sh.rows if r.kind == "item" and (r.install_rate is not None or r.supply_rate is not None))
        items = sum(1 for r in sh.rows if r.kind == "item")
        sheets.append({"name": sh.name, "kind": "pricing", "layout": sh.layout, "package": sh.package,
                       "columns": sh.cols, "has_supply": sh.has_supply,
                       "phases": [p["label"] + (f" {p['area'].title()}" if p.get("area") else "") for p in sh.phases],
                       "buildings": [b["label"] for b in sh.buildings], "areas": sh.areas,
                       "input_fill": sh.input_fill, "items": items, "priced": priced,
                       "sections": [{"title": s["title"], "row": s["row"], "basis": s.get("basis"),
                                     "notes": s.get("notes", [])} for s in sh.sections],
                       "bases": bases, "notes": sh.notes, "totals": sh.totals})
    prelims_weekly = [{"description": p["description"], "rate": p["rate"], "weeks": p["qty"], "sheet": p["sheet"],
                       "row": p["row"]} for p in wb.prelims if p["rate_basis"] == "weekly" and p["rate"]]
    prelims_items = [{"description": p["description"], "rate": p["rate"], "qty": p["qty"], "uom": p["uom"],
                      "sheet": p["sheet"], "row": p["row"]} for p in wb.prelims if p["rate_basis"] != "weekly" and p["rate"]]
    contractor = []
    lump_sums = []
    for sh in wb.pricing_sheets:
        for r in sh.rows:
            if r.kind == "contractor":
                contractor.append({"sheet": sh.name, "row": r.row, "description": r.description,
                                   "phase": r.phase, "months": r.qty if r.rate_basis == "monthly" else None,
                                   "rate": r.install_rate, "basis": r.rate_basis})
            elif r.kind == "lump_sum":
                lump_sums.append({"sheet": sh.name, "row": r.row, "description": r.description,
                                  "amount": (r.attrs or {}).get("amount") or r.install_rate})
    sm = [p["qty"] for p in wb.prelims if p["rate_basis"] == "weekly" and p["qty"]
          and re.search(r"site\s*manager", p["description"], re.I)]
    weeks = sorted(set(sm)) or sorted({max(p["qty"] for p in wb.prelims if p["rate_basis"] == "weekly" and p["qty"])}
                                      if any(p["rate_basis"] == "weekly" and p["qty"] for p in wb.prelims) else set())
    analysis = {
        "pricing_model": "unit_rate",
        "project": wb.project, "client": wb.client, "end_client": wb.end_client, "market": wb.market,
        "package": wb.package, "package_label": PACKAGE_LABEL.get(wb.package or "", wb.package),
        "doc_date": wb.doc_date, "currency": wb.currency, "language": wb.language,
        "is_takeoff": wb.is_takeoff,
        "subcontractor": wb.subcontractor,
        "summary_lines": wb.summary_lines,
        "not_participating": [l["label"] for l in wb.summary_lines if l.get("not_participating")],
        "sheets": sheets,
        "rate_card": {"install": install_card, "supply": supply_card},
        "prelims": {"weekly": prelims_weekly, "items": prelims_items, "programme_weeks": weeks},
        "contractor_items": contractor, "lump_sums": lump_sums,
        "delivery": delivery_info(wb),
        "ratios": wb.ratios,
        "attendance": wb.attendance,
    }
    analysis["agent_notes"] = agent_notes(wb, analysis)
    return analysis


def agent_notes(wb: BoqWorkbook, a: dict) -> list[str]:
    notes: list[str] = []
    notes.append("Unit-rate BOQ: every line is Quantity × Rate (€ per m / no / item / week / month); the rate already "
                 "covers labour, plant, consumables and margin. No hours, no hourly rate.")
    layouts = {s["layout"] for s in a["sheets"] if s.get("layout")}
    if layouts:
        names = {"A": "single install rate", "B": "install rate + material supply rate", "C": "phase split"}
        notes.append("Layout " + ", ".join(f"{l} ({names[l]})" for l in sorted(layouts)) + ".")
    # header note: does the header rate reflect "5 m containment + riser bend + bracketry"?
    hdr = [r for sh in wb.pricing_sheets for r in sh.rows if (r.attrs or {}).get("component") == "db_header"
           and r.install_rate]
    bends = [r.install_rate for sh in wb.pricing_sheets for r in sh.rows
             if (r.attrs or {}).get("component") == "bend" and r.install_rate]
    has_note = any(re.search(r"header\s+is\s+equal\s+to\s+5\s*m", n, re.I) for sh in wb.pricing_sheets for n in sh.notes)
    if hdr:
        rng = fmt_range(sorted({r.install_rate for r in hdr}))
        bend = statistics.median(bends) if bends else None
        if has_note and bend and max(r.install_rate for r in hdr) >= 2.5 * bend:
            notes.append(f"DB/Equip header = 5 m containment + 1 riser bend + bracketry here, so €{rng} per header, "
                         f"not the bare fitting rate (a bend is €{bend:g}).")
        elif has_note:
            notes.append(f"The BOQ says a DB/Equip header equals 5 m of containment + riser bend + bracketry, but it is "
                         f"priced like a fitting here (€{rng}). Treat header rates as project-specific.")
        else:
            notes.append(f"DB/Equip headers priced at €{rng}.")
    free = [s["title"] for sh in a["sheets"] for s in sh.get("sections", []) if s.get("basis") == "install_only"
            and re.search(r"free\s*issue", s["title"], re.I)]
    if free:
        notes.append("Free-issued sections (install rate only, supply stays empty): " + "; ".join(free[:6]) + ".")
    if a["not_participating"]:
        notes.append("Not priced on purpose (Summary says “Not participating”): " + "; ".join(a["not_participating"]) + ".")
    for d in a["delivery"]:
        if d.get("computed_percent"):
            notes.append(f"Materials delivery = {d['computed_percent']:g} % of the material-supply total "
                         f"(€{d['amount']:,.0f} on €{d['supply_total']:,.0f}, typed in as a number).")
    if a["prelims"]["programme_weeks"]:
        w = a["prelims"]["programme_weeks"]
        notes.append(f"Prelims run {w[0]:g}–{w[-1]:g} weeks" if len(w) > 1 else f"Prelims run {w[0]:g} weeks")
    for rr in a["ratios"][:4]:
        parts = ", ".join(f"{x['description'][:28]} {x['ratio']:g}×" for x in rr["rows"][:5])
        notes.append(f"Accessories per {rr['anchor'][:30]} ({rr['section'][:30]}): {parts}.")
    flagged = [r for sh in wb.pricing_sheets for r in sh.rows if "CONFLICTING_DESCRIPTION" in r.flags]
    for r in flagged[:3]:
        notes.append(f"Row {r.sheet} {r.row} is described as both 5-core and 3G (“{r.description[:60]}”): "
                     f"its supply rate is flagged, not learned.")
    return notes
