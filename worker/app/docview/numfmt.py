"""Pragmatic Excel number-format renderer for the viewer.

Not a full implementation of the Excel format language; it covers what estimates use:
sections (pos;neg;zero;text), decimals, thousands grouping, percent, scaling commas,
literal text / currency symbols (quoted, escaped, `[$€-426]`), dates and times, and
falls back to a "General"-style rendering for anything it cannot parse (fractions,
scientific with odd patterns, ...).

Two output styles: ``en`` (1,234.50) and ``eu`` (1 234,50). The workbook-level style
is guessed by :func:`guess_locale` from the LCIDs that appear in its formats.
"""
from __future__ import annotations

import datetime as _dt
import math
import re
from functools import lru_cache

from openpyxl.styles.numbers import BUILTIN_FORMATS, is_date_format

# LCIDs whose locale writes 1 234,50 / 1.234,50 (lv, lt, et, da, de, fi, fr, nb, sv, pl, ru, es, it, nl ...).
_EU_LCIDS = {
    0x426, 0x427, 0x425, 0x406, 0x407, 0x40B, 0x40C, 0x414, 0x41D, 0x415, 0x419,
    0x40A, 0xC0A, 0x410, 0x413, 0x813, 0x405, 0x40E, 0x424, 0x41A, 0x418, 0x816, 0x422,
    0xC07, 0x807, 0x80C, 0x100C,
}
_LCID_RE = re.compile(r"\[\$[^\]\-]*-([0-9A-Fa-f]+)\]")
_BRACKET_RE = re.compile(r"\[[^\]]*\]")
_COND_RE = re.compile(r"^\[(<=|>=|<>|<|>|=)(-?[0-9.]+)\]")


def guess_locale(formats: set[str]) -> str:
    for fmt in formats:
        for m in _LCID_RE.finditer(fmt or ""):
            try:
                if int(m.group(1), 16) & 0xFFFF in _EU_LCIDS:
                    return "eu"
            except ValueError:
                pass
    return "en"


# ------------------------------------------------------------------ general

def _general_number(v: float, loc: str) -> str:
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        s = str(v)
    else:
        if math.isnan(v) or math.isinf(v):
            return "#NUM!"
        if v == int(v) and abs(v) < 1e15:
            s = str(int(v))
        else:
            a = abs(v)
            if a != 0 and (a >= 1e11 or a < 1e-9):
                s = f"{v:.5E}"
            else:
                # Excel General shows ~10 significant digits.
                s = f"{v:.10g}"
                if "e" in s or "E" in s:
                    s = f"{v:.10f}".rstrip("0").rstrip(".")
    if loc == "eu":
        s = s.replace(".", ",")
    return s


def _group(int_digits: str, sep: str) -> str:
    out = []
    while len(int_digits) > 3:
        out.append(int_digits[-3:])
        int_digits = int_digits[:-3]
    out.append(int_digits)
    return sep.join(reversed(out))


# ------------------------------------------------------------------ parsing

def _split_sections(fmt: str) -> list[str]:
    parts, cur, q, esc = [], [], False, False
    for ch in fmt:
        if esc:
            cur.append(ch)
            esc = False
            continue
        if ch == "\\" and not q:
            cur.append(ch)
            esc = True
            continue
        if ch == '"':
            q = not q
        if ch == ";" and not q:
            parts.append("".join(cur))
            cur = []
            continue
        cur.append(ch)
    parts.append("".join(cur))
    return parts


class _NumPattern:
    __slots__ = ("prefix", "suffix", "decimals", "min_dec", "group", "percent", "scale", "min_int", "sci", "ok")

    def __init__(self) -> None:
        self.prefix = ""
        self.suffix = ""
        self.decimals = 0
        self.min_dec = 0
        self.group = False
        self.percent = 0
        self.scale = 0
        self.min_int = 0
        self.sci = False
        self.ok = True


@lru_cache(maxsize=2048)
def _parse_number_section(sec: str) -> _NumPattern:
    p = _NumPattern()
    # Tokenise into (kind, text): 'lit' or 'ph' (placeholder char) or 'dot' / 'comma'
    toks: list[tuple[str, str]] = []
    i, n = 0, len(sec)
    while i < n:
        ch = sec[i]
        if ch == '"':
            j = sec.find('"', i + 1)
            j = n if j < 0 else j
            toks.append(("lit", sec[i + 1:j]))
            i = j + 1
            continue
        if ch == "\\":
            if i + 1 < n:
                toks.append(("lit", sec[i + 1]))
            i += 2
            continue
        if ch == "_":  # padding the width of next char
            toks.append(("lit", " "))
            i += 2
            continue
        if ch == "*":  # fill
            i += 2
            continue
        if ch == "[":
            j = sec.find("]", i)
            j = n if j < 0 else j
            inner = sec[i + 1:j]
            if inner.startswith("$"):
                sym = inner[1:].split("-", 1)[0]
                if sym:
                    toks.append(("lit", sym))
            i = j + 1
            continue
        if ch in "0#?":
            toks.append(("ph", ch))
        elif ch == ".":
            toks.append(("dot", ch))
        elif ch == ",":
            toks.append(("comma", ch))
        elif ch == "%":
            p.percent += 1
            toks.append(("lit", "%"))
        elif ch in "eE" and i + 1 < n and sec[i + 1] in "+-":
            p.sci = True
            i += 2
            while i < n and sec[i] in "0#":
                i += 1
            continue
        elif ch == "/":
            p.ok = False  # fractions: not supported
            return p
        elif ch == "@":
            toks.append(("lit", ""))
        else:
            toks.append(("lit", ch))
        i += 1

    ph_idx = [k for k, (t, _) in enumerate(toks) if t in ("ph", "dot")]
    if not ph_idx:
        p.prefix = "".join(v for t, v in toks if t == "lit")
        p.ok = True
        p.min_int = -1  # no number shown
        return p
    first, last = ph_idx[0], ph_idx[-1]
    # scaling commas directly after the last placeholder
    k = last + 1
    while k < len(toks) and toks[k][0] == "comma":
        p.scale += 1
        k += 1
    p.prefix = "".join(v for t, v in toks[:first] if t == "lit")
    p.suffix = "".join(v for t, v in toks[k:] if t in ("lit",))
    core = toks[first:last + 1]
    seen_dot = False
    for t, v in core:
        if t == "dot":
            seen_dot = True
        elif t == "comma" and not seen_dot:
            p.group = True
        elif t == "ph":
            if seen_dot:
                p.decimals += 1
                if v == "0":
                    p.min_dec += 1
            elif v == "0":
                p.min_int += 1
        elif t == "lit":
            # literal inside the number (e.g. "0 000"): treat a space as grouping
            if v == " " and not seen_dot:
                p.group = True
    return p


def _render_number(v: float, pat: _NumPattern, loc: str, sign: bool) -> str:
    if pat.min_int == -1:
        return pat.prefix
    x = abs(v)
    x = x * (100 ** pat.percent) / (1000 ** pat.scale)
    if pat.sci:
        body = f"{x:.{pat.decimals}E}"
        if loc == "eu":
            body = body.replace(".", ",")
    else:
        body = f"{x:.{pat.decimals}f}"
        if "." in body:
            ip, fp = body.split(".")
        else:
            ip, fp = body, ""
        if pat.decimals > pat.min_dec and fp:
            fp = fp.rstrip("0")
            if len(fp) < pat.min_dec:
                fp = fp.ljust(pat.min_dec, "0")
        if ip == "0" and pat.min_int == 0:
            ip = ""
        if pat.min_int > len(ip):
            ip = ip.rjust(pat.min_int, "0")
        thou, dec = (" ", ",") if loc == "eu" else (",", ".")
        if pat.group and ip:
            ip = _group(ip, thou)
        body = ip + (dec + fp if fp else "")
    neg = sign and v < 0 and any(c in "123456789" for c in body.split("E")[0])
    return f"{'-' if neg else ''}{pat.prefix}{body}{pat.suffix}"


# ------------------------------------------------------------------ dates

_DATE_TOKEN_RE = re.compile(
    r'(?i)"[^"]*"|\\.|\[[^\]]*\]|am/pm|a/p|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|\.0+|.')

_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
           "October", "November", "December"]
_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _render_date(v, fmt: str) -> str:
    if isinstance(v, _dt.timedelta):
        v = _dt.datetime(1899, 12, 30) + v
    if isinstance(v, _dt.time):
        v = _dt.datetime.combine(_dt.date(1899, 12, 30), v)
    elif isinstance(v, _dt.date) and not isinstance(v, _dt.datetime):
        v = _dt.datetime.combine(v, _dt.time())
    toks = _DATE_TOKEN_RE.findall(fmt)
    ampm = any(t.lower() in ("am/pm", "a/p") for t in toks)
    out: list[str] = []
    for idx, t in enumerate(toks):
        tl = t.lower()
        if t.startswith('"'):
            out.append(t[1:-1])
        elif t.startswith("\\"):
            out.append(t[1:])
        elif t.startswith("["):
            inner = t[1:-1].lower()
            if inner in ("h", "hh"):
                out.append(str(int((v - _dt.datetime(1899, 12, 30)).total_seconds() // 3600)))
            elif inner.startswith("$"):
                sym = t[2:-1].split("-", 1)[0]
                out.append(sym)
        elif tl == "yyyy":
            out.append(f"{v.year:04d}")
        elif tl == "yy":
            out.append(f"{v.year % 100:02d}")
        elif tl in ("mm", "m"):
            # minutes if after an hour token or before a seconds token
            prev = next((x.lower() for x in reversed(toks[:idx]) if x.strip() and x[0].isalpha()), "")
            nxt = next((x.lower() for x in toks[idx + 1:] if x.strip() and x[0].isalpha()), "")
            if prev.startswith("h") or nxt.startswith("s"):
                out.append(f"{v.minute:02d}" if tl == "mm" else str(v.minute))
            else:
                out.append(f"{v.month:02d}" if tl == "mm" else str(v.month))
        elif tl == "mmm":
            out.append(_MONTHS[v.month - 1][:3])
        elif tl == "mmmm":
            out.append(_MONTHS[v.month - 1])
        elif tl == "mmmmm":
            out.append(_MONTHS[v.month - 1][0])
        elif tl == "dd":
            out.append(f"{v.day:02d}")
        elif tl == "d":
            out.append(str(v.day))
        elif tl == "ddd":
            out.append(_DAYS[v.weekday()][:3])
        elif tl == "dddd":
            out.append(_DAYS[v.weekday()])
        elif tl in ("hh", "h"):
            h = v.hour
            if ampm:
                h = h % 12 or 12
            out.append(f"{h:02d}" if tl == "hh" else str(h))
        elif tl == "ss":
            out.append(f"{v.second:02d}")
        elif tl == "s":
            out.append(str(v.second))
        elif tl.startswith(".0"):
            digits = len(t) - 1
            out.append("." + f"{v.microsecond:06d}"[:digits])
        elif tl == "am/pm":
            out.append("AM" if v.hour < 12 else "PM")
        elif tl == "a/p":
            out.append("A" if v.hour < 12 else "P")
        else:
            out.append(t)
    return "".join(out)


# ------------------------------------------------------------------ entry point

def format_value(value, fmt: str | None, loc: str = "en") -> str:
    """Render ``value`` the way Excel would show it with number format ``fmt``."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    fmt = fmt or "General"
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time, _dt.timedelta)):
        if is_date_format(fmt) or fmt.startswith("["):
            try:
                return _render_date(value, _strip_for_date(fmt))
            except Exception:  # noqa: BLE001 - never fail a render
                pass
        if isinstance(value, _dt.datetime):
            return value.strftime("%Y-%m-%d %H:%M" if (value.hour or value.minute) else "%Y-%m-%d")
        return value.isoformat()
    if isinstance(value, str):
        secs = _split_sections(fmt)
        if len(secs) >= 4 and "@" in secs[3]:
            return secs[3].replace('"', "").replace("@", value)
        return value
    if not isinstance(value, (int, float)):
        return str(value)

    if fmt == "General" or fmt.lower() == "general":
        return _general_number(value, loc)
    try:
        return _format_number(float(value) if not isinstance(value, int) else value, fmt, loc)
    except Exception:  # noqa: BLE001
        return _general_number(value, loc)


def _strip_for_date(fmt: str) -> str:
    return _split_sections(fmt)[0]


def _format_number(v, fmt: str, loc: str) -> str:
    secs = _split_sections(fmt)
    # Conditional sections ([>=100]) are rare in estimates: evaluate the simple case.
    sec: str
    sign = True
    if any(_COND_RE.match(s) for s in secs):
        sec = secs[-1]
        for s in secs:
            m = _COND_RE.match(s)
            if not m:
                continue
            op, lim = m.group(1), float(m.group(2))
            if {"<": v < lim, ">": v > lim, "=": v == lim, "<=": v <= lim, ">=": v >= lim,
                    "<>": v != lim}[op]:
                sec = s
                break
    elif len(secs) == 1 or not secs[0]:
        sec = secs[0]
    elif v > 0 or (v == 0 and len(secs) < 3):
        sec = secs[0]
    elif v < 0:
        sec, sign = secs[1], False
    else:
        sec = secs[2]
    if sec.lower() == "general":
        return _general_number(v if sign else abs(v), loc)
    if is_date_format(sec):
        try:
            base = _dt.datetime(1899, 12, 30) + _dt.timedelta(days=float(v))
            return _render_date(base, sec)
        except (OverflowError, ValueError):
            return _general_number(v, loc)
    pat = _parse_number_section(sec)
    if not pat.ok:
        return _general_number(v, loc)
    return _render_number(v, pat, loc, sign)


def builtin_format(fmt_id: int) -> str:
    return BUILTIN_FORMATS.get(fmt_id, "General")
