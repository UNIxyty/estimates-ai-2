"""Integration test of the `ingest_file` job against the test Postgres (pgvector)."""
from __future__ import annotations

import os
import shutil
import types
import uuid

import pytest

TEST_DB = os.environ.setdefault("ESTIMATES_DATABASE_URL", "postgresql://estimates:dev@127.0.0.1:5433/estimates")

from app import db  # noqa: E402
from app.config import settings  # noqa: E402
from app.ingest import pipeline  # noqa: E402
from fixtures.make_fixtures import build_all, soffice_convert  # noqa: E402


@pytest.fixture(scope="module")
def database():
    old = settings.database_url
    if old != TEST_DB:
        object.__setattr__(settings, "database_url", TEST_DB)
        db.reset_pool()
    try:
        db.fetchone("SELECT 1 AS ok FROM price_items LIMIT 1")
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"test database not available: {e}")
    yield
    if old != TEST_DB:
        object.__setattr__(settings, "database_url", old)
        db.reset_pool()


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    return build_all(str(tmp_path_factory.getbasetemp() / "ingest_fixtures"))


@pytest.fixture(scope="module")
def user(database):
    u = db.fetchone("""INSERT INTO users(email, name, role, status) VALUES (%s, 'Ingest test', 'admin', 'active')
                       RETURNING *""", (f"ingest_{uuid.uuid4().hex[:8]}@example.com",))
    yield u
    db.execute("DELETE FROM files WHERE uploaded_by=%s", (u["id"],))
    db.execute("DELETE FROM users WHERE id=%s", (u["id"],))


@pytest.fixture(autouse=True)
def no_models(monkeypatch):
    """Default: no LLM and no embeddings (deterministic path). Tests opt in explicitly."""
    monkeypatch.setattr(pipeline, "_llm_client", lambda: None)
    monkeypatch.setattr(pipeline, "_embed_texts", lambda: None)


def _file(user, path, tmp_path, *, tag="reference_estimate", ext=None) -> str:
    fid = str(uuid.uuid4())
    ext = ext or os.path.splitext(path)[1].lstrip(".")
    d = tmp_path / "knowledge" / fid
    d.mkdir(parents=True)
    dst = d / f"original.{ext}"
    shutil.copy(path, dst)
    db.execute("""INSERT INTO files(id, uploaded_by, original_name, ext, size_bytes, stored_path, tag)
                  VALUES (%s,%s,%s,%s,%s,%s,%s)""",
               (fid, user["id"], os.path.basename(path), ext, os.path.getsize(dst), str(dst), tag))
    return fid


def _statuses(monkeypatch) -> list[tuple[str, int]]:
    seen: list[tuple[str, int]] = []
    orig = pipeline._set_status

    def spy(file_id, status, progress, **kw):
        seen.append((status, progress))
        return orig(file_id, status, progress, **kw)
    monkeypatch.setattr(pipeline, "_set_status", spy)
    return seen


def test_ingest_reference_estimate(database, user, files, tmp_path, monkeypatch):
    seen = _statuses(monkeypatch)
    fid = _file(user, files["lv"], tmp_path)
    pipeline.ingest_file({"file_id": fid})
    assert [s for s, _ in seen] == ["reading", "analysing"]
    f = db.fetchone("SELECT * FROM files WHERE id=%s", (fid,))
    assert f["status"] == "analysed" and f["progress"] == 100 and f["fail_reason"] is None
    assert f["language"] == "LV" and f["analysed_at"] is not None
    s = f["summary"]
    assert s["item_count"] == 14 and s["norm_count"] == 0 and s["currency"] == "EUR" and s["sections"] == 4
    assert [x["kind"] for x in s["sheets"]] == ["estimate", "estimate", "summary"]
    assert s["description"].startswith("Reference estimate, LV, 3 sheets, 14 priced rows, hourly rate 12.5 / 14 / 15")
    st = f["stats"]
    assert st["items"] == 14 and st["model_calls"] == 0 and st["model_cells"] == 0 and st["model_rows"] == 0
    assert st["rows_parsed"] > 14 and st["seconds"] >= 0 and st["embeddings"] is False
    sheets = db.fetchall("SELECT * FROM file_sheets WHERE file_id=%s ORDER BY idx", (fid,))
    assert [x["name"] for x in sheets] == ["Elektroinstalācija", "Vājstrāvas", "Kopsavilkums"]
    assert sheets[0]["unit_block"]["unit_labour"] == "G" and sheets[0]["total_block"]["total"] == "O"
    assert {c["col"]: c["source"] for c in sheets[0]["columns"]}["G"] == "position"
    assert sheets[1]["hourly_rates"][1]["rate"] == 15.0 and sheets[1]["hourly_rates"][1]["currency"] == "EUR"
    secs = db.fetchall("SELECT * FROM file_sections WHERE file_id=%s ORDER BY sheet_id, ord", (fid,))
    assert len(secs) == 4 and {float(x["hourly_rate"]) for x in secs} == {12.5, 14.0, 15.0}
    items = db.fetchall("SELECT * FROM price_items WHERE file_id=%s ORDER BY sheet_name, row_idx", (fid,))
    assert len(items) == 14
    r9 = next(x for x in items if x["sheet_name"] == "Elektroinstalācija" and x["row_idx"] == 9)
    assert r9["item_norm"] == "kabelis nym j 3x1.5 mm2" and r9["unit_norm"] == "m"
    assert float(r9["unit_labour"]) == 1.0 and float(r9["norm_h_per_unit"]) == 0.08
    assert r9["attrs"]["cores"] == 3 and r9["category"] == "cable" and r9["embedding"] is None
    assert r9["source_cells"]["unit_material"] == "H9"
    logic = {x["logic_key"]: x for x in db.fetchall("SELECT * FROM file_logic WHERE file_id=%s", (fid,))}
    assert "sheet:Elektroinstalācija:labour" in logic and logic["sheet:Elektroinstalācija:labour"]["source"] == "code"
    notes = db.fetchall("SELECT * FROM agent_notes WHERE file_id=%s ORDER BY ord", (fid,))
    assert notes and all(n["source"] == "model" for n in notes)
    assert notes[0]["text"].startswith("Reference estimate, LV")


def test_overrides_survive_reanalysis(database, user, files, tmp_path):
    fid = _file(user, files["lv"], tmp_path)
    pipeline.ingest_file({"file_id": fid})
    uid = user["id"]
    db.execute("""UPDATE price_items SET override='{"unit_material": 0.99, "item_text": "Mans kabelis 3x1,5"}',
                  overridden_by=%s, overridden_at=now(), unit_material=0.99
                  WHERE file_id=%s AND sheet_name='Elektroinstalācija' AND row_idx=9""", (uid, fid))
    db.execute("""UPDATE file_logic SET override_sentence='Labour = 0.1 h × 13 EUR/h', override_numbers='{"rate": 13}',
                  overridden_by=%s, overridden_at=now() WHERE file_id=%s AND logic_key='sheet:Elektroinstalācija:labour'""",
               (uid, fid))
    db.execute("INSERT INTO agent_notes(file_id, ord, text, source, created_by) VALUES (%s, 50, 'My own note', 'user', %s)",
               (fid, uid))
    first_model = db.fetchone("SELECT id FROM agent_notes WHERE file_id=%s AND source='model' ORDER BY ord LIMIT 1",
                              (fid,))
    db.execute("UPDATE agent_notes SET text='Edited by me', edited=true WHERE id=%s", (first_model["id"],))
    n_model_before = db.fetchone("SELECT count(*) n FROM agent_notes WHERE file_id=%s AND source='model'", (fid,))["n"]

    pipeline.ingest_file({"file_id": fid})

    r9 = db.fetchone("""SELECT * FROM price_items WHERE file_id=%s AND sheet_name='Elektroinstalācija' AND row_idx=9""",
                     (fid,))
    assert r9["override"] == {"unit_material": 0.99, "item_text": "Mans kabelis 3x1,5"}
    assert float(r9["unit_material"]) == 0.99 and r9["item_text"] == "Mans kabelis 3x1,5"
    assert r9["item_norm"] == "mans kabelis 3x1.5" and r9["overridden_by"] == uid
    other = db.fetchone("""SELECT override, unit_material FROM price_items WHERE file_id=%s
                           AND sheet_name='Elektroinstalācija' AND row_idx=10""", (fid,))
    assert other["override"] is None and float(other["unit_material"]) == 0.95
    lab = db.fetchone("SELECT * FROM file_logic WHERE file_id=%s AND logic_key='sheet:Elektroinstalācija:labour'", (fid,))
    assert lab["override_sentence"] == "Labour = 0.1 h × 13 EUR/h" and lab["override_numbers"] == {"rate": 13}
    assert lab["sentence"].startswith("Labour per unit")        # code sentence refreshed underneath
    assert db.fetchone("SELECT count(*) n FROM file_logic WHERE file_id=%s AND logic_key='sheet:Elektroinstalācija:labour'",
                       (fid,))["n"] == 1
    notes = db.fetchall("SELECT * FROM agent_notes WHERE file_id=%s", (fid,))
    assert any(n["source"] == "user" and n["text"] == "My own note" for n in notes)
    assert any(n["edited"] and n["text"] == "Edited by me" for n in notes)
    assert sum(1 for n in notes if n["source"] == "model" and not n["edited"]) == n_model_before - 1 + 1
    assert db.fetchone("SELECT count(*) n FROM price_items WHERE file_id=%s", (fid,))["n"] == 14
    assert db.fetchone("SELECT count(*) n FROM file_sheets WHERE file_id=%s", (fid,))["n"] == 3


def test_norms_file_and_norm_override(database, user, files, tmp_path):
    fid = _file(user, files["norms"], tmp_path, tag="hourly_norms")
    pipeline.ingest_file({"file_id": fid})
    rows = db.fetchall("SELECT * FROM norms WHERE file_id=%s ORDER BY sheet_name, row_idx", (fid,))
    assert len(rows) == 11
    p36 = next(r for r in rows if r["sheet_name"] == "Laika normas" and r["row_idx"] == 9)
    assert p36["specificity"] == "parameterised" and p36["params"] == {"modules": 36} and float(p36["hours"]) == 5.5
    db.execute("""UPDATE norms SET override='{"hours": 6.0}', hours=6.0 WHERE id=%s""", (p36["id"],))
    pipeline.ingest_file({"file_id": fid})
    again = db.fetchone("""SELECT * FROM norms WHERE file_id=%s AND sheet_name='Laika normas' AND row_idx=9""", (fid,))
    assert float(again["hours"]) == 6.0 and again["override"] == {"hours": 6.0}
    f = db.fetchone("SELECT status, summary, stats FROM files WHERE id=%s", (fid,))
    assert f["status"] == "analysed" and f["summary"]["norm_count"] == 11 and f["stats"]["norms"] == 11


class _FakeLLM(types.SimpleNamespace):
    pass


def _fake_llm(*, raise_unavailable=False):
    class LLMUnavailable(RuntimeError):
        pass
    calls = []

    def complete_json(task, system, prompt, schema, **kw):
        calls.append({"task": task, "kw": kw, "schema": schema})
        if raise_unavailable:
            raise LLMUnavailable("no creds")
        return {"description": "Latvian reference estimate for a house.",
                "notes": ["Uses 12.50 EUR/h on the main sheet.", "Low-current sheet uses 14-15 EUR/h."],
                "logic": [{"sheet_name": "Elektroinstalācija", "sentence": "Standard LV form."}]}
    return _FakeLLM(available=lambda: True, complete_json=complete_json, LLMUnavailable=LLMUnavailable,
                    calls=calls)


def test_llm_notes_and_embeddings(database, user, files, tmp_path, monkeypatch):
    fake = _fake_llm()
    monkeypatch.setattr(pipeline, "_llm_client", lambda: fake)
    got = []

    def embed(texts, *, file_id=None, user_id=None):
        got.append((len(texts), file_id, user_id))
        return [[0.001 * (i + 1)] * 1024 for i in range(len(texts))]
    monkeypatch.setattr(pipeline, "_embed_texts", lambda: embed)
    fid = _file(user, files["lv"], tmp_path)
    pipeline.ingest_file({"file_id": fid})
    f = db.fetchone("SELECT * FROM files WHERE id=%s", (fid,))
    assert f["status"] == "analysed"
    assert f["summary"]["description"] == "Latvian reference estimate for a house."
    assert f["stats"]["model_calls"] == 1 and f["stats"]["embeddings"] is True
    assert fake.calls[0]["task"] == "file_analysis" and fake.calls[0]["kw"]["file_id"] == fid
    assert got == [(14, fid, str(user["id"]))]
    notes = [n["text"] for n in db.fetchall("SELECT text FROM agent_notes WHERE file_id=%s ORDER BY ord", (fid,))]
    assert notes == ["Uses 12.50 EUR/h on the main sheet.", "Low-current sheet uses 14-15 EUR/h."]
    ml = db.fetchone("SELECT * FROM file_logic WHERE file_id=%s AND logic_key='sheet:Elektroinstalācija:summary'",
                     (fid,))
    assert ml["source"] == "model" and ml["sentence"] == "Standard LV form."
    n_emb = db.fetchone("SELECT count(*) n FROM price_items WHERE file_id=%s AND embedding IS NOT NULL", (fid,))["n"]
    assert n_emb == 14
    # cosine search works on the stored vectors
    hit = db.fetchone("""SELECT row_idx FROM price_items WHERE file_id=%s
                         ORDER BY embedding <=> %s::vector LIMIT 1""", (fid, "[" + ",".join(["0.001"] * 1024) + "]"))
    assert hit is not None


def test_llm_unavailable_falls_back(database, user, files, tmp_path, monkeypatch):
    fake = _fake_llm(raise_unavailable=True)
    monkeypatch.setattr(pipeline, "_llm_client", lambda: fake)
    monkeypatch.setattr(pipeline, "_embed_texts", lambda: (lambda texts, **kw: None))
    fid = _file(user, files["da"], tmp_path)
    pipeline.ingest_file({"file_id": fid})
    f = db.fetchone("SELECT * FROM files WHERE id=%s", (fid,))
    assert f["status"] == "analysed" and f["language"] == "DA"
    assert f["summary"]["description"].startswith("Reference estimate, DA, 1 sheet, 7 priced rows, hourly rate 450 DKK/h")
    assert f["stats"]["model_calls"] == 0 and f["stats"]["embeddings"] is False
    assert db.fetchone("SELECT count(*) n FROM price_items WHERE file_id=%s AND embedding IS NULL", (fid,))["n"] == 7


def test_encrypted_pdf_fails_cleanly(database, user, files, tmp_path, monkeypatch):
    if not files["encrypted_pdf"]:
        pytest.skip("pypdf not installed")
    seen = _statuses(monkeypatch)
    fid = _file(user, files["encrypted_pdf"], tmp_path, tag="price_list")
    pipeline.ingest_file({"file_id": fid})           # no exception: a user-facing failure, not a crash
    f = db.fetchone("SELECT status, fail_reason FROM files WHERE id=%s", (fid,))
    assert f["status"] == "failed" and f["fail_reason"].startswith("PDF is encrypted")
    assert seen[0][0] == "reading"


def test_xls_work_path(database, user, files, tmp_path):
    if not os.path.exists("/usr/bin/soffice") and not shutil.which("soffice"):
        pytest.skip("LibreOffice not installed")
    xls = soffice_convert(files["da"], "xls", str(tmp_path))
    if not xls:
        pytest.skip("LibreOffice Calc not available")
    fid = _file(user, xls, tmp_path, ext="xls")
    pipeline.ingest_file({"file_id": fid})
    f = db.fetchone("SELECT status, stored_path, work_path FROM files WHERE id=%s", (fid,))
    assert f["status"] == "analysed"
    assert f["work_path"] == os.path.join(os.path.dirname(f["stored_path"]), "work.xlsx")
    assert os.path.exists(f["work_path"]) and os.path.exists(f["stored_path"])
    assert db.fetchone("SELECT count(*) n FROM price_items WHERE file_id=%s", (fid,))["n"] == 7


def test_deleted_or_missing_file_is_noop(database):
    assert pipeline.ingest_file({"file_id": str(uuid.uuid4())}) is None
