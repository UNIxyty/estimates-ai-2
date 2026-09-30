import time

from app.ingest.extract import extract_prices
from app.ingest.structure import analyse_workbook
from fixtures.make_fixtures import make_big


def test_5000_row_workbook_is_fast(tmp_path):
    path = make_big(str(tmp_path / "big.xlsx"), rows=5000, cols=15)
    t = time.monotonic()
    ws = analyse_workbook(path)
    recs = extract_prices(ws)
    elapsed = time.monotonic() - t
    s = ws.sheets[0]
    assert len(recs) == 4900 and len(s.sections) == 100
    assert s.unit_block["unit_labour"] == "G" and s.total_block["total"] == "O"
    assert elapsed < 12, f"5,000 rows took {elapsed:.1f}s"
