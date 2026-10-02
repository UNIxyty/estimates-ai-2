"""Unit-rate BOQs (EU data-centre subcontract BOQs): reading, analysis, ingestion. Synthetic workbooks follow the real
layouts; a separate test checks the real reference files when they are present (gitignored client data)."""
import agent_fixtures as fx  # noqa: I001  (sets env first)

import glob
import os

import pytest

from app import db
from app.unitrate.analysis import build_analysis
from app.unitrate.attributes import unit_rate_attributes
from app.unitrate.boq import is_unit_rate_workbook, norm_uom, read_boq
from app.unitrate.ratecard import card_label, rate_card
from fixtures.make_fixtures import build_all
from unitrate_fixtures import goodman_like


@pytest.fixture(scope="module")
def book(tmp_path_factory):
    p = str(tmp_path_factory.mktemp("ur") / "goodman_like.xlsx")
    goodman_like(p)
    return p


@pytest.fixture(scope="module")
def wb(book):
    return read_boq(book, file_name="3733 - Goodman AMS01 - Electrical Services Installation - BOQ.xlsx")


def _sheet(wb, name):
    return next(s for s in wb.sheets if s.name == name)


def test_detection_unit_rate_vs_latvian_tame(book, tmp_path):
    assert is_unit_rate_workbook(book)
    lv = build_all(str(tmp_path / "lv"))
    for k in ("lv", "lv_blank", "norms", "da"):
        assert not is_unit_rate_workbook(lv[k]), k  # norm-hours / hourly-rate columns → hourly_norm


def test_workbook_metadata_summary_and_not_participating(wb):
    assert wb.project == "Goodman AMS01" and wb.end_client == "Goodman" and wb.client == "Winthrop"
    assert wb.market == "NL" and wb.doc_date == "2025-07-01" and wb.package == "electrical"
    assert set(wb.subcontractor) == {"name", "offer_date", "validity"} and wb.subcontractor["name"]["cell"] == "E9"
    cable = next(l for l in wb.summary_lines if l["label"] == "Cable Installation")
    assert cable["not_participating"] and not any(l["not_participating"] for l in wb.summary_lines if l is not cable)
    supply = next(l for l in wb.summary_lines if "supply of the materials" in l["label"])
    assert supply["supply"] and supply["link"] == {"sheet": "Lighting Install", "cell": "J30"}


def test_layout_A_buildings_note_inputs_and_contractor_items(wb):
    sh = _sheet(wb, "Containment Install")
    assert sh.layout == "A" and [b["label"] for b in sh.buildings] == ["Building A", "Building B"]
    assert sh.cols["qty"] == "E" and sh.cols["rate"] == "G" and sh.cols["total"] == "H" and sh.input_fill
    assert any("DB/Equip Header is equal to 5 meters" in n for n in sh.notes)
    header = next(r for r in sh.rows if "DB/Equip Header" in r.description)
    assert header.install_rate == 150 and header.qty == 64 and header.attrs["component"] == "db_header"
    assert header.input_hint["rate"] and not header.input_hint["total"]  # total is a formula: not an input
    assert any("DB/Equip Header" in n for n in header.notes)  # the note travels with the rate
    tee = next(r for r in sh.rows if r.description.startswith("EXT - 300 x 60mm"))
    assert tee.attrs["component"] == "tee" and tee.attrs["width_mm"] == 300 and tee.attrs["finish"] == "EXT"
    kinds = {r.description.strip(): (r.kind, r.rate_basis) for r in sh.rows if r.kind != "item"}
    assert kinds["Accomondation"] == ("contractor", "monthly") and kinds["Tools"] == ("lump_sum", "lump_sum")


def test_layout_B_free_issue_supply_and_install_and_ratios(wb):
    sh = _sheet(wb, "Lighting Install")
    assert sh.layout == "B" and sh.has_supply and sh.cols["supply"] == "I" and sh.cols["supply_total"] == "J"
    lum = next(r for r in sh.rows if r.description.startswith("Type - A1"))
    assert lum.rate_basis == "install_only" and lum.install_rate == 30 and lum.supply_rate is None
    assert lum.attrs["free_issue"] and lum.attrs["type_code"] == "A1"
    cab = next(r for r in sh.rows if r.description.startswith("3C 2.5MM"))
    assert cab.rate_basis == "supply_and_install" and (cab.install_rate, cab.supply_rate) == (5, 1.46)
    assert cab.qty == 123 * 12 * 2  # live formula =C19*12 per building, evaluated without cached values
    rr = next(x for x in wb.ratios if x["section"].startswith("STANDARD CABLING"))
    by = {x["description"][:12]: x["ratio"] for x in rr["rows"]}
    assert rr["anchor"] == "Luminaire Bracket" and by["3C 2.5MM Cu "] == 12 and by["PG Glands"] == 4
    assert by["25MM CLASS4 "] == 3 and by["25MM GALV PL"] == 2.5


def test_layout_C_phases_by_formula_not_header_text(wb):
    sh = _sheet(wb, "BOQ labor+mat supply")
    assert sh.layout == "C" and sh.has_supply
    # the € column of phase 1 is labelled "Labor": found by its formula =C*M, not by the label
    assert [(p["label"], p["qty_col"], p["money_col"]) for p in sh.phases] == [
        ("Phase 1", "C", "D"), ("Phase 2", "E", "F"), ("Phase 3", "G", "H")]
    iso = next(r for r in sh.rows if r.description.startswith("16A 1PH"))
    assert iso.phase_qty == {"Phase 1": 10, "Phase 2": 4, "Phase 3": 2} and iso.qty == 16
    assert iso.attrs["amps"] == 16 and iso.attrs["phases"] == 1 and iso.attrs["product"] == "isolator"
    delivery = next(r for r in sh.rows if r.kind == "delivery")
    assert delivery.attrs["percent"] == 12 and delivery.attrs["amount"] == 600
    acc = next(r for r in sh.rows if r.description.startswith("Accomondation PHASE1"))
    assert acc.kind == "contractor" and acc.phase == "Phase 1" and acc.rate_basis == "monthly"


def test_prelims_and_analysis(wb):
    weekly = {p["description"]: (p["rate"], p["qty"]) for p in wb.prelims if p["rate_basis"] == "weekly"}
    assert weekly["Site Manager"] == (2200, 48) and weekly["Site Foreman"] == (1900, 48)
    a = build_analysis(wb)
    assert a["pricing_model"] == "unit_rate" and a["not_participating"] == ["Cable Installation"]
    assert a["prelims"]["programme_weeks"] == [48]
    d = a["delivery"][0]
    assert d["computed_percent"] is not None and d["typed_percent"] == 12
    assert any("Header = 5 m containment" in n or "header = 5 m containment" in n.lower() for n in a["agent_notes"])
    labels = {g["label"] for g in a["rate_card"]["install"]}
    assert {"Ladder straight · 300 mm", "Ladder bend", "Ladder DB/equip header", "Cable 3×2.5 mm²"} <= labels


def test_attributes_and_uom():
    assert norm_uom("Nr") == norm_uom("pcs") == norm_uom("no") == "no" and norm_uom("Wks") == "week"
    a = unit_rate_attributes("Cable Ties (203x4,6mm, 302x4,8mm)")
    assert a["product"] == "tie" and "mm2" not in a  # a tie's 4,6 mm width is not a 3×4.6 cable
    b = unit_rate_attributes("400V 3PH 63amp SEF Smoke Extract Fan")
    assert b["product"] == "connection" and b["amps"] == 63 and b["phases"] == 3
    c = unit_rate_attributes("1000mm 3 Tier", section="Bracketry")
    assert c["tiers"] == 3 and c["width_mm"] == 1000 and c["component"] == "tier_bracket"
    d = unit_rate_attributes("6MM 5CORE Cu Conductor, XLPE, LSOH (cable FXQ EASY 1kV 3G6 CPR)")
    assert (d["cores"], d["mm2"]) == (5, 6.0) and "conflict" in d  # own text wins; the 3G6 bracket is flagged
    e = unit_rate_attributes("3C 2.5MM  Cu Conductor, XLPE Insulation, LSOH (NHXMH-J 3x2.5)")
    assert (e["cores"], e["mm2"]) == (3, 2.5) and "conflict" not in e
    assert unit_rate_attributes("GALV BOX LID").get("component") is None  # a box lid is not a tray cover lid
    assert unit_rate_attributes("EXT - 300mm Cable Tray - (b) Tee Cover Lid")["component"] == "tee_cover_lid"


def test_ingestion_stores_unit_rate_items_and_analysis(book):
    fx.migrate()
    fid = fx.make_file_from_path(book, name="3733 - Goodman AMS01 - BOQ.xlsx") if hasattr(fx, "make_file_from_path") \
        else None
    if fid is None:
        import shutil
        import uuid
        from app.config import settings
        fid = str(uuid.uuid4())
        d = os.path.join(settings.data_dir, "knowledge", fid)
        os.makedirs(d, exist_ok=True)
        shutil.copyfile(book, os.path.join(d, "original.xlsx"))
        db.execute("""INSERT INTO files(id, original_name, ext, stored_path, tag) VALUES
                      (%s, '3733 - Goodman AMS01 - BOQ.xlsx', 'xlsx', %s, 'reference_estimate')""",
                   (fid, os.path.join(d, "original.xlsx")))
    try:
        from app.ingest import pipeline
        stats = pipeline.ingest_file({"file_id": fid})
        assert stats["pricing_model"] == "unit_rate"
        f = db.fetchone("SELECT * FROM files WHERE id=%s", (fid,))
        assert f["status"] == "analysed" and f["pricing_model"] == "unit_rate" and f["market"] == "NL"
        assert f["client"] == "Winthrop" and f["package"] == "electrical" and str(f["doc_date"]) == "2025-07-01"
        assert f["analysis"]["not_participating"] == ["Cable Installation"]
        items = db.fetchall("SELECT * FROM price_items WHERE file_id=%s", (fid,))
        assert items and all(i["pricing_model"] == "unit_rate" for i in items)
        cab = next(i for i in items if i["item_text"].startswith("3C 2.5MM"))
        assert float(cab["install_rate"]) == 5 and float(cab["supply_rate"]) == 1.46
        assert cab["rate_basis"] == "supply_and_install" and cab["package"] == "lighting"
        hdr = next(i for i in items if "DB/Equip Header" in i["item_text"])
        assert any("5 meters" in n for n in hdr["section_notes"]) and hdr["rate_key"] == "Ladder DB/equip header"
        sm = next(i for i in items if i["item_text"] == "Site Manager")
        assert sm["rate_basis"] == "weekly" and sm["package"] == "prelims" and float(sm["install_rate"]) == 2200
        assert db.fetchone("SELECT count(*) n FROM agent_notes WHERE file_id=%s", (fid,))["n"] >= 3
        sheets = db.fetchall("SELECT name, pricing_model, layout FROM file_sheets WHERE file_id=%s ORDER BY idx", (fid,))
        assert {s["name"]: s["layout"]["layout"] for s in sheets if s["layout"]["kind"] == "pricing"} == {
            "Containment Install": "A", "Lighting Install": "B", "BOQ labor+mat supply": "C"}
    finally:
        db.execute("DELETE FROM files WHERE id=%s", (fid,))


# ------------------------------------------------------------------ the real reference files (gitignored)

EU = os.environ.get("EU_BOQ_DIR") or os.path.join(os.path.dirname(__file__), "..", "..", "gate-estimates", "eu-boq")


@pytest.mark.skipif(not glob.glob(os.path.join(EU, "*.xlsx")), reason="EU BOQ reference files not present")
def test_real_reference_rate_card_matches_the_known_card():
    cards: dict[str, set] = {}
    for p in glob.glob(os.path.join(EU, "*.xlsx")):
        for g in rate_card(read_boq(p, file_name=os.path.basename(p))):
            cards.setdefault(g["label"], set()).update(g["install"])
    assert cards["Cable 3×2.5 mm²"] == {5} and cards["Cable 5×10 mm²"] == {7} and cards["Cable 5×16 mm²"] == {8}
    assert cards["Ladder bend"] <= {35, 45} and cards["Ladder tee"] == {40} and cards["Ladder reducer"] == {25}
    assert cards["Fire-rated JB"] == {18} and 100 in cards["Bracket 1000 mm · 1 tier"] | {100}
    assert cards["Bracket 600 mm · 3 tier"] == {45} and cards["Bracket 1000 mm · 1 tier"] == {40}
    assert 150 in cards["Isolator 100 A 3PH"]  # Goodman / FRA3H (FRA5's €28 is in the .xls GS file)


def test_card_label_examples():
    from app.unitrate.boq import BoqRow
    r = BoqRow(sheet="s", row=1, kind="item", description="EXT - 300 x 60mm Cable Tray - (b) Tee",
               attrs=unit_rate_attributes("EXT - 300 x 60mm Cable Tray - (b) Tee"))
    assert card_label(r) == "Tray tee (EXT)"
