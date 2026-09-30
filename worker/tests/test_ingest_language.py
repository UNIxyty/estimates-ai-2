import pytest

from app.ingest.language import detect_language


@pytest.mark.parametrize("texts,lang", [
    (["Nr.", "Darba nosaukums", "Mērv.", "Daudz.", "Kabelis NYM 3x1,5", "Kontaktligzda", "Kopā"], "LV"),
    (["Tekst", "Antal", "Enhed", "Timer", "Materialer", "I alt", "Kilde", "Stikkontakt, dobbelt"], "DA"),
    (["Beskrivelse", "Antall", "Enhet", "Timer", "Materiell", "Sum", "Stikkontakt"], "NO"),
    (["Benämning", "Antal", "Enhet", "Timmar", "Material", "Summa", "Uttag"], "SV"),
    (["Item", "Qty", "Unit", "Rate", "Total", "Cable 3x1.5", "Socket outlet"], "EN"),
    (["Pavadinimas", "Kiekis", "vnt", "Kaina", "Iš viso", "Kabelis", "Lizdas"], "LT"),
    (["Nimetus", "Kogus", "Ühik", "Hind", "Kokku", "Kaabel", "Pistikupesa"], "ET"),
    (["Bezeichnung", "Menge", "Einheit", "Einzelpreis", "Gesamtpreis", "Steckdose"], "DE"),
    (["Наименование", "Кол-во", "Ед. изм.", "Цена", "Сумма", "Кабель"], "RU"),
    (["Nazwa", "Ilość", "Jednostka", "Cena", "Wartość", "Gniazdo"], "PL"),
    (["Nimike", "Määrä", "Yksikkö", "Hinta", "Yhteensä", "Kaapeli"], "FI"),
])
def test_detect(texts, lang):
    assert detect_language(texts) == lang


def test_short_cells_aggregate():
    # each cell alone is weak; together clearly Latvian
    cells = ["m", "gab.", "Kabelis", "kompl.", "Slēdzis", "Gaismeklis", "Sadales skapis"] * 3
    assert detect_language(cells) == "LV"


def test_empty_defaults_to_en():
    assert detect_language([]) == "EN"
    assert detect_language(["123", "45,6", None]) == "EN"
    assert detect_language("Kopā ar PVN") == "LV"
