"""Fill a blank: one setup card (the hourly rate, always; which sheets, when there is a choice) → detect language →
price every row at that rate → write values into a copy of the blank in the blank's own language."""
from __future__ import annotations

import os
import re

from .. import db
from ..ingest.structure import analyse_workbook
from ..unitrate import run as unit_rate_run
from ..unitrate.boq import is_unit_rate_workbook
from . import cards, common
from .context import RunContext, RunWaiting
from .pricing import RowSpec
from .writer import layout_from_structure

UNSURE_LOW, UNSURE_HIGH = 0.35, 0.7
SUGGEST_AT = 0.6

PRICE_MEANINGS = {"norm_h", "hourly_rate", "unit_labour", "unit_material", "unit_total",
                  "total_norm_h", "total_labour", "total_material", "total"}
_TAME_NAME = re.compile(r"t[aā]m|estimate|kalkul|tilbud|overslag|kalkyl|eelarve|s[aą]mata", re.I)


def _meanings(sheet) -> set[str]:
    return {c.meaning for c in getattr(sheet, "columns", []) or [] if getattr(c, "meaning", None)}


def sheet_confidence(sheet) -> tuple[float, str]:
    """How likely this sheet is the one to price: it must have somewhere to write prices (price + quantity
    columns), then electrical content, then Tāme-style layout. Returns (0..1, plain-English reason)."""
    meanings = _meanings(sheet)
    price_cols = len(meanings & PRICE_MEANINGS)
    fill = min(1.0, price_cols / 4) * (1.0 if "qty" in meanings else 0.6)
    elec = float(sheet.electrical_confidence or 0)
    unit_block = bool({"unit_labour", "unit_material"} & meanings and {"total_labour", "total_material", "total"} & meanings)
    tame = 1.0 if (_TAME_NAME.search(sheet.name or "") or unit_block) else 0.0
    conf = round(0.55 * fill + 0.30 * elec + 0.15 * tame, 2)
    if price_cols == 0:
        why = "no price columns to fill (looks like a specification)"
    else:
        why = f"{price_cols} price column{'s' if price_cols != 1 else ''}" + (", Tāme layout" if tame else "")
        why += ", electrical items" if elec >= UNSURE_HIGH else ", few electrical words" if elec < UNSURE_LOW else ""
    return conf, why


def rank_sheets(candidates: list) -> list[tuple[object, float, str]]:
    ranked = [(s, *sheet_confidence(s)) for s in candidates]
    # When some sheet can be filled, specification-only sheets (no price columns) are never suggested.
    if any(_meanings(s) & PRICE_MEANINGS for s in candidates):
        ranked = [(s, c if _meanings(s) & PRICE_MEANINGS else min(c, 0.3), w) for s, c, w in ranked]
    return sorted(ranked, key=lambda x: -x[1])


def _parse_rate(v) -> float | None:
    if isinstance(v, (int, float)):
        return float(v) if v > 0 else None
    m = re.search(r"\d+(?:[.,]\d+)?", str(v or ""))
    if not m:
        return None
    f = float(m.group(0).replace(",", "."))
    return f if 0 < f < 1000 else None


def _item_rows(sheet) -> list[RowSpec]:
    specs = []
    for r in sheet.rows:
        if r.kind != "item" or not (r.text or "").strip():
            continue
        specs.append(RowSpec(sheet=sheet.name, row=r.row, text=r.text.strip(), unit=r.unit,
                             qty=float(r.qty) if isinstance(r.qty, (int, float)) else None,
                             section=getattr(r, "section_title", None)))
    return specs


def _sheet_rate(sheet) -> float | None:
    for hr in getattr(sheet, "hourly_rates", None) or []:
        rate = hr.get("rate") if isinstance(hr, dict) else None
        if rate:
            return float(rate)
    return None


def run(rc: RunContext, upload: dict) -> None:
    st = rc.state
    path = common.ensure_xlsx(upload["stored_path"])
    if rc.state.get("pricing_model") == "unit_rate" or is_unit_rate_workbook(path):
        # Quantity × unit rate (EU BOQs): a different pricing model with its own setup and references
        unit_rate_run.run(rc, upload, path)
        return
    rc.emitter.step_started("read", f"Reading {upload['original_name']}")
    structure = analyse_workbook(path)
    candidates = [s for s in structure.sheets if any(r.kind == "item" for r in s.rows)]
    rc.emitter.step_done("read", f"{len(structure.sheets)} sheet(s), {sum(len(_item_rows(s)) for s in candidates)} "
                                 f"item rows")
    if not candidates:
        msg = rc.new_assistant_message()
        rc.complete_message(str(msg["id"]), content="I couldn't find any item rows (text + quantity) in this file. "
                                                    "Is it an estimate blank?")
        return

    # 1. setup card: the hourly rate (always asked; prefilled from the blank) + which sheets (when there's a choice)
    rc.emitter.step_started("sheets", "Detecting the sheets to price")
    if "sheets" not in st or "target_rate" not in st:
        ranked = rank_sheets(candidates)
        suggested = [s.name for s, c, _ in ranked if c >= SUGGEST_AT] or [ranked[0][0].name]
        blank_rate = next((r for r in (_sheet_rate(s) for s, _, _ in ranked if s.name in suggested) if r), None)
        card_id = st.get("setup_card_id") or st.get("sheet_card_id")
        if card_id:
            card = cards.get(card_id)
            answers = cards.decision_data(card).get("answers") or {}
            picked = answers.get("sheets") or answers.get("q1")
            picked = picked if isinstance(picked, list) else [picked] if picked else []
            st["sheets"] = [n for n in picked if any(s.name == n for s in candidates)] or suggested
            st["target_rate"] = _parse_rate(answers.get("hourly_rate")) or blank_rate or rc.kb.default_hourly_rate(rc.allowed)
            st["rate_source"] = "you" if _parse_rate(answers.get("hourly_rate")) else "blank" if blank_rate else "references"
        else:
            cur = structure.currency or "EUR"
            ref_rate = rc.kb.default_hourly_rate(rc.allowed)
            questions = [{"id": "hourly_rate", "type": "number", "unit": f"{cur}/h",
                          "text": "Hourly labour rate for this estimate",
                          "default": blank_rate or ref_rate,
                          "hint": (f"Found in the blank: {blank_rate:g} {cur}/h." if blank_rate else
                                   f"Not in the blank. Your references average {ref_rate:g} {cur}/h." if ref_rate else
                                   "Not in the blank. Every labour row is priced at this rate.")}]
            if len(candidates) > 1:
                questions.insert(0, {"id": "sheets", "text": "Which sheets should I price?", "multi": True,
                                     "options": [s.name for s, _, _ in ranked], "suggested": suggested,
                                     "option_meta": {s.name: {"confidence": c, "reason": w} for s, c, w in ranked}})
            msg = rc.new_assistant_message()
            card = cards.create(rc.run, "clarify", {"purpose": "confirm_setup", "questions": questions},
                                message_id=str(msg["id"]))
            rc.save_state(setup_card_id=str(card["id"]))
            rc.complete_message(str(msg["id"]), content="Before I price this blank, confirm the hourly rate"
                                                        + (" and the sheets." if len(candidates) > 1 else "."))
            rc.emitter.step_warn("sheets", "Waiting for you to confirm the rate" + (" and sheets" if len(candidates) > 1 else ""))
            raise RunWaiting()
        rc.save_state(sheets=st["sheets"], target_rate=st["target_rate"], rate_source=st["rate_source"])
    chosen = [s for s in candidates if s.name in st["sheets"]]
    rc.emitter.step_done("sheets", ", ".join(s.name for s in chosen))

    # 2. language of the blank
    lang = structure.language or (chosen[0].language if chosen else None)
    rc.emitter.step_started("language", "Detecting the blank's language")
    rc.emitter.step_done("language", lang or "unknown")

    # 3. price every row
    specs = [sp for s in chosen for sp in _item_rows(s)]
    target_rate = st.get("target_rate")
    rc.save_state(lang=lang)
    if target_rate:
        rc.emitter.step_started("rate", "Hourly rate")
        rc.emitter.step_done("rate", f"{target_rate:g} {structure.currency or 'EUR'}/h for every labour row "
                                     f"(from {st.get('rate_source') or 'you'})")
    priced, stats = common.price_with_events(rc, specs, task="fill_blank", target_rate=target_rate)
    rc.check()

    # 4. write into a copy of the blank
    layouts = {s.name: layout_from_structure(s) for s in chosen}
    base = os.path.splitext(upload["original_name"])[0]
    common.finish_priced(rc, priced=priced, stats=stats, layouts=layouts, src_path=path,
                         name=f"{base} — priced.xlsx", mode="fill", lang=lang,
                         currency=structure.currency or "EUR", sheets=[s.name for s in chosen],
                         source_upload_id=str(upload["id"]))
    if rc.state.get("pending"):
        raise RunWaiting()
