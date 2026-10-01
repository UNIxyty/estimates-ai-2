"""Blind accuracy gate.

Ingest N reference estimates (plus optional norm files / price lists), blank a held-out hand-priced
estimate (every non-formula price cell cleared: per-unit block, row-total block, norm hours, source
column), let the agent fill the blank through the normal run path, then compare row by row with the
hand-priced values:

  * labour on norm HOURS per unit (main metric: hourly rates differ per project, so EUR alone misleads),
    labour EUR (secondary) and material EUR; a row "lands" when |agent − hand| ≤ 15 % of hand
  * median agent/hand ratio for labour hours, labour EUR and material
  * how rows were priced: directly (exact / closest match / norm), by the model, from the web, or NO PRICE
  * cost per run (from the usage ledger, real Bedrock token counts × price table)
  * share of rows priced without any model call

Leave-one-out (--loo DIR): every estimate in DIR is held out once while the others are the knowledge base.
Realistic mode (--knowledge DIR): every file there (priced estimates, price lists, hourly norms; sub-folders or the
file's own content decide the type) is ingested too and stays in the knowledge base for every held-out run.

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
        hours = rec.norm_h_per_unit
        if hours is None and rec.unit_labour and rec.hourly_rate:
            hours = rec.unit_labour / rec.hourly_rate
        truth[(rec.sheet_name, rec.row_idx)] = {"labour": rec.unit_labour, "material": rec.unit_material,
                                                "hours": hours, "rate": rec.hourly_rate,
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


def fill(blank_path: str, name: str, user: dict, allowed: list[str], truth_sheets: set[str] | None = None,
         rate: float | None = None) -> dict:
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
    for _ in range(3):  # answer the setup / sheet questions like the estimator would (never with prices)
        card = db.fetchone("SELECT * FROM cards WHERE run_id=%s AND kind='clarify' AND status='pending'", (rid,))
        if not card:
            break
        answers = {}
        for q in card["payload"]["questions"]:
            if q["id"] == "sheets":
                # the sheets that hold the hand-priced rows (names only, blind to prices)
                answers["sheets"] = ([o for o in q["options"] if truth_sheets and o in truth_sheets]
                                     or q.get("suggested") or q["options"])
            elif q["id"] == "hourly_rate":
                # the estimator knows their own rate for this job: the held-out estimate's rate, else the prefill
                answers["hourly_rate"] = rate or q.get("default")
        db.execute("""UPDATE cards SET status='answered', decision=%s WHERE id=%s""",
                   (db.jsonb({"action": "answer", "data": {"answers": answers}}), card["id"]))
        agent_run.resume_run({"run_id": rid, "card_id": str(card["id"])})
    run = db.fetchone("SELECT * FROM runs WHERE id=%s", (rid,))
    return {"run": run, "seconds": round(time.time() - t0, 1)}


def _ratio_stats(pairs: list[tuple[float, float]]) -> dict:
    """pairs of (agent, hand) → rows, within ±15 %, share, median agent/hand ratio, median |error|."""
    errs = [abs(a - h) / h for a, h in pairs]
    ratios = sorted(a / h for a, h in pairs)
    hit = sum(1 for e in errs if e <= TOL)
    return {"within_15pct": hit, "priced": len(pairs),
            "median_ratio": round(statistics.median(ratios), 3) if ratios else None,
            "median_abs_err": round(statistics.median(errs), 4) if errs else None}


DIRECT = ("exact", "semantic", "norm")


def score(run: dict, truth: dict[tuple[str, int], dict]) -> dict:
    doc = db.fetchone("SELECT * FROM documents WHERE run_id=%s", (run["id"],))
    rows = {(r["sheet_name"], r["row_idx"]): r for r in
            db.fetchall("SELECT * FROM estimate_rows WHERE document_id=%s", (doc["id"],))} if doc else {}
    out = {"rows_truth": len(truth), "rows_priced_by_agent": 0}
    for part, tkey, col in (("hours", "hours", "norm_h_per_unit"), ("labour", "labour", "unit_labour"),
                            ("material", "material", "unit_material")):
        n = 0
        pairs: list[tuple[float, float]] = []
        for key, t in truth.items():
            tv = t.get(tkey)
            if not tv or tv <= 0:
                continue
            n += 1
            r = rows.get(key)
            if r and r[col] is not None and float(r[col]) > 0:
                pairs.append((float(r[col]), float(tv)))
        st = _ratio_stats(pairs)
        out[part] = {"rows": n, **st, "share": round(st["within_15pct"] / n, 4) if n else None,
                     "unpriced": n - len(pairs)}
    stats = run.get("stats") or {}
    scored = [rows[k] for k in truth if k in rows]
    out["rows_priced_by_agent"] = sum(1 for r in rows.values() if r["unit_labour"] is not None or r["unit_material"] is not None)
    out["sources"] = {s: sum(1 for r in rows.values() if r["price_source"] == s)
                      for s in ("exact", "semantic", "norm", "model", "web", "none", "pending_permission")}
    out["how"] = {"direct": sum(1 for r in scored if r["price_source"] in DIRECT),
                  "model": sum(1 for r in scored if r["price_source"] == "model"),
                  "web": sum(1 for r in scored if r["price_source"] == "web"),
                  "no_price": sum(1 for r in scored if r["price_source"] in ("none", "pending_permission")),
                  "not_reached": len(truth) - len(scored)}
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

    def med(part: str) -> str:
        vals = [r["score"][part]["median_ratio"] for r in results if r["score"][part]["median_ratio"] is not None]
        return f"{statistics.median(vals):.2f}" if vals else "n/a"

    how = {k: sum(r["score"]["how"][k] for r in results) for k in ("direct", "model", "web", "no_price", "not_reached")}
    tot = sum(how.values()) or 1
    lines = ["# Accuracy gate", "", f"Held-out estimates: {len(results)} · tolerance ±{TOL:.0%} per row", "",
             f"**Labour hours within ±15%: {agg('hours')}** (main metric) · Labour EUR: {agg('labour')} · "
             f"**Material within ±15%: {agg('material')}**",
             f"Median agent/hand ratio (median of per-estimate medians): labour hours {med('hours')} · "
             f"labour EUR {med('labour')} · material {med('material')}",
             "How the hand-priced rows were priced: " + " · ".join(
                 f"{k.replace('_', ' ')} {v} ({v / tot:.0%})" for k, v in how.items()), ""]
    costs = [r["score"]["cost_usd"] for r in results]
    shares = [r["score"]["share_without_model_call"] for r in results if r["score"]["share_without_model_call"] is not None]
    lines += [f"Cost per run: mean ${statistics.mean(costs):.4f}, max ${max(costs):.4f}" if costs else "",
              f"Rows priced without a model call: {statistics.mean(shares):.1%}" if shares else "",
              f"One-off ingestion cost (all files): ${ingest_cost:.4f}", "",
              "| Held-out | Status | Hours ±15% | Labour EUR ±15% | Material ±15% | Median ratio h / L / M "
              "| Direct / model / web / none | No-model share | Cost | Time |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        s = r["score"]
        h, lab, mat, hw = s["hours"], s["labour"], s["material"], s["how"]
        mr = " / ".join("–" if x is None else f"{x:.2f}" for x in (h["median_ratio"], lab["median_ratio"], mat["median_ratio"]))
        lines.append(f"| {r['name']} | {s['status']} | {h['within_15pct']}/{h['rows']} | {lab['within_15pct']}/{lab['rows']} "
                     f"| {mat['within_15pct']}/{mat['rows']} | {mr} | {hw['direct']} / {hw['model']} / {hw['web']} / "
                     f"{hw['no_price'] + hw['not_reached']} | {s['share_without_model_call']} | ${s['cost_usd']:.4f} "
                     f"| {r['seconds']}s |")
    return "\n".join(lines) + "\n"


KNOWLEDGE_EXT = (".xlsx", ".xls", ".docx", ".pdf")


def guess_tag(path: str) -> str:
    """Knowledge type from the folder or file name, else from what the workbook looks like."""
    low = path.lower()
    if any(k in low for k in ("norm", "/norms/", "stundu", "darbietilp")):
        return "hourly_norms"
    if any(k in low for k in ("price", "cenu", "cenas", "cenrād", "prislist", "/prices/")):
        return "price_list"
    if any(k in low for k in ("/estimates/", "/references/", "tāme", "tame", "estimate", "piedāvāj")):
        return "reference_estimate"
    if low.endswith((".xlsx", ".xls")):
        try:
            src = path
            if low.endswith(".xls"):
                from .agent.common import ensure_xlsx
                tmp = os.path.join(settings.data_dir, "gate", str(uuid.uuid4()))
                os.makedirs(tmp)
                shutil.copyfile(path, os.path.join(tmp, os.path.basename(path)))
                src = ensure_xlsx(os.path.join(tmp, os.path.basename(path)))
            kinds = [s.kind for s in analyse_workbook(src).sheets]
            for kind, tag in (("norms", "hourly_norms"), ("prices", "price_list"), ("estimate", "reference_estimate")):
                if kinds.count(kind) and kinds.count(kind) == max(kinds.count(k) for k in ("norms", "prices", "estimate")):
                    return tag
        except Exception:  # noqa: BLE001 - the pipeline reports the real failure
            pass
    return "other"


def ingest_report(file_ids: list[str]) -> tuple[str, list[dict]]:
    rows = db.fetchall("""SELECT f.id, f.original_name, f.tag, f.status, f.fail_reason, f.language,
                                (SELECT count(*) FROM price_items p WHERE p.file_id=f.id) AS prices,
                                (SELECT count(*) FROM price_items p WHERE p.file_id=f.id AND p.norm_h_per_unit IS NOT NULL) AS with_hours,
                                (SELECT count(*) FROM norms n WHERE n.file_id=f.id) AS norms,
                                (SELECT COALESCE(SUM(cost_usd),0) FROM usage u WHERE u.file_id=f.id) AS cost
                           FROM files f WHERE f.id = ANY(%s) ORDER BY f.tag, f.original_name""", (file_ids,))
    lines = ["## Knowledge ingested", "",
             "| File | Type | Status | Language | Priced rows | …with norm hours | Norms | Cost | Failure |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['original_name']} | {r['tag']} | {r['status']} | {r['language'] or '–'} | {r['prices']} "
                     f"| {r['with_hours']} | {r['norms']} | ${float(r['cost']):.4f} | {r['fail_reason'] or ''} |")
    return "\n".join(lines) + "\n", [dict(r, id=str(r["id"]), cost=float(r["cost"])) for r in rows]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--loo", help="directory of hand-priced reference estimates (leave-one-out)")
    ap.add_argument("--refs", nargs="*", default=[], help="reference estimates (with --heldout)")
    ap.add_argument("--heldout", nargs="*", default=[], help="hand-priced estimates to blank and fill")
    ap.add_argument("--norms", nargs="*", default=[], help="hourly-norm files")
    ap.add_argument("--prices", nargs="*", default=[], help="price lists")
    ap.add_argument("--knowledge", help="directory (recursive) of extra knowledge: estimates, price lists, norms")
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
    knowledge_ids: dict[str, str] = {}
    if a.knowledge:
        kfiles = sorted(p for p in glob.glob(os.path.join(a.knowledge, "**", "*"), recursive=True)
                        if p.lower().endswith(KNOWLEDGE_EXT) and not os.path.basename(p).startswith(("~$", ".")))
        print(f"Ingesting {len(kfiles)} knowledge file(s) from {a.knowledge}…")
        for p in kfiles:
            tag = guess_tag(p)
            knowledge_ids[p] = ingest(p, tag, uid)
            print(f"  {tag:18s} {os.path.basename(p)}")
        extra += list(knowledge_ids.values())
    ingest_cost = float(db.fetchone("SELECT COALESCE(SUM(cost_usd),0) c FROM usage WHERE file_id = ANY(%s)",
                                    (list(ref_ids.values()) + extra,))["c"])
    held_hashes = {sha(p) for p in heldouts}
    results = []
    for h in heldouts:
        name = os.path.basename(h)
        # Blind: the held-out file (and any byte-identical copy) is removed from the knowledge base.
        hidden = [fid for p, fid in {**ref_ids, **knowledge_ids}.items() if sha(p) == sha(h)]
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
            allowed = [fid for p, fid in ref_ids.items() if fid not in hidden] + [f for f in extra if f not in hidden]
            print(f"Held out {name}: {len(truth)} hand-priced rows; filling with {len(allowed)} file(s)…")
            rates = [v["rate"] for v in truth.values() if v.get("rate")]
            res = fill(blank, name, user, allowed, truth_sheets={k[0] for k in truth},
                       rate=statistics.median(rates) if rates else None)
            sc = score(res["run"], truth)
            results.append({"name": name, "score": sc, "seconds": res["seconds"]})
            print(f"  hours {sc['hours']['within_15pct']}/{sc['hours']['rows']}, "
                  f"labour {sc['labour']['within_15pct']}/{sc['labour']['rows']}, material "
                  f"{sc['material']['within_15pct']}/{sc['material']['rows']}, ${sc['cost_usd']:.4f}, run {sc['status']}")
        finally:
            db.execute("UPDATE files SET deleted_at=NULL WHERE id = ANY(%s)", (hidden,))
    report = render(results, ingest_cost)
    k_md, k_rows = ingest_report(list(ref_ids.values()) + extra)
    report += "\n" + k_md
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(report)
    with open(os.path.splitext(a.out)[0] + ".json", "w", encoding="utf-8") as fh:
        json.dump({"results": results, "ingest_cost_usd": ingest_cost, "held_out_sha256": sorted(held_hashes),
                   "knowledge": k_rows},
                  fh, indent=2, default=str)
    print(report)
    if a.cleanup:
        db.execute("DELETE FROM files WHERE uploaded_by=%s", (uid,))
        db.execute("DELETE FROM conversations WHERE user_id=%s", (uid,))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
