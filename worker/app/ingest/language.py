"""Deterministic language detection for (short, many) estimate cell texts.

Scores are aggregated over all cells: diacritic / script signatures + stopwords + estimating vocabulary.
Returns an upper-case code: LV, EN, DA, LT, ET, DE, SV, NO, FI, RU, PL (EN when there is no signal).
"""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable

LANGS = ("LV", "EN", "DA", "LT", "ET", "DE", "SV", "NO", "FI", "RU", "PL")

# Characters that (nearly) identify a language, with weights.
_CHAR_SIG: dict[str, dict[str, float]] = {
    "LV": {"ā": 3, "ē": 3, "ī": 3, "ģ": 4, "ķ": 4, "ļ": 4, "ņ": 4, "ū": 1.5, "č": 1, "š": 1, "ž": 1},
    "LT": {"ą": 4, "ę": 4, "ė": 4, "į": 4, "ų": 4, "ū": 1.5, "č": 1, "š": 1, "ž": 1},
    "ET": {"õ": 4, "ä": 1, "ö": 1, "ü": 1.5, "š": 0.5, "ž": 0.5},
    "DE": {"ß": 4, "ä": 1, "ö": 1, "ü": 1.5},
    "SV": {"å": 1.5, "ä": 1.5, "ö": 1.5},
    "FI": {"ä": 1.5, "ö": 1},
    "DA": {"æ": 2.5, "ø": 2.5, "å": 1.5},
    "NO": {"æ": 2.5, "ø": 2.5, "å": 1.5},
    "PL": {"ł": 4, "ś": 4, "ź": 4, "ż": 3, "ć": 4, "ń": 3, "ą": 1.5, "ę": 1.5, "ó": 1.5},
}

_WORDS: dict[str, str] = {
    "LV": """un ar uz no par pie vai kas ir bez līdz kopā kopa summa darba darbs darbi nosaukums mērv mērvienība
        daudz daudzums vienības izmaksas materiāli materiali mehānismi alga likme stundas norma laika tāme tāmes
        kabelis kabeļa kabeļu kontaktligzda kontaktligzdas slēdzis gaismeklis sadale sadales skapis caurule montāža
        uzstādīšana ievilkšana izbūve elektroinstalācija elektroapgāde gab kompl tek virsizdevumi peļņa
        pievienošana nodoklis sociālais transporta izdevumi starpsumma pavisam objekts būvdarbi piegāde""",
    "LT": """ir su be iki kaina kiekis vnt kompl darbai darbo medžiagos medžiagų pavadinimas matavimo vienetas
        iš viso suma kabelis kabelio lizdas jungiklis šviestuvas skydas vamzdis montavimas įrengimas elektros
        mechanizmai pelnas pridėtinės išlaidos iš viso""",
    "ET": """ja on ning või kokku summa hind kogus ühik tk töö tööd materjal materjalid nimetus kaabel
        pistikupesa lüliti valgusti kilp toru paigaldus elekter paigaldamine""",
    "EN": """the and of for with to in on per item description quantity qty unit rate price total subtotal
        labour labor material materials cable socket switch luminaire board installation supply install
        hours hourly each pcs lot sum amount cost costs overheads profit contingency including excluding""",
    "DA": """og af til med i på for ikke stk antal enhed enhedspris pris timer timepris materialer materiale
        arbejde arbejdsløn i alt ialt beløb kilde tekst betegnelse beskrivelse kabel stikkontakt afbryder
        lampe tavle gruppetavle installation montering levering udførelse lbm sæt samlet avance moms""",
    "NO": """og av til med i på for ikke stk antall enhet enhetspris pris timer timepris materiell materiale
        arbeid sum totalt beskrivelse kabel stikkontakt bryter lampe tavle sikringsskap installasjon
        montering levering eks mva""",
    "SV": """och av till med i på för inte st antal enhet pris timmar timpris material arbete summa totalt
        benämning beskrivning kabel uttag strömbrytare armatur elcentral installation montering leverans
        moms inkl exkl""",
    "FI": """ja on tai kanssa yhteensä hinta määrä yksikkö kpl työ työt materiaali materiaalit nimike kaapeli
        pistorasia kytkin valaisin keskus asennus sähkö tarvikkeet""",
    "DE": """und der die das mit für von zu im auf pro stück stk menge einheit preis einzelpreis gesamtpreis
        gesamt summe zwischensumme lohn material stunden stundensatz bezeichnung beschreibung kabel leitung
        steckdose schalter leuchte verteiler montage lieferung pauschal inkl zzgl""",
    "RU": """и в на с по для из шт м кол во количество ед изм цена сумма итого всего работа работы материал
        материалы наименование кабель розетка выключатель светильник щит монтаж установка""",
    "PL": """i w na z do dla oraz szt ilość jednostka cena wartość razem suma robocizna materiały materiał
        nazwa opis kabel przewód gniazdo łącznik oprawa rozdzielnica montaż dostawa""",
}

_WORD_SETS: dict[str, set[str]] = {}
for _lang, _txt in _WORDS.items():
    _WORD_SETS[_lang] = {w.lower() for w in _txt.split()}

# word -> languages using it (words shared by several languages carry less evidence each)
_WORD_INDEX: dict[str, tuple[str, ...]] = {}
for _lang, _ws in _WORD_SETS.items():
    for _w in _ws:
        _WORD_INDEX[_w] = _WORD_INDEX.get(_w, ()) + (_lang,)

_RE_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
_RE_CYR = re.compile(r"[Ѐ-ӿ]")

# Letter-level distinguishers between DA and NO (and SV).
_DA_NO_HINTS = {
    "DA": ("af", "antal", "enhed", "enhedspris", "arbejde", "arbejdsløn", "materialer", "ikke", "beløb", "hvad",
           "udført", "ialt", "kilde", "lbm", "sæt", "også", "moms", "stikkontakter", "afbryder", "gruppetavle"),
    "NO": ("av", "antall", "enhet", "enhetspris", "arbeid", "materiell", "ikke", "totalt", "også", "mva",
           "sikringsskap", "bryter", "kurs", "jordfeil", "stikkontakter"),
}


_HINT_INDEX: dict[str, tuple[str, ...]] = {}
for _lang, _hs in _DA_NO_HINTS.items():
    for _h in _hs:
        _HINT_INDEX[_h] = _HINT_INDEX.get(_h, ()) + (_lang,)


def detect_language(texts: Iterable[str] | str, *, default: str = "EN", max_texts: int = 5000) -> str:
    """Detect the dominant language across many short texts (cells, paragraphs)."""
    seen = 0
    if isinstance(texts, str):
        texts = [texts]
    scores: dict[str, float] = {k: 0.0 for k in LANGS}
    n_chars = 0
    for t in texts:
        if t is None:
            continue
        s = str(t)
        if not s or len(s) > 4000:
            s = s[:4000]
        low = s.lower()
        if not any(ch.isalpha() for ch in low):
            continue
        n_chars += len(low)
        cyr = len(_RE_CYR.findall(low))
        if cyr:
            scores["RU"] += cyr * 0.5
        for lang, sig in _CHAR_SIG.items():
            for ch, w in sig.items():
                c = low.count(ch)
                if c:
                    scores[lang] += c * w
        for w in _RE_WORD.findall(low):
            langs = _WORD_INDEX.get(w)
            if langs:
                for lang in langs:
                    scores[lang] += 2.0 / len(langs)
            hint = _HINT_INDEX.get(w)
            if hint:
                for lang in hint:
                    scores[lang] += 1.0
        seen += 1
        if seen >= max_texts:
            break
    if n_chars == 0:
        return default
    # A language whose diacritics are absent but share them with another: prefer the one with words.
    best = max(scores.items(), key=lambda kv: kv[1])
    if best[1] < 1.0:
        return default
    return best[0]


def fold(s: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))
