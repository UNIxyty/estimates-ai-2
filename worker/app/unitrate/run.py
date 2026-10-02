"""A unit-rate blank in a chat run: setup card → references (unit-rate only) → plan → write → recalculate → document.

The run has one pricing model. References are the run's allowed files that are unit-rate BOQs. When none is selected:
  - an unselected unit-rate reference → a permission card for it (Allow adds it to the run);
  - only hourly-norm references selected → a "different pricing model" permission card; Allow uses their € per unit
    (norm hours × their hourly rate, plus material) as unit rates, every such line marked CHECK; Deny leaves the
    lines without a price. Nothing is ever mixed silently.
No model call is made: matching is attribute-based and every number comes from a reference or the setup answers."""
from __future__ import annotations

import os
import re
from datetime import date, timedelta

from .. import db
from ..agent import cards
from ..agent.context import RunContext, RunWaiting
from ..agent.documents import compute_totals, doc_dir
from ..llm import config_store
from .attributes import unit_rate_attributes
from .boq import BoqWorkbook, read_boq
from .fill import WEEKS_PER_MONTH, ExtraRef, Line, Plan, Planner, Setup, _phase_no, verify, write_plan
from .match import RefMeta, RefRow, UnitRateKB, Want, rows_from_db
from .ratecard import card_label

SUBCONTRACTOR_DEFAULT = "M.G.S. IT LLC"


def subcontractor_name() -> str:
    v = config_store._load("company") or {}
    return (v.get("subcontractor_name") or SUBCONTRACTOR_DEFAULT).strip() or SUBCONTRACTOR_DEFAULT


# ------------------------------------------------------------------ references


def _files(ids: list[str] | None = None) -> list[dict]:
    q = """SELECT id, original_name, tag, pricing_model, market, client, end_client, package, doc_date, analysis
           FROM files WHERE status='analysed' AND deleted_at IS NULL"""
    if ids is not None:
        return db.fetchall(q + " AND id = ANY(%s::uuid[])", (ids,)) if ids else []
    return db.fetchall(q)


def _meta(f: dict) -> RefMeta:
    d = f.get("doc_date")
    return RefMeta(file_id=str(f["id"]), file_name=f["original_name"], market=f.get("market"), client=f.get("client"),
                   end_client=f.get("end_client"), package=f.get("package"),
                   doc_date=d.isoformat() if hasattr(d, "isoformat") else d,
                   pricing_model=f.get("pricing_model") or "hourly_norm")


def load_references(unit_files: list[dict], cross_files: list[dict]) -> tuple[list[RefRow], list[ExtraRef], list]:
    metas = {str(f["id"]): _meta(f) for f in unit_files + cross_files}
    rows: list[RefRow] = []
    extras: list[ExtraRef] = []
    ratios = []
    if unit_files:
        ids = [str(f["id"]) for f in unit_files]
        items = db.fetchall("""SELECT * FROM price_items WHERE file_id = ANY(%s::uuid[]) AND pricing_model='unit_rate'
                               ORDER BY file_id, sheet_name, row_idx""", (ids,))
        rows += rows_from_db(items, metas)
        extras += extras_from_db(items, metas)
        for f in unit_files:
            for rr in (f.get("analysis") or {}).get("ratios") or []:
                ratios.append((metas[str(f["id"])], rr))
    if cross_files:
        ids = [str(f["id"]) for f in cross_files]
        for d in db.fetchall("""SELECT * FROM price_items WHERE file_id = ANY(%s::uuid[])
                                  AND COALESCE(pricing_model,'hourly_norm')='hourly_norm'
                                  AND (unit_labour IS NOT NULL OR unit_material IS NOT NULL)""", (ids,)):
            ov = d.get("override") or {}
            ul, um = ov.get("unit_labour", d.get("unit_labour")), ov.get("unit_material", d.get("unit_material"))
            text = ov.get("item_text", d["item_text"])
            a = unit_rate_attributes(text, section=d.get("section_title"))
            from .boq import BoqRow
            rows.append(RefRow(meta=metas[str(d["file_id"])], sheet=d["sheet_name"], row=d["row_idx"], description=text,
                               attrs=a, uom=d.get("unit_norm"), install_rate=float(ul) if ul is not None else None,
                               supply_rate=float(um) if um is not None else None, rate_basis=None, package=None,
                               section=d.get("section_title"), notes=[], flags=["CROSS_MODEL"],
                               rate_key=card_label(BoqRow(sheet="", row=0, kind="item", description=text, attrs=a)),
                               norm=d.get("item_norm") or ""))
    return rows, extras, ratios


def extras_from_db(items: list[dict], metas: dict[str, RefMeta]) -> list[ExtraRef]:
    out: list[ExtraRef] = []
    anchor: dict[tuple[str, str], float] = {}
    install_by_sheet: dict[tuple[str, str], float] = {}
    for d in items:
        fid = str(d["file_id"])
        kind = (d.get("attrs") or {}).get("kind")
        if d.get("package") == "prelims" and d.get("rate_basis") == "weekly" and d.get("qty") and \
                re.search(r"site\s*manager", d["item_text"], re.I):
            anchor[(fid, d["sheet_name"])] = float(d["qty"])
        if kind == "item" and d.get("install_rate") is not None and d.get("qty"):
            k = (fid, d["sheet_name"])
            install_by_sheet[k] = install_by_sheet.get(k, 0.0) + float(d["install_rate"]) * float(d["qty"])
    for d in items:
        fid = str(d["file_id"])
        meta = metas.get(fid)
        if meta is None:
            continue
        a = d.get("attrs") or {}
        ov = d.get("override") or {}
        rate = ov.get("install_rate", d.get("install_rate"))
        rate = float(rate) if rate is not None else None
        common = dict(meta=meta, description=d["item_text"], sheet=d["sheet_name"], row=d["row_idx"],
                      qty=float(d["qty"]) if d.get("qty") is not None else None, uom=d.get("unit_norm"),
                      basis=d.get("rate_basis"))
        if d.get("package") == "prelims" and rate:
            out.append(ExtraRef(kind="prelim", rate=rate, anchor_weeks=anchor.get((fid, d["sheet_name"])), **common))
        elif a.get("kind") == "contractor" and rate:
            out.append(ExtraRef(kind="contractor", rate=rate, phase=a.get("phase"), **common))
        elif a.get("kind") == "lump_sum" and a.get("amount"):
            out.append(ExtraRef(kind="lump_sum", rate=float(a["amount"]),
                                sheet_install_total=install_by_sheet.get((fid, d["sheet_name"])), **common))
    return out


# ------------------------------------------------------------------ setup card


def _phases(wb: BoqWorkbook) -> list[str]:
    nums = sorted({n for sh in wb.pricing_sheets for r in sh.rows if r.kind == "contractor"
                   for n in [_phase_no(r.description) or _phase_no(r.phase)] if n} |
                  {n for sh in wb.pricing_sheets for p in sh.phases for n in [_phase_no(p["label"])] if n})
    return [f"Phase {n}" for n in nums] or ["Programme"]


def _blank_weeks(wb: BoqWorkbook, phase: str) -> float | None:
    n = _phase_no(phase)
    months = [r.qty for sh in wb.pricing_sheets for r in sh.rows if r.kind == "contractor" and r.qty
              and r.rate_basis == "monthly" and (_phase_no(r.description) or _phase_no(r.phase)) == n]
    return round(max(months) * WEEKS_PER_MONTH, 1) if months else None


def _contractor_sheets(wb: BoqWorkbook) -> list[str]:
    return [sh.name for sh in wb.pricing_sheets if any(r.kind == "contractor" for r in sh.rows)]


def setup_questions(wb: BoqWorkbook, today: date) -> list[dict]:
    qs: list[dict] = []
    phases = _phases(wb)
    per_sheet = phases == ["Programme"] and len(_contractor_sheets(wb)) > 1
    hint = "Months for accommodation / transport / lifts and the prelims weeks follow from this."
    if per_sheet:
        # no phases, several packages with their own contractor items: each package has its own duration
        for name in _contractor_sheets(wb):
            qs.append({"id": f"weeks_sheet:{name}", "type": "number", "unit": "weeks",
                       "text": f"Programme length — {name}", "default": None, "hint": hint})
    else:
        for ph in phases:
            qs.append({"id": f"weeks:{ph}", "type": "number", "unit": "weeks",
                       "text": f"Programme length — {ph}" if ph != "Programme" else "Programme length",
                       "default": _blank_weeks(wb, ph), "hint": hint})
    if wb.prelims:
        qs.append({"id": "prelims_weeks", "type": "number", "unit": "weeks", "default": None, "optional": True,
                   "text": "Preliminaries duration (site manager weeks)",
                   "hint": "Leave empty to use the whole programme. Staff roles follow the closest reference."})
    lines = [ln for ln in wb.summary_lines if not ln.get("prelims")]
    if lines:
        qs.append({"id": "packages", "multi": True, "text": "Packages to price",
                   "options": [ln["label"] for ln in lines],
                   "suggested": [ln["label"] for ln in lines if not ln.get("not_participating")],
                   "option_meta": {ln["label"]: {"reason": "Summary says Not participating"} for ln in lines
                                   if ln.get("not_participating")}})
    has_supply = any(sh.has_supply for sh in wb.pricing_sheets)
    qs.append({"id": "material_supply", "text": "Is material supply in our scope?", "options": ["Yes", "No"],
               "default": "Yes" if has_supply else "No"})
    qs.append({"id": "delivery_pct", "type": "number", "unit": "%", "default": 12,
               "text": "Materials delivery (% of the material-supply total)"})
    qs.append({"id": "offer_date", "type": "date", "text": "Offer date", "default": today.isoformat()})
    qs.append({"id": "validity_date", "type": "date", "text": "Offer valid to",
               "default": (today + timedelta(days=61)).isoformat()})
    qs.append({"id": "subcontractor", "type": "text", "text": "Name of subcontractor", "default": subcontractor_name()})
    return qs


def _num(v) -> float | None:
    try:
        f = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return f if f >= 0 else None


def setup_from_answers(answers: dict, qs: list[dict]) -> Setup:
    def ans(qid):
        v = answers.get(qid)
        if v in (None, "", "No preference, use your defaults"):
            q = next((q for q in qs if q["id"] == qid), {})
            return q.get("suggested") if q.get("multi") else q.get("default")
        return v
    phase_weeks, sheet_weeks = {}, {}
    for q in qs:
        if q["id"].startswith(("weeks:", "weeks_sheet:")):
            w = _num(ans(q["id"]))
            if w:
                (phase_weeks if q["id"].startswith("weeks:") else sheet_weeks)[q["id"].split(":", 1)[1]] = w
    if sheet_weeks and not phase_weeks:
        phase_weeks = {"Programme": max(sheet_weeks.values())}   # prelims run for the longest package
    pk = next((q for q in qs if q["id"] == "packages"), None)
    participating = {}
    if pk:
        picked = ans("packages") or []
        picked = picked if isinstance(picked, list) else [picked]
        participating = {o: o in picked for o in pk["options"]}
    iso = lambda v: str(v)[:10] if v else None  # noqa: E731
    return Setup(phase_weeks=phase_weeks, sheet_weeks=sheet_weeks, participating=participating,
                 prelims_weeks=_num(answers.get("prelims_weeks")) or None,
                 material_supply=str(ans("material_supply") or "Yes").lower().startswith("y"),
                 delivery_pct=_num(ans("delivery_pct")) or 12.0, offer_date=iso(ans("offer_date")),
                 validity_date=iso(ans("validity_date")),
                 subcontractor=str(ans("subcontractor") or subcontractor_name()).strip())


# ------------------------------------------------------------------ rows / document


def _quote_ref(q) -> dict | None:
    if not q or not q.source:
        return None
    s = q.source
    return {"file_id": s.meta.file_id, "file_name": s.meta.file_name, "sheet": s.sheet, "row": s.row,
            "item_text": s.description, "install_rate": s.install_rate, "supply_rate": s.supply_rate,
            "market": s.meta.market, "client": s.meta.client, "doc_date": s.meta.doc_date,
            **({"cross_model": True} if s.meta.pricing_model != "unit_rate" else {})}


def _source(method: str | None) -> str:
    return {"exact": "exact", "item": "exact", "band": "semantic", "text": "semantic", "similar": "semantic",
            "web": "web"}.get(method or "", "none")


def line_to_row(ln: Line) -> dict:
    iq, sq = ln.install, ln.supply
    methods = [m for m in ((iq.method if iq else None), (sq.method if sq else None)) if m]
    src = _source(methods[0]) if methods else ("exact" if ln.priced else "none")
    if ln.kind != "item" and ln.priced:
        src = "exact"
    confs = [q.confidence for q in (iq, sq) if q and q.rate is not None]
    conf = "low" if "low" in confs else "medium" if "medium" in confs else ("high" if confs else
                                                                            ("medium" if ln.priced else None))
    matched = [m for m in (_quote_ref(iq), _quote_ref(sq)) if m]
    if ln.source and not matched:
        matched = [ln.source]
    alts = [{**a, "which": "install"} for a in (iq.alternatives if iq else [])] + \
           [{**a, "which": "supply"} for a in (sq.alternatives if sq else [])]
    qty = ln.qty
    total_install = round(qty * ln.install_rate, 2) if qty is not None and ln.install_rate is not None else None
    total_supply = round(qty * ln.supply_rate, 2) if qty is not None and ln.supply_rate is not None else None
    if ln.kind == "lump_sum":
        total_install = ln.amount
    if ln.kind == "delivery":
        total_supply = ln.amount
    return {"sheet_name": ln.sheet, "row_idx": ln.row, "section_title": ln.section, "item_text": ln.description,
            "unit": ln.uom, "unit_norm": ln.uom, "qty": qty, "norm_h_per_unit": None, "hourly_rate": None,
            "unit_labour": ln.install_rate, "unit_material": ln.supply_rate, "total_labour": total_install,
            "total_material": total_supply, "price_source": src, "confidence": conf,
            "confidence_pct": {"high": 90, "medium": 70, "low": 45}.get(conf or "", None),
            "reason": ln.note, "matched": matched, "norm_ref": None,
            "web": (ln.source or {}).get("web") if ln.source else None,
            "flags": list(dict.fromkeys(ln.flags)), "model_used": False, "row_kind": ln.kind,
            "rate_basis": ln.basis, "install_method": iq.method if iq else None,
            "supply_method": sq.method if sq else None, "note": ln.note, "alternatives": alts, "amount": ln.amount}


def layouts_for(wb: BoqWorkbook) -> dict[str, dict]:
    """Viewer edits rewrite these cells (the hourly writer's meanings: unit_labour = install €/unit, …)."""
    out = {}
    for sh in wb.pricing_sheets:
        c = sh.cols
        cols = {k: v for k, v in (("qty", c.get("qty")), ("unit_labour", c.get("rate")),
                                  ("total_labour", c.get("total")), ("unit_material", c.get("supply")),
                                  ("total_material", c.get("supply_total"))) if v}
        out[sh.name] = {"name": sh.name, "cols": cols, "pricing_model": "unit_rate", "layout": sh.layout}
    return out


def save_unit_rate_document(rc: RunContext, *, name: str, path: str, wb: BoqWorkbook, plan: Plan, checks: dict,
                            source_upload_id: str | None) -> dict:
    rows = [line_to_row(ln) for ln in plan.lines]
    with db.conn() as c:
        doc = c.execute(
            """INSERT INTO documents(run_id, conversation_id, user_id, name, stored_path, source_upload_id, mode,
                                     language, currency, layout, pricing_model, checks)
               VALUES (%s,%s,%s,%s,'',%s,'fill',%s,%s,%s,'unit_rate',%s) RETURNING *""",
            (rc.run["id"], rc.run["conversation_id"], rc.run["user_id"], name, source_upload_id, wb.language,
             wb.currency, db.jsonb(layouts_for(wb)), db.jsonb(checks))).fetchone()
        document_id = str(doc["id"])
        dst = os.path.join(doc_dir(document_id), "v1.xlsx")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        import shutil
        shutil.copyfile(path, dst)
        for r in rows:
            c.execute(
                """INSERT INTO estimate_rows(document_id, sheet_name, row_idx, section_title, item_text, unit, unit_norm,
                       qty, norm_h_per_unit, hourly_rate, unit_labour, unit_material, total_labour, total_material,
                       price_source, confidence, confidence_pct, reason, matched, norm_ref, web, flags, model_used,
                       row_kind, rate_basis, install_method, supply_method, note, alternatives, amount)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (document_id, sheet_name, row_idx) DO NOTHING""",
                (document_id, r["sheet_name"], r["row_idx"], r["section_title"], r["item_text"], r["unit"],
                 r["unit_norm"], r["qty"], None, None, r["unit_labour"], r["unit_material"], r["total_labour"],
                 r["total_material"], r["price_source"], r["confidence"], r["confidence_pct"], r["reason"],
                 db.jsonb(r["matched"]), None, db.jsonb(r["web"]), r["flags"], False, r["row_kind"],
                 r["rate_basis"], r["install_method"], r["supply_method"], r["note"], db.jsonb(r["alternatives"]),
                 r["amount"]))
        all_rows = c.execute("SELECT * FROM estimate_rows WHERE document_id=%s", (document_id,)).fetchall()
        totals = {**compute_totals(all_rows), "pricing_model": "unit_rate",
                  "install": round(sum(float(x["total_labour"] or 0) for x in all_rows), 2),
                  "supply": round(sum(float(x["total_material"] or 0) for x in all_rows), 2),
                  "sheets": checks.get("totals") or {}, "summary": checks.get("summary") or {}}
        doc = c.execute("UPDATE documents SET stored_path=%s, totals=%s, updated_at=now() WHERE id=%s RETURNING *",
                        (dst, db.jsonb(totals), document_id)).fetchone()
        from ..agent.documents import _record_web
        web = _record_web(c, run=rc.run, document_id=document_id, rows=[dict(r) for r in all_rows])
        per_file: dict[str, int] = {}
        for r in rows:
            for m in r["matched"][:1]:
                if m.get("file_id"):
                    per_file[m["file_id"]] = per_file.get(m["file_id"], 0) + 1
        for fid, n in per_file.items():
            c.execute("""INSERT INTO file_usage(file_id, conversation_id, run_id, document_id, rows_used)
                         VALUES (%s,%s,%s,%s,%s) ON CONFLICT (file_id, run_id) DO UPDATE SET
                         rows_used=EXCLUDED.rows_used, document_id=EXCLUDED.document_id""",
                      (fid, rc.run["conversation_id"], rc.run["id"], document_id, n))
        c.commit()
    doc = dict(doc)
    doc["_web"] = web
    return doc


# ------------------------------------------------------------------ the run


def _permission(rc: RunContext, f: dict, reason: str, *, cross_model: bool, message_id: str) -> dict:
    existing = db.fetchone("""SELECT id, status FROM cards WHERE run_id=%s AND kind='permission'
                              AND (payload->>'file_id'=%s OR payload->>'ref_file_id'=%s)""",
                           (rc.run_id, str(f["id"]), str(f["id"])))
    if existing:
        return existing
    # a different-model card names the file as ref_file_id: it is already selected, so Allow / Undo must not
    # change the run's allowed set; the worker reads the card's status instead
    payload = {("ref_file_id" if cross_model else "file_id"): str(f["id"]), "file_name": f["original_name"],
               "file_tag": f["tag"], "rows": [], "row_count": 0, "reason": reason,
               **({"cross_model": True, "title": "Different pricing model"} if cross_model else {})}
    return cards.create(rc.run, "permission", payload, message_id=message_id)


def _references(rc: RunContext, wb: BoqWorkbook) -> tuple[list[dict], list[dict]] | None:
    """(unit-rate files, approved different-model files), or None after posting permission cards."""
    allowed = sorted(rc.allowed - rc.denied)
    chosen = _files(allowed)
    unit = [f for f in chosen if f["pricing_model"] == "unit_rate"]
    hourly = [f for f in chosen if f["pricing_model"] != "unit_rate"]
    cross_ok = [f for f in hourly if str(f["id"]) in set(rc.state.get("cross_model_ok") or [])]
    if unit or cross_ok:
        return unit, cross_ok
    asked = set(rc.state.get("ur_asked") or [])
    others = [f for f in _files() if f["pricing_model"] == "unit_rate" and str(f["id"]) not in rc.allowed
              and str(f["id"]) not in rc.denied]
    msg = None
    posted = []
    for f in others:
        if str(f["id"]) in asked:
            continue
        msg = msg or rc.new_assistant_message()
        _permission(rc, f, f"This blank is a unit-rate BOQ (quantity × rate, no hours) and none of the selected "
                           f"references is. {f['original_name']} is a unit-rate reference.", cross_model=False,
                    message_id=str(msg["id"]))
        posted.append(str(f["id"]))
    if not posted:
        for f in hourly:
            if str(f["id"]) in asked:
                continue
            msg = msg or rc.new_assistant_message()
            _permission(rc, f, f"{f['original_name']} uses a different pricing model (hourly norms × an hourly "
                               f"rate). Its € per unit would be used as unit rates, every such line marked CHECK.",
                        cross_model=True, message_id=str(msg["id"]))
            posted.append(str(f["id"]))
    if posted:
        rc.save_state(ur_asked=sorted(asked | set(posted)))
        rc.complete_message(str(msg["id"]), content="None of the selected references uses unit rates. "
                                                    "May I use the one(s) below?")
        rc.emitter.step_warn("refs", "Waiting for permission to use a reference")
        raise RunWaiting()
    return [], []


WEB_LOOKUPS_PER_RUN = 40


def _web_supply(rc: RunContext):
    """Supply €/unit from the allowlisted supplier sites, EUR only, at most WEB_LOOKUPS_PER_RUN lookups a run."""
    from ..matching.text import tokens
    from ..websearch import search as websearch
    if not websearch.provider().configured():
        return None
    left = {"n": WEB_LOOKUPS_PER_RUN, "off": False}

    def lookup(row):
        if left["off"] or left["n"] <= 0:
            return None
        left["n"] -= 1
        try:
            found = websearch.find_price(row.description, ctx=rc.ctx, row_text=row.description,
                                         must_tokens={t for t in tokens(row.description) if len(t) > 3} or None)
        except websearch.SearchUnavailable as e:
            left["off"] = True
            rc.emitter.step_warn("price:web", f"Web search is unavailable, so no supplier prices were looked up: "
                                              f"{str(e)[:200]}")
            return None
        if not found or (found.get("currency") or "EUR").upper() != "EUR":
            return None
        return found
    return lookup


def run(rc: RunContext, upload: dict, path: str) -> None:
    st = rc.state
    rc.save_state(pricing_model="unit_rate")
    name = upload["original_name"]
    rc.emitter.step_started("read", f"Reading {name}")
    wb = read_boq(path, file_name=name)
    items = sum(1 for sh in wb.pricing_sheets for r in sh.rows if r.kind == "item")
    layouts = sorted({sh.layout for sh in wb.pricing_sheets if sh.layout})
    rc.emitter.step_done("read", f"Unit-rate BOQ · {len(wb.pricing_sheets)} pricing sheet(s) · layout "
                                 f"{'/'.join(layouts) or '–'} · {items} lines")

    # 1. setup card
    rc.emitter.step_started("sheets", "Setting up the offer")
    today = date.today()
    qs = st.get("ur_questions") or setup_questions(wb, today)
    card_id = st.get("setup_card_id")
    if not card_id:
        msg = rc.new_assistant_message()
        card = cards.create(rc.run, "clarify", {"purpose": "unit_rate_setup", "questions": qs},
                            message_id=str(msg["id"]))
        rc.save_state(setup_card_id=str(card["id"]), ur_questions=qs)
        rc.complete_message(str(msg["id"]), content="This is a unit-rate BOQ: every line is quantity × rate, no hours "
                                                    "and no hourly rate. Confirm the programme, the packages and the "
                                                    "offer details and I'll price it.")
        rc.emitter.step_warn("sheets", "Waiting for the programme and offer details")
        raise RunWaiting()
    answers = cards.decision_data(cards.get(card_id)).get("answers") or {}
    setup = setup_from_answers(answers, qs)
    rc.emitter.step_done("sheets", f"{setup.programme_weeks or '?'} weeks · delivery {setup.delivery_pct:g} % · "
                                   f"supply {'in' if setup.material_supply else 'not in'} scope")

    # 2. references (unit-rate only, unless a different-model reference was explicitly allowed)
    rc.emitter.step_started("refs", "Choosing unit-rate references")
    refs = _references(rc, wb)
    unit, cross = refs if refs else ([], [])
    rows, extras, ratios = load_references(unit, cross)
    want = Want(market=wb.market, client=wb.client, package=wb.package, end_client=wb.end_client)
    kb = UnitRateKB(rows, want)
    rc.emitter.step_done("refs", f"{len(unit)} unit-rate reference(s)" +
                         (f" + {len(cross)} hourly-norm (CHECK)" if cross else "") + f" · {len(rows)} rates")

    # 3. plan (supply rates no reference has may come from the allowlisted supplier sites; install never does)
    rc.emitter.step_started("price:exact", "Matching unit rates", items)
    plan = Planner(wb, kb, setup, extras=extras, ref_ratios=ratios, web_supply=_web_supply(rc)).plan()
    for ln in plan.lines:
        for q in (ln.install, ln.supply):
            if q and q.source and q.source.meta.pricing_model != "unit_rate":
                if "CHECK" not in ln.flags:
                    ln.flags.append("CHECK")
                ln.note = "; ".join(x for x in (ln.note, f"rate from {q.source.meta.file_name}, an hourly-norm "
                                                         f"reference (different pricing model)") if x)
    n_items = [ln for ln in plan.lines if ln.kind == "item"]
    rc.emitter.step_done("price:exact", f"{sum(1 for ln in n_items if ln.priced)} of {len(n_items)} lines priced · "
                                        f"{sum(1 for ln in n_items if 'NO PRICE' in ln.flags)} not priced")
    rc.check()

    # 4. write + recalculate
    rc.emitter.step_started("write", "Writing the workbook")
    tmp = os.path.join(os.path.dirname(path), "unit_rate_filled.xlsx")
    rep = write_plan(path, tmp, plan, wb)
    rc.emitter.step_done("write", f"{rep.written} cells written · {len(rep.skipped_formula)} formula cells left "
                                  f"intact · {len(rep.skipped_not_input)} non-input cells left")
    rc.emitter.step_started("recalc", "Recalculating totals")
    ver = verify(tmp, plan, wb)
    if ver.get("ok") is False:
        rc.emitter.step_warn("recalc", f"{len(ver['problems'])} problem(s) after recalculation: "
                                       f"{'; '.join(ver['problems'][:3])}")
    else:
        rc.emitter.step_done("recalc", "totals recalculated" if ver.get("recalculated") else ver["problems"][0])
    checks = {**ver, "ratio_checks": plan.checks, "skipped_sheets": plan.skipped_sheets,
              "not_priced": [{"sheet": ln.sheet, "row": ln.row, "description": ln.description[:80]}
                             for ln in plan.not_priced][:200],
              "write": {"written": rep.written, "formula": len(rep.skipped_formula),
                        "not_input": len(rep.skipped_not_input), "filled": len(rep.skipped_filled)},
              "setup": setup.__dict__}
    base = os.path.splitext(name)[0]
    doc = save_unit_rate_document(rc, name=f"{base} — priced.xlsx", path=tmp, wb=wb, plan=plan, checks=checks,
                                  source_upload_id=str(upload["id"]))
    rc.save_state(document_id=str(doc["id"]), stats={"pricing_model": "unit_rate", "lines": len(plan.lines),
                                                       "priced": sum(1 for ln in plan.lines if ln.priced),
                                                       "no_price": len(plan.not_priced), "cells_written": rep.written})
    db.execute("UPDATE runs SET stats=%s WHERE id=%s", (db.jsonb(rc.state["stats"]), rc.run_id))
    _summary_message(rc, doc, plan, checks)


def _summary_message(rc: RunContext, doc: dict, plan: Plan, checks: dict) -> None:
    from ..agent.common import publish_document
    t = doc["totals"] or {}
    items = [ln for ln in plan.lines if ln.kind == "item"]
    by = lambda m: sum(1 for ln in items if ln.install and ln.install.method == m)  # noqa: E731
    lines = [f"Priced {sum(1 for ln in items if ln.priced)} of {len(items)} lines in {doc['name']} "
             f"(unit rates, no hours).",
             f"Install rates: {by('exact')} same item, {by('item')} same rate-card item, {by('band')} from a band "
             f"(CHECK), {by('text') + by('similar')} by description. "
             f"Install €{t.get('install', 0):,.2f} · supply €{t.get('supply', 0):,.2f}."]
    if checks.get("skipped_sheets"):
        lines.append("Left as issued: " + "; ".join(f"{s['sheet']} ({s['reason']})" for s in checks["skipped_sheets"]))
    if checks.get("problems"):
        lines.append("After recalculation: " + "; ".join(checks["problems"][:3]))
    parts: list[dict] = [{"type": "text", "text": "\n".join(lines)}]
    doc_id = str(doc["id"])
    for label, sel, tone in (
            ("Not priced, check (no unit-rate reference has them; left empty):",
             [ln for ln in plan.lines if "NO PRICE" in ln.flags], "warn"),
            ("Please check:", [ln for ln in plan.lines if "CHECK" in ln.flags and "NO PRICE" not in ln.flags], None)):
        if sel:
            parts.append({"type": "text", "text": label, **({"tone": tone} if tone else {})})
            parts += [{"type": "chip", "kind": "row", "document_id": doc_id, "sheet": ln.sheet, "row": ln.row,
                       "label": f"{ln.sheet} · row {ln.row}"} for ln in sel[:8]]
    for chk in (checks.get("ratio_checks") or [])[:3]:
        parts.append({"type": "text", "text": chk["message"]})
    msg = rc.new_assistant_message()
    publish_document(rc, message_id=str(msg["id"]), doc=doc, web=doc.get("_web") or [])
    rc.complete_message(str(msg["id"]), content="\n".join(p["text"] for p in parts if p["type"] == "text"),
                        parts=parts)


def resume_after_permission(rc: RunContext, card: dict) -> bool:
    """A unit-rate run's permission card was decided: remember a different-model Allow, then run again."""
    if (rc.state.get("pricing_model") != "unit_rate"):
        return False
    p = card.get("payload") or {}
    if p.get("cross_model") and card["status"] == "approved":
        ok = set(rc.state.get("cross_model_ok") or []) | {p.get("ref_file_id")}
        rc.save_state(cross_model_ok=sorted(x for x in ok if x))
    return True

