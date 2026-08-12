#!/usr/bin/env python3
import json
import os
from collections import Counter
from pathlib import Path

from PIL import Image
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "production/catalog/creatures.json"
OUTPUT_DIR = ROOT / "output/pdf"
TMP_DIR = ROOT / "tmp/pdfs/punchgrow-encyclopedia"
OUTPUT_PATH = OUTPUT_DIR / "PunchGrow_Creature_Encyclopedia_256.pdf"
FONT_PATH = Path("/System/Library/Fonts/Supplemental/AppleGothic.ttf")
PAGE_W, PAGE_H = landscape(A4)

BG = HexColor("#0A1020")
PANEL = HexColor("#111B31")
PANEL_ALT = HexColor("#172540")
TEXT = HexColor("#F4F7FF")
MUTED = HexColor("#9DAECC")
CYAN = HexColor("#53E6FF")
GOLD = HexColor("#F4CC54")
GRID = HexColor("#263858")

RARITY_COLORS = {
    "PROCESS": "#72D6C9",
    "AGENT": "#63B3FF",
    "DAEMON": "#AD83FF",
    "ORACLE": "#FF8FCB",
    "ARCHITECT": "#F4CC54",
    "ORIGIN": "#FF7A59",
}

CATEGORY_LABELS = {
    "start": "시작형",
    "normal_evolution": "일반 진화",
    "branch": "분기 진화",
    "mixed": "혼합 진화",
    "special": "특수 진화",
    "mutant": "변이형",
}


def register_fonts():
    pdfmetrics.registerFont(TTFont("PunchGrow", str(FONT_PATH)))
    pdfmetrics.registerFont(TTFont("PunchGrowBold", str(FONT_PATH)))


def fit_text(text, max_chars):
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def draw_wrapped(c, text, x, y, width, font="PunchGrow", size=8.3, color=MUTED, leading=11, max_lines=3):
    c.setFont(font, size)
    c.setFillColor(color)
    words = list(text)
    lines, current = [], ""
    for char in words:
        candidate = current + char
        if pdfmetrics.stringWidth(candidate, font, size) <= width:
            current = candidate
        else:
            lines.append(current)
            current = char
            if len(lines) == max_lines:
                break
    if current and len(lines) < max_lines:
        lines.append(current)
    if len(lines) == max_lines and "".join(lines) != text:
        lines[-1] = fit_text(lines[-1], max(2, len(lines[-1]) - 1))
    for index, line in enumerate(lines):
        c.drawString(x, y - index * leading, line)


def thumbnail(entry, size=560):
    source = ROOT / entry["imagePath"]
    target = TMP_DIR / f'{entry["id"]}-{size}.jpg'
    if target.exists() and target.stat().st_mtime >= source.stat().st_mtime:
        return target
    image = Image.open(source).convert("RGBA")
    image.thumbnail((size, size), Image.Resampling.LANCZOS)
    background = Image.new("RGB", (size, size), "#111B31")
    x = (size - image.width) // 2
    y = (size - image.height) // 2
    background.paste(image, (x, y), image)
    background.save(target, quality=88, optimize=True, progressive=True)
    return target


def page_background(c, page_number=None):
    c.setFillColor(BG)
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    c.setStrokeColor(GRID)
    c.setLineWidth(0.35)
    for x in range(0, int(PAGE_W), 28):
        c.line(x, 0, x, PAGE_H)
    for y in range(0, int(PAGE_H), 28):
        c.line(0, y, PAGE_W, y)
    if page_number is not None:
        c.setFillColor(MUTED)
        c.setFont("PunchGrow", 7.5)
        c.drawRightString(PAGE_W - 26, 17, f"PUNCHGROW CREATURE ARCHIVE  •  {page_number:02d}")


def draw_cover(c, catalog):
    page_background(c)
    c.setFillColor(CYAN)
    c.roundRect(36, PAGE_H - 60, 118, 18, 9, stroke=0, fill=1)
    c.setFillColor(BG)
    c.setFont("PunchGrowBold", 8)
    c.drawCentredString(95, PAGE_H - 54, "DIGITAL MYTH ARCHIVE")
    c.setFillColor(TEXT)
    c.setFont("PunchGrowBold", 34)
    c.drawString(38, PAGE_H - 112, "PUNCHGROW")
    c.setFillColor(CYAN)
    c.setFont("PunchGrowBold", 24)
    c.drawString(38, PAGE_H - 145, "크리처 도감집")
    c.setFillColor(MUTED)
    c.setFont("PunchGrow", 11)
    c.drawString(40, PAGE_H - 170, "256 CREATURES  ·  64 START LINEAGES  ·  DIGITAL MYTHOLOGY")

    representatives = ["PG-001", "PG-102", "PG-109", "PG-166", "PG-193", "PG-211"]
    by_id = {entry["id"]: entry for entry in catalog}
    image_size = 126
    start_x, start_y = 420, 52
    positions = [(0, 250), (132, 250), (264, 250), (0, 112), (132, 112), (264, 112)]
    for creature_id, (dx, dy) in zip(representatives, positions):
        entry = by_id[creature_id]
        c.setFillColor(PANEL)
        c.roundRect(start_x + dx, start_y + dy, image_size, image_size, 14, stroke=0, fill=1)
        c.drawImage(str(thumbnail(entry, 420)), start_x + dx + 5, start_y + dy + 5, image_size - 10, image_size - 10)
    c.setFillColor(GOLD)
    c.setFont("PunchGrowBold", 10)
    c.drawString(40, 50, "FIRST EDITION  ·  2026")
    c.showPage()


def draw_overview(c, catalog):
    page_background(c, 2)
    c.setFillColor(TEXT)
    c.setFont("PunchGrowBold", 25)
    c.drawString(36, PAGE_H - 52, "도감 구성")
    c.setFillColor(MUTED)
    c.setFont("PunchGrow", 10)
    c.drawString(38, PAGE_H - 72, "이 도감은 현재 기준 256종을 ID 순서로 수록합니다.")

    category_counts = Counter(entry["category"] for entry in catalog)
    rarity_counts = Counter(entry["rarity"] for entry in catalog)
    blocks = [
        ("총 크리처", "256", CYAN),
        ("시작 계열", "64", HexColor("#72D6C9")),
        ("일반 진화", str(category_counts["normal_evolution"]), HexColor("#63B3FF")),
        ("특수·변이", str(sum(category_counts[key] for key in ["branch", "mixed", "special", "mutant"])), HexColor("#AD83FF")),
    ]
    for index, (label, value, color) in enumerate(blocks):
        x = 38 + index * 194
        c.setFillColor(PANEL)
        c.roundRect(x, PAGE_H - 172, 176, 76, 12, stroke=0, fill=1)
        c.setFillColor(color)
        c.setFont("PunchGrowBold", 25)
        c.drawString(x + 16, PAGE_H - 137, value)
        c.setFillColor(MUTED)
        c.setFont("PunchGrow", 9)
        c.drawString(x + 16, PAGE_H - 157, label)

    c.setFillColor(TEXT)
    c.setFont("PunchGrowBold", 14)
    c.drawString(38, PAGE_H - 216, "등급 분포")
    y = PAGE_H - 250
    total_width = 760
    total = sum(rarity_counts.values())
    cursor = 38
    for rarity in ["PROCESS", "AGENT", "DAEMON", "ORACLE", "ARCHITECT", "ORIGIN"]:
        count = rarity_counts[rarity]
        width = total_width * count / total
        c.setFillColor(HexColor(RARITY_COLORS[rarity]))
        c.rect(cursor, y, width, 22, stroke=0, fill=1)
        cursor += width
    legend_y = y - 26
    for index, rarity in enumerate(["PROCESS", "AGENT", "DAEMON", "ORACLE", "ARCHITECT", "ORIGIN"]):
        x = 38 + (index % 3) * 250
        yy = legend_y - (index // 3) * 24
        c.setFillColor(HexColor(RARITY_COLORS[rarity]))
        c.circle(x + 5, yy + 4, 4, stroke=0, fill=1)
        c.setFillColor(TEXT)
        c.setFont("PunchGrowBold", 8.5)
        c.drawString(x + 16, yy, rarity)
        c.setFillColor(MUTED)
        c.setFont("PunchGrow", 8)
        c.drawString(x + 88, yy, f"{rarity_counts[rarity]}종")

    c.setFillColor(PANEL_ALT)
    c.roundRect(38, 70, 760, 135, 14, stroke=0, fill=1)
    c.setFillColor(CYAN)
    c.setFont("PunchGrowBold", 12)
    c.drawString(56, 178, "카드 읽는 법")
    guide = [
        "ID · 이름 · 영문명: 도감의 고유 식별 정보",
        "등급 · 단계 · 유형: 성장 위치와 획득 분류",
        "계열 · 형태: 진화 관계와 실루엣 분류",
        "정체성 · 서사: 크리처의 역할과 세계관 이야기",
        "형태 DNA · 팔레트: 제작과 후속 진화에서 유지할 핵심 규칙",
    ]
    for index, line in enumerate(guide):
        c.setFillColor(CYAN if index == 0 else MUTED)
        c.setFont("PunchGrow" if index else "PunchGrowBold", 9.2)
        c.drawString(58, 153 - index * 19, f"{index + 1:02d}  {line}")
    c.showPage()


def draw_color_swatch(c, x, y, color, label):
    c.setFillColor(HexColor(color))
    c.roundRect(x, y, 20, 10, 3, stroke=0, fill=1)
    c.setFillColor(MUTED)
    c.setFont("PunchGrow", 5.8)
    c.drawString(x + 23, y + 1.5, label)


def draw_card(c, entry, x, y, width, height):
    rarity_color = HexColor(RARITY_COLORS.get(entry["rarity"], "#63B3FF"))
    c.setFillColor(PANEL)
    c.setStrokeColor(Color(rarity_color.red, rarity_color.green, rarity_color.blue, alpha=0.7))
    c.setLineWidth(1.2)
    c.roundRect(x, y, width, height, 13, stroke=1, fill=1)

    image_box = height - 24
    c.setFillColor(PANEL_ALT)
    c.roundRect(x + 10, y + 12, image_box, image_box, 10, stroke=0, fill=1)
    c.drawImage(str(thumbnail(entry)), x + 14, y + 16, image_box - 8, image_box - 8)

    text_x = x + image_box + 24
    text_width = width - image_box - 36
    c.setFillColor(rarity_color)
    c.setFont("PunchGrowBold", 8)
    c.drawString(text_x, y + height - 24, f'{entry["id"]}  ·  {entry["rarity"]}')
    c.setFillColor(TEXT)
    name_size = 16
    english_width = pdfmetrics.stringWidth(entry["enName"], "PunchGrow", 8)
    while name_size > 11 and pdfmetrics.stringWidth(entry["koName"], "PunchGrowBold", name_size) + english_width + 12 > text_width:
        name_size -= 1
    c.setFont("PunchGrowBold", name_size)
    c.drawString(text_x, y + height - 47, entry["koName"])
    c.setFillColor(MUTED)
    c.setFont("PunchGrow", 8)
    c.drawRightString(x + width - 14, y + height - 44, entry["enName"])

    meta = f'{CATEGORY_LABELS.get(entry["category"], entry["category"])}  ·  {entry["stage"]}단계  ·  {entry["bodyForm"]}'
    c.setFillColor(rarity_color)
    c.setFont("PunchGrow", 7.5)
    c.drawString(text_x, y + height - 62, fit_text(meta, 38))

    draw_wrapped(c, entry["identity"], text_x, y + height - 81, text_width, size=8.2, color=TEXT, leading=11, max_lines=2)
    draw_wrapped(c, entry["lore"], text_x, y + height - 110, text_width, size=7.1, color=MUTED, leading=9.5, max_lines=3)

    c.setFillColor(CYAN)
    c.setFont("PunchGrowBold", 6.8)
    c.drawString(text_x, y + 53, "SHAPE DNA")
    c.setFillColor(MUTED)
    c.setFont("PunchGrow", 6.6)
    for index, dna in enumerate(entry["shapeDNA"][:3]):
        c.drawString(text_x, y + 41 - index * 9, f"• {fit_text(dna, 27)}")

    swatch_y = y + 12
    draw_color_swatch(c, text_x, swatch_y, entry["palette"]["primary"], "P")
    draw_color_swatch(c, text_x + 38, swatch_y, entry["palette"]["secondary"], "S")
    draw_color_swatch(c, text_x + 76, swatch_y, entry["palette"]["glow"], "G")


def draw_catalog(c, catalog):
    margin_x = 28
    top = PAGE_H - 42
    gap_x = 14
    gap_y = 13
    card_w = (PAGE_W - margin_x * 2 - gap_x) / 2
    card_h = (PAGE_H - 72 - gap_y) / 2
    for page_index, start in enumerate(range(0, len(catalog), 4), start=3):
        page_background(c, page_index)
        subset = catalog[start : start + 4]
        c.setFillColor(TEXT)
        c.setFont("PunchGrowBold", 12)
        c.drawString(margin_x, PAGE_H - 26, f"CREATURE ARCHIVE  ·  {subset[0]['id']} - {subset[-1]['id']}")
        for index, entry in enumerate(subset):
            col = index % 2
            row = index // 2
            x = margin_x + col * (card_w + gap_x)
            y = top - (row + 1) * card_h - row * gap_y
            draw_card(c, entry, x, y, card_w, card_h)
        c.showPage()


def draw_back_cover(c):
    page_background(c)
    c.setFillColor(CYAN)
    c.circle(PAGE_W / 2, PAGE_H / 2 + 34, 46, stroke=0, fill=1)
    c.setFillColor(BG)
    c.setFont("PunchGrowBold", 25)
    c.drawCentredString(PAGE_W / 2, PAGE_H / 2 + 24, "PG")
    c.setFillColor(TEXT)
    c.setFont("PunchGrowBold", 18)
    c.drawCentredString(PAGE_W / 2, PAGE_H / 2 - 45, "코딩할수록, 세계가 자란다")
    c.setFillColor(MUTED)
    c.setFont("PunchGrow", 9)
    c.drawCentredString(PAGE_W / 2, PAGE_H / 2 - 68, "PUNCHGROW DIGITAL MYTH CREATURE ARCHIVE · 256")
    c.showPage()


def main():
    register_fonts()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    with CATALOG_PATH.open(encoding="utf-8") as stream:
        catalog = json.load(stream)
    if len(catalog) != 256:
        raise ValueError(f"Expected 256 creatures, found {len(catalog)}")
    pdf = canvas.Canvas(str(OUTPUT_PATH), pagesize=landscape(A4), pageCompression=1)
    pdf.setTitle("PunchGrow 크리처 도감집 - 256")
    pdf.setAuthor("PunchGrow")
    pdf.setSubject("PunchGrow Digital Myth Creature Archive")
    draw_cover(pdf, catalog)
    draw_overview(pdf, catalog)
    draw_catalog(pdf, catalog)
    draw_back_cover(pdf)
    pdf.save()
    print(json.dumps({"output": str(OUTPUT_PATH), "creatures": len(catalog), "pages": 63}, ensure_ascii=False))


if __name__ == "__main__":
    main()
