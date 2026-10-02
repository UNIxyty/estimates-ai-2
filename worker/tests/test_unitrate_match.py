"""Unit-rate matcher: preference order, rate-card items that must not be merged, luminaire type codes."""
from __future__ import annotations

from app.unitrate.attributes import unit_rate_attributes
from app.unitrate.boq import BoqRow
from app.unitrate.match import RefMeta, RefRow, UnitRateKB, Want
from app.unitrate.ratecard import card_label
from app.matching.text import normalise_text


def _label(text: str, section: str | None = None) -> str:
    return card_label(BoqRow(sheet="s", row=1, kind="item", description=text,
                             attrs=unit_rate_attributes(text, section=section)))


def _ref(meta: RefMeta, text: str, install: float | None, supply: float | None = None, *, uom: str = "no",
         section: str = "CABLING", row: int = 1) -> RefRow:
    a = unit_rate_attributes(text, section=section)
    return RefRow(meta=meta, sheet="Lighting", row=row, description=text, attrs=a, uom=uom, install_rate=install,
                  supply_rate=supply, rate_basis="install_only", package=meta.package, section=section, notes=[],
                  flags=[], rate_key=card_label(BoqRow(sheet="", row=0, kind="item", description=text, attrs=a)),
                  norm=normalise_text(text))


OLD = RefMeta("old", "old.xlsx", market="DE", client="Winthrop", end_client="NTT", package="lighting",
              doc_date="2024-11-05")
NEW = RefMeta("new", "new.xlsx", market="DE", client="Winthrop", end_client="NTT", package="lighting",
              doc_date="2025-06-20")
GOOD = RefMeta("gm", "goodman.xlsx", market="NL", client="Winthrop", end_client="Goodman", package="electrical",
               doc_date="2025-09-01")


def test_most_recent_reference_wins_when_everything_else_ties():
    # a "-" prefix on an ISO date string does not reverse its order: the older file used to win
    kb = UnitRateKB([_ref(OLD, "Luminaire Bracket", 5), _ref(NEW, "Luminaire Bracket", 10)],
                    Want(market="DE", client="Winthrop", package="lighting"))
    q = kb.quote("Luminaire Bracket", uom="no", section="CABLING")
    assert q.rate == 10 and q.source.meta.file_id == "new"
    assert sorted(a["rate"] for a in q.alternatives) == [5, 10]


def test_rate_card_items_that_must_not_be_merged():
    assert _label("Luminaire Bracket") == "Luminaire bracket"          # not "Luminaire / fitting"
    assert _label("Type - Exit sign - wall mounted") == "Exit sign"
    assert _label("25MM GALV PLAIN SADDLE (25mm Galvanised Spacer Bar Saddle)") == "Saddle"
    assert _label("25MM GALV LONG BUSH") == "Bush"
    assert _label("Fused Conection Unit c/w Neon") == "Fused connection unit"   # misspelt, not "Inline fuse"
    assert _label("Cat 6 Outlet") == "Data outlet"
    assert _label("Flush mounted double socket, 1P+N+PE") == "Socket double"
    assert _label("Wall mounted single socket, 1P+N+PE") == "Socket single"
    assert _label("400V CEE socket, 3P+N+PE") == "Socket CEE 3PH"
    assert _label("Receptacle combination / Wall box unit 400V IP67") == "Socket combination unit"


def test_similar_text_needs_the_same_component():
    # "DB/Equip Header Cover Lid" used to borrow the €150 header rate through token overlap
    kb = UnitRateKB([_ref(GOOD, "300 x 100mm Cable Ladder - DB/Equip Header", 150, uom="no", section="LADDER")],
                    Want(market="NL"))
    q = kb.quote("300 x 100mm Cable Ladder - DB/Equip Header Cover Lid", uom="no", section="LADDER")
    assert q.rate != 150


def test_luminaire_type_codes_only_carry_over_within_the_same_end_client():
    refs = [_ref(GOOD, "Type - S1 - BEGA 24816 K3", 28, section="SITE FITTINGS"),
            _ref(OLD, "Type - S1 - BEGA 24816 K3", 70, section="SITE FITTINGS", row=2)]
    q = UnitRateKB(refs, Want(market="DE", end_client="NTT")).quote("Type - S1 - BEGA 24816 K3", uom="no",
                                                                     section="SITE FITTINGS")
    assert q.rate == 70 and "NTT" in (q.note or "")
    # an unknown end client: no type-code match, a typical luminaire rate with CHECK
    q2 = UnitRateKB(refs, Want(market="NL", end_client="Equinix")).quote("Type - S1 - BEGA 24816 K3", uom="no",
                                                                         section="SITE FITTINGS")
    assert q2.check and q2.method == "item"


def test_luminaire_bracket_is_matched_as_a_bracket_not_a_fitting():
    refs = [_ref(OLD, "Type - E1 - emergency bulkhead", 28), _ref(NEW, "Luminaire Bracket", 10, row=2)]
    q = UnitRateKB(refs, Want(market="DE")).quote("Luminaire Bracket", uom="no", section="CABLING")
    assert q.rate == 10 and q.method == "item"
