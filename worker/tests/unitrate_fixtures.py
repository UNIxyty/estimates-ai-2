"""Synthetic unit-rate BOQ workbooks shaped like the EU data-centre BOQs (Summary / Site Attendance / Preliminaries /
pricing sheets with light-blue input cells). No client data: values are made up but follow the real patterns."""
from __future__ import annotations

from openpyxl import Workbook
from openpyxl.styles import PatternFill
from openpyxl.styles.colors import Color

BLUE = PatternFill("solid", fgColor=Color(theme=4, tint=0.6))
YELLOW = PatternFill("solid", fgColor="FFFFFF00")


def _summary(wb, project: str, lines: list[tuple[str, str, str, str | None]], not_participating: tuple[str, ...] = ()):
    ws = wb.active
    ws.title = "Summary"
    ws["C2"], ws["D2"] = "Project:", project
    ws["C3"], ws["D3"] = "Date:", "Tuesday 1st July 2025"
    ws["C4"], ws["D4"] = "Package: ", "Electrical Installation BOQ"
    ws["C7"] = "SUBCONTRACTOR TO FILL IN BELOW:"
    ws["C9"], ws["E9"] = "Name of Subcontractor", None
    ws["E9"].fill = YELLOW
    ws["C11"], ws["E11"] = "Date of offer", None
    ws["E11"].fill = YELLOW
    ws["C13"], ws["E13"] = "Offer valid to date", None
    ws["E13"].fill = YELLOW
    ws["C14"] = "Main contractor: Winthrop Engineering"
    ws["C25"], ws["D25"], ws["E25"], ws["F25"] = "Item", "Code", "Cost Summary", "Total Cost"
    r = 26
    for i, (code, label, sheet, cell) in enumerate(lines, 1):
        ws.cell(r, 3, i)
        ws.cell(r, 4, code)
        ws.cell(r, 5, label)
        ws.cell(r, 6, f"='{sheet}'!{cell}" if cell else None)
        if label in not_participating:
            ws.cell(r, 8, "Not participating ")
        r += 1
    ws.cell(r, 5, "Total")
    ws.cell(r, 6, f"=SUM(F26:F{r - 1})")


def _attendance(wb):
    ws = wb.create_sheet("Site Attendance")
    ws["B8"], ws["C8"], ws["D8"] = "Attendance item", "Main Contractor", "By Sub-Contractor"
    ws["B9"], ws["C9"] = "Welfare", "x"
    ws["B10"], ws["D10"] = "Waste removal", "x"


def _prelims(wb, name="Preliminaries", weeks=48):
    ws = wb.create_sheet(name)
    for c, h in zip("ABCDEFG", ["Ref", "Description", "Qty", "Unit", "Rate", "Total (€)", "Notes"]):
        ws[f"{c}7"] = h
    ws["B9"] = "Section 3 | Preliminaries for Pricing"
    rows = [("A", "Mobilisation", 1, "Item", 6500), ("B", "Demobilisation", 1, "Item", 6500),
            ("E", "Site Manager", weeks, "Wks", 2200), ("F", "Site Foreman", weeks, "Wks", 1900),
            ("K", "Quality Assurance", weeks, "Wks", 1800), ("L", "Storage", 1, "Item", 3500),
            ("M", "Offices", 1, "Item", None)]
    r = 19
    for ref, d, q, u, rate in rows:
        ws[f"A{r}"], ws[f"B{r}"], ws[f"C{r}"], ws[f"D{r}"], ws[f"E{r}"] = ref, d, q, u, rate
        ws[f"F{r}"] = f"=C{r}*E{r}"
        r += 1
    ws[f"E{r + 1}"] = "TOTAL - C/F TO SUMMARY"
    ws[f"F{r + 1}"] = f"=SUM(F19:F{r})"


def _pricing_header(ws, labels: dict[str, str], row: int = 8):
    ws["B2"] = "Pricing Document"
    ws["E6"] = "BILL OF QUANTITES "
    for c, h in labels.items():
        ws[f"{c}{row}"] = h
    ws[f"B{row + 1}"] = "Description"


def containment_A(wb, name="Containment Install"):
    """Layout A with Building A / B, header note, blue input cells, contractor items."""
    ws = wb.create_sheet(name)
    _pricing_header(ws, {"A": "Finish", "B": "All Areas ", "C": "Building A", "D": "Building B", "E": "Quantity",
                         "F": "UoM", "G": " Rate ", "H": "Total "})
    ws["B11"] = "Note: - DB/Equip Header is equal to 5 meters of the associated containment, 1No. Riser bend and bracketry"
    ws["B11"].fill = YELLOW
    rows = [("INTERNAL CABLE LADDER", None, None, None, None),
            ("300 x 100mm Cable Ladder", "PG", 440, "m", 25),
            ("300 x 100mm Cable Ladder - (a) Bend", "PG", 4, "no", 45),
            ("300 x 100mm Cable Ladder - (a) DB/Equip Header", "PG", 32, "no", 150),
            ("300 x 100mm Cable Ladder - (b) Tee", "PG", 28, "no", 40),
            ("500 x 100mm Cable Ladder", "PG", 730, "m", 45),
            ("900 x 110mm Cable Ladder", "PG", 230, "m", 60),
            ("EXTERNAL CABLE TRAY", None, None, None, None),
            ("EXT - 300 x 60mm Cable Tray - (b) Tee", "HDG", 12, "no", 40),
            ("EXT - 300mm Cable Tray - (b) Tee Cover Lid", "HDG", 8, "no", 10),
            ("300mm Tray/Ladder - Trapeze ", None, 4765, "no", 20)]
    r = 14
    for d, fin, q, u, rate in rows:
        ws[f"B{r}"] = d
        if q is not None:
            ws[f"A{r}"], ws[f"C{r}"], ws[f"D{r}"] = fin, q, f"=C{r}"
            ws[f"E{r}"], ws[f"F{r}"], ws[f"G{r}"], ws[f"H{r}"] = f"=SUM(C{r}:D{r})", u, rate, f"=E{r}*G{r}"
        ws[f"G{r}"].fill = BLUE
        ws[f"H{r}"].fill = BLUE
        r += 1
    ws[f"B{r + 1}"] = "Contractor Items "
    for i, (d, q, rate) in enumerate([("Accomondation ", 18, 20000), ("Transport ", 18, 6000), ("Tools", 1, 50000)]):
        rr = r + 2 + i
        ws[f"A{rr}"], ws[f"B{rr}"], ws[f"E{rr}"], ws[f"G{rr}"], ws[f"H{rr}"] = i + 1, d, q, rate, f"=E{rr}*G{rr}"
        ws[f"G{rr}"].fill = BLUE
    tr = r + 6
    ws[f"E{tr}"], ws[f"H{tr}"] = "TOTAL:", f"=SUM(H11:H{tr - 1})"
    return ws


def lighting_B(wb, name="Lighting Install"):
    """Layout B: install Rate + Unit price; free-issue fittings, Supply & Install cabling with live accessory ratios."""
    ws = wb.create_sheet(name)
    _pricing_header(ws, {"E": "Quantity", "F": "UoM", "G": " Rate ", "H": "Total ", "I": "Unit price", "J": "Total "})
    ws["B7"] = "Luminaires, Lighting Control devices and Lighting Track will be free issued by the client"
    ws["B7"].fill = YELLOW
    ws["B13"], ws["C13"], ws["D13"] = "All Areas ", "Building A", "Building B"
    ws["B14"] = "STANDARD FITTINGS (Free Issued for Install)"
    ws["B15"], ws["C15"], ws["D15"], ws["E15"], ws["F15"], ws["G15"] = "Type - A1 - ZUMTOBEL AMP L 8000-840", 96, "=C15", "=C15+D15", "Nr", 30
    ws["B16"], ws["C16"], ws["D16"], ws["E16"], ws["F16"], ws["G16"] = "Type - B1 - ZUMTOBEL PANOS EVO R150L", 27, "=C16", "=C16+D16", "Nr", 35
    ws["B18"] = "STANDARD CABLING (Supply & Install)"
    acc = [("Luminaire Bracket", "=SUM(C15:C16)", "Nr", 10, 7),
           ("3C 2.5MM  Cu Conductor, XLPE Insulation, LSOH", "=C19*12", "m", 5, 1.46),
           ("2C Control Cable", "=C20", "m", 5, 1.25),
           ("PG Glands", "=C23*4", "Nr", 1, 0.88),
           ("Junction Box", "=C19", "Nr", 15, 7),
           ("25MM CLASS4 GALV CONDUIT", "=C23*3", "m", 10, 10),
           ("25MM GALV PLAIN SADDLE", "=C24/1.2", "Nr", 0.5, 0.32)]
    for i, (d, q, u, rate, sup) in enumerate(acc):
        r = 19 + i
        ws[f"B{r}"], ws[f"C{r}"], ws[f"D{r}"], ws[f"E{r}"], ws[f"F{r}"] = d, q, q.replace("C", "D"), f"=C{r}+D{r}", u
        ws[f"G{r}"], ws[f"H{r}"], ws[f"I{r}"], ws[f"J{r}"] = rate, f"=E{r}*G{r}", sup, f"=I{r}*E{r}"
        for c in "GHIJ":
            ws[f"{c}{r}"].fill = BLUE
    ws["E30"], ws["H30"], ws["J30"] = "TOTAL:", "=SUM(H14:H29)", "=SUM(J14:J29)"
    return ws


def gs_C(wb, name="BOQ labor+mat supply"):
    """Layout C: per-phase (qty, €) pairs; one phase € column labelled "Labor"; contractor items; delivery 12 %."""
    ws = wb.create_sheet(name)
    _pricing_header(ws, {"K": "Quantity", "L": "UoM", "M": " Rate ", "N": "Total ", "O": " UNIT COST", "P": "Total "})
    ws["B13"], ws["C13"], ws["D13"], ws["E13"], ws["G13"] = "All Areas ", "Phase 1", "Labor", "Phase 2", "Phase 3"
    ws["B14"] = "ISOLATORS (Supply & Install)"
    items = [("16A 1PH ISOLATOR - 2CMA142268R1000", 10, 4, 2, "no", 18, 38.99),
             ("100A 3PH ISOLATOR - 1SCA022868R5730", 2, 1, 0, "no", 28, 590),
             ("5C 16MM Cu Conductor, XLPE Insulation, LSOH", 120, 40, 0, "m", 8, 11.67)]
    for i, (d, p1, p2, p3, u, rate, sup) in enumerate(items):
        r = 15 + i
        ws[f"B{r}"], ws[f"C{r}"], ws[f"E{r}"], ws[f"G{r}"] = d, p1, p2, p3
        ws[f"D{r}"], ws[f"F{r}"], ws[f"H{r}"] = f"=C{r}*M{r}", f"=E{r}*M{r}", f"=G{r}*M{r}"
        ws[f"K{r}"], ws[f"L{r}"], ws[f"M{r}"], ws[f"N{r}"] = f"=SUM(C{r}+E{r}+G{r})", u, rate, f"=K{r}*M{r}"
        ws[f"O{r}"], ws[f"P{r}"] = sup, f"=K{r}*O{r}"
        for c in "MNOP":
            ws[f"{c}{r}"].fill = BLUE
    ws["B19"] = "Contractor Items "
    ws["A20"], ws["B20"], ws["K20"], ws["L20"], ws["M20"], ws["N20"] = 1, "Accomondation PHASE1", 10, "Month", 12000, "=K20*M20"
    ws["A21"], ws["B21"], ws["K21"], ws["L21"], ws["M21"], ws["N21"] = 2, "Scissor lifts PHASE2", 6, "Month", 7200, "=K21*M21"
    ws["A22"], ws["B22"], ws["K22"], ws["L22"], ws["P22"] = 3, "Materials delivery costs PHASE1-4", 12, "%", 600
    ws["N24"], ws["P24"] = "=SUM(N15:N22)", "=SUM(P15:P22)"
    ws["K24"] = "TOTAL:"
    return ws


def goodman_like(path: str) -> None:
    wb = Workbook()
    _summary(wb, "Goodman AMS01", [("Prelims", "Preliminary Items Containment Installation", "Preliminaries", "F28"),
                                   ("E", "Containment Installation", "Containment Install", "H32"),
                                   ("E", "Cable Installation", "Cable Install", None),
                                   ("E", "Lighting Installation", "Lighting Install", "H30"),
                                   ("E", "Lighting Installation supply of the materials", "Lighting Install", "J30"),
                                   ("E", "General Services Installation", "BOQ labor+mat supply", "N24")],
             not_participating=("Cable Installation",))
    _attendance(wb)
    _prelims(wb)
    containment_A(wb)
    lighting_B(wb)
    gs_C(wb)
    wb.save(path)
