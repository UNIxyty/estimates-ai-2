"""Attributes of a unit-rate BOQ line (EU data-centre BOQs: containment, lighting, GS/small power, cable).

Matching in unit-rate mode is on component + attributes, not text: "EXT - 300 x 60mm Cable Tray - (b) Tee" is
{component: tee, product: tray, width_mm: 300, height_mm: 60, finish: EXT}. Brand / SKU text in brackets or after
"Type - X -" is kept separately (supply rates care, install rates don't)."""
from __future__ import annotations

import re
from typing import Any

# Component of a containment line: the "(a) Bend" style suffix, or words in the text. Order matters (most specific
# first: "riser bend" before "bend", "tee cover lid" before "tee").
_COMPONENTS: list[tuple[str, re.Pattern[str]]] = [
    ("4way_cover_lid", re.compile(r"4[\s-]*way[^,]*cover\s*lid|intersection\s*cover\s*lid", re.I)),
    ("riser_bend_cover_lid", re.compile(r"riser\s*bend\s*cover\s*lid", re.I)),
    ("bend_cover_lid", re.compile(r"\bbend\s*cover\s*lid", re.I)),
    ("tee_cover_lid", re.compile(r"\btee\s*cover\s*lid", re.I)),
    ("reducer_cover_lid", re.compile(r"reducer\s*cover\s*lid", re.I)),
    ("cover_lid", re.compile(r"cover\s*lid|(?<!box\s)\blid\b", re.I)),
    ("divider_fillet", re.compile(r"divider|fillet", re.I)),
    ("db_header", re.compile(r"db\s*/?\s*equip\w*\s*header|equipment\s*header", re.I)),
    ("riser_bend", re.compile(r"riser\s*bend", re.I)),
    ("4way", re.compile(r"4[\s-]*way|intersection|cross\s*piece", re.I)),
    ("5m_drop", re.compile(r"5\s*m\s*drop", re.I)),
    ("tee", re.compile(r"\btee\b", re.I)),
    ("bend", re.compile(r"\bbend\b|\belbow\b", re.I)),
    ("offset", re.compile(r"\boffset\b", re.I)),
    ("reducer", re.compile(r"\breducer\b", re.I)),
    ("trapeze", re.compile(r"trapeze", re.I)),
    ("unistrut", re.compile(r"unistrut|strut\b", re.I)),
    ("tier_bracket", re.compile(r"\b\d\s*tier\b", re.I)),
    ("bracket", re.compile(r"bracket", re.I)),
]
_PRODUCTS: list[tuple[str, re.Pattern[str]]] = [
    ("panduit", re.compile(r"panduit|fibre\s*(?:runner|duct)", re.I)),
    ("ladder", re.compile(r"\bladder\b", re.I)),
    ("tray", re.compile(r"\btray\b", re.I)),
    ("basket", re.compile(r"basket|wire\s*mesh|cablofil", re.I)),
    ("trunking", re.compile(r"trunking", re.I)),
    ("conduit", re.compile(r"conduit", re.I)),
    ("busbar", re.compile(r"busbar|track\b|lighting\s*track", re.I)),
    ("tie", re.compile(r"\bties?\b|cable\s*tie", re.I)),
    ("termination", re.compile(r"terminat|\bterm\b", re.I)),
    ("connection", re.compile(r"^\s*\d{3}\s*v\b.*\d+\s*amp|connection|car\s*charger", re.I)),
    ("cable", re.compile(r"\bcable\b|\d\s*c\s*\d|\d\s*g\s*\d|core|flex|lsoh|xlpe|n2xh|nyy|cu\s*conductor|fp\s*plus|fe180", re.I)),
    ("luminaire", re.compile(r"luminaire|type\s*-\s*[a-z]\d|fitting|exit\s*sign|downlight", re.I)),
    ("fcu", re.compile(r"fused\s*conn?ection|\bfcu\b|spur", re.I)),
    ("data_outlet", re.compile(r"\bcat\s*\d\w*\b.*outlet|\brj\s*45\b|data\s*outlet", re.I)),
    ("socket", re.compile(r"socket|outlet|schuko|receptacle", re.I)),
    ("isolator", re.compile(r"isolator|isolating\s*switch|switch[\s-]*disconnector", re.I)),
    ("junction_box", re.compile(r"junction\s*box|\bjb\b|firebox", re.I)),
    ("sensor", re.compile(r"sensor|detector|pir", re.I)),
    ("switch", re.compile(r"switch|push\s*button|pushbutton", re.I)),
    ("gland", re.compile(r"gland", re.I)),
    ("label", re.compile(r"label", re.I)),
    ("floor_box", re.compile(r"floor\s*box", re.I)),
]

_SIZE = re.compile(r"(\d{2,4})\s*(?:mm)?\s*[x×]\s*(\d{2,4})\s*mm", re.I)
_WIDTH = re.compile(r"(\d{2,4})\s*mm\b", re.I)
_TIERS = re.compile(r"(\d)\s*tiers?\b", re.I)
_CABLE = re.compile(r"(\d{1,2})\s*(?:c|g|x|core[s]?)\s*(\d{1,3}(?:[.,]\d+)?)\s*(?:mm2|mm²|mm|sq)?", re.I)
_CABLE_ALT = re.compile(r"(\d{1,3}(?:[.,]\d+)?)\s*(?:mm2|mm²|mm)\s*(\d{1,2})\s*-?\s*core", re.I)
_AMPS = re.compile(r"(\d{1,4})\s*(?:a|amp|amps)\b(?!\w)", re.I)
_STD_MM2 = {0.5, 0.75, 1.0, 1.5, 2.5, 4.0, 6.0, 10.0, 16.0, 25.0, 35.0, 50.0, 70.0, 95.0, 120.0, 150.0, 185.0, 240.0,
            300.0, 400.0, 500.0, 630.0}
_IP = re.compile(r"\bip\s*(\d{2})\b", re.I)


def _f(s: str) -> float:
    return float(s.replace(",", "."))


def _cable_size(t: str) -> tuple[int, float] | None:
    m = _CABLE_ALT.search(t)  # "6MM 5 CORE", "4MM 5CORE"
    if m and 1 <= int(m.group(2)) <= 61 and _f(m.group(1)) in _STD_MM2:
        return int(m.group(2)), _f(m.group(1))
    m = _CABLE.search(t)      # "3C 2.5MM", "5x16", "3G6"
    if m and 1 <= int(m.group(1)) <= 61 and _f(m.group(2)) in _STD_MM2:
        return int(m.group(1)), _f(m.group(2))
    return None


def unit_rate_attributes(text: str | None, *, finish: str | None = None, section: str | None = None) -> dict[str, Any]:
    t = (text or "").strip()
    out: dict[str, Any] = {}
    low = t.lower()
    for name, rx in _COMPONENTS:
        if rx.search(t):
            out["component"] = name
            break
    for name, rx in _PRODUCTS:
        if rx.search(t):
            out["product"] = name
            break
    if out.get("product") in (None, "cable") and section and re.search(r"ladder|tray|basket|panduit", section, re.I) \
            and out.get("component") not in (None,):
        out.setdefault("product", re.search(r"ladder|tray|basket|panduit", section, re.I).group(0).lower())
    # containment straights: a sized ladder/tray/basket line with no fitting word is the straight run
    if out.get("product") in ("ladder", "tray", "basket", "panduit", "trunking") and "component" not in out:
        out["component"] = "straight"
    m = _SIZE.search(t)
    if m:
        out["width_mm"], out["height_mm"] = int(m.group(1)), int(m.group(2))
    elif out.get("product") in ("ladder", "tray", "basket", "panduit", "trunking") or out.get("component") in (
            "trapeze", "tier_bracket", "bracket", "cover_lid", "bend_cover_lid", "tee_cover_lid", "riser_bend_cover_lid",
            "4way_cover_lid", "reducer_cover_lid", "5m_drop"):
        m = _WIDTH.search(t)
        if m:
            out["width_mm"] = int(m.group(1))
    m = _TIERS.search(t)
    if m:
        out["tiers"] = int(m.group(1))
    if out.get("product") in ("cable", "termination", None) or re.search(r"\bcable\b(?!\s*tie)|core|lsoh|flex", low):
        # the line's own text wins over a brand / product name in brackets; a disagreeing bracket is flagged
        main = re.sub(r"\([^)]*\)", " ", t)
        own = _cable_size(main)
        br = _cable_size(" ".join(re.findall(r"\(([^)]*)\)", t)))
        size = own or br
        if size and out.get("product") != "tie":
            out["cores"], out["mm2"] = size
            if own and br and own != br:
                out["conflict"] = f"{own[0]}×{own[1]:g} in the text vs {br[0]}×{br[1]:g} in brackets"
    m = _AMPS.search(t)
    if m and 1 <= int(m.group(1)) <= 4000:
        out["amps"] = int(m.group(1))
    if re.search(r"\b3\s*ph\b|3[\s-]*phase|\b3p\b|\btp\b|\b400\s*v", low):
        out["phases"] = 3
    elif re.search(r"\b1\s*ph\b|single[\s-]*phase|\b1p\b|\bsp\b|\b230\s*v", low):
        out["phases"] = 1
    m = _IP.search(t)
    if m:
        out["ip"] = int(m.group(1))
    if re.search(r"\bfp\b|fp\s*plus|fire\s*rated|firebox|fe\s*180|\be30\b|\be90\b", low):
        out["fire_rated"] = True
    fin = (finish or "").strip().upper()
    if re.match(r"^EXT\b", t, re.I) or fin in ("HDG",) and re.search(r"\bext\b", low):
        out["finish"] = "EXT"
    if fin in ("PG", "HDG", "SS", "GALV"):
        out["coating"] = fin
    if re.search(r"\be90\b", low):
        out["e90"] = True
    if re.search(r"\binternal\b", low):
        out["finish"] = out.get("finish") or "internal"
    if section and re.search(r"free\s*issue", section, re.I):
        out["free_issue"] = True
    # brand / SKU: "Type - A1 - ZUMTOBEL …", text in brackets
    m = re.match(r"\s*type\s*-\s*([a-z0-9]+)\s*(?:-\s*(.*))?$", t, re.I)
    if m:
        out["type_code"] = m.group(1).upper()
        if m.group(2):
            out["brand_text"] = m.group(2).strip()
    br = re.findall(r"\(([^)]*[A-Za-z]{3,}[^)]*)\)", t)
    if br and "brand_text" not in out:
        out["brand_text"] = "; ".join(b.strip() for b in br)
    return out


def install_key(attrs: dict[str, Any]) -> tuple:
    """What determines an install rate: component + product + sizes + tiers + electrical rating (not brand, and not a
    luminaire type code: "Type C1" is a different fitting on every project)."""
    return tuple((k, attrs.get(k)) for k in ("component", "product", "width_mm", "height_mm", "tiers", "mm2", "cores",
                                              "amps", "phases", "fire_rated", "finish"))


def section_kind(section: str | None, sheet: str | None = None) -> str:
    """Rates differ between standard / emergency / controls / external sections of the same file."""
    t = f"{section or ''} {sheet or ''}".lower()
    if "emer" in t or "exit" in t:
        return "emergency"
    if "control" in t:
        return "controls"
    if "external" in t or "site fitting" in t or re.search(r"\bext\b", t):
        return "external"
    if "track" in t or "busbar" in t:
        return "track"
    return "standard"
