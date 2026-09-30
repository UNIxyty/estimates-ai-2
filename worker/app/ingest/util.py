"""Small helpers shared by the ingest modules."""
from __future__ import annotations

import re
from typing import Any

from openpyxl.utils.cell import get_column_letter

_CURRENCY_NOISE = re.compile(
    r"(eur|euro|eiro|€|dkk|nok|sek|kr\.?|usd|\$|£|gbp|pln|zl|zł|ls|lvl|руб\.?|rub|chf|,-)", re.IGNORECASE)
_NUMLIKE = re.compile(r"^[+-]?[\d\s.,'’  ]*\d[\d\s.,'’  ]*$")
_PCT = re.compile(r"^\s*([+-]?\d+(?:[.,]\d+)?)\s*%\s*$")


def parse_number(v: Any) -> float | None:
    """Number from a cell value. Handles numbers stored as text: "12,50", "1 234,50", "1.234,50",
    "1,234.50", "€ 12.50", "12.50 EUR", "25%" (-> 0.25). Returns None for empty / non-numeric."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    s = str(v).strip()
    if not s or len(s) > 40:
        return None
    m = _PCT.match(s)
    if m:
        return float(m.group(1).replace(",", ".")) / 100.0
    s = _CURRENCY_NOISE.sub("", s).strip()
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    if not s or not _NUMLIKE.match(s):
        return None
    s = re.sub(r"[\s'’  ]", "", s)
    neg = s.startswith("-")
    s = s.lstrip("+-")
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):        # 1.234,50
            s = s.replace(".", "").replace(",", ".")
        else:                                   # 1,234.50
            s = s.replace(",", "")
    elif "," in s:
        parts = s.split(",")
        if len(parts) > 2:                      # 1,234,567
            s = s.replace(",", "")
        else:
            s = s.replace(",", ".")             # 12,50 (decimal comma; "1,234" is also read as 1.234)
    elif s.count(".") > 1:                      # 1.234.567
        s = s.replace(".", "")
    try:
        f = float(s)
    except ValueError:
        return None
    return -f if neg else f


def is_text(v: Any) -> bool:
    return isinstance(v, str) and parse_number(v) is None and any(ch.isalpha() for ch in v)


def coord(row: int, col: int) -> str:
    return f"{get_column_letter(col)}{row}"


def close(a: float | None, b: float | None, *, rel: float = 0.006, abs_tol: float = 0.011) -> bool:
    if a is None or b is None:
        return False
    return abs(a - b) <= max(abs_tol, rel * max(abs(a), abs(b)))


def r2(x: float | None, nd: int = 4) -> float | None:
    return None if x is None else round(float(x), nd)
