import os
import shutil

import pytest

from app.ingest import formulas as fx
from app.ingest.readers import IngestError, convert_to_xlsx, read_any, read_xlsx
from app.ingest.util import parse_number
from fixtures.make_fixtures import build_all, soffice_convert


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    return build_all(str(tmp_path_factory.getbasetemp() / "ingest_fixtures"))


def test_parse_number_text_forms():
    assert parse_number("12,50") == 12.5
    assert parse_number("1 234,50") == 1234.5
    assert parse_number("1.234,50") == 1234.5
    assert parse_number("1,234.50") == 1234.5
    assert parse_number("€ 12.50") == 12.5
    assert parse_number("12,50 EUR") == 12.5
    assert parse_number("450 kr.") == 450
    assert parse_number("25%") == 0.25
    assert parse_number("(12,00)") == -12
    assert parse_number("-") is None
    assert parse_number("gab.") is None
    assert parse_number(3) == 3.0
    assert parse_number(True) is None


def test_xlsx_cells_formulas_merges(files):
    doc = read_xlsx(files["lv"])
    assert [s.name for s in doc.sheets] == ["Elektroinstalācija", "Vājstrāvas", "Kopsavilkums"]
    sd = doc.sheets[0]
    assert (5, 5, 5, 10) in sd.merged                 # "Vienības izmaksas" E5:J5
    assert (5, 11, 5, 15) in sd.merged
    assert sd.merged_range(5, 7) == (5, 5, 5, 10)
    c = sd.cell(9, 7)                                 # G9 = ROUND(E9*F9,2)
    assert c.is_formula and c.value == "=ROUND(E9*F9,2)"
    assert c.cached == pytest.approx(1.0)             # computed: openpyxl never caches values
    assert (9, 7) in sd.computed
    assert sd.cell(5, 2).bold
    assert "€" in sd.cell(9, 12).number_format
    assert sd.get(15, 8) == "6,80"                    # number stored as text is kept as text ...
    assert sd.get(15, 13) == pytest.approx(163.2)     # ... and still used by formulas (=D15*H15)
    summary = doc.sheets[2]
    assert summary.get(6, 2) == pytest.approx(summary.get(4, 2) + summary.get(5, 2))


def test_formula_parser_shapes():
    assert fx.shape("=G12*D12") == {"kind": "product", "refs": [(None, 7, 12), (None, 4, 12)], "const": 1.0}
    assert fx.shape("=SUM(J5:J40)") == {"kind": "sum_range", "range": (None, 10, 5, 10, 40)}
    s = fx.shape("=J41*0.2")
    assert s["kind"] == "scale" and s["ref"] == (None, 10, 41) and s["factor"] == pytest.approx(0.2)
    assert fx.shape("=J41*20%")["factor"] == pytest.approx(0.2)
    assert fx.shape("=J41/100*20")["factor"] == pytest.approx(0.2)
    assert fx.shape("=ROUND(E9*F9,2)")["kind"] == "product"
    assert fx.shape("=L9+M9+N9")["kind"] == "sum_refs"
    assert fx.shape("='Sheet 1'!B4")["ref"] == ("Sheet 1", 2, 4)
    vals = {(None, 1, 1): 2.0, (None, 2, 1): 3.0}
    assert fx.evaluate("=A1*B1+ROUND(10/3,2)", lambda s, c, r: vals.get((s, c, r))) == pytest.approx(9.33)
    assert fx.evaluate("=IF(A1>1,A1,0)", lambda s, c, r: vals.get((s, c, r))) == 2.0
    assert fx.parse_formula("=FOO(") is None


def test_docx_tables(files):
    doc = read_any(files["docx"])
    assert doc.kind == "docx"
    assert any("Cenu piedāvājums" in p for p in doc.paragraphs)
    t = doc.sheets[0]
    assert t.get(1, 2) == "Nosaukums"
    assert t.get(3, 5) == "11,18"


def test_pdf_text_and_tables(files):
    if not files["pdf"]:
        pytest.skip("reportlab not installed")
    doc = read_any(files["pdf"])
    assert doc.kind == "pdf" and doc.pages == 1
    assert doc.sheets and doc.sheets[0].get(1, 2) == "Description"
    assert any("Price offer" in p for p in doc.paragraphs)


def test_encrypted_pdf_clean_failure(files):
    if not files["encrypted_pdf"]:
        pytest.skip("pypdf not installed")
    with pytest.raises(IngestError) as e:
        read_any(files["encrypted_pdf"])
    assert e.value.reason.startswith("PDF is encrypted")


def test_scanned_pdf_clean_failure(files):
    if not files["scanned_pdf"]:
        pytest.skip("reportlab not installed")
    with pytest.raises(IngestError) as e:
        read_any(files["scanned_pdf"])
    assert e.value.reason.startswith("Scanned PDF: no text layer")


def test_missing_and_bad_files(tmp_path):
    with pytest.raises(IngestError):
        read_any(str(tmp_path / "nope.xlsx"))
    bad = tmp_path / "bad.xlsx"
    bad.write_bytes(b"not a zip at all")
    with pytest.raises(IngestError) as e:
        read_any(str(bad))
    assert "damaged" in e.value.reason or "could not be opened" in e.value.reason


@pytest.mark.skipif(not shutil.which("soffice") and not os.path.exists("/usr/bin/soffice"),
                    reason="LibreOffice not installed")
def test_xls_conversion_keeps_original(files, tmp_path):
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    xls = soffice_convert(files["lv"], "xls", str(src_dir))
    if not xls:
        pytest.skip("LibreOffice Calc (libreoffice-calc-nogui) not installed")
    assert xls.endswith(".xls")
    store = tmp_path / "knowledge" / "abc"
    store.mkdir(parents=True)
    original = store / "original.xls"
    shutil.copy(xls, original)
    before = original.read_bytes()
    doc = read_any(str(original), ext="xls")
    assert doc.work_path == str(store / "work.xlsx") and os.path.exists(doc.work_path)
    assert original.read_bytes() == before
    names = [s.name for s in doc.sheets]
    assert "Elektroinstalācija" in names
    sd = doc.sheets[0]
    # LibreOffice writes cached values, so no evaluation was needed for G9
    assert sd.get(9, 7) == pytest.approx(1.0)
    assert (5, 5, 5, 10) in sd.merged
    # concurrent conversions use separate LibreOffice profiles and don't clash
    from concurrent.futures import ThreadPoolExecutor
    outs = [str(tmp_path / f"par{i}.xlsx") for i in range(2)]
    with ThreadPoolExecutor(2) as ex:
        res = list(ex.map(lambda o: convert_to_xlsx(str(original), o), outs))
    assert res == outs and all(os.path.getsize(o) > 0 for o in outs)
