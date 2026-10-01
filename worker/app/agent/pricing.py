"""Price rows cheapest-first:

  1. exact / normalised match in allowed references (unit normalisation + hard attribute equality)
  2. semantic match (pgvector, or lexical when embeddings are unavailable) with hard attribute filters
  3. norm lookup from hourly-norm files: parameterised > item > category
  4. ONE batched model call per ≤40 rows still ambiguous after 1–3
  5. web search only where no allowed file has a price (after Deny, or nothing anywhere)
  6. NO PRICE

Permission rule (enforced here, not in a prompt): prices are only ever taken from files in the run's
allowed set. When the best match sits in an unselected file, the row is parked as
`pending_permission` with `blocked_file` set, so the agent can post a permission card while the other
rows continue. Denied files are ignored completely.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable

from .. import db
from ..llm import client as llm
from ..llm.ledger import Ctx
from ..matching.attributes import attributes_compatible, parse_attributes
from ..matching.units import normalise_unit, units_compatible
from .knowledge import KItem, KNorm, Knowledge, lexical_similarity, match_key, tokens

log = logging.getLogger(__name__)

MODEL_BATCH = 40
SEM_HIGH, SEM_MED, SEM_ACCEPT = 0.88, 0.80, 0.72     # cosine similarity (embeddings)
LEX_HIGH, LEX_MED, LEX_ACCEPT = 0.85, 0.66, 0.52     # weighted token overlap (fallback)
BLOCK_MARGIN = 0.04


@dataclass
class RowSpec:
    sheet: str
    row: int
    text: str
    unit: str | None = None
    qty: float | None = None
    section: str | None = None
    unit_norm: str | None = None
    attrs: dict = field(default_factory=dict)
    key: str = ""
    toks: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.unit_norm = self.unit_norm or normalise_unit(self.unit)
        self.attrs = self.attrs or parse_attributes(self.text)
        self.key = match_key(self.text)
        self.toks = tokens(self.text)

    @property
    def rid(self) -> str:
        return f"{self.sheet}!{self.row}"


@dataclass
class PricedRow:
    spec: RowSpec
    source: str = "none"          # exact|semantic|norm|model|web|none|pending_permission
    norm_h: float | None = None
    hourly_rate: float | None = None
    unit_labour: float | None = None
    unit_material: float | None = None
    confidence: str | None = None
    confidence_pct: int | None = None
    reason: str = ""
    matched: list[dict] = field(default_factory=list)
    norm_ref: dict | None = None
    web: dict | None = None
    flags: list[str] = field(default_factory=list)
    blocked_file: dict | None = None     # {file_id, file_name, similarity}
    model_used: bool = False

    @property
    def priced(self) -> bool:
        return self.unit_labour is not None or self.unit_material is not None

    @property
    def total_labour(self) -> float | None:
        return None if self.unit_labour is None or self.spec.qty is None else round(self.spec.qty * self.unit_labour, 2)

    @property
    def total_material(self) -> float | None:
        return None if self.unit_material is None or self.spec.qty is None else round(self.spec.qty * self.unit_material, 2)

    def set_conf(self, pct: int) -> None:
        pct = max(1, min(99, int(pct)))
        self.confidence_pct = pct
        self.confidence = "high" if pct >= 80 else "medium" if pct >= 60 else "low"
        if self.confidence == "low" and "CHECK" not in self.flags:
            self.flags.append("CHECK")


def _compatible(spec: RowSpec, attrs: dict, unit_norm: str | None) -> bool:
    return attributes_compatible(spec.attrs, attrs) and units_compatible(spec.unit_norm, unit_norm)


class PricingEngine:
    def __init__(self, kb: Knowledge, *, allowed: set[str], denied: set[str], ctx: Ctx,
                 target_rate: float | None = None, task: str = "fill_blank", forced_tier: str | None = None,
                 progress: Callable[[str, int, int], None] | None = None,
                 web_lookup: Callable[[RowSpec], dict | None] | None = None,
                 should_stop: Callable[[], bool] | None = None, use_model: bool = True,
                 current: Callable[[str, str], None] | None = None):
        self.kb, self.allowed, self.denied, self.ctx = kb, set(allowed), set(denied), ctx
        self.default_rate = kb.default_hourly_rate(self.allowed)
        self.target_rate = target_rate
        self.task, self.forced_tier = task, forced_tier
        self.progress = progress or (lambda stage, done, total: None)
        self.web_lookup = web_lookup
        self.should_stop = should_stop or (lambda: False)
        self.use_model = use_model
        self.current = current or (lambda stage, text: None)  # "Now: <item>" in the working-steps block
        self.stats = {"rows": 0, "exact": 0, "semantic": 0, "norm": 0, "model": 0, "web": 0, "none": 0,
                      "pending_permission": 0, "model_calls": 0, "rows_without_model": 0}

    # ----------------------------------------------------------------- helpers
    def _visible(self, file_id: str) -> bool:
        return file_id not in self.denied

    def _rate_for(self, item: KItem | None = None) -> float | None:
        return self.target_rate or (item.hourly_rate if item else None) or self.default_rate

    def _apply_item(self, pr: PricedRow, item: KItem, source: str, sim: float | None, pct: int, why: str) -> None:
        pr.source = source
        pr.matched = [item.ref(sim)]
        pr.norm_h = item.norm_h
        pr.unit_material = item.unit_material
        rate = self._rate_for(item)
        pr.hourly_rate = rate
        if item.norm_h is not None and rate is not None:
            pr.unit_labour = round(item.norm_h * rate, 4)
            if item.hourly_rate and self.target_rate and abs(item.hourly_rate - self.target_rate) > 1e-6:
                why += f"; labour re-rated from {item.hourly_rate:g} to {self.target_rate:g}/h"
        elif item.unit_labour is not None and item.hourly_rate and self.target_rate:
            # Only EUR labour in the source: convert through the source's own rate to hours, then to this run's rate.
            pr.norm_h = round(item.unit_labour / item.hourly_rate, 4)
            pr.unit_labour = round(pr.norm_h * self.target_rate, 4)
            pr.hourly_rate = self.target_rate
            if abs(item.hourly_rate - self.target_rate) > 1e-6:
                why += (f"; labour {item.unit_labour:g} at {item.hourly_rate:g}/h = {pr.norm_h:g} h, "
                        f"re-rated to {self.target_rate:g}/h")
        else:
            pr.unit_labour = item.unit_labour
        pr.reason = why
        pr.set_conf(pct)

    # ----------------------------------------------------------------- stage 1
    def _exact(self, rows: list[PricedRow]) -> None:
        for pr in rows:
            cands = [i for i in self.kb.by_key.get(pr.spec.key, [])
                     if self._visible(i.file_id) and _compatible(pr.spec, i.attrs, i.unit_norm)
                     and (i.unit_labour is not None or i.unit_material is not None or i.norm_h is not None)]
            allowed = [i for i in cands if i.file_id in self.allowed]
            if allowed:
                # prefer reference estimates over price lists, then the most recent (largest id order is fine)
                best = sorted(allowed, key=lambda i: (i.tag != "reference_estimate", i.unit_labour is None))[0]
                self._apply_item(pr, best, "exact", 1.0, 95,
                                 f"Same item in {best.file_name} ({best.sheet} row {best.row})")
                self.stats["exact"] += 1
            elif cands:
                best = cands[0]
                pr.blocked_file = {"file_id": best.file_id, "file_name": best.file_name, "similarity": 1.0}

    # ----------------------------------------------------------------- stage 2
    def _candidates(self, pr: PricedRow, emb: list[float] | None, limit: int = 8) -> list[tuple[KItem, float]]:
        out: list[tuple[KItem, float]] = []
        if emb is not None and self.kb.has_embeddings:
            visible = [f for f in self.kb.files if self._visible(f)]
            rows = db.fetchall(
                """SELECT id, 1 - (embedding <=> %s::vector) AS sim FROM price_items
                   WHERE file_id = ANY(%s) AND embedding IS NOT NULL
                   ORDER BY embedding <=> %s::vector LIMIT 40""", (emb, visible, emb))
            by_id = {i.id: i for i in self.kb.items}
            for r in rows:
                it = by_id.get(str(r["id"]))
                if it and _compatible(pr.spec, it.attrs, it.unit_norm):
                    out.append((it, float(r["sim"])))
        else:
            cat = pr.spec.attrs.get("category")
            for it in self.kb.items:
                if not self._visible(it.file_id):
                    continue
                if cat and it.category and cat != it.category:
                    continue
                s = lexical_similarity(pr.spec.toks, it.toks)
                if s >= LEX_ACCEPT * 0.8 and _compatible(pr.spec, it.attrs, it.unit_norm):
                    out.append((it, s))
        out.sort(key=lambda t: -t[1])
        return out[:limit]

    def _semantic(self, rows: list[PricedRow], embeddings: dict[str, list[float]] | None) -> None:
        high, med, accept = (SEM_HIGH, SEM_MED, SEM_ACCEPT) if embeddings else (LEX_HIGH, LEX_MED, LEX_ACCEPT)
        todo = [pr for pr in rows if not pr.priced]
        for n, pr in enumerate(todo, 1):
            cands = self._candidates(pr, (embeddings or {}).get(pr.spec.rid))
            pr._cands = cands  # type: ignore[attr-defined]  # reused by the model stage
            allowed = [(i, s) for i, s in cands if i.file_id in self.allowed]
            others = [(i, s) for i, s in cands if i.file_id not in self.allowed]
            best_a = allowed[0] if allowed else None
            best_o = others[0] if others else None
            if best_o and best_o[1] >= med and (not best_a or best_o[1] > best_a[1] + BLOCK_MARGIN) \
                    and not (best_a and best_a[1] >= high):
                if not pr.blocked_file or pr.blocked_file["similarity"] < best_o[1]:
                    pr.blocked_file = {"file_id": best_o[0].file_id, "file_name": best_o[0].file_name,
                                       "similarity": round(best_o[1], 3)}
                continue
            if best_a and best_a[1] >= med:
                it, s = best_a
                pct = 88 if s >= high else 72
                self._apply_item(pr, it, "semantic", s, pct,
                                 f"Closest match ({s:.0%}) in {it.file_name} ({it.sheet} row {it.row}): "
                                 f"“{it.text}”")
                self.stats["semantic"] += 1
                pr.blocked_file = None
            if n % 25 == 0:
                self.progress("semantic", n, len(todo))

    # ----------------------------------------------------------------- stage 3
    def _norm_for(self, spec: RowSpec) -> tuple[KNorm, int, str] | None:
        cat = spec.attrs.get("category")
        norms = [n for n in self.kb.norms if n.file_id in self.allowed]
        # parameterised: every parameter must equal the row's parsed attribute
        param = [n for n in norms if n.specificity == "parameterised" and n.params
                 and (not cat or not n.category or n.category == cat)
                 and all(spec.attrs.get(k) == v for k, v in n.params.items())
                 and units_compatible(spec.unit_norm, n.unit_norm)]
        if param:
            best = max(param, key=lambda n: lexical_similarity(spec.toks, n.toks))
            return best, 85, "parameterised"
        item = [(n, lexical_similarity(spec.toks, n.toks)) for n in norms if n.specificity == "item"
                and _compatible(spec, n.attrs, n.unit_norm)]
        item = [t for t in item if t[1] >= 0.6]
        if item:
            best, s = max(item, key=lambda t: t[1])
            return best, 72 if s >= 0.8 else 64, "item"
        catn = [n for n in norms if n.specificity == "category" and cat and n.category == cat
                and units_compatible(spec.unit_norm, n.unit_norm)]
        if catn:
            return max(catn, key=lambda n: lexical_similarity(spec.toks, n.toks)), 55, "category"
        return None

    def _norms(self, rows: list[PricedRow]) -> None:
        for pr in rows:
            if pr.source == "pending_permission" or (pr.priced and pr.unit_labour is not None):
                continue
            hit = self._norm_for(pr.spec)
            if not hit:
                continue
            norm, pct, spec_level = hit
            rate = self.target_rate or self.default_rate
            pr.norm_ref = norm.ref()
            pr.norm_h = norm.hours
            pr.hourly_rate = rate
            if rate is not None:
                pr.unit_labour = round(norm.hours * rate, 4)
            if pr.source in ("none",):
                pr.source = "norm"
                pr.reason = (f"{spec_level.capitalize()} norm {norm.hours:g} h/unit from {norm.file_name}"
                             f" × {rate:g}/h" if rate else f"{spec_level} norm {norm.hours:g} h/unit (no hourly rate)")
                pr.set_conf(pct if rate else 45)
                self.stats["norm"] += 1
            else:
                pr.reason += f"; labour from {spec_level} norm {norm.hours:g} h/unit ({norm.file_name})"

    # ----------------------------------------------------------------- stage 4
    PRICE_SCHEMA = {
        "type": "object",
        "properties": {"rows": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "row_id": {"type": "string"},
                "candidate_id": {"type": ["string", "null"],
                                 "description": "id of the candidate that prices this row, or null"},
                "norm_h": {"type": ["number", "null"]},
                "unit_material": {"type": ["number", "null"]},
                "confidence": {"type": "number", "description": "0..1"},
                "reason": {"type": "string"},
            },
            "required": ["row_id", "candidate_id", "confidence", "reason"],
        }}},
        "required": ["rows"],
    }
    PRICE_SYSTEM = (
        "You price rows of an electrical installation estimate. For each row you get candidate rows from "
        "the user's own reference estimates and norm files (the only allowed sources). Decide on logic, "
        "not strings: two brands of the same cable cost the same labour; a 3×1.5 mm² cable is NOT a "
        "5×2.5 mm² cable; units must agree. Pick the candidate that prices the row (candidate_id), or, "
        "when none fits exactly, derive norm_h / unit_material by analogy from the candidates and explain "
        "how in `reason` (confidence ≤ 0.6 then). If nothing supports a price, return candidate_id null, "
        "norm_h null and unit_material null. Never invent supplier prices."
    )

    def _model_fallback(self, todo: list[PricedRow]) -> None:
        """Deterministic fallback: accept the best allowed candidate above the accept bar, flagged CHECK."""
        for pr in todo:
            allowed = [(i, s) for i, s in pr._cands if i.file_id in self.allowed]  # type: ignore[attr-defined]
            if not allowed:
                continue
            i, s = allowed[0]
            if not pr.priced and s >= (SEM_ACCEPT if self.kb.has_embeddings else LEX_ACCEPT):
                self._apply_item(pr, i, "semantic", s, 50,
                                 f"Weak match ({s:.0%}) to “{i.text}” in {i.file_name} row {i.row} — check")
                self.stats["semantic"] += 1

    def _model(self, rows: list[PricedRow]) -> None:
        todo = [pr for pr in rows if pr.source not in ("pending_permission",)
                and (not pr.priced or (pr.confidence == "low" and pr.source != "norm"))
                and getattr(pr, "_cands", None)]
        todo = [pr for pr in todo if any(i.file_id in self.allowed for i, _ in pr._cands)]  # type: ignore[attr-defined]
        if not todo or not self.use_model or not llm.available():
            self._model_fallback(todo)
            return
        for start in range(0, len(todo), MODEL_BATCH):
            if self.should_stop():
                raise llm.Cancelled()
            batch = todo[start:start + MODEL_BATCH]
            payload_rows, cand_map = [], {}
            for pr in batch:
                cands = []
                for i, s in [(i, s) for i, s in pr._cands if i.file_id in self.allowed][:5]:  # type: ignore[attr-defined]
                    cid = f"c{len(cand_map) + 1}"
                    cand_map[cid] = (i, s)
                    cands.append({"id": cid, "text": i.text, "unit": i.unit_norm, "norm_h": i.norm_h,
                                  "unit_labour": i.unit_labour, "unit_material": i.unit_material,
                                  "hourly_rate": i.hourly_rate, "file": i.file_name, "similarity": round(s, 2)})
                payload_rows.append({"row_id": pr.spec.rid, "text": pr.spec.text, "unit": pr.spec.unit_norm,
                                     "qty": pr.spec.qty, "section": pr.spec.section, "candidates": cands,
                                     "norm": pr.norm_ref})
            import json
            prompt = (f"Hourly rate for this estimate: {self.target_rate or self.default_rate}\n"
                      f"Rows:\n{json.dumps(payload_rows, ensure_ascii=False)}")
            try:
                out = llm.complete_json(self.task, self.PRICE_SYSTEM, prompt, self.PRICE_SCHEMA, ctx=self.ctx,
                                        forced_tier=self.forced_tier, max_tokens=8000)
            except (llm.LLMUnavailable, llm.LLMError) as e:
                # A refused or failing model must not sink the run: the rest of the rows take the deterministic
                # path (weak matches flagged CHECK) and go on to web search / NO PRICE. The caller warns.
                log.warning("pricing model call failed, falling back: %s", e)
                self.stats["model_error"] = str(e)[:300]
                self._model_fallback(todo[start:])
                return
            self.stats["model_calls"] += 1
            by_rid = {pr.spec.rid: pr for pr in batch}
            for r in out.get("rows", []):
                pr = by_rid.get(r.get("row_id"))
                if not pr:
                    continue
                pr.model_used = True
                conf = int(round(float(r.get("confidence") or 0) * 100))
                cid = r.get("candidate_id")
                if cid and cid in cand_map:
                    item, s = cand_map[cid]
                    self._apply_item(pr, item, "model", s, conf, f"Model chose “{item.text}” ({item.file_name} "
                                                                 f"row {item.row}): {r.get('reason', '')}")
                    if r.get("norm_h") is not None and item.norm_h is None:
                        pr.norm_h = float(r["norm_h"])
                elif r.get("norm_h") is not None or r.get("unit_material") is not None:
                    rate = self.target_rate or self.default_rate
                    pr.source, pr.reason = "model", f"Derived by analogy: {r.get('reason', '')}"
                    pr.norm_h = float(r["norm_h"]) if r.get("norm_h") is not None else pr.norm_h
                    pr.hourly_rate = rate
                    if pr.norm_h is not None and rate:
                        pr.unit_labour = round(pr.norm_h * rate, 4)
                    if r.get("unit_material") is not None:
                        pr.unit_material = float(r["unit_material"])
                    pr.matched = [i.ref(s) for i, s in pr._cands if i.file_id in self.allowed][:3]  # type: ignore[attr-defined]
                    pr.set_conf(min(conf, 60))
                else:
                    continue
                self.stats["model"] += 1
            self.progress("model", min(start + MODEL_BATCH, len(todo)), len(todo))

    # ----------------------------------------------------------------- stage 5
    def _web(self, rows: list[PricedRow], denied_rows: set[str]) -> None:
        if not self.web_lookup:
            return
        todo = [pr for pr in rows if pr.source in ("none", "norm") and pr.unit_material is None]
        for n, pr in enumerate(todo, 1):
            if self.should_stop():
                raise llm.Cancelled()
            self.current("web", pr.spec.text)
            found = self.web_lookup(pr.spec)
            if found and found.get("unit_price") is not None:
                pr.web = found
                pr.unit_material = float(found["unit_price"])
                if "WEB" not in pr.flags:
                    pr.flags.append("WEB")
                if pr.source == "none":
                    pr.source = "web"
                    pr.reason = (f"Retail web price from {found.get('domain') or found.get('url')} "
                                 f"({found.get('country') or '?'}, {found.get('url')}) — retail prices can run "
                                 f"~40% above contract prices")
                    pr.set_conf(40)
                else:
                    pr.reason += f"; material from web ({found.get('url')})"
                self.stats["web"] += 1
            self.progress("web", n, len(todo))

    def _apply_run_rate(self, rows: list[PricedRow]) -> None:
        """The estimator's hourly rate for this run applies to EVERY labour row: labour = norm hours × run rate."""
        if not self.target_rate:
            return
        for pr in rows:
            if pr.norm_h is not None:
                pr.hourly_rate = self.target_rate
                pr.unit_labour = round(pr.norm_h * self.target_rate, 4)

    # ----------------------------------------------------------------- run
    def price(self, specs: list[RowSpec], *, embeddings: dict[str, list[float]] | None = None,
              denied_rows: set[str] | None = None) -> list[PricedRow]:
        rows = [PricedRow(spec=s) for s in specs]
        self.stats["rows"] = len(rows)
        self.progress("exact", 0, len(rows))
        self._exact(rows)
        self.progress("exact", len(rows), len(rows))
        self._semantic(rows, embeddings)
        for pr in rows:
            # Rows the user already denied a file for go on to norms / model / web, never to another card.
            if (not pr.priced and pr.blocked_file and pr.blocked_file["file_id"] not in self.denied
                    and pr.spec.rid not in (denied_rows or ())):
                pr.source = "pending_permission"
                pr.reason = f"Best match is in {pr.blocked_file['file_name']}, which is not selected for this chat"
        self._norms(rows)
        self._model(rows)
        self._web(rows, denied_rows or set())
        self._apply_run_rate(rows)
        for pr in rows:
            if pr.source == "pending_permission":
                self.stats["pending_permission"] += 1
            elif not pr.priced:
                pr.source = "none"
                pr.flags = [f for f in pr.flags if f != "CHECK"] + ["NO PRICE"]
                pr.reason = pr.reason or "No price in any allowed file, norm file or web source"
                pr.confidence, pr.confidence_pct = None, None
                self.stats["none"] += 1
        self.stats["rows_without_model"] = sum(1 for pr in rows if not pr.model_used)
        return rows
