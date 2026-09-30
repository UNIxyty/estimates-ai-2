"""Technical attribute extraction and the HARD compatibility filter used during matching.

`parse_attributes("Kabelis NYM-J 3x1,5 mm²")` -> {"category": "cable", "cores": 3, "cross_section_mm2": 1.5,
"cable_type": "nym j"}. `attributes_compatible(a, b)` is False whenever a technical attribute present on both
sides differs (a 3x1.5 cable never matches a 5x2.5 one) or the categories differ. Brands never matter.
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from .text import normalise_text

CATEGORIES = (
    "cable", "cable_tray", "conduit", "socket", "switch", "luminaire", "distribution_board", "breaker", "rcd",
    "junction_box", "earthing", "data_outlet", "fire_alarm", "labour_only", "other",
)

# Keyword stems per category (matched at a word start on normalised, diacritic-folded text).
# Resolution: earliest match in the text wins; at the same position the longest keyword wins, so
# "kabelu trase" (tray) beats "kabel" (cable) and "automatsledzis" (breaker) beats "sledzis" (switch).
_CATEGORY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "cable_tray": (
        "kabelu trase", "kabelu trases", "kabelu plaukt", "kabelu kanal", "kabelu renes", "kabelu ren", "kabelu teknes",
        "kabelu tekn", "kabelu kapnes", "kabelu kapn", "kabeltrase", "perforeta tekne", "tekne", "kabelu gald",
        "kabelu rezg", "cable tray", "cable trays", "cable ladder", "cable basket", "wire mesh tray", "trunking",
        "cable trunking", "cable duct", "kabelbakke", "kabelbakker", "kabelstige", "kabelkanal", "kabelrinne",
        "kabelpritsche", "gitterrinne", "kabelstege", "kabelranna", "kabelhylla", "kaapelihylly", "kaapelikouru",
        "kabeliu lovel", "kaablirenn", "лоток", "кабельный канал", "кабель канал", "короб", "koryto kablowe",
        "listwa", "kanal kablowy", "installationskanal", "el kanal", "elkanal",
    ),
    "conduit": (
        "caurul", "gofret", "gofr caur", "aizsargcaurul", "conduit", "flex pipe", "flexible pipe", "pipe",
        "flexror", "flex ror", "ror", "installationsror", "rohr", "wellrohr", "installationsrohr", "putki",
        "suojaputki", "vamzd", "toru", "гофр", "труба", "rura", "peschel", "pesel",
    ),
    "cable": (
        "kabel", "kabelis", "kabela", "kabeli", "kabelu", "vads", "vadi", "vada", "cable", "cables", "wire", "wiring",
        "ledning", "ledninger", "installationskabel", "leitung", "kaapeli", "kaabel", "laidas", "кабель", "провод",
        "przewod", "nym", "nyy", "nhxh", "n2xh", "cyky", "cykyd", "mmj", "pvikj", "noiklx", "noikx", "pfxp", "axmk",
        "mcmk", "exq", "nhxmh", "h07rn", "h05vv", "yky", "vvg", "ппв", "utp", "ftp", "sftp", "cat6", "cat5", "cat 6",
        "cat 5", "optical fibre", "optiskais", "jyst", "j y st", "liycy", "fe180", "ngo", "pp00", "pvc cable",
        "installation cable", "power cable", "vadu", "kabelu vilksana", "kabeli ievilksana", "kabelu ievilk",
    ),
    "socket": (
        "kontaktligzd", "rozete", "rozetes", "socket", "sockets", "outlet", "receptacle", "power point",
        "stikkontakt", "stikkontakter", "stikk", "steckdose", "schuko", "uttag", "vagguttag", "pistorasia",
        "pistikupesa", "lizd", "розетк", "gniazd", "cee ligzd", "cee socket", "cee kontakt",
    ),
    "switch": (
        "sledz", "slēdz", "switch", "switches", "dimmer", "dimmeris", "gaismas sledz", "afbryder", "kontakt afbryder",
        "schalter", "lichtschalter", "strombrytare", "brytare", "kytkin", "valokatkaisin", "luliti", "jungikl",
        "выключател", "lacznik", "wlacznik", "poga", "button", "push button", "tryk", "tryk knap", "trykknap",
        "kustibas sensor", "kustibas detektor", "klatbutnes sensor", "klatbutnes detektor", "motion detector",
        "motion sensor", "presence detector", "pir sensor", "bevaegelsesmelder", "bevaegelsessensor",
        "tilstedevaerelsesmelder", "bewegungsmelder", "rorelsevakt", "liiketunnistin",
    ),
    "luminaire": (
        "gaismekl", "lampa", "lampas", "prozektor", "spuldz", "downlight", "luminaire", "luminaires", "light fitting",
        "lighting fixture", "light fixture", "fixture", "led panel", "led panelis", "led lente", "led strip",
        "floodlight", "lamp", "lamps", "armatur", "armaturer", "lysarmatur", "loftlampe", "spot", "spots",
        "leuchte", "leuchten", "valaisin", "valgusti", "sviestuv", "светильник", "лампа", "prozektors",
        "oprawa", "evakuacijas gaismekl", "exit sign", "emergency light", "nodlys",
        "nodbelysning", "panikbelysning",
    ),
    "distribution_board": (
        "sadal", "sadales skap", "sadalne", "sadalnes", "el skap", "elektrosadal", "skapis", "distribution board",
        "distribution panel", "switchboard", "panelboard", "panel board", "consumer unit", "db board", "enclosure",
        "tavle", "gruppetavle", "eltavle", "el tavle", "hovedtavle", "undertavle", "sikringsskab", "fordelingsskab",
        "tavla", "sikringsskap", "sikringstavle", "verteiler", "unterverteilung", "verteilerschrank",
        "elcentral", "central", "gruppcentral", "keskus", "ryhmakeskus", "jakokeskus", "kilp", "skyd", "щит",
        "щиток", "rozdzielnic", "sadales kapnes", "skapja", "skapa", "modulu skap",
    ),
    "breaker": (
        "automatsledz", "automats", "automata", "automati", "automatisk sikring", "automatsikring", "automatsikr",
        "mcb", "circuit breaker", "miniature circuit breaker", "breaker", "breakers", "sikring", "sikringer",
        "kombirele", "leitungsschutzschalter", "ls schalter", "sicherungsautomat", "dvargbrytare", "sakring",
        "johdonsuojakatkaisija", "automaatkaitse", "kaitselul", "automatinis jungikl", "автоматический выключател",
        "автомат", "wylacznik nadpradow", "drošinatāj", "drosinataj", "fuse", "fuses", "slēdžautomāt",
        "sledzautomat", "jaudas sledz", "slodzes sledz", "mccb", "load break", "sikkerhedsafbryder",
        "lastfrakobler", "lastskillebryter", "lastfraskiller", "ievadslēdz", "ievadsledz",
    ),
    "rcd": (
        "noplud", "nopludes stravas", "diferencial", "rcd", "rcbo", "rccb", "residual current", "earth leakage",
        "elcb", "hpfi", "hfi", "fejlstrom", "fejlstromsafbryder", "jordfeil", "jordfeilbryter", "jordfelsbrytare",
        "fi schalter", "fi ls", "fehlerstrom", "vikavirta", "vikavirtasuoja", "rikkevool", "nuotekio",
        "узо", "дифавтомат", "roznicowopradow", "strāvas noplūdes", "stravas nopludes", "difautomat",
    ),
    "junction_box": (
        "sadales karb", "nozarkarb", "karba", "karbas", "montazas karb", "kārba", "zemapmetuma karb",
        "virsapmetuma karb", "junction box", "junction boxes", "back box", "backbox", "flush box", "box",
        "dase", "daase", "samledase", "forgreningsdase", "indmuringsdase", "koblingsboks", "koplingsboks",
        "abzweigdose", "verteilerdose", "unterputzdose", "gerätedose", "geratedose", "kopplingsdosa", "dosa",
        "kytkentarasia", "rasia", "harukarp", "karp", "dezut", "коробка", "puszk",
    ),
    "earthing": (
        "zemej", "zemesan", "zemētāj", "zemetaj", "zibensaizsardz", "zibens", "potencialu izlidz", "potencialu",
        "earthing", "earth rod", "earth electrode", "grounding", "ground rod", "lightning", "bonding",
        "equipotential", "jording", "jordspyd", "jordleder", "potentialudligning", "jordingsanlegg", "lynavleder",
        "erdung", "potentialausgleich", "blitzschutz", "jordning", "maadoitus", "maandus", "iszemin",
        "заземлен", "молниезащит", "uziemien", "pe kopne", "pe kopn", "zemējuma kopne",
    ),
    "data_outlet": (
        "datu rozet", "datu ligzd", "datu kontaktligzd", "rj45", "rj 45", "rj11", "data outlet", "data point",
        "data socket", "network outlet", "datu punkt", "dataudtag", "data udtag", "datastik", "netvaerksudtag",
        "datauttag", "datenanschluss", "datendose", "netzwerkdose", "atk rasia", "datapistorasia", "andmepesa",
        "kompiuterinis lizd", "компьютерная розетка", "gniazdo komputerowe", "tv rozet", "tv ligzd", "tv outlet",
        "antenas rozet", "antennestik",
    ),
    "fire_alarm": (
        "ugunsgrek", "ugunsdrosibas signaliz", "ugunsdzes", "dumu detektor", "dumu detekt", "siltuma detektor",
        "detektor", "detektors", "adss", "ugunsaizsardz", "fire alarm", "smoke detector", "heat detector",
        "manual call point", "call point", "sounder", "brandalarm", "roegalarm", "rogalarm", "roegdetektor",
        "rogdetektor", "brandsignal", "brannalarm", "roykvarsler", "rauchmelder", "brandmelder", "brandlarm",
        "palovaroitin", "paloilmoitin", "tulekahju", "gaisro", "дымовой", "пожарн", "czujka", "ppoz",
        "evakuacijas izej", "trauksm", "sirena",
    ),
    "labour_only": (
        "demontaz", "demontāž", "palaisan", "palaišan", "ieregul", "merijum", "mērījum", "parbaud", "pārbaud",
        "izpilddokument", "izpildokument", "izpilddokumentacij", "dokumentacij", "darba stundas", "stundu darbs",
        "testing", "commissioning", "measurements", "measurement", "documentation", "as built", "dismantl",
        "demolition", "removal", "labour", "labor", "work hours", "man hours", "idriftsaettelse", "maling",
        "afprovning", "dokumentation", "nedtagning", "demontering", "timeloen", "arbejdstimer", "igangkjoring",
        "demontage", "inbetriebnahme", "prufung", "messung", "driftsattning", "matning", "provning",
        "kayttoonotto", "mittaus", "purku", "демонтаж", "пусконаладк", "измерени", "demontaz", "pomiar",
    ),
}

_CAT_PATTERNS: list[tuple[int, str, re.Pattern[str]]] = []


def _build_patterns() -> None:
    seen: set[tuple[str, str]] = set()
    for cat, kws in _CATEGORY_KEYWORDS.items():
        for kw in kws:
            k = normalise_text(kw)
            if not k or (cat, k) in seen:
                continue
            seen.add((cat, k))
            _CAT_PATTERNS.append((len(k), cat, re.compile(r"(?<![\w])" + re.escape(k))))


_build_patterns()
# One alternation, longest keywords first: `search` returns the leftmost match and, at that position,
# the longest keyword (Python tries alternatives in order) - i.e. exactly the resolution rule above.
_KW_TO_CAT: dict[str, str] = {}
for _len, _cat, _pat in sorted(_CAT_PATTERNS, key=lambda x: -x[0]):
    _KW_TO_CAT.setdefault(_pat.pattern[len("(?<![\\w])"):], _cat)
_CAT_BIG = re.compile(r"(?<![\w])(" + "|".join(sorted(_KW_TO_CAT, key=len, reverse=True)) + ")")
_KW_LOOKUP = {re.sub(r"\\(.)", r"\1", k): v for k, v in _KW_TO_CAT.items()}


@lru_cache(maxsize=65536)
def detect_category(text: str | None) -> str | None:
    """Earliest keyword wins; at equal start the longest keyword wins. None when nothing matches."""
    n = normalise_text(text)
    if not n:
        return None
    m = _CAT_BIG.search(n)
    if m is None:
        return None
    return _KW_LOOKUP.get(m.group(1))


# ------------------------------------------------------------------ numeric attributes

_NUM = r"\d{1,4}(?:\.\d{1,3})?"
_RE_3GROUP = re.compile(r"(?<![\w.])(\d{1,3})x(\d{1,2})x(\d(?:\.\d{1,2})?)(?![\w.])")
_RE_CORES = re.compile(r"(?<![\w.])(\d{1,3})\s*x\s*\(?\s*(" + _NUM + r")\s*\)?(?:\s*mm2)?(?![\d.])")
_RE_G = re.compile(r"(?<![\w.])(\d{1,2})\s*g\s*(" + _NUM + r")(?![\d.])")
_RE_MM2_ONLY = re.compile(r"(?<![\w.])(" + _NUM + r")\s*mm2\b")
_RE_IP = re.compile(r"\bip\s?(\d)(\d|x)\b|\bip\s?x(\d)\b")
_RE_MODULES = re.compile(
    r"(?<![\w.])(\d{1,3})\s*(?:-\s*)?(?:modul\w*|mod\b\.?|mod\.|moduli\w*|moduler|module\w*|te\b|"
    r"moduļ\w*|модул\w*|modulow)")
_RE_MODULES_M = re.compile(r"(?<![\w.])(\d{1,3})M\b")          # raw text only: "36M"
_RE_GANGS_NUM = re.compile(
    r"(?<![\w.])(\d)\s*(?:-\s*)?(?:vietig\w*|vietu\b|vietas\b|gang\w*|g\b|fold\b|fach\b|fald\w*|polet? stik|"
    r"ligzd\w*|stik\b|x stikkontakt|x socket|-?dobbelt)")
_GANG_WORDS = (
    (1, ("vienvietig", "viena vieta", "single", "enkelt", "enkel", "einfach", "yksio", "odinarn", "vienvieciai",
         "pojedyncz", "одинарн", "1 vietig")),
    (2, ("divvietig", "divu vietu", "dubult", "double", "twin", "dobbelt", "dobbel", "dubbel", "zweifach", "doppel",
         "kaksois", "kahekordne", "dvivieci", "podwojn", "двойн")),
    (3, ("trisvietig", "trīsvietīg", "triple", "tredobbelt", "trippel", "dreifach", "kolmois", "trivieci", "potrojn",
         "тройн")),
    (4, ("cetrvietig", "četrvietīg", "quadruple", "quad", "firedobbelt", "firdubbel", "vierfach", "poczworn")),
)
_RE_POLES = re.compile(r"(?<![\w.])([1-4])\s*(?:-\s*)?(?:p\b|pol\b|polig\w*|poles?\b|polu\b|polig|polu\w*|"
                       r"polig|polu|pole\b|pols\b|polet\b|polet|полюс\w*|biegun\w*)(?:\s*\+\s*n)?")
_RE_POLES_PN = re.compile(r"(?<![\w.])([1-3])\s*p\s*\+\s*n\b")
_RE_AMPS = re.compile(r"(?<![\w.])(\d{1,4}(?:\.\d)?)\s*a\b")
_RE_CURVE = re.compile(r"(?<![\w.])([bcdk])\s?(\d{1,3})(?![\w.])")
_STD_AMPS = {0.5, 1, 2, 3, 4, 6, 8, 10, 13, 16, 20, 25, 32, 35, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315,
             400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000}
_RE_MA = re.compile(r"(?<![\w.])(\d{1,4})\s*ma\b")
_RE_DIAM_PREFIX = re.compile(r"(?:(?<![\w])d\s*=?\s*|ø\s*|∅\s*|(?<![\w])fi\s*|(?<![\w])dn\s*=?\s*|(?<![\w])diam\.?\s*)"
                             r"(\d{2,3})(?![\d.])")
_RE_DIAM_MM = re.compile(r"(?<![\w.])(\d{2,3})\s*mm\b(?!2)")
_RE_SIZE = re.compile(r"(?<![\w.])(\d{2,4})\s*x\s*(\d{2,4})(?:\s*x\s*(\d{1,4}))?(?![\w.])")
_RE_CABLE_TYPE = re.compile(
    r"\b(\(?a\)?\s?xmk|axmk|xmk|nym(?:\s?[jo])?|nyy(?:\s?[jo])?|cyky(?:\s?[jo])?|cykyd|mmj|pvikj|noiklx|noikx|pfxp|"
    r"mcmk|exq|n2xh|nhxh|nhxmh|h07rn\s?f|h05vv\s?f|yky|vvg\w*|utp|ftp|sftp|s ftp|u ftp|f utp|liycy|jy\s?st\s?y|"
    r"fe180|ngo|pp00)\b")
_RE_CAT_DATA = re.compile(r"\bcat\s?(5e|6a|6|7a|7|8|5)\b")

_EQUAL_KEYS = ("cores", "cross_section_mm2", "ip", "modules", "gangs", "poles", "amps", "diameter_mm", "size",
               "sensitivity_ma")


def _f(x: str) -> float:
    return float(x.replace(",", "."))


def _num(v: float) -> float | int:
    return int(v) if float(v).is_integer() else round(v, 3)


@lru_cache(maxsize=65536)
def _parse(text: str) -> tuple[tuple[str, Any], ...]:
    raw = str(text)
    n = normalise_text(raw)
    out: dict[str, Any] = {}
    cat = detect_category(raw)

    # cable type designations (kept for info; brand-independent)
    m = _RE_CABLE_TYPE.search(n)
    if m:
        out["cable_type"] = re.sub(r"[()\s]", "", m.group(1))
        if cat is None:
            cat = "cable"
    m = _RE_CAT_DATA.search(n)
    if m:
        out["data_cat"] = m.group(1)

    # cores x cross-section
    size_like = cat in ("cable_tray", "junction_box", "distribution_board", "luminaire")
    m3 = _RE_3GROUP.search(n)
    if m3 and not size_like:
        out["cores"] = int(m3.group(1)) * int(m3.group(2))
        out["pairs"] = int(m3.group(1))
        out["conductor_mm"] = _num(_f(m3.group(3)))
    else:
        m = _RE_CORES.search(n)
        if m and not size_like:
            cores, cs = int(m.group(1)), _f(m.group(2))
            if 1 <= cores <= 61 and 0.14 <= cs <= 1000:
                out["cores"] = cores
                out["cross_section_mm2"] = _num(cs)
        if "cores" not in out:
            m = _RE_G.search(n)
            if m:
                cores, cs = int(m.group(1)), _f(m.group(2))
                if 1 <= cores <= 61 and 0.14 <= cs <= 1000:
                    out["cores"] = cores
                    out["cross_section_mm2"] = _num(cs)
        if "cross_section_mm2" not in out:
            m = _RE_MM2_ONLY.search(n)
            if m:
                out["cross_section_mm2"] = _num(_f(m.group(1)))
    if "cores" in out and cat is None:
        cat = "cable"

    # tray / box / board dimensions (e.g. 300x60, 100x100x50)
    if "cores" not in out or size_like:
        m = _RE_SIZE.search(n)
        if m and (size_like or int(m.group(1)) > 61):
            out["size"] = "x".join(g for g in m.groups() if g)

    # IP rating
    m = _RE_IP.search(n)
    if m:
        if m.group(3):
            out["ip"] = f"X{m.group(3)}"
        elif m.group(2) == "x":
            out["ip"] = f"{m.group(1)}X"
        else:
            out["ip"] = int(m.group(1) + m.group(2))

    # modules (distribution boards)
    m = _RE_MODULES.search(n)
    if m:
        out["modules"] = int(m.group(1))
    else:
        m = _RE_MODULES_M.search(raw)
        if m and cat in (None, "distribution_board"):
            out["modules"] = int(m.group(1))
    if "modules" in out and cat is None:
        cat = "distribution_board"

    # gangs
    if cat in ("socket", "switch", "data_outlet", "junction_box", None):
        m = _RE_GANGS_NUM.search(n)
        if m and not (m.group(0).rstrip().endswith("g") and cat is None):
            out["gangs"] = int(m.group(1))
        else:
            for count, words in _GANG_WORDS:
                if any(re.search(r"(?<![\w])" + re.escape(normalise_text(w)), n) for w in words):
                    out["gangs"] = count
                    break
            else:
                m = re.search(r"(?<![\w.])(\d)\s*x\s*(?:kontaktligzd|stikkontakt|socket|uttag|rozet)", n)
                if m:
                    out["gangs"] = int(m.group(1))

    # poles
    m = _RE_POLES_PN.search(n)
    if m:
        out["poles"] = int(m.group(1))
        out["neutral"] = True
    else:
        m = _RE_POLES.search(n)
        if m:
            out["poles"] = int(m.group(1))

    # amps & trip curve
    m = _RE_AMPS.search(n)
    if m:
        a = _f(m.group(1))
        if 0.1 <= a <= 6300:
            out["amps"] = _num(a)
    m = _RE_CURVE.search(n)
    if m and int(m.group(2)) in _STD_AMPS and (
            cat in ("breaker", "rcd") or (cat is None and m.group(1) in "bc")):
        if "amps" not in out:
            out["amps"] = int(m.group(2))
        out["curve"] = m.group(1).upper()
        if cat is None:
            cat = "breaker"
    m = _RE_MA.search(n)
    if m:
        out["sensitivity_ma"] = int(m.group(1))

    # conduit diameter
    m = _RE_DIAM_PREFIX.search(raw.lower())
    if m and cat in ("conduit", "cable_tray", None, "junction_box", "other"):
        out["diameter_mm"] = int(m.group(1))
    elif cat == "conduit":
        m = _RE_DIAM_MM.search(n)
        if m:
            out["diameter_mm"] = int(m.group(1))

    out["category"] = cat or "other"
    return tuple(out.items())


def parse_attributes(text: str | None) -> dict[str, Any]:
    """Extract technical attributes (+ `category`) from an item description. Never raises."""
    if not text:
        return {"category": "other"}
    try:
        return dict(_parse(str(text)))
    except Exception:  # noqa: BLE001 - defensive: never break ingestion on odd text
        return {"category": "other"}


def _eq(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(float(a) - float(b)) <= 1e-6 * max(1.0, abs(float(a)))
    return str(a).lower() == str(b).lower()


def attributes_compatible(a: dict[str, Any] | None, b: dict[str, Any] | None) -> bool:
    """HARD filter. Category must match when both are known (not "other"); every technical attribute
    present on both sides must be equal. Brands are not attributes and never matter."""
    a = a or {}
    b = b or {}
    ca, cb = a.get("category"), b.get("category")
    if ca and cb and ca != "other" and cb != "other" and ca != cb:
        return False
    for k in _EQUAL_KEYS:
        va, vb = a.get(k), b.get(k)
        if va is None or vb is None:
            continue
        if not _eq(va, vb):
            return False
    return True
