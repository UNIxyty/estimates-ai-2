"""Text normalisation for matching estimate rows.

`normalise_text` produces a stable, language-agnostic key: lowercase, diacritics folded, numbers in one
format ("3×2,5 mm²" -> "3x2.5 mm2"), punctuation noise removed. `strip_brands` removes manufacturer and
product-series names so that two brands of the same cable/device map to the same key. Cable TYPES
(NYM, NYY, CYKY, MMJ, AXMK, N2XH, ...) are not brands and are kept.
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

# Letters NFKD does not decompose.
_SPECIAL_FOLD = str.maketrans({
    "ø": "o", "Ø": "o", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ß": "ss", "ł": "l", "Ł": "l",
    "đ": "d", "Đ": "d", "þ": "th", "ð": "d", "ı": "i", "∅": "o",
    "²": "2", "³": "3", "×": "x", "·": " ", "–": "-", "—": "-", "‐": "-", " ": " ",
})

_RE_MULT = re.compile(r"(?<=\d)\s*[x×*хХX]\s*(?=\(?\d)")      # 3 x 1,5 / 3×1.5 / 3*1.5 / cyrillic х
_RE_DEC_COMMA = re.compile(r"(?<=\d),(?=\d)")
_RE_MM2 = re.compile(r"\bmm\s*(?:\^\s*)?2\b|\bmm\s*kv\b|\bkv\.?\s*mm\b")
_RE_NOISE = re.compile(r"[^\w\s.%/+-]", re.UNICODE)
_RE_DOT_NOT_DEC = re.compile(r"(?<!\d)\.|\.(?!\d)")
_RE_DASH = re.compile(r"(?<!\d)-|-(?!\d)")
_RE_SLASH = re.compile(r"(?<![\w])/|/(?![\w])")
_RE_WS = re.compile(r"\s+")
_RE_UNDERSCORE = re.compile(r"_+")


def fold_diacritics(s: str) -> str:
    s = s.translate(_SPECIAL_FOLD)
    decomposed = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


@lru_cache(maxsize=65536)
def normalise_text(s: str | None) -> str:
    """Lowercase, fold diacritics, unify number formats, strip punctuation noise, collapse whitespace."""
    if s is None:
        return ""
    s = str(s)
    if not s:
        return ""
    s = fold_diacritics(s.lower())
    s = _RE_DEC_COMMA.sub(".", s)
    s = _RE_MULT.sub("x", s)
    s = _RE_MM2.sub("mm2", s)
    s = _RE_NOISE.sub(" ", s)
    s = _RE_UNDERSCORE.sub(" ", s)
    s = _RE_DOT_NOT_DEC.sub(" ", s)
    s = _RE_DASH.sub(" ", s)
    s = _RE_SLASH.sub(" ", s)
    # "mm 2" split by the noise pass (e.g. "mm²)" -> "mm2")
    s = re.sub(r"\bmm 2\b", "mm2", s)
    return _RE_WS.sub(" ", s).strip()


# Manufacturer / brand / product-series names. Deliberately NOT included: cable type designations
# (NYM, NYY, CYKY, MMJ, NOIKLX, PFXP, AXMK, N2XH, FTP, UTP, H07RN-F ...) which change the item.
BRANDS: tuple[str, ...] = (
    # devices / distribution
    "schneider electric", "schneider", "abb", "hager", "legrand", "siemens", "eaton", "moeller",
    "gewiss", "jung", "gira", "busch jaeger", "busch-jaeger", "berker", "merten", "elko", "elko ep",
    "lk fuga", "fuga", "opus", "schrack", "kopos", "kaiser", "spelsberg", "wago", "hensel", "fibox",
    "obo bettermann", "obo", "niedax", "pemsa", "vergokan", "rittal", "finder", "doepke", "chint",
    "noark", "etipro", "eti", "kanlux", "vimar", "bticino", "simon", "ensto", "malmbergs",
    "unica", "sedna", "asfora", "mureva", "niloe", "valena", "celiane", "mosaic", "odace", "exxact",
    "acti9", "resi9", "ic60", "easy9", "multi9", "system m", "ls990", "future linear", "reflex si",
    "tehalit", "dlp", "plexo", "prisma", "pragma", "mini pragma", "kaedra", "volta", "gamma",
    # cables
    "draka", "prysmian", "nexans", "reka", "keinutuote", "nkt", "helukabel", "lapp", "olflex",
    "cabloswiss", "top cable", "klaus faber", "elektrokabel", "eltrak", "tele fonika", "telefonika",
    "bitner", "elkeila", "kabeltec", "nkt cables", "faber", "sab brockskes", "general cable",
    "dätwyler", "datwyler", "belden", "leoni", "cavel", "technokabel",
    # lighting
    "philips", "signify", "osram", "ledvance", "zumtobel", "thorn", "trilux", "fagerhult", "glamox",
    "luxonic", "sylvania", "havells", "disano", "ridi", "regent", "louis poulsen", "nordlux",
    "lival", "etap", "iguzzini", "lug", "cariboni", "performance in lighting", "tridonic", "helvar",
    # fire / low current
    "bosch", "honeywell", "notifier", "esser", "apollo", "hochiki", "zeta", "kentec", "cooper",
    "hikvision", "dahua", "axis", "paxton", "aritech",
)

_BRAND_RE = re.compile(
    r"(?<![\w])(?:" + "|".join(sorted((re.escape(normalise_text(b)) for b in BRANDS), key=len, reverse=True))
    + r")(?![\w])"
)


@lru_cache(maxsize=65536)
def strip_brands(s: str | None) -> str:
    """Normalise `s` and remove brand/series tokens. Types (NYM, NYY, CYKY ...) are kept."""
    n = normalise_text(s)
    if not n:
        return ""
    n = _BRAND_RE.sub(" ", n)
    # a bare "tips"/"type"/"razotajs"/"brand" left dangling after removal is noise
    n = re.sub(r"\b(?:razotajs|zimols|brand|manufacturer|fabrikat|fabr|marke|merke|tip|type)\b\s*$", " ", n)
    return _RE_WS.sub(" ", n).strip()


def tokens(s: str | None) -> list[str]:
    return normalise_text(s).split()
