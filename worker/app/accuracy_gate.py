"""Blind accuracy gate.

Ingest N reference estimates (plus optional norm files / price lists), blank a held-out hand-priced
estimate (every non-formula price cell cleared: per-unit block, row-total block, norm hours, source
column), let the agent fill the blank through the normal run path, then compare row by row with the
hand-priced values:

  * labour and material separately, a row "lands" when |agent − hand| ≤ 15 % of hand
  * cost per run (from the usage ledger, real Bedrock token counts × price table)
  * share of rows priced without any model call

Leave-one-out (--loo DIR): every estimate in DIR is held out once while the others are the knowledge base.

    python -m app.accuracy_gate --loo /gate/references --norms /gate/norms/*.xlsx --out /gate/report.md
    python -m app.accuracy_gate --refs a.xlsx b.xlsx --heldout c.xlsx --out report.md

Run it against a scratch database: it creates a 'gate' user, files and runs (use --cleanup to remove them).
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import shutil
import statistics
import sys
import time
import uuid

import openpyxl

from . import db
from .agent import run as agent_run
from .agent.writer import PRICE_MEANINGS, layout_from_structure
from .config import settings
from .ingest.extract import extract_prices
from .ingest.structure import analyse_workbook
from .migrate import run_migrations

TOL = 0.15


def sha(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


# ------------------------------------------------------------------ setup helpers

def gate_user() -> dict:
    return db.fetchone("""INSERT INTO users(email, name, role, status) VALUES ('gate@accuracy.local','Gate','admin','active')
                          ON CONFLICT (email) DO UPDATE SET status='active' RETURNING *""")


def ingest(path: str, tag: str, user_id: str) -> str:
    from .ingest import pipeline
    fid = str(uuid.uuid4())
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    d = os.path.join(settings.data_dir, "knowledge", fid)
    os.makedirs(d, exist_ok=True)
    dst = os.path.join(d, f"original.{ext}")
    shutil.copyfile(path, dst)
    db.execute("""INSERT INTO files(id, uploaded_by, original_name, ext, size_bytes, sha256, stored_path, tag, summary)
                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'{"gate":true}')""",
               (fid, user_id, os.path.basename(path), ext, os.path.getsize(path), sha(path), dst, tag))
    pipeline.ingest_file({"file_id": fid})
    row = db.fetchone("SELECT status, fail_reason FROM files WHERE id=%s", (fid,))
    if row["status"] != "analysed":
        print(f"  ! {os.path.basename(path)}: {row['status']} {row['fail_reason'] or ''}", file=sys.stderr)
    return fid


def make_blank(src: str, dst: str) -> dict[tuple[str, int], dict]:
    """Clear every non-formula price cell of item rows. Returns the hand-priced truth per (sheet,row)."""
    struct = analyse_workbook(src)
    truth: dict[tuple[str, int], dict] = {}
    for rec in extract_prices(struct):
        truth[(rec.sheet_name, rec.row_idx)] = {"labour": rec.unit_labour, "material": rec.unit_material,
                                                "text": rec.item_text, "qty": rec.qty}
    wb = openpyxl.load_workbook(src)
    for sheet in struct.sheets:
        if sheet.name not in wb.sheetnames:
            continue
        ws = wb[sheet.name]
        lay = layout_from_structure(sheet)
        cols = [letter for meaning, letter in lay.cols.items() if meaning in PRICE_MEANINGS | {"source"}]
        for r in sheet.rows:
            if r.kind != "item":
                continue
            for letter in cols:
                cell = ws[f"{letter}{r.row}"]
                if not (isinstance(cell.value, str) and cell.value.startswith("=")):
                    try:
                        cell.value = None
                    except AttributeError:  # merged non-anchor cell
                        pass
    wb.save(dst)
    return truth


def fill(blank_path: str, name: str, user: dict, allowed: list[str]) -> dict:
    conv = db.fetchone("INSERT INTO conversations(user_id, title) VALUES (%s,%s) RETURNING *", (user["id"], f"gate {name}"))
    up_id = str(uuid.uuid4())
    d = os.path.join(settings.data_dir, "uploads", up_id)
    os.makedirs(d, exist_ok=True)
    dst = os.path.join(d, "original.xlsx")
    shutil.copyfile(blank_path, dst)
    db.execute("""INSERT INTO uploads(id, user_id, conversation_id, original_name, ext, stored_path)
                  VALUES (%s,%s,%s,%s,'xlsx',%s)""", (up_id, user["id"], conv["id"], name, dst))
    run = db.fetchone("""INSERT INTO runs(conversation_id, user_id, allowed_file_ids, attachment_ids, cost_cap_usd)
                         VALUES (%s,%s,%s,%s,%s) RETURNING *""",
                      (conv["id"], user["id"], allowed, [up_id], settings.run_cost_cap_usd))
    db.execute("INSERT INTO messages(conversation_id, run_id, role, content, attachment_ids) VALUES (%s,%s,'user',%s,%s)",
               (conv["id"], run["id"], "Fill this blank", [up_id]))
    rid = str(run["id"])
    t0 = time.time()
    agent_run.run_agent({"run_id": rid})
    for _ in range(3):  # answer "which sheets?" with the sheets that hold hand-priced rows (blind to prices)
        card = db.fetchone("SELECT * FROM cards WHERE run_id=%s AND kind='clarify' AND status='pending'", (rid,))
        if not card:
            break
        opts = card["payload"]["questions"][0].get("suggested") or card["payload"]["questions"][0]["options"]
        db.execute("""UPDATE cards SET status='answered', decision=%s WHERE id=%s""",
                   (db.jsonb({"action": "answer", "data": {"answers": {"sheets": opts}}}), card["id"]))
        agent_run.resume_run({"run_id": rid, "card_id": str(card["id"])})
    run = db.fetchone("SELECT * FROM runs WHERE id=%s", (rid,))
    return {"run": run, "seconds": round(time.time() - t0, 1)}


def score(run: dict, truth: dict[tuple[str, int], dict]) -> dict:
    doc = db.fetchone("SELECT * FROM documents WHERE run_id=%s", (run["id"],))
    rows = {(r["sheet_name"], r["row_idx"]): r for r in
            db.fetchall("SELECT * FROM estimate_rows WHERE document_id=%s", (doc["id"],))} if doc else {}
    out = {"rows_truth": len(truth), "rows_priced_by_agent": 0}
    for part, col in (("labour", "unit_labour"), ("material", "unit_material")):
        n = hit = 0
        errs = []
        for key, t in truth.items():
            tv = t[part]
            if not tv or tv <= 0:
                continue
            n += 1
            r = rows.get(key)
            pv = float(r[col]) if r and r[col] is not None else None
            if pv is not None:
                err = abs(pv - tv) / tv
                errs.append(err)
                hit += err <= TOL
        out[part] = {"rows": n, "within_15pct": hit, "share": round(hit / n, 4) if n else None,
                     "median_abs_err": round(statistics.median(errs), 4) if errs else None,
                     "unpriced": n - len(errs)}
    stats = run.get("stats") or {}
    out["rows_priced_by_agent"] = sum(1 for r in rows.values() if r["unit_labour"] is not None or r["unit_material"] is not None)
    out["sources"] = {s: sum(1 for r in rows.values() if r["price_source"] == s)
                      for s in ("exact", "semantic", "norm", "model", "web", "none", "pending_permission")}
    out["rows_without_model_call"] = sum(1 for r in rows.values() if not r["model_used"])
    out["share_without_model_call"] = round(out["rows_without_model_call"] / len(rows), 4) if rows else None
    usage = db.fetchone("""SELECT COALESCE(SUM(cost_usd),0) c, COALESCE(SUM(input_tokens),0) i,
                                  COALESCE(SUM(output_tokens),0) o, COUNT(*) FILTER (WHERE kind='llm') calls
                           FROM usage WHERE run_id=%s""", (run["id"],))
    out["cost_usd"] = float(usage["c"])
    out["model_calls"] = usage["calls"]
    out["tokens"] = {"input": usage["i"], "output": usage["o"]}
    out["status"] = run["status"]
    out["pricing_stats"] = stats
    return out


def render(results: list[dict], ingest_cost: float) -> str:
    def agg(part: str) -> str:
        n = sum(r["score"][part]["rows"] for r in results)
        h = sum(r["score"][part]["within_15pct"] for r in results)
        return f"{h}/{n} ({h / n:.1%})" if n else "n/a"

    lines = ["# Accuracy gate", "", f"Held-out estimates: {len(results)} · tolerance ±{TOL:.0%} per row",
             f"**Labour within ±15%: {agg('labour')}** · **Material within ±15%: {agg('material')}**",
             ""]
    costs = [r["score"]["cost_usd"] for r in results]
    shares = [r["score"]["share_without_model_call"] for r in results if r["score"]["share_without_model_call"] is not None]
    lines += [f"Cost per run: mean ${statistics.mean(costs):.4f}, max ${max(costs):.4f}" if costs else "",
              f"Rows priced without a model call: {statistics.mean(shares):.1%}" if shares else "",
              f"One-off ingestion cost (all files): ${ingest_cost:.4f}", "",
              "| Held-out | Status | Labour ±15% | Material ±15% | Unpriced (L/M) | Sources | No-model share | Cost | Time |",
              "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        s = r["score"]
        src = ", ".join(f"{k} {v}" for k, v in s["sources"].items() if v)
        lab, mat = s["labour"], s["material"]
        lines.append(f"| {r['name']} | {s['status']} | {lab['within_15pct']}/{lab['rows']} | {mat['within_15pct']}/{mat['rows']}"
                     f" | {lab['unpriced']}/{mat['unpriced']} | {src} | {s['share_without_model_call']} "
                     f"| ${s['cost_usd']:.4f} | {r['seconds']}s |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--loo", help="directory of hand-priced reference estimates (leave-one-out)")
    ap.add_argument("--refs", nargs="*", default=[], help="reference estimates (with --heldout)")
    ap.add_argument("--heldout", nargs="*", default=[], help="hand-priced estimates to blank and fill")
    ap.add_argument("--norms", nargs="*", default=[], help="hourly-norm files")
    ap.add_argument("--prices", nargs="*", default=[], help="price lists")
    ap.add_argument("--out", default="accuracy_report.md")
    ap.add_argument("--cleanup", action="store_true", help="delete the gate's files/conversations afterwards")
    a = ap.parse_args(argv)
    run_migrations()
    db.reset_pool()
    user = gate_user()
    uid = str(user["id"])

    if a.loo:
        refs = sorted(p for p in glob.glob(os.path.join(a.loo, "*")) if p.lower().endswith((".xlsx", ".xls")))
        heldouts = refs
    else:
        refs, heldouts = a.refs, a.heldout
    print(f"Ingesting {len(refs)} reference(s), {len(a.norms)} norm file(s), {len(a.prices)} price list(s)…")
    ref_ids = {p: ingest(p, "reference_estimate", uid) for p in refs}
    extra = [ingest(p, "hourly_norms", uid) for p in a.norms] + [ingest(p, "price_list", uid) for p in a.prices]
    ingest_cost = float(db.fetchone("SELECT COALESCE(SUM(cost_usd),0) c FROM usage WHERE file_id = ANY(%s)",
                                    (list(ref_ids.values()) + extra,))["c"])
    held_hashes = {sha(p) for p in heldouts}
    results = []
    for h in heldouts:
        name = os.path.basename(h)
        # Blind: the held-out file (and any byte-identical copy) is removed from the knowledge base.
        hidden = [fid for p, fid in ref_ids.items() if sha(p) == sha(h)]
        db.execute("UPDATE files SET deleted_at=now() WHERE id = ANY(%s)", (hidden,))
        try:
            src = h
            if h.lower().endswith(".xls"):
                from .agent.common import ensure_xlsx
                tmp = os.path.join(settings.data_dir, "gate", str(uuid.uuid4()))
                os.makedirs(tmp)
                shutil.copyfile(h, os.path.join(tmp, name))
                src = ensure_xlsx(os.path.join(tmp, name))
            blank = os.path.join(settings.data_dir, "gate", f"blank_{uuid.uuid4().hex}.xlsx")
            os.makedirs(os.path.dirname(blank), exist_ok=True)
            truth = make_blank(src, blank)
            allowed = [fid for p, fid in ref_ids.items() if fid not in hidden] + extra
            print(f"Held out {name}: {len(truth)} hand-priced rows; filling with {len(allowed)} file(s)…")
            res = fill(blank, name, user, allowed)
            sc = score(res["run"], truth)
            results.append({"name": name, "score": sc, "seconds": res["seconds"]})
            print(f"  labour {sc['labour']['within_15pct']}/{sc['labour']['rows']}, material "
                  f"{sc['material']['within_15pct']}/{sc['material']['rows']}, ${sc['cost_usd']:.4f}")
        finally:
            db.execute("UPDATE files SET deleted_at=NULL WHERE id = ANY(%s)", (hidden,))
    report = render(results, ingest_cost)
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(report)
    with open(os.path.splitext(a.out)[0] + ".json", "w", encoding="utf-8") as fh:
        json.dump({"results": results, "ingest_cost_usd": ingest_cost, "held_out_sha256": sorted(held_hashes)},
                  fh, indent=2, default=str)
    print(report)
    if a.cleanup:
        db.execute("DELETE FROM files WHERE uploaded_by=%s", (uid,))
        db.execute("DELETE FROM conversations WHERE user_id=%s", (uid,))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
