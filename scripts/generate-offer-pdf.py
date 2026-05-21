#!/usr/bin/env python3
"""Generate a branded PDF offer from an Excel template.

Usage:
  generate-offer-pdf.py <template.xlsx> <brand> <output.pdf>

Reads the LuckyBear-style Excel offer template, replaces every occurrence of
"LuckyBear" (or any other placeholder brand string in cell B2) with the
caller-supplied brand, then renders the table + included-services blocks as a
PDF matching the visual style of the Betongame reference PDF.
"""
import os
import sys
import re
import openpyxl
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib.colors import HexColor, white, black
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

if len(sys.argv) != 4:
    print(__doc__)
    sys.exit(1)

TEMPLATE = sys.argv[1]
BRAND = sys.argv[2].strip() or "Your Brand"
OUT = sys.argv[3]

FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
pdfmetrics.registerFont(TTFont("DejaVu", FONT_REG))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", FONT_BOLD))

# --- Read the Excel template ---
wb = openpyxl.load_workbook(TEMPLATE, data_only=False)
sh = wb.active

# Original brand placeholder = cell B2 (the value after PRICING OFFER header).
original_brand = str(sh.cell(2, 1).value or "").strip() or "LuckyBear"

def sub(value):
    if value is None:
        return ""
    s = str(value).strip()
    # Replace any occurrence of the original brand (case-insensitive,
    # but with case-preserving substitution to the new brand).
    return re.sub(re.escape(original_brand), BRAND, s, flags=re.IGNORECASE)

# Pull table rows (Project, Description, QTY, Price, TOTAL) from rows 5..N
# until we hit "TOTAL" in column D or an empty row.
rows = []
total_val = None
for r in range(5, sh.max_row + 1):
    project = sub(sh.cell(r, 1).value)
    desc = sub(sh.cell(r, 2).value)
    qty = sh.cell(r, 3).value
    price = sh.cell(r, 4).value
    total = sh.cell(r, 5).value
    # The TOTAL row has nothing in col A/B/C and "TOTAL" in col D.
    if (desc == "" and project == "" and str(qty or "").strip() == "" and
        str(price or "").strip().upper() == "TOTAL"):
        # Compute total by summing data rows' computed totals.
        total_val = 0
        for rrow in rows:
            try:
                p = float(str(rrow["price"]).replace(",", ".") or 0)
                q = float(str(rrow["qty"]).replace(",", ".") or 0)
                total_val += p * q
            except ValueError:
                pass
        break
    if not (project or desc or qty or price):
        continue
    rows.append({
        "project": project,
        "description": desc,
        "qty": qty if qty is not None else 1,
        "price": price if price is not None else 0,
    })

# Pull free-form notes (everything below the table, col B onwards).
notes = []
in_notes = False
for r in range(1, sh.max_row + 1):
    a = sub(sh.cell(r, 1).value)
    b = sub(sh.cell(r, 2).value)
    if a == "Offer is valid for 30 days after presentation":
        in_notes = True
        continue
    if in_notes and b:
        notes.append(b)

# --- Render PDF ---
W, H = A4
c = canvas.Canvas(OUT, pagesize=A4)

NAVY = HexColor("#0c1830")
ACCENT = HexColor("#1f8fff")
TABLE_HEADER = HexColor("#3a4565")
ROW_BG = HexColor("#ffffff")
ROW_ALT = HexColor("#f6f8fc")
MUTED = HexColor("#5a6478")

# Header bar with brand name + ConvertAgain mark
c.setFillColor(NAVY)
c.rect(0, H - 3.2*cm, W, 3.2*cm, fill=True, stroke=False)
c.setFillColor(ACCENT)
c.rect(0, H - 3.2*cm - 0.15*cm, W, 0.15*cm, fill=True, stroke=False)
c.setFillColor(white)
c.setFont("DejaVu", 10)
c.drawString(2*cm, H - 1.4*cm, "PRICING OFFER")
c.setFont("DejaVu-Bold", 22)
c.drawString(2*cm, H - 2.4*cm, BRAND)
# Right-aligned mark
c.setFont("DejaVu-Bold", 18)
c.drawRightString(W - 2*cm, H - 1.9*cm, "Convert Again")
c.setFont("DejaVu", 9)
c.drawRightString(W - 2*cm, H - 2.4*cm, "retention remarketing for iGaming")

# --- Pricing table ---
y = H - 4.5*cm
col_w = [3.5*cm, 7.0*cm, 1.5*cm, 2.5*cm, 2.5*cm]
col_x = [2*cm]
for w in col_w[:-1]:
    col_x.append(col_x[-1] + w)
headers = ["Project", "Description", "QTY", "Price", "TOTAL"]

# Header row
c.setFillColor(TABLE_HEADER)
c.rect(2*cm, y - 0.7*cm, sum(col_w), 0.7*cm, fill=True, stroke=False)
c.setFillColor(white)
c.setFont("DejaVu-Bold", 10)
for x, w, h in zip(col_x, col_w, headers):
    c.drawString(x + 0.15*cm, y - 0.5*cm, h)
y -= 0.7*cm

def fmt_money(v):
    try:
        n = float(str(v).replace(",", "."))
        # European style: "€ 3 000,00"
        s = f"{n:,.2f}".replace(",", " ").replace(".", ",")
        return f"€ {s}"
    except (ValueError, TypeError):
        return str(v or "")

c.setFont("DejaVu", 10)
for i, r in enumerate(rows):
    bg = ROW_ALT if i % 2 == 0 else ROW_BG
    c.setFillColor(bg)
    c.rect(2*cm, y - 0.6*cm, sum(col_w), 0.6*cm, fill=True, stroke=False)
    c.setFillColor(black)
    c.drawString(col_x[0] + 0.15*cm, y - 0.4*cm, r["project"][:30])
    c.drawString(col_x[1] + 0.15*cm, y - 0.4*cm, r["description"][:55])
    c.drawString(col_x[2] + 0.15*cm, y - 0.4*cm, str(r["qty"]))
    c.drawString(col_x[3] + 0.15*cm, y - 0.4*cm, fmt_money(r["price"]))
    try:
        line_total = float(str(r["price"]).replace(",", ".")) * float(str(r["qty"]).replace(",", "."))
    except ValueError:
        line_total = r["price"]
    c.drawString(col_x[4] + 0.15*cm, y - 0.4*cm, fmt_money(line_total))
    y -= 0.6*cm

# Total row
c.setFillColor(NAVY)
c.rect(2*cm, y - 0.7*cm, sum(col_w), 0.7*cm, fill=True, stroke=False)
c.setFillColor(white)
c.setFont("DejaVu-Bold", 11)
c.drawString(col_x[3] + 0.15*cm, y - 0.5*cm, "TOTAL")
c.drawString(col_x[4] + 0.15*cm, y - 0.5*cm, fmt_money(total_val if total_val is not None else 0))
y -= 1.2*cm

# Validity line
c.setFillColor(MUTED)
c.setFont("DejaVu", 10)
c.drawCentredString(W / 2, y, "Offer is valid for 30 days after presentation")
y -= 1.0*cm

# --- Notes (Included services etc.) ---
c.setFillColor(black)
c.setFont("DejaVu", 10)
max_w = W - 4*cm
line_h = 14
for note in notes:
    note = sub(note)
    if not note.strip():
        y -= 6
        continue
    # Bold for headers (lines ending with ":")
    if note.strip().endswith(":"):
        y -= 6
        c.setFont("DejaVu-Bold", 10)
    else:
        c.setFont("DejaVu", 10)
    # Word-wrap
    words = note.split()
    line = ""
    for w in words:
        test = (line + " " + w).strip()
        if c.stringWidth(test, c._fontname, c._fontsize) > max_w:
            c.drawString(2*cm, y, line)
            y -= line_h
            if y < 3*cm:
                c.showPage()
                y = H - 2*cm
                c.setFillColor(black)
            line = w
        else:
            line = test
    if line:
        c.drawString(2*cm, y, line)
        y -= line_h
    if y < 3*cm:
        c.showPage()
        y = H - 2*cm
        c.setFillColor(black)

# Footer
c.setFillColor(MUTED)
c.setFont("DejaVu", 8)
c.drawCentredString(W / 2, 1.2*cm, "ConvertAgain · retention remarketing for iGaming · @ConvertAgainSales · convertagain.io")

c.save()
print(f"OK {OUT} brand={BRAND} rows={len(rows)} total={total_val} size={os.path.getsize(OUT)}")
