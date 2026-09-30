"""Workbook structure analysis: header rows, column meanings, per-unit vs row-total blocks, sections,
subtotals, markups, hourly rates, electrical-sheet detection.

Deterministic first. Column meanings come from (1) header text (incl. two-row / merged group headers),
(2) position relative to the total block and numeric relationships across rows
(total_labour ≈ qty × unit_labour, unit_labour ≈ norm_h × hourly_rate), and only then (3) an optional
`llm(prompt, schema) -> dict` callable for columns code can't decide. Works on blanks (price cells empty):
it then falls back to header/position only.
"""
from __future__ import annotations

import logging
import os
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

from openpyxl.utils.cell import get_column_letter

from ..matching.attributes import detect_category
from ..matching.text import normalise_text
from ..matching.units import normalise_unit
from .language import detect_language
from .readers import DocumentData, SheetData, read_any
from .util import close, coord, is_text, parse_number

log = logging.getLogger(__name__)

MEANINGS = (
    "no", "code", "item", "unit", "qty", "norm_h", "hourly_rate", "unit_labour", "unit_material", "unit_mechanisms",
    "unit_total", "total_norm_h", "total_labour", "total_material", "total_mechanisms", "total", "source", "notes",
    "category", "unknown",
)
NUMERIC_MEANINGS = ("qty", "norm_h", "hourly_rate", "unit_labour", "unit_material", "unit_mechanisms", "unit_total",
                    "total_norm_h", "total_labour", "total_material", "total_mechanisms", "total")
UNIT_OF = {"total_norm_h": "norm_h", "total_labour": "unit_labour", "total_material": "unit_material",
           "total_mechanisms": "unit_mechanisms", "total": "unit_total"}
TOTAL_OF = {v: k for k, v in UNIT_OF.items()}
UNIT_BLOCK = ("norm_h", "hourly_rate", "unit_labour", "unit_material", "unit_mechanisms", "unit_total")
TOTAL_BLOCK = ("total_norm_h", "total_labour", "total_material", "total_mechanisms", "total")
GENERIC = {"labour": ("unit_labour", "total_labour"), "material": ("unit_material", "total_material"),
           "mechanisms": ("unit_mechanisms", "total_mechanisms"), "total": ("unit_total", "total"),
           "price": ("unit_total", "total"), "hours": ("norm_h", "total_norm_h")}


# ------------------------------------------------------------------ dataclasses

@dataclass
class ColumnInfo:
    letter: str
    idx: int
    header: str
    meaning: str
    source: str = "header"          # header | position | model
    confidence: float = 0.9


@dataclass
class Section:
    title: str
    row_start: int
    row_end: int
    subtotal_row: int | None = None
    hourly_rate: float | None = None


@dataclass
class RowInfo:
    row: int
    kind: str                       # item | section | subtotal | total | header | note | blank
    text: str | None = None
    unit: str | None = None
    qty: float | None = None
    values: dict[str, float | None] = field(default_factory=dict)
    formulas: dict[str, bool] = field(default_factory=dict)
    cells: dict[str, str] = field(default_factory=dict)
    section_title: str | None = None
    number: str | None = None       # "1.2" from the No column
    code: str | None = None
    source_ref: str | None = None   # "Kilde" / source column text
    hidden: bool = False
    bold: bool = False
    markup: dict[str, Any] | None = None
    text_col: str | None = None     # column letter the text came from (item column, or a fallback column)
    category_label: str | None = None


@dataclass
class SheetStructure:
    name: str
    idx: int
    kind: str = "other"             # estimate | norms | prices | summary | other
    is_electrical: bool | None = None
    electrical_confidence: float = 0.0
    header_row: int | None = None
    first_data_row: int | None = None
    last_data_row: int | None = None
    columns: list[ColumnInfo] = field(default_factory=list)
    unit_block: dict[str, str] = field(default_factory=dict)
    total_block: dict[str, str] = field(default_factory=dict)
    hourly_rates: list[dict[str, Any]] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)
    rows: list[RowInfo] = field(default_factory=list)
    language: str | None = None
    currency: str | None = None
    # extras
    header_rows: tuple[int, int] | None = None
    row_count: int = 0
    col_count: int = 0
    markups: list[dict[str, Any]] = field(default_factory=list)
    totals: dict[str, float] = field(default_factory=dict)
    hidden: bool = False
    source: str = "xlsx"
    model_cells: int = 0
    model_rows: int = 0
    model_calls: int = 0
    notes: list[str] = field(default_factory=list)

    def col(self, meaning: str) -> ColumnInfo | None:
        for c in self.columns:
            if c.meaning == meaning:
                return c
        return None

    def col_idx(self, meaning: str) -> int | None:
        c = self.col(meaning)
        return c.idx if c else None

    @property
    def items(self) -> list[RowInfo]:
        return [r for r in self.rows if r.kind == "item"]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class WorkbookStructure:
    sheets: list[SheetStructure]
    language: str
    currency: str | None
    model_calls: int = 0
    model_cells: int = 0
    model_rows: int = 0
    kind: str = "xlsx"
    paragraphs: list[str] = field(default_factory=list)
    path: str | None = None
    work_path: str | None = None
    document: DocumentData | None = field(default=None, repr=False)

    def sheet(self, name: str) -> SheetStructure | None:
        for s in self.sheets:
            if s.name == name:
                return s
        return None


# ------------------------------------------------------------------ vocabulary (matched on normalise_text output)

def _rx(p: str) -> re.Pattern[str]:
    return re.compile(p)


_HEADER_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("no", _rx(r"^(nr|n r|no|nr p k|npk|n p k|nr pk|nr p k|pos|poz|lp|lfd nr|lfd|numurs|pk|nr p|item no|ref|"
               r"punkts|#|№|nro|jrk|eil nr|nr\s?\d?|kods nr)$|^nr p|^n p k|^npk\b|^№")),
    ("code", _rx(r"\b(kods|code|art nr|artikel|artikul|varenr|vare nr|kataloga|katalog|el nr|el nummer|sku|"
                 r"resursa kods|produktkode|produktnr|tunnus|kood|kodas|shifr|шифр|обоснование)\b")),
    ("category", _rx(r"^(kategorija|category|kategori|kategorie|grupa|group|gruppe|ryhma|kategooria)$")),
    ("source", _rx(r"\b(kilde|source|avots|allikas|quelle|kalla|lahde|saltinis|источник)\b")),
    ("notes", _rx(r"\b(piezim\w*|note|notes|bemaerk\w*|kommentar\w*|comment\w*|remark\w*|anm\w*|markus\w*|"
                  r"pastab\w*|huom\w*|примечани\w*|uwagi)\b")),
    ("hourly_rate", _rx(r"(stundas likme|stundu likme|samaksas likme|darba samaksas likme|\blikme|timepris|timelon|"
                        r"timesats|hourly rate|labour rate|labor rate|rate per hour|rate eur h|\beur h\b|eur st\b|"
                        r"kr time|kr t\b|stundensatz|timpris|tuntihinta|valandinis|tunnihind|hourly|ставка|"
                        r"stawka|dkk time|eur stunda)")),
    ("hours", _rx(r"(laika norma|\bnorma\b|\bnormas\b|\bc h\b|cilv st|cilvekst|man hours?|hours? per|h vien|"
                  r"h unit|h stk|timer pr|timer stk|timer enhed|\btimer\b|\bhours?\b|\bh\b|normtid|arbejdstimer|"
                  r"stunden|\bstd\b|timmar|tunnit|darbietilpib\w*|labour hours|time norm|трудоемк\w*|чел ч|"
                  r"roboczogodz\w*|\bnorm\b|normative|norma c h|norma h)")),
    ("item", _rx(r"(nosaukum\w*|apraksts|description|descr|\bitem\b|\btekst\b|\btext\b|betegnelse|beskrivelse|"
                 r"benaevnelse|ydelse|\bwork\b|works|pavadinim\w*|nimetus|bezeichnung|leistung\w*|benamning|"
                 r"nimike|наименовани\w*|nazwa|\bopis\b|specifikacij\w*|specification|materials and works|"
                 r"darbu veids|darba veids|materialu nosaukums|position text|arbejde)")),
    ("unit", _rx(r"^(merv|mervien\w*|mer v|mv|unit|units|uom|u m|enhed|enh|enhet|vnt|mat vnt|yhik|uhik|einheit|"
                 r"eh|ед|ед изм|yksikko|yks|jedn|j m|jm|mervienibas|mervieniba|mer vien|mērv|unit of measure|"
                 r"matavimo vnt|mato vnt|m v)$|\bmerv|\bunit\b(?! price| cost| rate)|\benhed\b(?!spris)|"
                 r"\benhet\b(?!spris)|ед изм|\beinheit\b|mērvienība|mervieniba")),
    ("qty", _rx(r"(daudz\w*|apjoms|apjom\w*|quantity|\bqty\b|\bantal\b|\bantall\b|\bmangde\b|kiekis|kogus|menge|"
                r"кол во|количеств\w*|maara|ilosc|\bkiek\b|\bstk antal\b|\bmg\b)")),
    ("labour", _rx(r"(darba alga|darba samaksa|darba samaksas|\balga\b|\bdarbs\b|labour|labor|work cost|"
                   r"installation cost|arbejdslon|arbejdsl|\blon\b|\barbejde\b|\barbeid\b|\blohn\b|\barbete\b|"
                   r"\btyo\b|darbo|\btoo\b|работ\w*|robocizn\w*|montaz\w*|darba izmaksas|work)")),
    ("material", _rx(r"(materiali|materialu|materials?\b|materialer|materiel|materiell|materjal\w*|medziag\w*|"
                     r"материал\w*|materialy|tarvik\w*|\bmat\b|materiāli)")),
    ("mechanisms", _rx(r"(mehanism\w*|mechanism\w*|machinery|equipment|maskin\w*|masin\w*|mechaniz\w*|"
                       r"механизм\w*|tehnika|iekartas|plant)")),
    ("price", _rx(r"(\bcena\b|\bpris\b|\bprice\b|kaina|\bhind\b|preis|hinta|цена|a pris|enhedspris|enhetspris|"
                  r"unit price|unit rate|einzelpreis|styckpris|stk pris|vienibas cena|vien cena)")),
    ("total", _rx(r"(kopa|summa|total|i alt|ialt|\bsum\b|samlet|belob|\bcost\b|izmaksas|итого|стоимост\w*|"
                  r"wartosc|razem|yhteensa|kokku|is viso|gesamt|betrag|totalt|kostnad|\bsuma\b|amount)")),
]

_UNIT_QUAL = _rx(r"(vienib\w*|\bvien\b|uz vien|per unit|pr enhed|pr stk|per stk|pr\. enhed|enhedspris|enhetspris|"
                 r"a pris|unit price|unit cost|unit rate|\beach\b|\bpr\b|\bper\b|\bvnt\b|uhiku|yksikko|einzel|"
                 r"stk pris|stykpris|за ед|/vien|1 vien|per enhed|pr enhet|a\s?pris|\bea\b|\bunit\b)")
_TOTAL_QUAL = _rx(r"(\bkopa\b|kopeja|kopejas|kopeji|\bsumma\b|\btotal\b|i alt|\bialt\b|samlet|visu apjomu|pavisam|"
                  r"gesamt|totalt|yhteensa|kokku|is viso|итого|razem|\bsum\b|amount|\bsuma\b|sammanlagt)")
_GROUP_UNIT = _rx(r"(vienibas|vienības|uz vienibu|vienibu|per unit|unit cost|unit price|unit rates?|pr enhed|"
                  r"enhedspris|a pris|einheitspreis|einzelpreis|uhiku|yksikko|vieneto|цена за ед|за единицу|"
                  r"cena jednostkowa|enhetspris|per enhet|pr stk|pr\. stk)")
_GROUP_TOTAL = _rx(r"(\bkopa\b|kopeja|kopejas|kopeji|\bsumma\b|\btotal\b|i alt|\bialt\b|samlet|visu apjomu|pavisam|"
                   r"gesamt|totalt|yhteensa|kokku|is viso|итого|razem|stoimost|стоимость|wartosc|visam apjomam)")

_SUBTOTAL_RX = _rx(r"^(\d+[.)]?\s*)?(kopa|kopā|starpsumma|summa|i alt|ialt|total|subtotal|sub total|sum|totalt|"
                   r"summa kopa|zwischensumme|gesamt|итого|всего|is viso|kokku|yhteensa|razem|suma|mellemsum|"
                   r"delsum|delsumma|subtotaal)\b")
_GRAND_RX = _rx(r"(pavisam|tames kopsumma|kopsumma|kopa tame|tame kopa|kopa ar pvn|ar pvn|grand total|"
                r"total incl|total excl|incl vat|excl vat|i alt ekskl|i alt inkl|inkl moms|ekskl moms|total sum|"
                r"sum total|tilbudssum|overall|kopeja summa|kopeja tames|visam objektam|gesamtsumme|всего по смете|"
                r"итого по смете|kopa par|pavisam kopa|totalt eks|totalt inkl)")
_MARKUP_RX = _rx(r"(virsizdevum\w*|pelna|pelnu|socialais nodoklis|soc nodoklis|darba devej\w*|transporta izdevum\w*|"
                 r"transports|neparedzet\w*|darba aizsardz\w*|\bpvn\b|overhead\w*|profit|margin|contingenc\w*|"
                 r"\bvat\b|social tax|social security|insurance|transport\w*|avance|daekningsbidrag|fortjeneste|"
                 r"administration|\bmoms\b|risiko|korsel|\bmva\b|paaslag|zuschlag|gewinn|wagnis|mwst|\bust\b|"
                 r"pridetin\w*|\bpvm\b|kasum|uldkulud|\bkm\b|voitto|yleiskulu\w*|\balv\b|narzut\w*|\bzysk\b|"
                 r"накладн\w*|прибыль|ндс|apdrosinasan\w*|buvuzraudz\w*|sadzives|atkritum\w*|risk\b|"
                 r"virsizdevumi|nodoklis|nodokli)")
_RATE_CELL_RX = _rx(r"(stundas likme|stundu likme|darba samaksas likme|vid stundas|vidēja stundas|timepris|timelon|"
                    r"timesats|hourly rate|labour rate|labor rate|rate per hour|stundensatz|timpris|tuntihinta|"
                    r"valandinis|tunnihind|ставка|stawka|darba stundas cena|stundas cena|\bstundas\b.*\beur\b|"
                    r"eur ?/ ?h\b|eur/st)")
_NOTE_RX = _rx(r"^(piezim\w*|note|notes|bemaerk\w*|obs|nb|anm\w*|remark\w*|примечани\w*|\*)")
_SUMMARY_NAME_RX = _rx(r"(kopsavilk\w*|summary|resume|sammendrag|oversigt|kopsav|kops|koptame|kopt|sammanst\w*|"
                       r"zusammenfassung|свод\w*|kokkuvote|yhteenveto|podsumowanie|titul\w*|title|cover|forside)")
_NORMS_NAME_RX = _rx(r"(norm\w*|laika normas|timer|hours|normtid)")
_ELEC_WORDS = _rx(r"(elektr\w*|\bel\b|el install\w*|elinstall\w*|staerkstrom|svagstrom|elektro\w*|electrical|"
                  r"electric\w*|zemsprieg\w*|vajstrav\w*|apgaism\w*|lighting|belysning|kabel\w*|cable\w*|"
                  r"kontaktligzd\w*|gaismekl\w*|sadal\w*|slēdž\w*|sledz\w*|zemej\w*|installation\w*|"
                  r"stikkontakt\w*|tavle\w*|lamp\w*|вэ|электр\w*|power|jauda|автомат\w*)")
_NONELEC_WORDS = _rx(r"(beton\w*|mur\w*is|muris|murveks|apmetum\w*|krasos\w*|flize\w*|flizes|jumt\w*|santehn\w*|"
                     r"ventilac\w*|apkur\w*|udensvad\w*|kanalizac\w*|concrete|masonry|plaster\w*|painting|paint\b|"
                     r"tiles?\b|roof\w*|plumbing|hvac|heating|ventilation|maling|flise\w*|\btag\b|\bvvs\b|"
                     r"murvaerk|tagdaekning|gips\w*|drywall|grunts|zemes darbi|excavation|asfalt\w*|bruges|"
                     r"logi\b|durvis|windows?\b|doors?\b|vinduer|dore|parket\w*|grid\w*|lamin\w*)")
_CURRENCY_RX = [
    ("EUR", _rx(r"(\beur\b|€|\beuro\b|\beiro\b|\beur h\b)")),
    ("DKK", _rx(r"(\bdkk\b|\bkr\b|\bkroner\b)")),
    ("NOK", _rx(r"\bnok\b")),
    ("SEK", _rx(r"\bsek\b")),
    ("USD", _rx(r"(\busd\b|\$)")),
    ("GBP", _rx(r"(\bgbp\b|£)")),
    ("PLN", _rx(r"(\bpln\b|\bzl\b)")),
    ("RUB", _rx(r"(\brub\b|руб)")),
]
_LANG_CURRENCY = {"LV": "EUR", "LT": "EUR", "ET": "EUR", "FI": "EUR", "DE": "EUR", "DA": "DKK", "NO": "NOK",
                  "SV": "SEK", "PL": "PLN", "EN": None, "RU": None}
_PCT_IN_TEXT = _rx(r"(\d+(?:\.\d+)?)\s*%")


def classify_header(text: str | None) -> tuple[str | None, str | None]:
    """(meaning-or-generic, qualifier) for one header cell. Qualifier: 'unit' | 'total' | None."""
    n = normalise_text(text)
    if not n:
        return None, None
    meaning = None
    for m, rx in _HEADER_RULES:
        if rx.search(n):
            meaning = m
            break
    if meaning is None:
        return None, None
    qual = None
    if meaning in GENERIC:
        # own qualifier words ("Darba alga uz vienību", "Materialer i alt"); the generic word itself doesn't count
        stripped = n
        if meaning in ("total",):
            stripped = _TOTAL_QUAL.sub(" ", n, count=1)
        if _TOTAL_QUAL.search(stripped):
            qual = "total"
        elif _UNIT_QUAL.search(n):
            qual = "unit"
    return meaning, qual


# ------------------------------------------------------------------ public entry

LLMFn = Callable[[str, dict], dict]


def analyse_workbook(path: str | None = None, *, llm: LLMFn | None = None, document: DocumentData | None = None,
                     tag: str | None = None, progress: Callable[[int], None] | None = None,
                     ext: str | None = None, work_dir: str | None = None) -> WorkbookStructure:
    """Analyse an xlsx/xls/docx/pdf (or an already-read `document`)."""
    if document is None:
        if path is None:
            raise ValueError("path or document required")
        document = read_any(path, ext=ext, work_dir=work_dir)
    texts: list[str] = []
    for sd in document.sheets:
        for _, row in zip(range(3000), sd.rows):
            for v in row:
                if isinstance(v, str) and not v.startswith("="):
                    texts.append(v)
    texts.extend(document.paragraphs[:2000])
    language = detect_language(texts)
    sheets: list[SheetStructure] = []
    total = max(1, len(document.sheets))
    for i, sd in enumerate(document.sheets):
        ss = analyse_sheet(sd, llm=llm, tag=tag, language=language)
        sheets.append(ss)
        if progress:
            try:
                progress(int(100 * (i + 1) / total))
            except Exception:  # noqa: BLE001
                pass
    cur = Counter(s.currency for s in sheets if s.currency)
    currency = cur.most_common(1)[0][0] if cur else _currency_from_texts(texts) or _LANG_CURRENCY.get(language)
    for s in sheets:
        if not s.currency:
            s.currency = currency
    return WorkbookStructure(
        sheets=sheets, language=language, currency=currency,
        model_calls=sum(s.model_calls for s in sheets), model_cells=sum(s.model_cells for s in sheets),
        model_rows=sum(s.model_rows for s in sheets), kind=document.kind, paragraphs=document.paragraphs,
        path=document.path, work_path=document.work_path, document=document)


# ------------------------------------------------------------------ sheet analysis

def _text_at(sd: SheetData, r: int, c: int) -> str | None:
    v = sd.get(r, c)
    if isinstance(v, str) and not v.startswith("="):
        return v
    return None


def _merged_text(sd: SheetData, r: int, c: int) -> tuple[str | None, bool]:
    """Text at (r,c) or, if inside a merged range, the text of its top-left cell. Bool = came from a merge
    spanning more than one column."""
    t = _text_at(sd, r, c)
    rng = sd.merged_range(r, c)
    if rng is None:
        return t, False
    r1, c1, r2, c2 = rng
    return _text_at(sd, r1, c1), c2 > c1


def _row_score(sd: SheetData, r: int) -> tuple[float, set[str]]:
    row = sd.rows[r - 1] if r - 1 < len(sd.rows) else []
    found: set[str] = set()
    n_text = 0
    n_num = 0
    for v in row:
        if v is None:
            continue
        if isinstance(v, str) and parse_number(v) is None:
            n_text += 1
            if len(v) > 60:
                continue
            m, _ = classify_header(v)
            if m:
                found.add(m)
        else:
            n_num += 1
    score = len(found) + (2 if "item" in found else 0) + (1.5 if "qty" in found else 0) + \
        (1 if "unit" in found else 0) - 0.5 * n_num
    return score, found


def _is_numbering_row(sd: SheetData, r: int) -> bool:
    row = [v for v in (sd.rows[r - 1] if 0 < r <= len(sd.rows) else []) if v is not None]
    if len(row) < 3:
        return False
    nums = [parse_number(v) for v in row]
    if any(n is None for n in nums):
        return False
    ints = [int(n) for n in nums if float(n).is_integer()]
    return len(ints) == len(nums) and ints == sorted(ints) and ints[0] <= 2 and len(set(ints)) == len(ints)


def find_header(sd: SheetData, scan_rows: int = 40) -> tuple[int, int] | None:
    """(top, bottom) 1-based header rows, or None."""
    best: tuple[float, int, int] | None = None
    limit = min(len(sd.rows), scan_rows)
    scores = {r: _row_score(sd, r) for r in range(1, limit + 1)}
    for r in range(1, limit + 1):
        s, found = scores[r]
        if not found:
            continue
        cand = (s, r, r)
        if r + 1 <= limit:
            s2, found2 = scores[r + 1]
            if found2 and not (found2 <= found) and not _has_numbers_in_data_cols(sd, r + 1):
                union = found | found2
                comb = len(union) + (2 if "item" in union else 0) + (1.5 if "qty" in union else 0) + \
                    (1 if "unit" in union else 0)
                if comb > s + 0.5:
                    cand = (comb, r, r + 1)
            elif not found2 and _group_row(sd, r) and _row_is_textual(sd, r + 1):
                cand = (s + 0.5, r, r + 1)
        if cand[0] >= 3 and (best is None or cand[0] > best[0] + 1e-9):
            best = cand
    if best is None:
        return None
    top, bottom = best[1], best[2]
    # sub-header row directly below with only blanks under merged group headers (unlabelled unit columns)
    if top == bottom and _group_row(sd, top) and bottom + 1 <= len(sd.rows) and _row_is_textual(sd, bottom + 1):
        bottom += 1
    return top, bottom


def _has_numbers_in_data_cols(sd: SheetData, r: int) -> bool:
    row = sd.rows[r - 1] if r - 1 < len(sd.rows) else []
    nums = sum(1 for v in row if v is not None and parse_number(v) is not None)
    return nums >= 3 and not _is_numbering_row(sd, r)


def _row_is_textual(sd: SheetData, r: int) -> bool:
    row = sd.rows[r - 1] if 0 < r <= len(sd.rows) else []
    vals = [v for v in row if v is not None]
    if not vals:
        return False
    texts = sum(1 for v in vals if isinstance(v, str) and parse_number(v) is None)
    return texts >= max(1, len(vals) - 1) and not any(len(str(v)) > 80 for v in vals)


def _group_row(sd: SheetData, r: int) -> bool:
    """A header row containing a merged cell spanning several columns with a unit/total group label."""
    for (r1, c1, r2, c2) in sd.merged:
        if r1 == r and c2 > c1 and r2 == r:
            t = _text_at(sd, r1, c1)
            n = normalise_text(t)
            if n and (_GROUP_UNIT.search(n) or _GROUP_TOTAL.search(n)):
                return True
    return False


def analyse_sheet(sd: SheetData, *, llm: LLMFn | None = None, tag: str | None = None,
                  language: str | None = None) -> SheetStructure:
    ss = SheetStructure(name=sd.name, idx=sd.idx, row_count=sd.n_rows, col_count=sd.n_cols,
                        hidden=sd.state != "visible", source=sd.source)
    sheet_texts = [v for row in sd.rows[:2000] for v in row if isinstance(v, str)]
    ss.language = detect_language(sheet_texts, default=language or "EN") if sheet_texts else language
    if not sd.rows:
        ss.kind = "other"
        return ss
    hdr = find_header(sd)
    if hdr is None and llm is not None:
        hdr = _llm_header(sd, llm, ss)
    if hdr is None:
        ss.kind = "summary" if _SUMMARY_NAME_RX.search(normalise_text(sd.name)) else "other"
        ss.currency = _sheet_currency(sd, None)
        _classify_electrical(ss, sd, [])
        ss.first_data_row = 1
        ss.last_data_row = sd.n_rows
        return ss
    top, bottom = hdr
    ss.header_rows = (top, bottom)
    ss.header_row = bottom
    first = bottom + 1
    while first <= sd.n_rows and _is_numbering_row(sd, first):
        first += 1
    ss.first_data_row = first
    ss.last_data_row = sd.n_rows
    _resolve_columns(ss, sd, top, bottom, llm)
    _build_rows(ss, sd)
    _hourly_rates(ss, sd)
    _kind(ss, sd, tag)
    ss.currency = _sheet_currency(sd, ss)
    _classify_electrical(ss, sd, [r.text for r in ss.rows if r.kind == "item" and r.text])
    return ss


# ------------------------------------------------------------------ column resolution

@dataclass
class _Col:
    idx: int
    header: str = ""
    group: str | None = None        # 'unit' | 'total' | None
    group_text: str = ""
    raw: str | None = None          # meaning or generic from header
    qual: str | None = None
    meaning: str | None = None
    source: str = "header"
    confidence: float = 0.0


def _resolve_columns(ss: SheetStructure, sd: SheetData, top: int, bottom: int, llm: LLMFn | None) -> None:
    ncols = max(sd.n_cols, 1)
    cols: dict[int, _Col] = {}
    # group ranges (horizontal merges or a lone label followed by blanks) in header rows above the bottom row
    group_of: dict[int, tuple[str, str]] = {}
    for r in range(top, bottom):
        for (r1, c1, r2, c2) in sd.merged:
            if r1 == r and c2 > c1 and r2 < bottom + 1:
                t = _text_at(sd, r1, c1) or ""
                n = normalise_text(t)
                g = "unit" if _GROUP_UNIT.search(n) else ("total" if _GROUP_TOTAL.search(n) else None)
                if g:
                    for c in range(c1, c2 + 1):
                        group_of[c] = (g, t)
        # lone group labels without merge: span until the next label in that row
        row = sd.rows[r - 1] if r - 1 < len(sd.rows) else []
        labels = [(c, v) for c, v in enumerate(row, start=1) if isinstance(v, str) and v.strip()]
        for i, (c, v) in enumerate(labels):
            if c in group_of:
                continue
            n = normalise_text(v)
            g = "unit" if _GROUP_UNIT.search(n) else ("total" if _GROUP_TOTAL.search(n) else None)
            if not g:
                continue
            end = labels[i + 1][0] - 1 if i + 1 < len(labels) else ncols
            if sd.merged_range(bottom, c) is None and _text_at(sd, bottom, c) is None and end > c:
                for cc in range(c, end + 1):
                    group_of.setdefault(cc, (g, v))

    for c in range(1, ncols + 1):
        parts: list[str] = []
        for r in range(top, bottom + 1):
            t, from_wide_merge = _merged_text(sd, r, c)
            if t and (r == bottom or not from_wide_merge) and t not in parts:
                parts.append(t)
        col = _Col(idx=c, header=" / ".join(parts))
        if c in group_of:
            col.group, col.group_text = group_of[c]
        # classify the most specific part (bottom first)
        for p in reversed(parts):
            m, q = classify_header(p)
            if m:
                col.raw, col.qual = m, q
                break
        if col.raw is None and parts and not col.group:
            # a header text that is itself a group label ("Kopā" over one column)
            m, q = classify_header(" ".join(parts))
            col.raw, col.qual = m, q
        cols[c] = col

    # specific meanings from header
    for col in cols.values():
        raw = col.raw
        if raw is None:
            continue
        if raw in ("no", "code", "item", "unit", "qty", "source", "notes", "hourly_rate", "category"):
            col.meaning, col.confidence = raw, 0.9
        elif raw in GENERIC:
            ctx = col.group or col.qual
            if raw == "hours":
                n = normalise_text(col.header)
                if ctx == "total" or (ctx is None and "darbietilpib" in n):
                    col.meaning = "total_norm_h"
                else:
                    col.meaning = "norm_h" if ctx == "unit" or ctx is None else "total_norm_h"
                col.confidence = 0.85 if ctx else 0.7
            elif ctx in ("unit", "total"):
                col.meaning = GENERIC[raw][0 if ctx == "unit" else 1]
                col.confidence = 0.85
            elif raw == "total":
                col.meaning, col.confidence = "total", 0.7
            elif raw == "price":
                col.meaning, col.confidence = "unit_total", 0.7
            # labour/material/mechanisms without context stay generic for now

    # duplicate specific meanings: keep the first for item/qty/unit; demote the rest
    seen: dict[str, int] = {}
    for c in sorted(cols):
        m = cols[c].meaning
        if m is None:
            continue
        if m in seen and m not in ("notes",):
            if m == "item":
                # two text columns: keep the one with more text in data
                cols[c].meaning = "notes" if _avg_text_len(sd, c, ss.first_data_row) < \
                    _avg_text_len(sd, seen[m], ss.first_data_row) else "item"
                if cols[c].meaning == "item":
                    cols[seen[m]].meaning = "notes"
                    seen[m] = c
                continue
            if m in GENERIC.get(cols[c].raw or "", ()) or m in UNIT_BLOCK + TOTAL_BLOCK:
                # the same money meaning twice -> the first is per unit, the second is the row total
                u, t = UNIT_OF.get(m, m), TOTAL_OF.get(m, m)
                if u in UNIT_BLOCK and t in TOTAL_BLOCK:
                    cols[seen[m]].meaning = u
                    cols[c].meaning = t
                    seen[u] = seen[m]
                    seen[t] = c
                    continue
            cols[c].meaning = None
        else:
            seen[m] = c

    # content-based fallbacks for item / unit / qty
    data_rows = _sample_rows(sd, ss.first_data_row, 400)
    if not any(c.meaning == "item" for c in cols.values()):
        best = max(cols, key=lambda c: _avg_text_len(sd, c, ss.first_data_row), default=None)
        if best and _avg_text_len(sd, best, ss.first_data_row) > 8:
            cols[best].meaning, cols[best].source, cols[best].confidence = "item", "position", 0.6
    if not any(c.meaning == "unit" for c in cols.values()):
        for c in sorted(cols):
            if cols[c].meaning is None and _unit_share(sd, c, data_rows) >= 0.6:
                cols[c].meaning, cols[c].source, cols[c].confidence = "unit", "position", 0.7
                break

    # generic labour/material/mechanisms without context: decide by numbers later
    _numeric_resolution(ss, sd, cols, data_rows)

    # hourly rate column that is actually per-row constant is fine; drop meanings on empty unlabelled columns
    if llm is not None:
        _llm_columns(ss, sd, cols, data_rows, llm)

    out: list[ColumnInfo] = []
    for c in sorted(cols):
        col = cols[c]
        has_data = _has_data(sd, c, data_rows)
        if col.meaning is None:
            if not col.header and not has_data:
                continue
            meaning, conf, src = "unknown", 0.2, col.source if col.source == "model" else "header"
            if not col.header:
                src = "position"
            out.append(ColumnInfo(get_column_letter(c), c, col.header, meaning, src, conf))
            continue
        out.append(ColumnInfo(get_column_letter(c), c, col.header, col.meaning, col.source,
                              round(col.confidence, 2)))
    ss.columns = out
    ss.unit_block = {c.meaning: c.letter for c in out if c.meaning in UNIT_BLOCK}
    ss.total_block = {c.meaning: c.letter for c in out if c.meaning in TOTAL_BLOCK}


def _sample_rows(sd: SheetData, first: int, n: int) -> list[int]:
    last = sd.n_rows
    if last < first:
        return []
    span = last - first + 1
    if span <= n:
        return list(range(first, last + 1))
    step = span / n
    return sorted({first + int(i * step) for i in range(n)})


def _avg_text_len(sd: SheetData, c: int, first: int | None) -> float:
    rows = _sample_rows(sd, first or 1, 200)
    lens = [len(v) for r in rows if (v := sd.get(r, c)) is not None and is_text(v)]
    return sum(lens) / max(1, len(rows)) if lens else 0.0


def _unit_share(sd: SheetData, c: int, rows: list[int]) -> float:
    vals = [sd.get(r, c) for r in rows]
    vals = [v for v in vals if isinstance(v, str) and v.strip()]
    if len(vals) < 2:
        return 0.0
    return sum(1 for v in vals if normalise_unit(v)) / len(vals)


def _has_data(sd: SheetData, c: int, rows: list[int]) -> bool:
    return any(sd.get(r, c) is not None for r in rows)


def _num_col(sd: SheetData, c: int, rows: list[int]) -> dict[int, float]:
    out: dict[int, float] = {}
    for r in rows:
        v = parse_number(sd.get(r, c))
        if v is not None:
            out[r] = v
    return out


def _match_ratio(t: dict[int, float], q: dict[int, float], u: dict[int, float]) -> tuple[float, int]:
    """Share of rows where t ≈ q × u (t non-zero)."""
    n = ok = 0
    for r, tv in t.items():
        if tv == 0 or r not in q or r not in u:
            continue
        qv, uv = q[r], u[r]
        if qv == 0:
            continue
        n += 1
        if close(tv, qv * uv, rel=0.006, abs_tol=0.011):
            ok += 1
    return (ok / n if n else 0.0), n


def _numeric_resolution(ss: SheetStructure, sd: SheetData, cols: dict[int, _Col], rows: list[int]) -> None:
    qty_c = next((c for c, col in cols.items() if col.meaning == "qty"), None)
    item_c = next((c for c, col in cols.items() if col.meaning == "item"), None)
    unit_c = next((c for c, col in cols.items() if col.meaning == "unit"), None)
    anchor = max(x for x in (qty_c, unit_c, item_c, 0) if x is not None)
    numcache: dict[int, dict[int, float]] = {}

    def num(c: int) -> dict[int, float]:
        if c not in numcache:
            numcache[c] = _num_col(sd, c, rows)
        return numcache[c]

    # qty by content when the header didn't say
    if qty_c is None and unit_c is not None:
        for c in (unit_c + 1, unit_c - 1):
            if c in cols and cols[c].meaning is None and len(num(c)) >= max(2, len(rows) // 4):
                cols[c].meaning, cols[c].source, cols[c].confidence = "qty", "position", 0.6
                qty_c = c
                break
    if qty_c is None:
        return
    q = num(qty_c)

    def unresolved(c: int) -> bool:
        col = cols[c]
        return c > anchor and c != qty_c and (col.meaning is None or col.raw in ("labour", "material", "mechanisms")
                                              and col.meaning is None)

    candidates = [c for c in cols if c > anchor and c != qty_c and cols[c].meaning is None
                  and cols[c].raw not in ("no", "code", "item", "unit", "source", "notes", "category")]
    # 1) labelled totals -> find their per-unit counterpart among unresolved / generic columns
    for t_meaning in ("total_labour", "total_material", "total_mechanisms", "total", "total_norm_h"):
        t_c = next((c for c, col in cols.items() if col.meaning == t_meaning), None)
        u_meaning = UNIT_OF[t_meaning]
        u_existing = next((c for c, col in cols.items() if col.meaning == u_meaning), None)
        if t_c is None:
            continue
        t = num(t_c)
        if u_existing is not None:
            ratio, n = _match_ratio(t, q, num(u_existing))
            if n >= 2 and ratio >= 0.7:
                cols[u_existing].confidence = max(cols[u_existing].confidence, 0.97)
                cols[t_c].confidence = max(cols[t_c].confidence, 0.97)
            continue
        best: tuple[float, int] | None = None
        for c in candidates:
            if cols[c].meaning is not None or c == t_c:
                continue
            ratio, n = _match_ratio(t, q, num(c))
            if n >= 2 and ratio >= 0.7 and (best is None or ratio > best[0]):
                best = (ratio, c)
        if best:
            c = best[1]
            cols[c].meaning = u_meaning
            cols[c].source = "header" if cols[c].raw else "position"
            cols[c].confidence = 0.95
            cols[t_c].confidence = max(cols[t_c].confidence, 0.95)

    # 2) generic columns with no context: G ≈ qty × H  => G total, H unit
    generics = [c for c in candidates if cols[c].meaning is None and cols[c].raw in ("labour", "material",
                                                                                         "mechanisms", "hours")]
    for g in generics:
        if cols[g].meaning is not None:
            continue
        raw = cols[g].raw
        u_m, t_m = GENERIC[raw]
        # is g a per-unit value of some labelled/unresolved total column?
        for c in candidates:
            if c == g or cols[c].meaning not in (None, t_m):
                continue
            ratio, n = _match_ratio(num(c), q, num(g))
            if n >= 2 and ratio >= 0.7:
                cols[g].meaning, cols[g].confidence = u_m, 0.9
                if cols[c].meaning is None:
                    cols[c].meaning, cols[c].confidence = t_m, 0.9
                    cols[c].source = "header" if cols[c].raw else "position"
                break
        if cols[g].meaning is None:
            for c in candidates:
                if c == g or cols[c].meaning not in (None, u_m):
                    continue
                ratio, n = _match_ratio(num(g), q, num(c))
                if n >= 2 and ratio >= 0.7:
                    cols[g].meaning, cols[g].confidence = t_m, 0.9
                    if cols[c].meaning is None:
                        cols[c].meaning, cols[c].confidence = u_m, 0.9
                        cols[c].source = "header" if cols[c].raw else "position"
                    break

    # 3) hourly rate: unit_labour ≈ norm_h × R
    ul_c = next((c for c, col in cols.items() if col.meaning == "unit_labour"), None)
    nh_c = next((c for c, col in cols.items() if col.meaning == "norm_h"), None)
    rate_c = next((c for c, col in cols.items() if col.meaning == "hourly_rate"), None)
    free = [c for c in candidates if cols[c].meaning is None]
    if ul_c is not None and rate_c is None:
        ul = num(ul_c)
        if nh_c is not None:
            for c in free:
                ratio, n = _match_ratio(ul, num(nh_c), num(c))
                if n >= 2 and ratio >= 0.7:
                    cols[c].meaning, cols[c].confidence = "hourly_rate", 0.93
                    cols[c].source = "header" if cols[c].raw else "position"
                    break
        else:
            for a in free:
                for b in free:
                    if a >= b or cols[a].meaning or cols[b].meaning:
                        continue
                    ratio, n = _match_ratio(ul, num(a), num(b))
                    if n >= 2 and ratio >= 0.7:
                        va, vb = list(num(a).values()), list(num(b).values())
                        spread_a = _spread(va)
                        spread_b = _spread(vb)
                        rate, norm = (a, b) if spread_a < spread_b else (b, a)
                        cols[rate].meaning, cols[rate].confidence = "hourly_rate", 0.9
                        cols[norm].meaning, cols[norm].confidence = "norm_h", 0.9
                        for x in (rate, norm):
                            cols[x].source = "header" if cols[x].raw else "position"
                        break
    # unit_total ≈ labour + material + mechanisms
    if not any(col.meaning == "unit_total" for col in cols.values()):
        parts = [c for c, col in cols.items() if col.meaning in ("unit_labour", "unit_material", "unit_mechanisms")]
        if parts:
            for c in [c for c in candidates if cols[c].meaning is None]:
                vals = num(c)
                n = ok = 0
                for r, v in vals.items():
                    if v == 0:
                        continue
                    s = sum(num(p).get(r, 0.0) for p in parts)
                    n += 1
                    ok += close(v, s)
                if n >= 2 and ok / n >= 0.7:
                    cols[c].meaning, cols[c].confidence = "unit_total", 0.9
                    cols[c].source = "header" if cols[c].raw else "position"
                    break

    # 4) position mapping for columns still unresolved in the unit block (e.g. blanks with empty price cells)
    total_cols = sorted((c for c, col in cols.items() if col.meaning in TOTAL_BLOCK))
    if total_cols:
        first_total = total_cols[0]
        unit_cols = [c for c in cols if anchor < c < first_total and c != qty_c
                     and cols[c].meaning in (None,) + UNIT_BLOCK
                     and cols[c].raw not in ("no", "code", "item", "unit", "source", "notes", "category")]
        unit_cols = [c for c in unit_cols if cols[c].group in (None, "unit")]
        pending = [c for c in unit_cols if cols[c].meaning is None]
        if pending:
            template = [UNIT_OF[cols[c].meaning] for c in total_cols]
            if len(unit_cols) == len(template) + 1 and "norm_h" in template:
                i = template.index("norm_h")
                template.insert(i + 1, "hourly_rate")
            elif len(unit_cols) == len(template) + 1 and "unit_labour" in template:
                template.insert(template.index("unit_labour"), "hourly_rate")
            taken = {cols[c].meaning for c in unit_cols if cols[c].meaning}
            if len(unit_cols) == len(template):
                for c, m in zip(unit_cols, template):
                    if cols[c].meaning is None and m not in taken:
                        cols[c].meaning, cols[c].source, cols[c].confidence = m, "position", 0.6
                        taken.add(m)
            else:
                remaining = [m for m in template if m not in taken]
                for c, m in zip(pending, remaining):
                    cols[c].meaning, cols[c].source, cols[c].confidence = m, "position", 0.4
    # generic leftovers: first occurrence -> per unit, later -> total (reading order)
    for raw, (u_m, t_m) in GENERIC.items():
        left = [c for c in sorted(cols) if cols[c].meaning is None and cols[c].raw == raw]
        taken = {col.meaning for col in cols.values()}
        for c in left:
            m = u_m if u_m not in taken else (t_m if t_m not in taken else None)
            if m:
                cols[c].meaning, cols[c].confidence = m, 0.5
                taken.add(m)


def _spread(vals: list[float]) -> float:
    vals = [v for v in vals if v]
    if len(vals) < 2:
        return 0.0
    m = statistics.fmean(vals)
    return statistics.pstdev(vals) / abs(m) if m else float("inf")


# ------------------------------------------------------------------ model fallbacks (optional)

_COL_SCHEMA = {
    "type": "object",
    "properties": {"columns": {"type": "array", "items": {"type": "object", "properties": {
        "letter": {"type": "string"}, "meaning": {"type": "string", "enum": list(MEANINGS)},
        "confidence": {"type": "number"}}, "required": ["letter", "meaning"]}}},
    "required": ["columns"],
}


def _llm_columns(ss: SheetStructure, sd: SheetData, cols: dict[int, _Col], rows: list[int], llm: LLMFn) -> None:
    ambiguous = [c for c, col in cols.items()
                 if col.meaning is None and _has_data(sd, c, rows) and len(_num_col(sd, c, rows)) >= 2]
    if not ambiguous:
        return
    sample = [r for r in rows if any(sd.get(r, c) is not None for c in ambiguous)][:8]
    show = sorted(set(ambiguous) | {c for c, col in cols.items() if col.meaning})
    lines = ["Column headers and meanings found so far (letter: header -> meaning):"]
    for c in show:
        lines.append(f"{get_column_letter(c)}: {cols[c].header or '(no header)'} -> {cols[c].meaning or '?'}")
    lines.append("Sample rows (letter=value):")
    n_cells = 0
    for r in sample:
        vals = []
        for c in show:
            v = sd.get(r, c)
            if v is not None:
                vals.append(f"{get_column_letter(c)}={v}")
                n_cells += 1
        lines.append(f"row {r}: " + "; ".join(vals))
    lines.append("Decide the meaning of the columns marked '?'. Allowed meanings: " + ", ".join(MEANINGS) + ".")
    prompt = "\n".join(lines)
    try:
        res = llm(prompt, _COL_SCHEMA) or {}
    except Exception:  # noqa: BLE001 - model trouble must not break ingestion
        log.warning("llm column resolution failed", exc_info=True)
        return
    finally:
        ss.model_calls += 1
        ss.model_cells += n_cells
        ss.model_rows += len(sample)
    taken = {col.meaning for col in cols.values() if col.meaning}
    for item in res.get("columns", []) if isinstance(res, dict) else []:
        try:
            from openpyxl.utils.cell import column_index_from_string
            c = column_index_from_string(str(item.get("letter", "")).strip().upper())
        except Exception:  # noqa: BLE001
            continue
        m = item.get("meaning")
        if c in ambiguous and m in MEANINGS and m != "unknown" and (m not in taken or m == "notes"):
            cols[c].meaning = m
            cols[c].source = "model"
            cols[c].confidence = float(item.get("confidence") or 0.6)
            taken.add(m)


_HDR_SCHEMA = {"type": "object", "properties": {"header_row": {"type": ["integer", "null"]}},
               "required": ["header_row"]}


def _llm_header(sd: SheetData, llm: LLMFn, ss: SheetStructure) -> tuple[int, int] | None:
    rows = min(len(sd.rows), 25)
    if rows < 2:
        return None
    lines = []
    n_cells = 0
    for r in range(1, rows + 1):
        vals = [f"{get_column_letter(c)}={v}" for c, v in enumerate(sd.rows[r - 1], start=1) if v is not None][:20]
        n_cells += len(vals)
        lines.append(f"row {r}: " + "; ".join(vals))
    prompt = ("Which row is the column header row of this estimate / price table? Answer null if none.\n"
              + "\n".join(lines))
    try:
        res = llm(prompt, _HDR_SCHEMA) or {}
    except Exception:  # noqa: BLE001
        return None
    finally:
        ss.model_calls += 1
        ss.model_cells += n_cells
        ss.model_rows += rows
    r = res.get("header_row") if isinstance(res, dict) else None
    if isinstance(r, int) and 1 <= r <= rows:
        return r, r
    return None


# ------------------------------------------------------------------ rows / sections

def _row_texts(sd: SheetData, row: list[Any], skip: set[int]) -> list[tuple[int, str]]:
    out = []
    for c, v in enumerate(row, start=1):
        if c in skip or v is None:
            continue
        if isinstance(v, str) and not v.startswith("=") and parse_number(v) is None and any(ch.isalpha() for ch in v):
            out.append((c, v))
    return out


def _build_rows(ss: SheetStructure, sd: SheetData) -> None:
    by = {c.meaning: c.idx for c in ss.columns if c.meaning not in ("unknown",)}
    item_c, unit_c, qty_c = by.get("item"), by.get("unit"), by.get("qty")
    no_c, code_c, src_c, cat_c = by.get("no"), by.get("code"), by.get("source"), by.get("category")
    num_meanings = [m for m in NUMERIC_MEANINGS if m in by and m != "qty"]
    unit_block_cols = {by[m] for m in UNIT_BLOCK if m in by}
    header_texts = {normalise_text(c.header) for c in ss.columns if c.header}
    first = ss.first_data_row or 1
    rows: list[RowInfo] = []
    current: Section | None = None
    sections: list[Section] = []
    seen_grand = False
    last_item_row = None
    skip_text_cols = {unit_c} if unit_c else set()
    for r in range(first, sd.n_rows + 1):
        row = sd.rows[r - 1]
        if not any(v is not None for v in row):
            rows.append(RowInfo(row=r, kind="blank", hidden=r in sd.hidden_rows))
            continue
        ri = RowInfo(row=r, kind="item", hidden=r in sd.hidden_rows)
        texts = _row_texts(sd, row, skip_text_cols | ({qty_c} if qty_c else set()))
        item_txt = sd.get(r, item_c) if item_c else None
        if item_txt is not None and not isinstance(item_txt, str):
            item_txt = str(item_txt)
        if isinstance(item_txt, str) and item_txt.startswith("="):
            item_txt = None
        text_c = item_c if item_txt else None
        if not item_txt:
            others = [(c, t) for c, t in texts if c not in (no_c, code_c, src_c)]
            if others:
                text_c, item_txt = max(others, key=lambda x: len(x[1]))
        ri.text = item_txt.strip() if isinstance(item_txt, str) else None
        ri.text_col = get_column_letter(text_c) if text_c else None
        if cat_c:
            v = sd.get(r, cat_c)
            ri.category_label = str(v).strip() if v is not None and str(v).strip() else None
        if no_c:
            v = sd.get(r, no_c)
            ri.number = None if v is None else (str(int(v)) if isinstance(v, float) and v.is_integer() else str(v))
        if code_c:
            v = sd.get(r, code_c)
            ri.code = None if v is None else str(v)
        if src_c:
            v = sd.get(r, src_c)
            ri.source_ref = None if v is None else str(v)
        unit_raw = sd.get(r, unit_c) if unit_c else None
        ri.unit = str(unit_raw).strip() if unit_raw is not None and str(unit_raw).strip() else None
        ri.qty = parse_number(sd.get(r, qty_c)) if qty_c else None
        if qty_c:
            ri.cells["qty"] = coord(r, qty_c)
            ri.formulas["qty"] = (r, qty_c) in sd.formulas
        for m in num_meanings:
            c = by[m]
            ri.values[m] = parse_number(sd.get(r, c))
            ri.cells[m] = coord(r, c)
            ri.formulas[m] = (r, c) in sd.formulas
        if item_c:
            ri.cells["item"] = coord(r, item_c)
        if unit_c:
            ri.cells["unit"] = coord(r, unit_c)
        ri.bold = any(sd.is_bold(r, c) for c in (item_c, no_c) if c) or (
            item_c is not None and sd.is_bold(r, item_c))
        merged_row = any(sd.merged_range(r, c) and sd.merged_range(r, c)[3] > sd.merged_range(r, c)[1]
                         for c in (item_c, no_c, 1) if c)
        full_text = " ".join(t for _, t in texts) or (ri.text or "")
        n_full = normalise_text(full_text)
        has_price = any(v not in (None, 0) for v in ri.values.values())
        has_unit_price = any(ri.values.get(m) not in (None, 0) for m in UNIT_BLOCK if m in ri.values)
        unit_ok = ri.unit is not None and normalise_unit(ri.unit, ss.language) is not None
        qty_ok = ri.qty is not None
        n_text = normalise_text(ri.text)

        if not ri.text and not qty_ok and not unit_ok:
            ri.kind = "total" if has_price and last_item_row else "note"
            if ri.kind == "note" and not full_text:
                ri.kind = "blank"
        elif header_texts and sum(1 for _, t in texts if normalise_text(t) in header_texts) >= 2:
            ri.kind = "header"
        elif not qty_ok and not _GRAND_RX.search(n_full) and (
                _MARKUP_RX.search(n_full) and (_PCT_IN_TEXT.search(full_text) or has_price or _pct_cell(sd, r, row))
                and last_item_row is not None):
            ri.kind = "total"
            ri.markup = _markup_info(sd, r, row, full_text, ss)
        elif not qty_ok and not unit_ok and (_SUBTOTAL_RX.search(n_text or n_full) or _GRAND_RX.search(n_full)):
            if _GRAND_RX.search(n_full) or current is None or seen_grand or \
                    _closes_everything(ri, rows, sections, current):
                ri.kind = "total"
                if current is not None and current.subtotal_row is None:
                    current.row_end = r - 1
                    current = None
                seen_grand = seen_grand or bool(_GRAND_RX.search(n_full)) or last_item_row is not None
            else:
                ri.kind = "subtotal"
                current.subtotal_row = r
                current.row_end = r
                current = None
        elif qty_ok or unit_ok or (has_unit_price and not ri.bold and not merged_row):
            if ri.text is None and not has_price and not qty_ok:
                ri.kind = "note"
            else:
                ri.kind = "item"
                last_item_row = r
        elif seen_grand or _NOTE_RX.search(n_text or "") or len(ri.text or "") > 160:
            ri.kind = "note"
        else:
            ri.kind = "section"
            if current is not None and current.subtotal_row is None:
                current.row_end = r - 1
            current = Section(title=ri.text or full_text, row_start=r, row_end=r)
            sections.append(current)
        if ri.kind in ("item", "note") and current is not None:
            current.row_end = r
        if ri.kind == "item":
            ri.section_title = current.title if current else None
        elif ri.kind in ("section", "subtotal"):
            ri.section_title = sections[-1].title if sections else None
        rows.append(ri)
    # trim trailing blanks
    while rows and rows[-1].kind == "blank":
        rows.pop()
    ss.rows = rows
    ss.last_data_row = rows[-1].row if rows else ss.first_data_row
    ss.sections = [s for s in sections if s.title]
    ss.markups = [dict(r.markup, row=r.row) for r in rows if r.markup]
    # totals over items
    tot: dict[str, float] = defaultdict(float)
    for r in rows:
        if r.kind != "item":
            continue
        q = r.qty or 0.0
        for tm, um in (("total_labour", "unit_labour"), ("total_material", "unit_material"),
                       ("total_mechanisms", "unit_mechanisms"), ("total", "unit_total"),
                       ("total_norm_h", "norm_h")):
            v = r.values.get(tm)
            if v is None and r.values.get(um) is not None:
                v = q * r.values[um]
            if v is not None:
                tot[tm] += v
    ss.totals = {k: round(v, 4) for k, v in tot.items()}
    del unit_block_cols


_SUM_KEYS = ("total", "total_labour", "total_material", "total_norm_h", "total_mechanisms")


def _closes_everything(ri: RowInfo, rows: list[RowInfo], sections: list[Section], current: Section) -> bool:
    """A 'Kopā'/'I alt' row below several sections: is it the current section's subtotal or the sheet total?"""
    since = 0
    for i in range(len(rows) - 1, -1, -1):
        if rows[i].kind == "total":
            since = i + 1
            break
    block = rows[since:]
    for key in _SUM_KEYS:
        v = ri.values.get(key)
        if not v:
            continue
        sec_sum = sum((x.values.get(key) or 0.0) for x in block if x.kind == "item" and x.row >= current.row_start)
        all_sum = sum((x.values.get(key) or 0.0) for x in block if x.kind == "item")
        if close(v, sec_sum, rel=0.002) and not close(v, all_sum, rel=0.002):
            return False
        if close(v, all_sum, rel=0.002) and not close(v, sec_sum, rel=0.002):
            return True
        break
    # no numbers to decide: earlier sections in this block without their own subtotal -> sheet total
    first_row = block[0].row if block else 0
    earlier = [s for s in sections if s is not current and s.row_start >= first_row]
    return bool(earlier) and all(s.subtotal_row is None for s in earlier)


def _pct_cell(sd: SheetData, r: int, row: list[Any]) -> bool:
    for c, v in enumerate(row, start=1):
        if isinstance(v, (int, float)) and "%" in sd.number_format(r, c):
            return True
    return False


def _markup_info(sd: SheetData, r: int, row: list[Any], text: str, ss: SheetStructure) -> dict[str, Any]:
    info: dict[str, Any] = {"name": None, "pct": None, "value": None, "value_cell": None, "pct_cell": None,
                            "formula": None}
    n = normalise_text(text)
    names = [t for _, t in _row_texts(sd, row, set())]
    info["name"] = (names[0] if names else text).strip()
    m = _PCT_IN_TEXT.search(text.replace(",", "."))
    if m:
        info["pct"] = float(m.group(1)) / 100.0
    numeric = [(c, v) for c, v in enumerate(row, start=1) if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if not numeric:
        numeric = [(c, parse_number(v)) for c, v in enumerate(row, start=1)
                   if isinstance(v, str) and parse_number(v) is not None and "%" not in v]
    for c, v in numeric:
        if "%" in sd.number_format(r, c) or (info["pct"] is None and 0 < v < 1 and c < max(cc for cc, _ in numeric)):
            info["pct"] = float(v)
            info["pct_cell"] = coord(r, c)
            continue
    vals = [(c, v) for c, v in numeric if coord(r, c) != info["pct_cell"]]
    if vals:
        c, v = vals[-1]
        info["value"] = float(v)
        info["value_cell"] = coord(r, c)
        f = sd.formula(r, c)
        if f:
            info["formula"] = f
    info["key"] = re.sub(r"[^a-z0-9]+", "_", re.sub(r"\d+(\.\d+)?\s*%", "", n)).strip("_")[:40] or f"row{r}"
    return info


# ------------------------------------------------------------------ hourly rates

def _hourly_rates(ss: SheetStructure, sd: SheetData) -> None:
    rates: list[dict[str, Any]] = []
    # 1) labelled cells anywhere ("Stundas likme: 12,50 EUR/h", or label with the number to the right/below)
    rate_col = ss.col_idx("hourly_rate")
    header_rows = set(range(ss.header_rows[0], ss.header_rows[1] + 1)) if ss.header_rows else set()
    label_cells: list[tuple[int, float, str]] = []
    for r, row in enumerate(sd.rows, start=1):
        for c, v in enumerate(row, start=1):
            if not isinstance(v, str) or len(v) > 120:
                continue
            if r in header_rows and c == rate_col:
                continue
            n = normalise_text(v)
            if not _RATE_CELL_RX.search(n):
                continue
            val = None
            src = None
            m = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:eur|€|dkk|kr|nok|sek|/|$)", v.lower())
            if m:
                val = parse_number(m.group(1))
                src = coord(r, c)
            if val is None:
                for cc in range(c + 1, min(c + 6, len(row) + 1)):
                    x = parse_number(row[cc - 1]) if cc - 1 < len(row) else None
                    if x is not None:
                        val, src = x, coord(r, cc)
                        break
            if val is None and r < len(sd.rows):
                x = parse_number(sd.get(r + 1, c))
                if x is not None:
                    val, src = x, coord(r + 1, c)
            if val is not None and 1 <= val <= 500:
                label_cells.append((r, val, src))
    label_cells.sort()
    # 2) per-row effective rate: rate column, else unit_labour / norm_h
    items = [x for x in ss.rows if x.kind == "item"]
    per_row: dict[int, tuple[float, str]] = {}
    for it in items:
        rv = it.values.get("hourly_rate")
        if rv:
            per_row[it.row] = (round(rv, 4), "column")
            continue
        ul, nh = it.values.get("unit_labour"), it.values.get("norm_h")
        if (not ul or not nh) and it.qty:
            tl, tn = it.values.get("total_labour"), it.values.get("total_norm_h")
            if tl and tn:
                ul, nh = tl / it.qty, tn / it.qty
        if ul and nh:
            per_row[it.row] = (round(ul / nh, 2), "derived")

    def rate_for_rows(r_from: int, r_to: int) -> tuple[float | None, str | None]:
        vals = [v for r, v in per_row.items() if r_from <= r <= r_to]
        if vals:
            cnt = Counter(v[0] for v in vals)
            rate, _ = cnt.most_common(1)[0]
            src = "column " + get_column_letter(rate_col) if vals[0][1] == "column" and rate_col else "derived"
            return rate, src
        lab = [x for x in label_cells if x[0] <= r_to]
        if lab:
            return lab[-1][1], "cell " + lab[-1][2]
        return None, None

    # sections
    for s in ss.sections:
        rate, _ = rate_for_rows(s.row_start, s.row_end)
        s.hourly_rate = rate
    # sheet-level list: group consecutive rows with the same rate
    if per_row:
        runs: list[dict[str, Any]] = []
        for r in sorted(per_row):
            rate, how = per_row[r]
            if runs and runs[-1]["rate"] == rate:
                runs[-1]["rows"][1] = r
                runs[-1]["count"] += 1
            else:
                src = f"column {get_column_letter(rate_col)}" if how == "column" and rate_col else "derived"
                runs.append({"rate": rate, "rows": [r, r], "source": src, "count": 1})
        # merge outliers (single rows) into neighbours for readability; keep all distinct rates
        merged: dict[float, dict[str, Any]] = {}
        for run in runs:
            m = merged.get(run["rate"])
            if m is None:
                merged[run["rate"]] = {**run, "rows": list(run["rows"])}
            else:
                m["rows"][0] = min(m["rows"][0], run["rows"][0])
                m["rows"][1] = max(m["rows"][1], run["rows"][1])
                m["count"] += run["count"]
        for m in merged.values():
            if m["count"] >= 2 or len(merged) == 1:
                rates.append(m)
    for (r, val, src) in label_cells:
        if not any(abs(x["rate"] - val) < 0.005 for x in rates):
            rates.append({"rate": val, "rows": [r, ss.last_data_row or r], "source": f"cell {src}", "count": 0})
        else:
            for x in rates:
                if abs(x["rate"] - val) < 0.005 and x["source"] == "derived":
                    x["source"] = f"cell {src}"
    for x in rates:
        x["currency"] = None  # filled once currency is known
        secs = [s.title for s in ss.sections if s.hourly_rate is not None and abs(s.hourly_rate - x["rate"]) < 0.005]
        if secs:
            x["sections"] = secs
    ss.hourly_rates = sorted(rates, key=lambda x: x["rows"][0])


# ------------------------------------------------------------------ kind / currency / electrical

def _kind(ss: SheetStructure, sd: SheetData, tag: str | None) -> None:
    ms = {c.meaning for c in ss.columns}
    items = [r for r in ss.rows if r.kind == "item"]
    name = normalise_text(sd.name)
    money = ms & {"unit_labour", "unit_material", "unit_total", "total_labour", "total_material", "total"}
    hours = ms & {"norm_h", "total_norm_h"}
    if _SUMMARY_NAME_RX.search(name) and len(items) < 30:
        cross = sum(1 for f in sd.formulas.values() if "!" in f)
        if cross >= 2 or not ("qty" in ms and "item" in ms):
            ss.kind = "summary"
            return
    if "item" not in ms and "qty" not in ms:
        cross = sum(1 for f in sd.formulas.values() if "!" in f)
        ss.kind = "summary" if cross >= 2 else "other"
        return
    if "qty" in ms and items:
        if hours and not money and (tag == "hourly_norms" or _NORMS_NAME_RX.search(name)):
            ss.kind = "norms"
        else:
            ss.kind = "estimate"
        return
    if hours and not ({"unit_labour", "unit_material", "total_labour", "total_material"} & ms):
        ss.kind = "norms"
        return
    if money and items:
        ss.kind = "prices"
        return
    if hours:
        ss.kind = "norms"
        return
    ss.kind = "estimate" if items else "other"


def _sheet_currency(sd: SheetData, ss: SheetStructure | None) -> str | None:
    cnt: Counter[str] = Counter()
    for fmt in list(sd.number_formats.values())[:5000]:
        f = fmt.lower()
        if "€" in f or "[$eur" in f or "eur" in f:
            cnt["EUR"] += 1
        elif "kr" in f or "dkk" in f:
            cnt["DKK"] += 1
        elif "$" in f and "[$" not in f:
            cnt["USD"] += 1
        elif "£" in f:
            cnt["GBP"] += 1
        elif "zł" in f:
            cnt["PLN"] += 1
    texts = []
    if ss is not None:
        texts.extend(c.header for c in ss.columns if c.header)
    for row in sd.rows[:40]:
        texts.extend(v for v in row if isinstance(v, str) and len(v) < 120)
    cur = _currency_from_texts(texts)
    if cur:
        cnt[cur] += 3
    if not cnt:
        return None
    return cnt.most_common(1)[0][0]


def _currency_from_texts(texts: list[str]) -> str | None:
    cnt: Counter[str] = Counter()
    for t in texts[:3000]:
        low = str(t).lower()
        for code, rx in _CURRENCY_RX:
            if rx.search(low):
                cnt[code] += 1
    return cnt.most_common(1)[0][0] if cnt else None


def _classify_electrical(ss: SheetStructure, sd: SheetData, item_texts: list[str]) -> None:
    name = normalise_text(sd.name)
    name_hit = bool(_ELEC_WORDS.search(name))
    name_non = bool(_NONELEC_WORDS.search(name))
    e = n = 0
    for t in item_texts:
        cat = detect_category(t)
        nt = normalise_text(t)
        if cat and cat not in ("labour_only", "other"):
            e += 1
        elif _NONELEC_WORDS.search(nt):
            n += 1
        elif _ELEC_WORDS.search(nt):
            e += 0.5
    total = len(item_texts)
    if total == 0:
        texts = [normalise_text(v) for row in sd.rows[:200] for v in row if isinstance(v, str)]
        e = sum(1 for t in texts if _ELEC_WORDS.search(t) or detect_category(t) not in (None, "labour_only"))
        n = sum(1 for t in texts if _NONELEC_WORDS.search(t))
        total = max(len(texts), 1)
    unknown = max(0.0, total - e - n)
    score = (e + (3 if name_hit else 0)) / max(1.0, e + n + 0.35 * unknown + (3 if name_hit or name_non else 0))
    if name_non and not name_hit:
        score *= 0.5
    conf = round(min(1.0, score), 2)
    ss.electrical_confidence = conf
    if total >= 3 or name_hit or name_non:
        if conf >= 0.6:
            ss.is_electrical = True
        elif conf <= 0.25:
            ss.is_electrical = False
        else:
            ss.is_electrical = None
    else:
        ss.is_electrical = None


def structure_to_json(ws: WorkbookStructure) -> dict[str, Any]:
    return {"language": ws.language, "currency": ws.currency, "kind": ws.kind, "model_calls": ws.model_calls,
            "model_cells": ws.model_cells, "model_rows": ws.model_rows,
            "sheets": [s.to_dict() for s in ws.sheets]}


def basename(path: str) -> str:
    return os.path.basename(path)
