"""Timing: first conversion of a 5,000 x 15 sheet and page-fetch latency through the router.

Numbers are printed (run with ``-s`` to see them); assertions are loose ceilings so CI stays stable.
"""
from __future__ import annotations

import random
import statistics
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.docview import api, cache
from app.docview.resolve import Target
from test_docview_helpers import make_big_xlsx, patch_settings

ROWS, COLS = 5000, 15


@pytest.fixture(scope="module")
def setup(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    d = tmp_path_factory.mktemp("perf")
    patch_settings(mp, data_dir=str(d / "data"), internal_token="")
    mp.setenv("ALLOW_NO_INTERNAL_TOKEN", "1")
    mp.setenv("DOCVIEW_USE_INGEST", "0")
    path = make_big_xlsx(str(d / "big.xlsx"), ROWS, COLS)
    fid = "00000000-0000-4000-8000-000000000001"
    target = Target("file", fid, "xlsx", path, path, "xlsx", "big.xlsx", "application/octet-stream")
    mp.setattr(api, "resolve", lambda kind, id_, need_view=True: target)  # no DB needed for timing
    app = FastAPI()
    app.include_router(api.router)
    cache.clear_memory()
    yield TestClient(app), fid, path
    cache.clear_memory()
    mp.undo()


def _ms(samples):
    s = sorted(samples)
    return (f"median={statistics.median(s) * 1000:.1f}ms p95={s[int(len(s) * 0.95) - 1] * 1000:.1f}ms "
            f"max={s[-1] * 1000:.1f}ms")


def test_timings(setup):
    client, fid, path = setup
    c0 = cache.stats["conversions"]

    t = time.perf_counter()
    r = client.get("/internal/view/sheets", params={"kind": "file", "id": fid})
    first = time.perf_counter() - t
    assert r.status_code == 200 and cache.stats["conversions"] == c0 + 1
    meta = r.json()["sheets"][0]
    assert meta["row_count"] == ROWS and meta["col_count"] == COLS

    rng = random.Random(7)
    pages = []
    size = 0
    for _ in range(40):
        off = rng.randrange(0, ROWS - 200)
        t = time.perf_counter()
        r = client.get("/internal/view/rows", params={"kind": "file", "id": fid, "sheet": 0, "offset": off,
                                                       "limit": 200})
        pages.append(time.perf_counter() - t)
        assert r.status_code == 200 and len(r.json()["rows"]) == 200
        size = len(r.content)

    searches = []
    for q in ("rinda 12", "nym 3x2", "sadaļa", "249.60", "nav tāda"):
        t = time.perf_counter()
        r = client.get("/internal/view/rows", params={"kind": "file", "id": fid, "q": q, "limit": 200})
        searches.append(time.perf_counter() - t)
        assert r.status_code == 200

    arounds = []
    for row in (1, 2500, 4999):
        t = time.perf_counter()
        r = client.get("/internal/view/rows", params={"kind": "file", "id": fid, "around": row, "limit": 200})
        arounds.append(time.perf_counter() - t)
        assert any(x["r"] == row for x in r.json()["rows"])

    cache.clear_memory()  # simulate a worker restart: disk cache, no reconversion
    t = time.perf_counter()
    r = client.get("/internal/view/rows", params={"kind": "file", "id": fid, "offset": 0, "limit": 200})
    disk = time.perf_counter() - t
    assert r.status_code == 200 and cache.stats["conversions"] == c0 + 1

    print(f"\n[docview perf {ROWS}x{COLS}] first conversion (via /sheets): {first * 1000:.0f}ms")
    print(f"[docview perf] page fetch limit=200 (40 random offsets): {_ms(pages)}; page JSON {size / 1024:.0f} KiB")
    print(f"[docview perf] search q (5 queries): {_ms(searches)}")
    print(f"[docview perf] around (3 jumps): {_ms(arounds)}")
    print(f"[docview perf] first page after memory clear (gzip disk cache): {disk * 1000:.0f}ms")

    assert first < 60
    assert statistics.median(pages) < 0.25
    assert disk < first
