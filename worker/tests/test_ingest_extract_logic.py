import pytest

from app.ingest.extract import extract_norms, extract_prices
from app.ingest.logic import derive_logic
from app.ingest.structure import analyse_workbook
from fixtures.make_fixtures import build_all


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    return build_all(str(tmp_path_factory.getbasetemp() / "ingest_fixtures"))


@pytest.fixture(scope="module")
def lv(files):
    return analyse_workbook(files["lv"])


def _by_row(recs, sheet, row):
    return next(r for r in recs if r.sheet_name == sheet and r.row_idx == row)


def test_lv_price_records(lv):
    recs = extract_prices(lv, tag="reference_estimate")
    assert len(recs) == 14
    r = _by_row(recs, "Elektroinstalācija", 9)
    assert r.item_text == "Kabelis NYM-J 3x1,5 mm²"
    assert r.item_norm == "kabelis nym j 3x1.5 mm2"
    assert (r.unit, r.unit_norm, r.qty) == ("m", "m", 120)
    assert r.norm_h_per_unit == pytest.approx(0.08)
    assert r.unit_labour == pytest.approx(1.0) and r.unit_material == pytest.approx(0.65)
    assert r.total_labour == pytest.approx(120) and r.total_material == pytest.approx(78)
    assert r.hourly_rate == 12.5 and r.currency == "EUR"
    assert r.attrs["cores"] == 3 and r.attrs["cross_section_mm2"] == 1.5 and r.category == "cable"
    assert r.section_title == "Kabeļi un caurules"
    assert r.source_cells["unit_labour"] == "G9" and r.source_cells["qty"] == "D9"
    board = _by_row(recs, "Elektroinstalācija", 18)
    assert board.unit_norm == "set" and board.attrs["modules"] == 36 and board.norm_h_per_unit == 5.5
    ground = _by_row(recs, "Vājstrāvas", 15)
    assert ground.hourly_rate == 15.0 and ground.unit_labour == pytest.approx(18.0)


def test_derivations_from_totals(files):
    ws = analyse_workbook(files["da"])
    recs = extract_prices(ws)
    r = recs[0]                                        # Stikkontakt: 20 stk, 0.4 h, 85 kr, 450 kr/h
    assert r.unit_labour == pytest.approx(180.0)       # derived: 3600 / 20
    assert "unit_labour" in r.derived
    assert r.norm_h_per_unit == pytest.approx(0.4) and r.hourly_rate == 450
    assert r.unit_material == pytest.approx(85) and r.currency == "DKK"
    assert r.source_ref == "Solar prisliste 2024" and r.attrs["source_ref"] == "Solar prisliste 2024"
    assert r.unit_norm == "pcs" and recs[1].unit_norm == "m"      # "lbm"


def test_norm_from_labour_and_rate(tmp_path):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws["A1"] = "Stundas likme 20 EUR/h"
    ws.append([])
    ws.append(["Nr.", "Darba nosaukums", "Mērv.", "Daudz.", "Darba alga uz vienību", "Materiāli uz vienību",
               "Darba alga kopā", "Materiāli kopā"])
    ws.append([1, "Kontaktligzda", "gab.", 10, 6.0, 5.0, 60.0, 50.0])
    ws.append([2, "Slēdzis", "gab.", 4, 5.0, 3.0, 20.0, 12.0])
    p = tmp_path / "rate.xlsx"
    wb.save(p)
    st = analyse_workbook(str(p))
    assert st.sheets[0].hourly_rates[0]["rate"] == 20 and st.sheets[0].hourly_rates[0]["source"] == "cell A1"
    recs = extract_prices(st)
    assert recs[0].norm_h_per_unit == pytest.approx(0.3) and "norm_h" in recs[0].derived


def test_blank_yields_no_price_records(files):
    ws = analyse_workbook(files["lv_blank"])
    assert extract_prices(ws) == []


def test_docx_combined_price(files):
    recs = extract_prices(analyse_workbook(files["docx"]))
    assert len(recs) == 3
    assert recs[0].unit_material == pytest.approx(1.65) and recs[0].attrs["combined_price"] is True


def test_norm_records(files):
    ws = analyse_workbook(files["norms"], tag="hourly_norms")
    norms = extract_norms(ws, tag="hourly_norms")
    by = {(n.sheet_name, n.row_idx): n for n in norms}
    cat = by[("Laika normas", 4)]
    assert cat.specificity == "category" and cat.category == "cable" and cat.hours == 0.08
    assert cat.item_text == "Kabeļi"
    p36 = by[("Laika normas", 9)]
    assert p36.specificity == "parameterised" and p36.params == {"modules": 36} and p36.hours == 5.5
    assert p36.category == "distribution_board" and p36.unit_norm == "pcs"
    item = by[("Laika normas", 7)]
    assert item.specificity == "item" and item.category == "socket"
    assert by[("Laika normas", 8)].hours == pytest.approx(0.3)            # "0,30" as text
    assert by[("Laika normas", 11)].specificity == "category"
    assert by[("Laika normas", 11)].category == "distribution_board"
    en = by[("Norms EN", 2)]
    assert en.specificity == "parameterised" and en.params == {"modules": 36} and en.hours == 5.5
    assert extract_prices(ws, tag="hourly_norms") == []


def test_logic_sentences_lv(lv):
    logic = {r.logic_key: r for r in derive_logic(lv)}
    lab = logic["sheet:Elektroinstalācija:labour"]
    assert lab.kind == "labour"
    assert lab.sentence.startswith("Labour per unit = norm (h) × hourly rate 12.50 EUR/h; row labour = qty × unit labour.")
    assert lab.numbers["hourly_rate"] == 12.5 and lab.numbers["confirmed_by"] == "formulas"
    assert lab.numbers["rounding"] == 2
    rate = logic["sheet:Elektroinstalācija:rate"]
    assert rate.kind == "rate" and rate.numbers["hourly_rate"] == 12.5
    assert logic["sheet:Elektroinstalācija:material"].numbers["confirmed_by"] == "formulas"
    sub = logic["sheet:Elektroinstalācija:subtotal"]
    assert sub.kind == "subtotal" and "=SUM(" in sub.sentence
    ovh = logic["sheet:Elektroinstalācija:markup:virsizdevumi"]
    assert ovh.kind == "markup" and ovh.numbers["pct"] == pytest.approx(0.08) and ovh.numbers["base"] == "total"
    assert ovh.numbers["confirmed_by"] == "formula"
    soc = logic["sheet:Elektroinstalācija:markup:darba_deveja_socialais_nodoklis"]
    assert soc.numbers["base"] == "labour" and soc.numbers["pct"] == pytest.approx(0.2359)
    tr = logic["sheet:Elektroinstalācija:markup:transporta_izdevumi"]
    assert tr.numbers["base"] == "material" and tr.numbers["pct"] == pytest.approx(0.03)
    assert tr.sentence.startswith("Transport costs")
    # per-section rates on the second sheet
    assert logic["sheet:Vājstrāvas:section:zemejums:rate"].numbers["hourly_rate"] == 15.0
    assert "section's hourly rate" in logic["sheet:Vājstrāvas:labour"].sentence
    # keys are stable across runs
    assert [r.logic_key for r in derive_logic(lv)] == [r.logic_key for r in derive_logic(lv)]
    assert all(r.kind in ("labour", "material", "subtotal", "markup", "rate", "other") for r in logic.values())


def test_logic_sentences_da(files):
    logic = {r.logic_key: r for r in derive_logic(analyse_workbook(files["da"]))}
    lab = logic["sheet:Tilbud:labour"]
    assert lab.sentence.startswith("Row labour = qty × norm (h) × hourly rate 450.00 DKK/h.")
    assert lab.numbers["confirmed_by"] == "formulas"
    moms = logic["sheet:Tilbud:markup:moms"]
    assert moms.numbers["base"] == "total_with_markups" and moms.numbers["pct"] == pytest.approx(0.25)
    assert "Solar prisliste 2024" in logic["sheet:Tilbud:material"].sentence
