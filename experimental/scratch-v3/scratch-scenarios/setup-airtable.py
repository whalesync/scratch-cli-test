#!/usr/bin/env python3
"""One-time setup: create tables and seed records in the Scratch Demo Airtable base.

Usage:
    export AIRTABLE_TOKEN=pat...
    python3 setup-airtable.py

Outputs a .env file with all base/table/record IDs for use by test scripts.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

TOKEN = os.environ.get("AIRTABLE_TOKEN", "")
BASE_ID = "appHaYEakWjJfxunq"
API = "https://api.airtable.com/v0"

# Rate limit: 5 req/s for Airtable API
REQUEST_COUNT = 0
REQUEST_WINDOW_START = time.time()


def api(method, path, body=None):
    """Make an Airtable API request with rate limiting."""
    global REQUEST_COUNT, REQUEST_WINDOW_START

    # Simple rate limiter: max 4 req/s to stay safe
    REQUEST_COUNT += 1
    elapsed = time.time() - REQUEST_WINDOW_START
    if elapsed < 1.0 and REQUEST_COUNT >= 4:
        time.sleep(1.0 - elapsed)
        REQUEST_COUNT = 0
        REQUEST_WINDOW_START = time.time()
    elif elapsed >= 1.0:
        REQUEST_COUNT = 1
        REQUEST_WINDOW_START = time.time()

    url = f"{API}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        print(f"ERROR {e.code} {method} {path}: {error_body}", file=sys.stderr)
        sys.exit(1)


def create_table(name, fields):
    """Create a table in the base. Returns {id, fields: [{id, name, type}]}."""
    print(f"  Creating table: {name}")
    result = api("POST", f"/meta/bases/{BASE_ID}/tables", {
        "name": name,
        "fields": fields,
    })
    return result


def add_field(table_id, field):
    """Add a field to an existing table. Returns {id, name, type}."""
    print(f"  Adding field: {field['name']} to {table_id}")
    return api("POST", f"/meta/bases/{BASE_ID}/tables/{table_id}/fields", field)


def create_records(table_id, records):
    """Create records in a table (max 10 per call). Returns created records with IDs."""
    all_created = []
    for i in range(0, len(records), 10):
        chunk = records[i:i + 10]
        result = api("POST", f"/{BASE_ID}/{table_id}", {
            "records": [{"fields": r} for r in chunk],
        })
        all_created.extend(result.get("records", []))
    return all_created


# ── Public-domain image URLs (stable, from picsum.photos) ─────────────────

IMAGES = {
    "travel": "https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=800",
    "food": "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800",
    "tech": "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800",
    "alice": "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400",
    "bob": "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400",
    "widget1": "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800",
    "widget2": "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800",
    "gadget": "https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=800",
}


def attachment(url, filename):
    return [{"url": url, "filename": filename}]


def main():
    if not TOKEN:
        print("Set AIRTABLE_TOKEN environment variable", file=sys.stderr)
        sys.exit(1)

    env = {"AIRTABLE_BASE_ID": BASE_ID}

    # ── 1. Create tables (no FK fields yet) ──────────────────────────────

    print("\n1. Creating tables...")

    tags_table = create_table("Tags", [
        {"name": "Name", "type": "singleLineText"},
        {"name": "Slug", "type": "singleLineText"},
    ])
    env["AIRTABLE_TAGS_TABLE_ID"] = tags_table["id"]

    authors_table = create_table("Authors", [
        {"name": "Name", "type": "singleLineText"},
        {"name": "Bio", "type": "multilineText"},
        {"name": "Avatar", "type": "multipleAttachments"},
    ])
    env["AIRTABLE_AUTHORS_TABLE_ID"] = authors_table["id"]

    posts_table = create_table("Posts", [
        {"name": "Title", "type": "singleLineText"},
        {"name": "Body", "type": "multilineText"},
        {"name": "Featured Image", "type": "multipleAttachments"},
        {"name": "Slug", "type": "singleLineText"},
    ])
    env["AIRTABLE_POSTS_TABLE_ID"] = posts_table["id"]

    pages_table = create_table("Pages", [
        {"name": "Title", "type": "singleLineText"},
        {"name": "Slug", "type": "singleLineText"},
        {"name": "Content", "type": "multilineText"},
    ])
    env["AIRTABLE_PAGES_TABLE_ID"] = pages_table["id"]

    products_table = create_table("Products", [
        {"name": "Name", "type": "singleLineText"},
        {"name": "Price", "type": "currency", "options": {"precision": 2, "symbol": "$"}},
        {"name": "Description", "type": "multilineText"},
        {"name": "Images", "type": "multipleAttachments"},
        {"name": "Color", "type": "singleSelect", "options": {
            "choices": [{"name": "Red"}, {"name": "Blue"}, {"name": "Green"}, {"name": "Black"}]
        }},
        {"name": "Weight", "type": "singleLineText"},
        {"name": "In Stock", "type": "checkbox", "options": {"icon": "check", "color": "greenBright"}},
        {"name": "Rating", "type": "rating", "options": {"icon": "star", "max": 5, "color": "yellowBright"}},
    ])
    env["AIRTABLE_PRODUCTS_TABLE_ID"] = products_table["id"]

    # ── 2. Add FK fields ─────────────────────────────────────────────────

    print("\n2. Adding foreign key fields...")

    # Posts → Tags (many-to-many)
    add_field(posts_table["id"], {
        "name": "Tags",
        "type": "multipleRecordLinks",
        "options": {"linkedTableId": tags_table["id"]},
    })

    # Posts → Authors (many-to-one, but Airtable uses multipleRecordLinks)
    add_field(posts_table["id"], {
        "name": "Author",
        "type": "multipleRecordLinks",
        "options": {"linkedTableId": authors_table["id"]},
    })

    # Pages → Pages (self-referencing for parent/child)
    add_field(pages_table["id"], {
        "name": "Parent",
        "type": "multipleRecordLinks",
        "options": {"linkedTableId": pages_table["id"]},
    })

    # ── 3. Create records in parent tables ────────────────────────────────

    print("\n3. Creating tag records...")

    tag_records = create_records(tags_table["id"], [
        {"Name": "Travel", "Slug": "travel"},
        {"Name": "Food", "Slug": "food"},
        {"Name": "Music", "Slug": "music"},
        {"Name": "Tech", "Slug": "tech"},
    ])

    tag_ids = {}
    for r in tag_records:
        name = r["fields"]["Name"]
        tag_ids[name] = r["id"]
        env[f"REC_TAG_{name.upper()}"] = r["id"]

    print(f"  Tags: {tag_ids}")

    print("\n4. Creating author records...")

    author_records = create_records(authors_table["id"], [
        {
            "Name": "Alice Chen",
            "Bio": "Travel and food writer based in Portland. Has visited 40 countries and counting.",
            "Avatar": attachment(IMAGES["alice"], "alice.jpg"),
        },
        {
            "Name": "Bob Smith",
            "Bio": "Music and tech journalist. Former radio host turned digital nomad.",
            "Avatar": attachment(IMAGES["bob"], "bob.jpg"),
        },
    ])

    author_ids = {}
    for r in author_records:
        name = r["fields"]["Name"]
        author_ids[name] = r["id"]
        key = name.split()[0].upper()
        env[f"REC_AUTHOR_{key}"] = r["id"]

    print(f"  Authors: {author_ids}")

    # ── 4. Create records in child tables ─────────────────────────────────

    print("\n5. Creating post records...")

    post_records = create_records(posts_table["id"], [
        {
            "Title": "Best Travel Tips for 2025",
            "Slug": "best-travel-tips",
            "Body": "<h2>Pack Light</h2>\n<p>The most important travel tip is to pack light. You'll thank yourself when navigating cobblestone streets in Europe or squeezing onto a packed train in Tokyo.</p>\n\n<h2>Learn Basic Phrases</h2>\n<p>Even just <em>hello</em>, <em>thank you</em>, and <em>where is the bathroom</em> go a long way.</p>",
            "Tags": [tag_ids["Travel"]],
            "Author": [author_ids["Alice Chen"]],
            "Featured Image": attachment(IMAGES["travel"], "travel-tips.jpg"),
        },
        {
            "Title": "A Food Lover's Guide to Paris",
            "Slug": "food-guide-paris",
            "Body": "<p>Paris is a food lover's paradise. From corner boulangeries to Michelin-starred restaurants, every meal is an experience.</p>\n\n<h2>Must-Try Dishes</h2>\n<ul>\n<li>Croissants from Du Pain et des Idées</li>\n<li>Steak tartare at Le Comptoir</li>\n<li>Crêpes in Montmartre</li>\n</ul>",
            "Tags": [tag_ids["Food"], tag_ids["Travel"]],
            "Author": [author_ids["Alice Chen"]],
            "Featured Image": attachment(IMAGES["food"], "paris-food.jpg"),
        },
        {
            "Title": "Album Reviews: Best of 2024",
            "Slug": "album-reviews-2024",
            "Body": "<p>2024 was a landmark year for music. Here are the albums that defined it.</p>\n\n<h2>Top Picks</h2>\n<p>From indie folk to electronic, the range was extraordinary. <strong>Our #1 pick</strong> pushed boundaries in ways we didn't expect.</p>",
            "Tags": [tag_ids["Music"]],
            "Author": [author_ids["Bob Smith"]],
            # No featured image — tests null attachment
        },
        {
            "Title": "How AI Will Change Everything in 2025",
            "Slug": "ai-in-2025",
            "Body": "<p>Artificial intelligence is no longer a future technology — it's here, and it's reshaping every industry.</p>\n\n<h2>Key Trends</h2>\n<ol>\n<li>Agentic workflows replacing manual processes</li>\n<li>Multimodal models understanding images, audio, and text</li>\n<li>On-device AI reducing cloud dependency</li>\n</ol>",
            "Tags": [tag_ids["Tech"]],
            "Author": [author_ids["Bob Smith"]],
            "Featured Image": attachment(IMAGES["tech"], "ai-2025.jpg"),
        },
        {
            "Title": "Weekend Guide: Portland's Best Kept Secrets",
            "Slug": "weekend-guide-portland",
            "Body": "<p>Portland offers the perfect blend of food culture and outdoor adventure. Here's how to spend a weekend.</p>\n\n<h2>Saturday</h2>\n<p>Start at the farmers market, then hike Forest Park.</p>\n\n<h2>Sunday</h2>\n<p>Brunch at Screen Door, then explore Powell's Books.</p>",
            "Tags": [tag_ids["Travel"], tag_ids["Food"]],
            "Author": [author_ids["Alice Chen"]],
            # No featured image
        },
    ])

    for r in post_records:
        title = r["fields"]["Title"]
        slug = r["fields"].get("Slug", "")
        key = slug.upper().replace("-", "_")
        env[f"REC_POST_{key}"] = r["id"]

    print(f"  Posts: {len(post_records)} created")

    # ── Pages (create parents first, then update children with parent FK) ──

    print("\n6. Creating page records...")

    # Create all pages without parent links first
    page_records = create_records(pages_table["id"], [
        {
            "Title": "About Us",
            "Slug": "about",
            "Content": "<h1>About Scratch</h1>\n<p>We help teams manage content across services. Founded in 2023, we believe content should flow freely between the tools you love.</p>",
        },
        {
            "Title": "Our Team",
            "Slug": "team",
            "Content": "<h1>Meet the Team</h1>\n<p>We're a small, distributed team passionate about developer tools and content management.</p>\n\n<h2>Leadership</h2>\n<p>Our founders bring experience from Stripe, Notion, and GitHub.</p>",
        },
        {
            "Title": "Contact",
            "Slug": "contact",
            "Content": "<h1>Get in Touch</h1>\n<p>Email us at hello@scratch.io or find us on Twitter @scratchhq.</p>\n\n<p>For support, visit our <a href=\"/docs\">documentation</a>.</p>",
        },
    ])

    page_ids = {}
    for r in page_records:
        title = r["fields"]["Title"]
        page_ids[title] = r["id"]
        slug = r["fields"]["Slug"]
        env[f"REC_PAGE_{slug.upper()}"] = r["id"]

    print(f"  Pages: {page_ids}")

    # Update "Our Team" to set parent = "About Us"
    print("  Setting Team parent → About...")
    api("PATCH", f"/{BASE_ID}/{pages_table['id']}", {
        "records": [{
            "id": page_ids["Our Team"],
            "fields": {"Parent": [page_ids["About Us"]]},
        }],
    })

    # ── Products ─────────────────────────────────────────────────────────

    print("\n7. Creating product records...")

    product_records = create_records(products_table["id"], [
        {
            "Name": "Classic Widget",
            "Price": 29.99,
            "Description": "A beautifully crafted widget for everyday use. Precision-engineered from sustainable materials with a matte finish that feels great in your hand.",
            "Images": [
                {"url": IMAGES["widget1"], "filename": "widget-front.jpg"},
                {"url": IMAGES["widget2"], "filename": "widget-side.jpg"},
            ],
            "Color": "Red",
            "Weight": "2.4 oz",
            "In Stock": True,
            "Rating": 4,
        },
        {
            "Name": "Pro Gadget",
            "Price": 49.99,
            "Description": "The pro-grade gadget for power users. Features wireless connectivity, all-day battery, and a minimal design that disappears into your workflow.",
            "Images": attachment(IMAGES["gadget"], "gadget.jpg"),
            "Color": "Black",
            "Weight": "5.1 oz",
            "In Stock": True,
            "Rating": 5,
        },
    ])

    for r in product_records:
        name = r["fields"]["Name"]
        key = name.split()[0].upper()
        env[f"REC_PRODUCT_{key}"] = r["id"]

    print(f"  Products: {len(product_records)} created")

    # ── Write .env file ──────────────────────────────────────────────────

    print("\n8. Writing .env file...")

    env_path = os.path.join(os.path.dirname(__file__), ".env")
    with open(env_path, "w") as f:
        f.write("# Scratch Scenario Test Environment\n")
        f.write("# Generated by setup-airtable.py — do not edit manually\n")
        f.write(f"# Created: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")

        f.write("# Airtable\n")
        f.write(f"AIRTABLE_TOKEN=  # paste your token here\n")
        for key in sorted(env):
            if key.startswith("AIRTABLE_"):
                f.write(f"{key}={env[key]}\n")

        f.write("\n# Record IDs — Tags\n")
        for key in sorted(env):
            if key.startswith("REC_TAG_"):
                f.write(f"{key}={env[key]}\n")

        f.write("\n# Record IDs — Authors\n")
        for key in sorted(env):
            if key.startswith("REC_AUTHOR_"):
                f.write(f"{key}={env[key]}\n")

        f.write("\n# Record IDs — Posts\n")
        for key in sorted(env):
            if key.startswith("REC_POST_"):
                f.write(f"{key}={env[key]}\n")

        f.write("\n# Record IDs — Pages\n")
        for key in sorted(env):
            if key.startswith("REC_PAGE_"):
                f.write(f"{key}={env[key]}\n")

        f.write("\n# Record IDs — Products\n")
        for key in sorted(env):
            if key.startswith("REC_PRODUCT_"):
                f.write(f"{key}={env[key]}\n")

        f.write("\n# WordPress\n")
        f.write("WP_URL=  # e.g. https://scratch-test.wpengine.com\n")
        f.write("WP_USER=  # admin username\n")
        f.write("WP_APP_PASSWORD=  # application password\n")

        f.write("\n# Supabase\n")
        f.write("SUPA_URL=  # e.g. https://xxxxx.supabase.co\n")
        f.write("SUPA_KEY=  # anon or service_role key\n")

    print(f"  Written to {env_path}")
    print("\nDone! Airtable base is ready.")
    print(f"  Base: https://airtable.com/{BASE_ID}")
    print(f"  Tables: Tags, Authors, Posts, Pages, Products")
    print(f"  Records: {len(tag_records)} tags, {len(author_records)} authors, "
          f"{len(post_records)} posts, {len(page_records)} pages, {len(product_records)} products")


if __name__ == "__main__":
    main()
