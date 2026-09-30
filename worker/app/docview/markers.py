"""Per-row provenance markers for produced estimates (``estimate_rows``)."""
from __future__ import annotations

from typing import Any

from .. import db

# Highest priority first.
MARKER_PRIORITY = ("EDITED", "NO PRICE", "WEB", "CHECK")
_IMPLIED = {"edited": "EDITED", "none": "NO PRICE", "web": "WEB"}
_COUNT_KEYS = {"WEB": "web", "CHECK": "check", "NO PRICE": "no_price", "EDITED": "edited"}


def effective_flags(flags: list[str] | None, price_source: str | None) -> set[str]:
    eff = {str(f).upper() for f in (flags or [])}
    implied = _IMPLIED.get(price_source or "")
    if implied:
        eff.add(implied)
    return eff


def marker_for(eff: set[str]) -> str | None:
    for m in MARKER_PRIORITY:
        if m in eff:
            return m
    return None


def _row_info(r: dict) -> dict[str, Any]:
    eff = effective_flags(r["flags"], r["price_source"])
    return {
        "marker": marker_for(eff),
        "flags": list(r["flags"] or []),
        "price_source": r["price_source"],
        "confidence": r["confidence"],
        "confidence_pct": r["confidence_pct"],
        "estimate_row_id": str(r["id"]),
        "_eff": eff,  # internal: used by filters, stripped from responses
    }


def load_markers(document_id: str, sheet_name: str) -> dict[int, dict]:
    rows = db.fetchall(
        "SELECT id, row_idx, flags, price_source, confidence, confidence_pct FROM estimate_rows "
        "WHERE document_id = %s AND sheet_name = %s", (document_id, sheet_name))
    return {r["row_idx"]: _row_info(r) for r in rows}


def marker_counts(document_id: str) -> dict[str, dict[str, int]]:
    """Per sheet: ``{web, check, no_price, edited, flagged}`` (a row counts once per flag it carries)."""
    rows = db.fetchall(
        "SELECT sheet_name, flags, price_source FROM estimate_rows WHERE document_id = %s", (document_id,))
    out: dict[str, dict[str, int]] = {}
    for r in rows:
        c = out.setdefault(r["sheet_name"], {"web": 0, "check": 0, "no_price": 0, "edited": 0, "flagged": 0})
        eff = effective_flags(r["flags"], r["price_source"])
        for f in eff:
            k = _COUNT_KEYS.get(f)
            if k:
                c[k] += 1
        if marker_for(eff):
            c["flagged"] += 1
    return out
