"""Fill a blank: detect electrical sheets (ask when unsure) → detect language → price every row →
write values into a copy of the blank in the blank's own language."""
from __future__ import annotations

import os

from .. import db
from ..ingest.structure import analyse_workbook
from . import cards, common
from .context import RunContext, RunWaiting
from .pricing import RowSpec
from .writer import layout_from_structure

UNSURE_LOW, UNSURE_HIGH = 0.35, 0.7


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

    # 1. which sheets are electrical — ask only when unsure
    rc.emitter.step_started("sheets", "Detecting electrical sheets")
    if "sheets" not in st:
        sure = [s for s in candidates if s.is_electrical and s.electrical_confidence >= UNSURE_HIGH]
        unsure = [s for s in candidates if UNSURE_LOW < (s.electrical_confidence or 0) < UNSURE_HIGH]
        if len(candidates) == 1 and not unsure:
            st["sheets"] = [candidates[0].name]
        elif sure and not unsure:
            st["sheets"] = [s.name for s in sure]
        elif st.get("sheet_card_id"):
            card = cards.get(st["sheet_card_id"])
            answers = cards.decision_data(card).get("answers") or {}
            picked = answers.get("sheets") or answers.get("q1")
            picked = picked if isinstance(picked, list) else [picked] if picked else []
            st["sheets"] = [n for n in picked if any(s.name == n for s in candidates)] or [s.name for s in sure]
        else:
            msg = rc.new_assistant_message()
            card = cards.create(rc.run, "clarify", {"purpose": "confirm_sheets", "questions": [{
                "id": "sheets", "text": "Which sheets should I price as electrical works?", "multi": True,
                "options": [s.name for s in candidates],
                "suggested": [s.name for s in candidates if s.is_electrical]}]}, message_id=str(msg["id"]))
            rc.save_state(sheet_card_id=str(card["id"]))
            rc.complete_message(str(msg["id"]), content="I'm not sure which sheets are electrical. "
                                                        "Please confirm before I price them.")
            rc.emitter.step_warn("sheets", "Waiting for you to confirm the electrical sheets")
            raise RunWaiting()
        rc.save_state(sheets=st["sheets"])
    chosen = [s for s in candidates if s.name in st["sheets"]]
    rc.emitter.step_done("sheets", ", ".join(s.name for s in chosen))

    # 2. language of the blank
    lang = structure.language or (chosen[0].language if chosen else None)
    rc.emitter.step_started("language", "Detecting the blank's language")
    rc.emitter.step_done("language", lang or "unknown")

    # 3. price every row
    specs = [sp for s in chosen for sp in _item_rows(s)]
    target_rate = next((r for r in (_sheet_rate(s) for s in chosen) if r), None)
    rc.save_state(lang=lang, target_rate=target_rate)
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
