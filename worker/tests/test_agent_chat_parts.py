"""Structured message parts the chat UI renders: file chips with an optional sheet/row, the amber
"nothing found" note, the document card's sheet list and the Language choice on the structure card."""
import agent_fixtures as fx  # noqa: I001  (sets env first)

from types import SimpleNamespace

import pytest

from app import db
from app.agent import common, qa
from app.agent import run as agent_run
from app.agent.pricing import PricedRow, RowSpec
from app.llm import client as llm
from test_agent_generate_e2e import _decide, _ref_file


def _rc(doc_id: str = "d1"):
    kb = SimpleNamespace(files={"f1": {"name": "norms.docx"}}, file_name=lambda fid: "norms.docx")
    return SimpleNamespace(latest_document=lambda: {"id": doc_id}, kb=kb)


def test_file_chip_with_and_without_row():
    parts = qa.to_parts(_rc(), "See [[file:f1]] and [[file:f1!EL!103]], and [[row:EL!58]].")
    chips = [p for p in parts if p["type"] == "chip"]
    assert chips[0] == {"type": "chip", "kind": "file", "file_id": "f1", "label": "norms.docx"}
    assert chips[1] == {"type": "chip", "kind": "file", "file_id": "f1", "label": "norms.docx", "sheet": "EL", "row": 103}
    assert chips[2]["kind"] == "row" and chips[2]["sheet"] == "EL" and chips[2]["row"] == 58
    assert qa._plain(parts) == "See norms.docx and norms.docx, and Row 58."


def test_unknown_file_marker_stays_text():
    parts = qa.to_parts(_rc(), "[[file:nope!EL!1]]")
    assert parts == [{"type": "text", "text": "[[file:nope!EL!1]]"}]


def test_no_price_rows_get_a_warn_note_with_chips():
    ok = PricedRow(spec=RowSpec(sheet="EL", row=5, text="Kabelis", qty=1), unit_labour=1.0)
    none = PricedRow(spec=RowSpec(sheet="EL", row=9, text="Zibensaizsardzība", qty=1), flags=["NO PRICE"])
    doc = {"id": "d1", "totals": {"labour": 1, "material": 0, "total": 1}, "currency": "EUR"}
    stats = {"exact": 1, "semantic": 0, "norm": 0, "model": 0, "web": 0}
    text, parts = common.summary_parts(doc, [ok, none], stats, lang="LV", sheets=["EL"], lead="Priced 1 of 2 rows.")
    note = next(p for p in parts if p.get("tone") == "warn")
    assert note["text"].startswith("I couldn't find a price for 1 row ")
    i = parts.index(note)
    assert parts[i + 1] == {"type": "chip", "kind": "row", "document_id": "d1", "sheet": "EL", "row": 9,
                            "label": "EL · row 9"}
    assert note["text"] in text


@pytest.fixture()
def _gen_env():
    fx.migrate()
    object.__setattr__(llm.settings, "llm_enabled", False)
    created: list[str] = []
    yield created
    object.__setattr__(llm.settings, "llm_enabled", True)
    fx.cleanup_files(created)
    db.execute("DELETE FROM jobs")


def test_generate_uses_language_chosen_on_the_card_and_document_card_lists_sheets(_gen_env):
    ref = _ref_file("Tame_lang.xlsx")
    _gen_env.append(ref)
    conv = fx.make_conversation(fx.make_user())
    run = fx.make_run(conv, allowed=[ref], text=(
        "Sagatavo tāmi:\n1. Kabelis NYM-J 3x1,5 mm2 guldīšana — 200 m\n2. Kabelis NYM-J 5x2,5 mm2 guldīšana — 60 m\n"
        "3. Kontaktligzda 2-vietīga IP44 montāža — 18 gab.\n"))
    rid = str(run["id"])
    agent_run.run_agent({"run_id": rid})
    card = db.fetchone("SELECT * FROM cards WHERE run_id=%s AND kind='structure'", (rid,))
    assert card, db.fetchone("SELECT status, error FROM runs WHERE id=%s", (rid,))
    assert card["payload"]["language"] == "LV"
    _decide(str(card["id"]), "generate", {"language": "en"})
    agent_run.resume_run({"run_id": rid, "card_id": str(card["id"])})
    doc = db.fetchone("SELECT * FROM documents WHERE run_id=%s", (rid,))
    assert doc["language"] == "EN"
    dcard = db.fetchone("SELECT * FROM cards WHERE run_id=%s AND kind='document'", (rid,))
    assert dcard["payload"]["sheets"] == ["Elektro"]
