"""Internal viewer API end to end against the test DB (files, documents, estimate_rows markers)."""
from __future__ import annotations

import os
import shutil
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.docview import cache
from test_docview_helpers import (TEST_DB_URL, make_big_xlsx, make_docx, make_estimate_xlsx, patch_settings,
                                  write_garbage)

psycopg = pytest.importorskip("psycopg")


def _db_ok() -> bool:
    try:
        with psycopg.connect(TEST_DB_URL, connect_timeout=3) as c:
            c.execute("SELECT 1 FROM estimate_rows LIMIT 1")
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _db_ok(), reason="test database not reachable")


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    """Settings + DB rows: a user, conversation, document with estimate_rows, and knowledge files."""
    mp = pytest.MonkeyPatch()
    data = tmp_path_factory.mktemp("data")
    patch_settings(mp, data_dir=str(data), database_url=TEST_DB_URL, internal_token="")
    mp.setenv("ALLOW_NO_INTERNAL_TOKEN", "1")
    mp.setenv("DOCVIEW_USE_INGEST", "0")
    from app import db

    db.reset_pool()
    cache.clear_memory()

    def put(rel: str, maker) -> str:
        full = os.path.join(str(data), rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        maker(full)
        return rel

    ids = {k: str(uuid.uuid4()) for k in ("xlsx", "xls_ready", "xls_pending", "docx", "pdf", "deleted",
                                          "bad_xlsx", "bad_docx", "missing")}
    files = {
        "xlsx": ("xlsx", put(f"knowledge/{ids['xlsx']}/original.xlsx", make_estimate_xlsx), None, None),
        "xls_ready": ("xls", put(f"knowledge/{ids['xls_ready']}/original.xls", write_garbage),
                      put(f"knowledge/{ids['xls_ready']}/work.xlsx", make_estimate_xlsx), None),
        "xls_pending": ("xls", put(f"knowledge/{ids['xls_pending']}/original.xls", write_garbage), None, None),
        "docx": ("docx", put(f"knowledge/{ids['docx']}/original.docx", make_docx), None, None),
        "pdf": ("pdf", put(f"knowledge/{ids['pdf']}/original.pdf",
                           lambda p: write_garbage(p, b"%PDF-1.4\n%%EOF\n")), None, None),
        "deleted": ("xlsx", put(f"knowledge/{ids['deleted']}/original.xlsx", make_estimate_xlsx), None, "now()"),
        "bad_xlsx": ("xlsx", put(f"knowledge/{ids['bad_xlsx']}/original.xlsx", write_garbage), None, None),
        "bad_docx": ("docx", put(f"knowledge/{ids['bad_docx']}/original.docx", write_garbage), None, None),
        "missing": ("xlsx", f"knowledge/{ids['missing']}/original.xlsx", None, None),
    }
    for key, (ext, stored, work, deleted) in files.items():
        db.execute(
            "INSERT INTO files (id, original_name, ext, stored_path, work_path, deleted_at, status) "
            f"VALUES (%s, %s, %s, %s, %s, {deleted or 'NULL'}, 'analysed')",
            (ids[key], f"{key}.{ext}", ext, stored, work))

    user = db.fetchone("INSERT INTO users (email, name, status) VALUES (%s, 'DocView Test', 'active') RETURNING id",
                       (f"docview-{uuid.uuid4().hex[:8]}@example.com",))["id"]
    conv = db.fetchone("INSERT INTO conversations (user_id, title) VALUES (%s, 'docview') RETURNING id",
                       (user,))["id"]
    doc_id = str(uuid.uuid4())
    doc_rel = put(f"documents/{doc_id}/v1.xlsx", lambda p: make_big_xlsx(p, 1500))
    db.execute("INSERT INTO documents (id, conversation_id, user_id, name, stored_path, mode) "
               "VALUES (%s, %s, %s, 'Tāme objektam', %s, 'fill')", (doc_id, conv, user, doc_rel))
    marker_rows = {
        3: (["WEB"], "web", "medium", 70),
        4: (["CHECK"], "semantic", "low", 45),
        5: (["NO PRICE", "CHECK"], "none", None, None),
        6: (["EDITED", "WEB"], "edited", "high", 100),
        7: ([], "exact", "high", 98),
        8: (["WEB", "CHECK"], "web", "low", 30),
        1203: (["NO PRICE"], "none", None, None),
    }
    for r, (flags, src, conf, pct) in marker_rows.items():
        db.execute(
            "INSERT INTO estimate_rows (document_id, sheet_name, row_idx, item_text, price_source, confidence, "
            "confidence_pct, flags) VALUES (%s, 'Big', %s, %s, %s, %s, %s, %s)",
            (doc_id, r, f"row {r}", src, conf, pct, flags))
    # a row on another sheet name must not leak into this sheet
    db.execute("INSERT INTO estimate_rows (document_id, sheet_name, row_idx, item_text, price_source, flags) "
               "VALUES (%s, 'Other', 3, 'x', 'none', '{NO PRICE}')", (doc_id,))

    from app.docview.api import router

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    yield {"client": client, "ids": ids, "doc": doc_id, "data": str(data), "mp": mp}

    db.execute("DELETE FROM files WHERE id = ANY(%s::uuid[])", (list(ids.values()),))
    db.execute("DELETE FROM users WHERE id = %s", (user,))  # cascades conversations/documents/estimate_rows
    db.reset_pool()
    mp.undo()
    cache.clear_memory()
    shutil.rmtree(str(data), ignore_errors=True)


def get(world, path, **params):
    return world["client"].get(f"/internal/view/{path}", params=params)


# ------------------------------------------------------------------ auth

def test_token_required(world, monkeypatch):
    fid = world["ids"]["xlsx"]
    assert get(world, "sheets", kind="file", id=fid).status_code == 200  # ALLOW_NO_INTERNAL_TOKEN=1
    monkeypatch.delenv("ALLOW_NO_INTERNAL_TOKEN")
    assert get(world, "sheets", kind="file", id=fid).status_code == 401  # empty token: reject everything
    patch_settings(monkeypatch, internal_token="s3cret")
    c = world["client"]
    assert c.get("/internal/view/sheets", params={"kind": "file", "id": fid}).status_code == 401
    assert c.get("/internal/view/sheets", params={"kind": "file", "id": fid},
                 headers={"X-Internal-Token": "wrong"}).status_code == 401
    r = c.get("/internal/view/sheets", params={"kind": "file", "id": fid}, headers={"X-Internal-Token": "s3cret"})
    assert r.status_code == 200
    monkeypatch.setenv("ALLOW_NO_INTERNAL_TOKEN", "1")  # a configured token is still enforced
    assert c.get("/internal/view/sheets", params={"kind": "file", "id": fid}).status_code == 401


# ------------------------------------------------------------------ files

def test_sheets_file(world):
    r = get(world, "sheets", kind="file", id=world["ids"]["xlsx"])
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "file" and body["id"] == world["ids"]["xlsx"] and body["name"] == "xlsx.xlsx"
    assert body["locale"] == "eu"
    assert [s["name"] for s in body["sheets"]] == ["Tāme", "Kopsavilkums"]
    s0 = body["sheets"][0]
    assert "rows" not in s0 and "marker_counts" not in s0
    assert s0["merges"] == [{"r1": 1, "c1": 1, "r2": 1, "c2": 7}]
    assert s0["frozen"] == {"rows": 3, "cols": 2} and s0["hidden_rows"] == [2] and s0["hidden_cols"] == [5]


def test_rows_file(world):
    r = get(world, "rows", kind="file", id=world["ids"]["xlsx"], sheet=0, offset=0, limit=200)
    body = r.json()
    assert r.status_code == 200 and body["total"] == 10 and body["sheet"] == 0
    assert [row["kind"] for row in body["rows"]][:5] == ["note", "note", "header", "section", "item"]
    r = get(world, "rows", kind="file", id=world["ids"]["xlsx"], sheet="Kopsavilkums")
    assert r.json()["sheet"] == 1
    assert get(world, "rows", kind="file", id=world["ids"]["xlsx"], sheet=7).status_code == 404
    r = get(world, "rows", kind="file", id=world["ids"]["xlsx"], q="kabelis")
    assert r.json()["matches"] == [5, 6] and r.json()["total"] == 2


def test_xls_uses_work_path(world):
    assert get(world, "sheets", kind="file", id=world["ids"]["xls_ready"]).status_code == 200
    r = get(world, "sheets", kind="file", id=world["ids"]["xls_pending"])
    assert r.status_code == 409 and r.json()["error"] == "not_ready"
    raw = get(world, "raw-path", kind="file", id=world["ids"]["xls_pending"]).json()
    assert raw["path"].endswith("original.xls")


def test_errors(world):
    ids = world["ids"]
    r = get(world, "sheets", kind="file", id=str(uuid.uuid4()))
    assert r.status_code == 404 and r.json() == {"error": "not_found"}
    assert get(world, "sheets", kind="file", id=ids["deleted"]).status_code == 404
    assert get(world, "sheets", kind="file", id="not-a-uuid").status_code == 400
    assert get(world, "sheets", kind="nope", id=ids["xlsx"]).status_code == 400
    r = get(world, "sheets", kind="file", id=ids["missing"])
    assert r.status_code == 404 and r.json()["reason"] == "file missing on disk"
    r = get(world, "rows", kind="file", id=ids["bad_xlsx"])
    assert r.status_code == 422 and r.json()["error"] == "unreadable" and r.json()["reason"]
    r = get(world, "html", kind="file", id=ids["bad_docx"])
    assert r.status_code == 422 and r.json()["error"] == "unreadable"
    assert get(world, "sheets", kind="file", id=ids["docx"]).status_code == 415
    assert get(world, "html", kind="file", id=ids["xlsx"]).status_code == 415
    assert get(world, "html", kind="document", id=world["doc"]).status_code == 415
    r = get(world, "rows", kind="file", id=ids["xlsx"], filter="bogus")
    assert r.status_code == 400 and r.json()["error"] == "bad_param"
    assert get(world, "rows", kind="file", id=ids["xlsx"], offset="x").status_code == 400
    assert get(world, "rows", kind="file", id=ids["xlsx"], offset=-1).status_code == 400


def test_html_and_raw_path(world):
    r = get(world, "html", kind="file", id=world["ids"]["docx"])
    assert r.status_code == 200
    html = r.json()["html"]
    assert "<table>" in html and "<script" not in html.lower() and "javascript:" not in html.lower()
    r = get(world, "raw-path", kind="file", id=world["ids"]["pdf"])
    assert r.json() == {"path": os.path.join(world["data"], f"knowledge/{world['ids']['pdf']}/original.pdf"),
                        "name": "pdf.pdf", "mime": "application/pdf"}
    r = get(world, "raw-path", kind="document", id=world["doc"]).json()
    assert r["name"] == "Tāme objektam.xlsx" and r["path"].endswith("v1.xlsx")
    assert r["mime"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# ------------------------------------------------------------------ documents + markers

def test_document_sheets_marker_counts(world):
    body = get(world, "sheets", kind="document", id=world["doc"]).json()
    s = body["sheets"][0]
    assert s["name"] == "Big" and s["row_count"] == 1500
    assert s["marker_counts"] == {"web": 3, "check": 3, "no_price": 2, "edited": 1, "flagged": 6}


def test_document_rows_markers(world):
    body = get(world, "rows", kind="document", id=world["doc"], sheet=0, limit=10).json()
    rows = {r["r"]: r for r in body["rows"]}
    assert rows[3]["marker"] == "WEB" and rows[3]["confidence"] == "medium" and rows[3]["confidence_pct"] == 70
    assert rows[3]["price_source"] == "web" and rows[3]["flags"] == ["WEB"]
    uuid.UUID(rows[3]["estimate_row_id"])
    assert rows[4]["marker"] == "CHECK"
    assert rows[5]["marker"] == "NO PRICE"          # NO PRICE > CHECK
    assert rows[6]["marker"] == "EDITED"            # EDITED > WEB
    assert rows[7]["marker"] is None and rows[7]["price_source"] == "exact"
    assert rows[8]["marker"] == "WEB"               # WEB > CHECK
    assert "marker" not in rows[9] and "_eff" not in rows[3]


@pytest.mark.parametrize("flt,expected", [
    ("web", [3, 6, 8]), ("check", [4, 5, 8]), ("no_price", [5, 1203]), ("edited", [6]),
    ("flagged", [3, 4, 5, 6, 8, 1203]),
])
def test_document_filters(world, flt, expected):
    body = get(world, "rows", kind="document", id=world["doc"], filter=flt, limit=500).json()
    assert body["total"] == len(expected) and [r["r"] for r in body["rows"]] == expected


def test_document_filter_paging_q_around(world):
    body = get(world, "rows", kind="document", id=world["doc"], filter="flagged", limit=2, offset=2).json()
    assert body["total"] == 6 and [r["r"] for r in body["rows"]] == [5, 6]
    body = get(world, "rows", kind="document", id=world["doc"], filter="flagged", limit=2, around=1203).json()
    assert body["offset"] == 4 and [r["r"] for r in body["rows"]] == [8, 1203]
    body = get(world, "rows", kind="document", id=world["doc"], filter="no_price", q="rinda 1203").json()
    assert body["total"] == 1 and body["matches"] == [1203]
    body = get(world, "rows", kind="document", id=world["doc"], limit=200, around=1203).json()
    assert body["offset"] == 1200 and body["rows"][0]["r"] == 1201 and body["total"] == 1500
    body = get(world, "rows", kind="document", id=world["doc"], limit=9999).json()
    assert body["limit"] == 500 and len(body["rows"]) == 500
