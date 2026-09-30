from app.matching.text import normalise_text, strip_brands
from app.matching.units import normalise_unit, units_compatible


def test_normalise_text_diacritics_and_numbers():
    assert normalise_text("Kabelis NYM-J 3×2,5 mm²") == "kabelis nym j 3x2.5 mm2"
    assert normalise_text("Kabelis NYM-J 3 x 2,5 mm 2") == "kabelis nym j 3x2.5 mm2"
    assert normalise_text("kabelis nym-j 3*2.5mm2") == "kabelis nym j 3x2.5mm2"
    assert normalise_text("Slēdzis ģērbtuvē, ķēde; ļoti ņemts") == "sledzis gerbtuve kede loti nemts"
    assert normalise_text("Rør Ø20, sæt åben") == "ror o20 saet aben"
    assert normalise_text("  Gaismeklis   LED  (36W) ") == "gaismeklis led 36w"
    assert normalise_text(None) == ""
    assert normalise_text("") == ""


def test_normalise_text_same_key_for_variants():
    variants = ["Kabelis NYM-J 3x1,5 mm²", "kabelis nym j 3 x 1.5 mm2", "KABELIS NYM-J 3×1,5MM²"]
    keys = {normalise_text(v).replace("mm2", " mm2").replace("  ", " ") for v in variants}
    assert len(keys) == 1


def test_strip_brands_keeps_types():
    a = strip_brands("Kabelis Draka NYM-J 3x1,5 mm²")
    b = strip_brands("Kabelis Reka NYM-J 3x1,5 mm²")
    c = strip_brands("Kabelis Prysmian NYM-J 3x1,5 mm²")
    assert a == b == c == "kabelis nym j 3x1.5 mm2"
    # cable types are not brands
    assert "nyy" in strip_brands("Kabelis Nexans NYY-J 5x10")
    assert "cyky" in strip_brands("Kabel CYKY 3x2,5 Keinutuote")
    s = strip_brands("Schneider Electric Unica kontaktligzda 2-vietīga")
    assert s == "kontaktligzda 2 vietiga"
    assert strip_brands("ABB automātslēdzis C16") == strip_brands("Hager automātslēdzis C16")
    assert strip_brands("Busch-Jaeger slēdzis") == "sledzis"


def test_normalise_unit_multilingual():
    cases = {
        "m": "m", "m.": "m", "tek.m": "m", "t.m.": "m", "lbm": "m", "løbende meter": "m", "lm": "m", "м": "m",
        "gab.": "pcs", "gab": "pcs", "stk": "pcs", "stk.": "pcs", "pcs": "pcs", "pc": "pcs", "ea": "pcs",
        "each": "pcs", "no.": "pcs", "nr": "pcs", "шт.": "pcs", "Stück": "pcs", "szt.": "pcs",
        "kompl.": "set", "kpl": "set", "set": "set", "sæt": "set", "sats": "set", "компл.": "set",
        "m2": "m2", "m²": "m2", "kv.m": "m2", "м2": "m2", "m3": "m3", "m³": "m3",
        "kg": "kg", "t": "t", "l": "l", "h": "h", "c/h": "h", "timer": "h", "km": "km",
        "obj.": "lot", "lot": "lot", "pauš.": "lot", "psch": "lot",
        "vieta": "point", "punkts": "point", "point": "point",
    }
    for raw, exp in cases.items():
        assert normalise_unit(raw) == exp, raw
    assert normalise_unit("st.", "LV") == "h"
    assert normalise_unit("st.", "SV") == "pcs"
    assert normalise_unit("kpl", "FI") == "pcs"
    assert normalise_unit("") is None
    assert normalise_unit(None) is None
    assert normalise_unit("banana") is None


def test_units_compatible():
    assert units_compatible("gab.", "stk")
    assert units_compatible("gab.", "kompl.")          # countables
    assert units_compatible("m", "tek.m")
    assert units_compatible("m", "lbm")
    assert not units_compatible("m", "gab.")
    assert not units_compatible("m", "m2")
    assert not units_compatible("m", "km")
    assert units_compatible(None, "m")                  # unknown never blocks
    assert units_compatible("m", "m")
