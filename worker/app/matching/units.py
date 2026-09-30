"""Unit-of-measure normalisation across LV / DA / NO / SV / EN / DE / RU / LT / ET / FI / PL estimates.

Canonical units: m, m2, m3, pcs, set, kg, t, l, h, km, lot, point.
"""
from __future__ import annotations

import re
from functools import lru_cache

from .text import fold_diacritics

CANONICAL_UNITS = ("m", "m2", "m3", "pcs", "set", "kg", "t", "l", "h", "km", "lot", "point")

_ALIASES: dict[str, tuple[str, ...]] = {
    "m": ("m", "m1", "mtr", "metrs", "metri", "metru", "meter", "meters", "metre", "metres", "tek m", "tekm",
          "tek metrs", "t m", "tm", "lm", "lbm", "lb m", "lob m", "lobende meter", "lobende m", "lin m",
          "running meter", "running metre", "rm", "lfm", "lfd m", "lfdm", "laufmeter", "м", "пм", "п м", "мп",
          "м п", "пог м", "jm", "jooksev m", "jm.", "mb", "metras", "metrai", "metriä", "metri"),
    "m2": ("m2", "kv m", "kvm", "kvadratmetrs", "sq m", "sqm", "sq ft2", "m 2", "м2", "кв м", "m^2", "kvadratmeter"),
    "m3": ("m3", "kub m", "kubm", "м3", "куб м", "cbm", "m^3", "kubikmeter"),
    "pcs": ("gab", "gb", "gabals", "gabali", "gabalu", "pcs", "pc", "pce", "piece", "pieces", "ea", "each", "no",
            "nr", "num", "stk", "stck", "stuck", "stueck", "styk", "styck", "stykk", "шт", "штук", "vnt", "vienetai",
            "tk", "tukk", "kpl_fi", "szt", "sztuk", "unit", "units", "u", "un", "enh", "item", "items"),
    "set": ("kompl", "komplekts", "komplekti", "kompl", "kmpl", "kpl", "set", "sets", "saet", "sat", "sats",
            "sett", "satz", "компл", "к т", "комплект", "kompl t", "kompl.", "kit", "komplektas", "kompleks",
            "zestaw", "kmp"),
    "kg": ("kg", "kilogram", "kilograms", "кг", "kilo"),
    "t": ("t", "tn", "tonna", "tonnas", "ton", "tons", "tonne", "tonnes", "т"),
    "l": ("l", "ltr", "litrs", "litri", "liter", "litre", "litres", "liters", "л"),
    "h": ("h", "hr", "hrs", "hour", "hours", "stunda", "stundas", "st_lv", "c h", "ch", "cilv st", "cilvst",
          "cilv h", "man hour", "man hours", "manhour", "timer", "time", "tim", "timmar", "timme", "std",
          "stunden", "час", "ч", "чел ч", "val", "tund", "tunti"),
    "km": ("km", "км", "kilometrs", "kilometer"),
    "lot": ("lot", "ls", "lump sum", "obj", "objekts", "objekta", "pauš", "paus", "pausal", "pausals",
            "pauschal", "psch", "pau", "lumpsum", "job", "sum", "kompl obj", "object", "sam", "samlet", "fast pris"),
    "point": ("vieta", "vietas", "punkts", "punkti", "point", "points", "pt", "pts", "pkt", "punkt", "tilslutning",
              "tilsl", "udtag", "uttag", "точка", "taskas"),
}

_LOOKUP: dict[str, str] = {}
for _canon, _names in _ALIASES.items():
    for _n in _names:
        _LOOKUP.setdefault(_n, _canon)
_LOOKUP.pop("kpl_fi", None)
_LOOKUP.pop("st_lv", None)

_RE_CLEAN = re.compile(r"[.\s,;:_/\\()\[\]-]+")


@lru_cache(maxsize=4096)
def normalise_unit(raw: str | None, lang: str | None = None) -> str | None:
    """Map a raw unit label to a canonical unit, or None when empty/unknown.

    `lang` only disambiguates: "st." is hours ("stundas") in Latvian but pieces ("styck") in Swedish/German;
    "kpl" is a set in Latvian but pieces in Finnish.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    low = fold_diacritics(s.lower()).replace("²", "2").replace("³", "3")
    low = low.replace("æ", "ae")
    lang = (lang or "").upper()
    compact = _RE_CLEAN.sub(" ", low).strip()
    if compact in ("st", "st.") or low.strip() in ("st", "st."):
        return "h" if lang == "LV" else "pcs"
    if compact == "kpl" and lang == "FI":
        return "pcs"
    for cand in (compact, compact.replace(" ", ""), low.strip().rstrip(".")):
        if cand in _LOOKUP:
            return _LOOKUP[cand]
    # "m." / "m2." / "gab.)" / "1 gab" / "per m" / "EUR/m"
    m = re.match(r"^(?:1\s+|per\s+|pr\s+|eur\s+|a\s+)?([a-zа-я0-9 ]+?)$", compact)
    if m and m.group(1) in _LOOKUP:
        return _LOOKUP[m.group(1)]
    return None


# Countable units that describe the same thing in practice ("gab." vs "kompl." vs "vieta").
_COMPAT_GROUPS = ({"pcs", "set", "point"}, {"set", "lot"})


def units_compatible(a: str | None, b: str | None, lang: str | None = None) -> bool:
    """True when two raw or canonical units describe the same measure. Unknown units never block."""
    na = a if a in CANONICAL_UNITS else normalise_unit(a, lang)
    nb = b if b in CANONICAL_UNITS else normalise_unit(b, lang)
    if na is None or nb is None:
        return True
    if na == nb:
        return True
    return any(na in g and nb in g for g in _COMPAT_GROUPS)
