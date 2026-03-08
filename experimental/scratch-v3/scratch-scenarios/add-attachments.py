#!/usr/bin/env python3
"""Add file attachments (2 PDFs, 1 CSV) to posts and pages.

Creates the files programmatically and uploads via Airtable's content API.

Usage:
    export AIRTABLE_TOKEN=pat...
    python3 add-attachments.py
"""

import base64
import json
import os
import sys
import time
import urllib.request
import urllib.error

TOKEN = os.environ.get("AIRTABLE_TOKEN", "")
BASE_ID = "appHaYEakWjJfxunq"
API = "https://api.airtable.com/v0"
CONTENT_API = "https://content.airtable.com/v0"

ENV = {}
env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                v = v.split("#")[0].strip()
                if v:
                    ENV[k] = v

POSTS_TABLE = ENV["AIRTABLE_POSTS_TABLE_ID"]
PAGES_TABLE = ENV["AIRTABLE_PAGES_TABLE_ID"]

REQUEST_COUNT = 0
REQUEST_WINDOW_START = time.time()


def api(method, path, body=None, base_url=API):
    global REQUEST_COUNT, REQUEST_WINDOW_START
    REQUEST_COUNT += 1
    elapsed = time.time() - REQUEST_WINDOW_START
    if elapsed < 1.0 and REQUEST_COUNT >= 4:
        time.sleep(1.0 - elapsed)
        REQUEST_COUNT = 0
        REQUEST_WINDOW_START = time.time()
    elif elapsed >= 1.0:
        REQUEST_COUNT = 1
        REQUEST_WINDOW_START = time.time()

    url = f"{base_url}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        print(f"ERROR {e.code} {method} {url}: {error_body}", file=sys.stderr)
        sys.exit(1)


def add_field(table_id, field):
    print(f"  Adding field: {field['name']}")
    return api("POST", f"/meta/bases/{BASE_ID}/tables/{table_id}/fields", field)


def upload_attachment(record_id, field_id, filename, content_type, content_bytes):
    """Upload a file directly to an attachment field via the content API."""
    print(f"  Uploading: {filename} ({len(content_bytes)} bytes)")
    encoded = base64.standard_b64encode(content_bytes).decode("ascii")
    return api("POST",
        f"/{BASE_ID}/{record_id}/{field_id}/uploadAttachment",
        {"contentType": content_type, "filename": filename, "file": encoded},
        base_url=CONTENT_API,
    )


# ── File generators ──────────────────────────────────────────────────────

def make_pdf(title, sections):
    """Create a minimal valid PDF with text content.

    PDF is a text-based format at its core. We build one manually to avoid
    any library dependencies.
    """
    # Build the text content as PDF drawing commands
    lines = []
    y = 740
    lines.append(f"BT /F1 20 Tf 72 {y} Td ({_pdf_escape(title)}) Tj ET")
    y -= 40

    for heading, body_lines in sections:
        if y < 100:
            break
        lines.append(f"BT /F2 14 Tf 72 {y} Td ({_pdf_escape(heading)}) Tj ET")
        y -= 24
        for line in body_lines:
            if y < 72:
                break
            # Wrap long lines
            while len(line) > 80:
                lines.append(f"BT /F3 10 Tf 72 {y} Td ({_pdf_escape(line[:80])}) Tj ET")
                line = line[80:]
                y -= 14
            lines.append(f"BT /F3 10 Tf 72 {y} Td ({_pdf_escape(line)}) Tj ET")
            y -= 14
        y -= 10

    stream_content = "\n".join(lines)
    # PDF Type1 fonts only support latin-1; replace unicode chars
    stream_content = stream_content.replace("\u2014", "--").replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    stream_bytes = stream_content.encode("latin-1", errors="replace")

    objects = []

    # 1: Catalog
    objects.append(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
    # 2: Pages
    objects.append(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")
    # 3: Page
    objects.append(
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
        b" /Contents 4 0 R /Resources << /Font <<"
        b" /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> >>\nendobj\n"
    )
    # 4: Content stream
    objects.append(
        f"4 0 obj\n<< /Length {len(stream_bytes)} >>\nstream\n".encode("latin-1")
        + stream_bytes
        + b"\nendstream\nendobj\n"
    )
    # 5-7: Fonts
    objects.append(b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n")
    objects.append(b"6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n")
    objects.append(b"7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")

    # Build the PDF
    pdf = b"%PDF-1.4\n"
    offsets = []
    for obj in objects:
        offsets.append(len(pdf))
        pdf += obj

    # Cross-reference table
    xref_offset = len(pdf)
    pdf += f"xref\n0 {len(objects) + 1}\n".encode()
    pdf += b"0000000000 65535 f \n"
    for off in offsets:
        pdf += f"{off:010d} 00000 n \n".encode()

    pdf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n".encode()
    pdf += f"startxref\n{xref_offset}\n%%EOF\n".encode()

    return pdf


def _pdf_escape(text):
    """Escape special PDF string characters."""
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_csv(headers, rows):
    """Create a simple CSV file."""
    import csv
    import io
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue().encode("utf-8")


# ── Main ─────────────────────────────────────────────────────────────────

def main():
    if not TOKEN:
        print("Set AIRTABLE_TOKEN environment variable", file=sys.stderr)
        sys.exit(1)

    # ── 1. Find Attachments field IDs (already created) ─────────────────

    print("\n1. Finding Attachments field IDs...")

    tables = api("GET", f"/meta/bases/{BASE_ID}/tables")
    posts_att_field_id = None
    pages_att_field_id = None
    for table in tables.get("tables", []):
        if table["id"] == POSTS_TABLE:
            for field in table.get("fields", []):
                if field["name"] == "Attachments" and field["type"] == "multipleAttachments":
                    posts_att_field_id = field["id"]
        elif table["id"] == PAGES_TABLE:
            for field in table.get("fields", []):
                if field["name"] == "Attachments" and field["type"] == "multipleAttachments":
                    pages_att_field_id = field["id"]

    if not posts_att_field_id:
        print("  Creating Attachments field on Posts...")
        posts_att_field = add_field(POSTS_TABLE, {"name": "Attachments", "type": "multipleAttachments"})
        posts_att_field_id = posts_att_field["id"]
    else:
        print(f"  Posts Attachments field: {posts_att_field_id}")

    if not pages_att_field_id:
        print("  Creating Attachments field on Pages...")
        pages_att_field = add_field(PAGES_TABLE, {"name": "Attachments", "type": "multipleAttachments"})
        pages_att_field_id = pages_att_field["id"]
    else:
        print(f"  Pages Attachments field: {pages_att_field_id}")

    # ── 2. Create files ──────────────────────────────────────────────────

    print("\n2. Creating files...")

    # PDF 1: Travel packing checklist
    packing_pdf = make_pdf("Travel Packing Checklist", [
        ("Essentials", [
            "Passport and travel documents",
            "Phone, charger, and power adapter",
            "Medications and first-aid basics",
            "Cash and cards (notify your bank)",
            "Travel insurance documents",
        ]),
        ("Clothing", [
            "3-5 tops that mix and match",
            "2 pairs of pants/shorts",
            "1 light jacket or layer",
            "Comfortable walking shoes",
            "Flip-flops for hostels/beach",
        ]),
        ("Toiletries (keep it minimal)", [
            "Toothbrush and toothpaste",
            "Sunscreen SPF 30+",
            "Deodorant",
            "Any prescription items",
            "Tip: Buy shampoo/soap at your destination",
        ]),
        ("Tech", [
            "Laptop (if needed for work)",
            "Kindle or book",
            "Noise-canceling headphones",
            "Universal power adapter",
            "Portable battery pack",
        ]),
        ("Pro Tips", [
            "Roll clothes instead of folding — saves 30% space",
            "Wear your heaviest shoes on the plane",
            "Pack a spare outfit in your carry-on",
            "Take photos of important documents",
            "Leave room for souvenirs on the way back",
        ]),
    ])
    print(f"  packing-checklist.pdf: {len(packing_pdf)} bytes")

    # PDF 2: Content style guide
    style_pdf = make_pdf("Content Style Guide", [
        ("Voice and Tone", [
            "Write like you're explaining to a smart friend.",
            "Be direct. Cut filler words. Say what you mean.",
            "Use active voice: 'We built this' not 'This was built'.",
            "Humor is fine. Sarcasm is not.",
        ]),
        ("Formatting", [
            "Headlines: sentence case, not title case.",
            "Keep paragraphs under 4 sentences.",
            "Use subheadings every 2-3 paragraphs.",
            "Lists for 3+ items. Prose for fewer.",
            "Bold for emphasis. Never ALL CAPS.",
        ]),
        ("SEO Guidelines", [
            "Title tag: 50-60 characters.",
            "Meta description: 150-160 characters.",
            "One H1 per page. Multiple H2s are fine.",
            "Include the target keyword in the first paragraph.",
            "Internal links: 2-3 per article to related content.",
        ]),
        ("Images", [
            "Minimum 800px wide for featured images.",
            "Always include alt text — describe what's in the image.",
            "Compress before uploading (aim for under 200KB).",
            "Use real photos over stock when possible.",
        ]),
    ])
    print(f"  content-style-guide.pdf: {len(style_pdf)} bytes")

    # CSV: Product catalog export
    catalog_csv = make_csv(
        ["SKU", "Product Name", "Category", "Price", "Color", "Weight", "In Stock", "Rating"],
        [
            ["CDL-CDS-001", "Cedar & Sage Candle", "Candles", "$34.00", "Green", "12 oz", "Yes", "5"],
            ["CDL-LAV-001", "Lavender Fields Candle", "Candles", "$28.00", "Blue", "9 oz", "Yes", "4"],
            ["CDL-CIT-001", "Citrus Morning Candle", "Candles", "$32.00", "Green", "11 oz", "Yes", "4"],
            ["CDL-TBH-001", "Tobacco & Honey Candle", "Candles", "$38.00", "Black", "14 oz", "Yes", "5"],
            ["CDL-SEA-001", "Sea Salt & Driftwood Candle", "Candles", "$30.00", "Blue", "10 oz", "No", "4"],
            ["CDL-FIR-001", "Fireside Candle", "Candles", "$36.00", "Red", "12 oz", "No", "5"],
            ["CER-MUG-001", "Speckled Stoneware Mug", "Ceramics", "$24.00", "Blue", "14 oz", "Yes", "5"],
            ["CER-BWL-001", "Ramen Bowl Set", "Ceramics", "$48.00", "Black", "2.1 lbs", "Yes", "4"],
            ["CER-VAS-001", "Minimalist Vase", "Ceramics", "$42.00", "Red", "1.8 lbs", "Yes", "5"],
            ["CER-ESP-001", "Espresso Cup Pair", "Ceramics", "$32.00", "Green", "8 oz", "Yes", "4"],
            ["CER-PLT-001", "Serving Platter", "Ceramics", "$56.00", "Blue", "3.2 lbs", "Yes", "5"],
            ["TXT-THR-001", "Alpaca Throw Blanket", "Textiles", "$120.00", "Green", "2.4 lbs", "Yes", "5"],
            ["TXT-NAP-001", "Linen Napkin Set", "Textiles", "$36.00", "Blue", "12 oz", "Yes", "4"],
            ["TXT-PIL-001", "Hand-Block Print Pillow", "Textiles", "$54.00", "Blue", "1.6 lbs", "Yes", "5"],
            ["TXT-RUN-001", "Wool Table Runner", "Textiles", "$68.00", "Red", "1.1 lbs", "No", "5"],
            ["TXT-DSH-001", "Cotton Dish Towel Set", "Textiles", "$22.00", "Black", "14 oz", "Yes", "3"],
            ["STN-DOT-001", "Dot Grid Notebook", "Stationery", "$18.00", "Black", "9 oz", "Yes", "5"],
            ["STN-PEN-001", "Brass Pen", "Stationery", "$45.00", "Red", "2.1 oz", "Yes", "5"],
            ["STN-CRD-001", "Letterpress Card Set", "Stationery", "$16.00", "Green", "8 oz", "Yes", "4"],
            ["STN-DSK-001", "Desk Organizer", "Stationery", "$38.00", "Red", "1.2 lbs", "Yes", "4"],
            ["ACC-TOT-001", "Canvas Tote Bag", "Accessories", "$28.00", "Black", "1.1 lbs", "Yes", "4"],
            ["ACC-WAL-001", "Leather Card Wallet", "Accessories", "$42.00", "Red", "2 oz", "Yes", "5"],
            ["ACC-PCH-001", "Waxed Canvas Pouch", "Accessories", "$24.00", "Green", "6 oz", "Yes", "4"],
            ["WDG-RED-001", "Classic Widget", "Accessories", "$29.99", "Red", "2.4 oz", "Yes", "4"],
            ["GDG-BLK-001", "Pro Gadget", "Accessories", "$49.99", "Black", "5.1 oz", "Yes", "5"],
        ],
    )
    print(f"  product-catalog.csv: {len(catalog_csv)} bytes")

    # ── 3. Upload to records ─────────────────────────────────────────────

    print("\n3. Uploading attachments...")

    # PDF 1 → "Best Travel Tips" post
    upload_attachment(
        ENV["REC_POST_BEST_TRAVEL_TIPS"], posts_att_field_id,
        "packing-checklist.pdf", "application/pdf", packing_pdf,
    )

    # PDF 2 → "Privacy Policy" page
    upload_attachment(
        ENV["REC_PAGE_PRIVACY"], pages_att_field_id,
        "content-style-guide.pdf", "application/pdf", style_pdf,
    )

    # CSV → "Remote Work Gear" post
    upload_attachment(
        ENV["REC_POST_REMOTE_WORK_GEAR_2025"], posts_att_field_id,
        "product-catalog.csv", "text/csv", catalog_csv,
    )

    print("\nDone! Attachments added:")
    print("  Best Travel Tips      → packing-checklist.pdf")
    print("  Privacy Policy page   → content-style-guide.pdf")
    print("  Remote Work Gear post → product-catalog.csv")


if __name__ == "__main__":
    main()
