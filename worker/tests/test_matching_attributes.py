import pytest

from app.matching.attributes import attributes_compatible, detect_category, parse_attributes as pa


@pytest.mark.parametrize("text,cores,cs", [
    ("Kabelis NYM-J 3x1.5", 3, 1.5),
    ("Kabelis NYM-J 3×2,5 mm²", 3, 2.5),
    ("Cable 5G2.5", 5, 2.5),
    ("NYM-J 3x1,5", 3, 1.5),
    ("(A)XMK 4x16", 4, 16),
    ("NOIKLX 3G1,5", 3, 1.5),
    ("Kabelis 3 x 1,5 mm 2", 3, 1.5),
    ("Kabel CYKY-J 4x10", 4, 10),
])
def test_cores_cross_section(text, cores, cs):
    a = pa(text)
    assert a["cores"] == cores and a["cross_section_mm2"] == cs
    assert a["category"] == "cable"


def test_ip_modules_gangs_poles_amps_diameter():
    assert pa("Gaismeklis LED IP44")["ip"] == 44
    assert pa("Sadales kārba IP 65")["ip"] == 65
    for t in ("Sadales skapis 36 moduļi", "distribution board 36 mod", "Tavle 36-modul", "Hager 36M"):
        a = pa(t)
        assert a["modules"] == 36, t
        assert a["category"] == "distribution_board", t
    for t, g in (("Kontaktligzda 2-vietīga", 2), ("Divvietīga kontaktligzda", 2), ("2-gang socket", 2),
                 ("Stikkontakt dobbelt", 2), ("2-fold socket outlet", 2), ("Vienvietīga kontaktligzda", 1)):
        assert pa(t)["gangs"] == g, t
    assert pa("Automātslēdzis 1P C16")["poles"] == 1
    assert pa("Leitungsschutzschalter B10 3-polig")["poles"] == 3
    assert pa("Breaker 3P 25A")["poles"] == 3
    a = pa("Automātslēdzis C16")
    assert a["amps"] == 16 and a["curve"] == "C" and a["category"] == "breaker"
    assert pa("MCB B10")["amps"] == 10
    assert pa("RCD 40A 30mA 4P")["amps"] == 40
    assert pa("RCD 40A 30mA 4P")["sensitivity_ma"] == 30
    assert pa("Gofrētā caurule d20")["diameter_mm"] == 20
    assert pa("Aizsargcaurule Ø25")["diameter_mm"] == 25
    assert pa("20mm caurule")["diameter_mm"] == 20
    # a conduit's "d20" is a diameter, not a D-curve 20 A breaker
    assert "amps" not in pa("Gofrētā caurule d20")


@pytest.mark.parametrize("text,cat", [
    ("Kabelis NYM 3x1.5", "cable"), ("Kabeļu trase 300x60", "cable_tray"), ("Kabelbakke 100 mm", "cable_tray"),
    ("Gofrētā caurule d20", "conduit"), ("Kontaktligzda zemapmetuma", "socket"), ("Stikkontakt", "socket"),
    ("Slēdzis 1-polīgs", "switch"), ("Afbryder", "switch"), ("Gaismeklis LED", "luminaire"),
    ("LED downlight", "luminaire"), ("Sadales skapis", "distribution_board"), ("Gruppetavle", "distribution_board"),
    ("Automātslēdzis C16", "breaker"), ("RCBO 16A 30mA", "rcd"), ("Noplūdes strāvas slēdzis", "rcd"),
    ("Sadales kārba", "junction_box"), ("Junction box IP55", "junction_box"), ("Zemējuma elektrods", "earthing"),
    ("Datu rozete RJ45", "data_outlet"), ("Dūmu detektors", "fire_alarm"), ("Røgalarm", "fire_alarm"),
    ("Demontāžas darbi", "labour_only"), ("Commissioning and testing", "labour_only"),
    ("Kabelis caurulē", "cable"),
])
def test_category(text, cat):
    assert detect_category(text) == cat
    assert pa(text)["category"] == cat


def test_unknown_is_other():
    assert pa("Something unrelated")["category"] == "other"
    assert pa("") == {"category": "other"}
    assert pa(None) == {"category": "other"}


def test_hard_filter():
    a = pa("Kabelis NYM-J 3x1,5 mm²")
    b = pa("Kabelis NYM-J 5x2,5 mm²")
    assert not attributes_compatible(a, b)           # 3x1.5 never matches 5x2.5
    assert not attributes_compatible(a, pa("Kabelis NYM-J 3x2,5"))
    assert not attributes_compatible(a, pa("Kabelis NYM-J 5x1,5"))
    # brand never matters
    assert attributes_compatible(pa("Kabelis Draka NYM-J 3x1,5"), pa("Kabelis Reka NYM-J 3×1,5 mm²"))
    assert attributes_compatible(pa("Schneider kontaktligzda 2-vietīga IP44"), pa("ABB kontaktligzda divvietīga IP44"))
    # category must match when both known
    assert not attributes_compatible(pa("Kontaktligzda 2-vietīga"), pa("Slēdzis 2-vietīgs"))
    # other/unknown category doesn't block; missing attributes don't block
    assert attributes_compatible(pa("Kontaktligzda"), pa("Kontaktligzda 2-vietīga IP44"))
    assert attributes_compatible({"category": "other"}, pa("Slēdzis"))
    assert not attributes_compatible(pa("IP44 gaismeklis"), pa("IP65 gaismeklis"))
    assert not attributes_compatible(pa("Sadales skapis 36 moduļi"), pa("Sadales skapis 24 moduļi"))
    assert not attributes_compatible(pa("Automātslēdzis C16 1P"), pa("Automātslēdzis C16 3P"))
    assert not attributes_compatible(pa("Automātslēdzis C16"), pa("Automātslēdzis C20"))
    assert not attributes_compatible(pa("Gofrētā caurule d20"), pa("Gofrētā caurule d32"))
    assert attributes_compatible(None, None)
