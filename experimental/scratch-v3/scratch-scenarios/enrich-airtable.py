#!/usr/bin/env python3
"""Enrich the Scratch Demo Airtable base with realistic data.

Adds working/draft columns (the "Airtable workflow" columns that don't sync),
more authors, more posts, more pages, and 25+ products.

Usage:
    export AIRTABLE_TOKEN=pat...
    python3 enrich-airtable.py
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

# Load existing IDs
ENV = {}
env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                v = v.split("#")[0].strip()  # strip inline comments
                if v:
                    ENV[k] = v

TAGS_TABLE = ENV["AIRTABLE_TAGS_TABLE_ID"]
AUTHORS_TABLE = ENV["AIRTABLE_AUTHORS_TABLE_ID"]
POSTS_TABLE = ENV["AIRTABLE_POSTS_TABLE_ID"]
PAGES_TABLE = ENV["AIRTABLE_PAGES_TABLE_ID"]
PRODUCTS_TABLE = ENV["AIRTABLE_PRODUCTS_TABLE_ID"]

REQUEST_COUNT = 0
REQUEST_WINDOW_START = time.time()


def api(method, path, body=None):
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


def add_field(table_id, field):
    print(f"    + {field['name']}")
    return api("POST", f"/meta/bases/{BASE_ID}/tables/{table_id}/fields", field)


def create_records(table_id, records):
    all_created = []
    for i in range(0, len(records), 10):
        chunk = records[i:i + 10]
        result = api("POST", f"/{BASE_ID}/{table_id}", {
            "records": [{"fields": r} for r in chunk],
        })
        all_created.extend(result.get("records", []))
    return all_created


def update_records(table_id, updates):
    """Updates: list of {id, fields}."""
    for i in range(0, len(updates), 10):
        chunk = updates[i:i + 10]
        api("PATCH", f"/{BASE_ID}/{table_id}", {
            "records": [{"id": u["id"], "fields": u["fields"]} for u in chunk],
        })


def att(url, filename):
    return [{"url": url, "filename": filename}]


def main():
    if not TOKEN:
        print("Set AIRTABLE_TOKEN environment variable", file=sys.stderr)
        sys.exit(1)

    new_env = {}

    # ── 1. Add workflow columns to Posts ──────────────────────────────────

    print("\n1. Adding workflow columns to Posts...")

    add_field(POSTS_TABLE, {"name": "Client Draft", "type": "multilineText"})
    add_field(POSTS_TABLE, {"name": "SEO Description", "type": "singleLineText"})
    add_field(POSTS_TABLE, {
        "name": "Status", "type": "singleSelect",
        "options": {"choices": [
            {"name": "Draft", "color": "redLight2"},
            {"name": "Review", "color": "yellowLight2"},
            {"name": "Ready", "color": "blueLight2"},
            {"name": "Published", "color": "greenLight2"},
        ]},
    })
    add_field(POSTS_TABLE, {"name": "Internal Notes", "type": "multilineText"})

    # ── 2. Add workflow columns to Products ──────────────────────────────

    print("\n2. Adding workflow columns to Products...")

    add_field(PRODUCTS_TABLE, {"name": "Supplier Description", "type": "multilineText"})
    add_field(PRODUCTS_TABLE, {"name": "SKU", "type": "singleLineText"})
    add_field(PRODUCTS_TABLE, {"name": "Dimensions", "type": "singleLineText"})
    add_field(PRODUCTS_TABLE, {
        "name": "Category", "type": "singleSelect",
        "options": {"choices": [
            {"name": "Candles"},
            {"name": "Ceramics"},
            {"name": "Textiles"},
            {"name": "Stationery"},
            {"name": "Accessories"},
        ]},
    })
    add_field(PRODUCTS_TABLE, {
        "name": "Status", "type": "singleSelect",
        "options": {"choices": [
            {"name": "Draft", "color": "redLight2"},
            {"name": "Active", "color": "greenLight2"},
            {"name": "Discontinued", "color": "grayLight2"},
        ]},
    })

    # ── 3. Update existing posts with workflow data ──────────────────────

    print("\n3. Updating existing posts with workflow fields...")

    update_records(POSTS_TABLE, [
        {
            "id": ENV["REC_POST_BEST_TRAVEL_TIPS"],
            "fields": {
                "Client Draft": "hey can u write smth about travel tips?? like packing and stuff. maybe language tips too idk",
                "SEO Description": "Essential travel tips for 2025: packing light, learning local phrases, and making the most of every trip.",
                "Status": "Published",
                "Internal Notes": "Client wanted generic tips. I focused on practical, actionable advice. Good evergreen piece.",
            },
        },
        {
            "id": ENV["REC_POST_FOOD_GUIDE_PARIS"],
            "fields": {
                "Client Draft": "Paris food guide - need recs for boulangeries, restaurants, street food. Budget-friendly if possible but also some splurge spots",
                "SEO Description": "A local's guide to the best food in Paris: from corner bakeries to Michelin-starred restaurants.",
                "Status": "Published",
                "Internal Notes": "Alice lived in Paris for 2 years — all personal recs. Update seasonally.",
            },
        },
        {
            "id": ENV["REC_POST_ALBUM_REVIEWS_2024"],
            "fields": {
                "Client Draft": "need year end music roundup. top albums, maybe 10-15? mix of genres",
                "SEO Description": "The best albums of 2024 across indie, electronic, folk, and hip-hop. Our critics' picks.",
                "Status": "Published",
                "Internal Notes": "Bob's personal picks. Controversial #1 choice drove good engagement.",
            },
        },
        {
            "id": ENV["REC_POST_AI_IN_2025"],
            "fields": {
                "Client Draft": "write about AI trends for 2025. agentic stuff, multimodal, on-device. keep it accessible not too techy",
                "SEO Description": "How AI is reshaping industries in 2025: agentic workflows, multimodal models, and on-device intelligence.",
                "Status": "Published",
                "Internal Notes": "Needs quarterly updates. Link to our AI tools roundup when it's ready.",
            },
        },
        {
            "id": ENV["REC_POST_WEEKEND_GUIDE_PORTLAND"],
            "fields": {
                "Client Draft": "portland weekend guide. food + outdoor stuff. alice knows the city well",
                "SEO Description": "How to spend a perfect weekend in Portland: farmers markets, Forest Park hikes, and the best brunch spots.",
                "Status": "Published",
                "Internal Notes": "Part of the Weekend Guide series. Next: Austin, Denver, Lisbon.",
            },
        },
    ])

    # ── 4. Update existing products with workflow data ───────────────────

    print("\n4. Updating existing products with workflow fields...")

    update_records(PRODUCTS_TABLE, [
        {
            "id": ENV["REC_PRODUCT_CLASSIC"],
            "fields": {
                "Supplier Description": "Widget item, red color, standard size, material: recycled aluminum + bamboo composite. MOQ 500 units. Lead time 4-6 weeks from Shenzhen factory.",
                "SKU": "WDG-RED-001",
                "Dimensions": "3.2\" x 1.8\" x 0.6\"",
                "Category": "Accessories",
                "Status": "Active",
            },
        },
        {
            "id": ENV["REC_PRODUCT_PRO"],
            "fields": {
                "Supplier Description": "Pro gadget, black, wireless BT 5.3, 2000mAh battery, USB-C charging. Includes carry case. Factory: Dongguan.",
                "SKU": "GDG-BLK-001",
                "Dimensions": "5.5\" x 2.2\" x 0.8\"",
                "Category": "Accessories",
                "Status": "Active",
            },
        },
    ])

    # ── 5. Add more tags ─────────────────────────────────────────────────

    print("\n5. Adding more tags...")

    new_tags = create_records(TAGS_TABLE, [
        {"Name": "Photography", "Slug": "photography"},
        {"Name": "Lifestyle", "Slug": "lifestyle"},
        {"Name": "Science", "Slug": "science"},
        {"Name": "Business", "Slug": "business"},
        {"Name": "Health", "Slug": "health"},
        {"Name": "Design", "Slug": "design"},
    ])

    tag_ids = {}
    for r in new_tags:
        name = r["fields"]["Name"]
        tag_ids[name] = r["id"]
        new_env[f"REC_TAG_{name.upper()}"] = r["id"]
    # Include existing tags
    tag_ids["Travel"] = ENV["REC_TAG_TRAVEL"]
    tag_ids["Food"] = ENV["REC_TAG_FOOD"]
    tag_ids["Music"] = ENV["REC_TAG_MUSIC"]
    tag_ids["Tech"] = ENV["REC_TAG_TECH"]

    print(f"  Added: {list(tag_ids.keys())[:6]}")

    # ── 6. Add more authors ──────────────────────────────────────────────

    print("\n6. Adding more authors...")

    new_authors = create_records(AUTHORS_TABLE, [
        {
            "Name": "Carol Martinez",
            "Bio": "Photographer and visual storyteller. Her work has appeared in National Geographic, Wired, and The New York Times. Based in Mexico City.",
            "Avatar": att("https://images.unsplash.com/photo-1580489944761-15a19d654956?w=400", "carol.jpg"),
        },
        {
            "Name": "David Park",
            "Bio": "Science and health writer with a PhD in neuroscience. Translates complex research into stories everyone can understand.",
            "Avatar": att("https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400", "david.jpg"),
        },
    ])

    author_ids = {
        "Alice Chen": ENV["REC_AUTHOR_ALICE"],
        "Bob Smith": ENV["REC_AUTHOR_BOB"],
    }
    for r in new_authors:
        name = r["fields"]["Name"]
        author_ids[name] = r["id"]
        key = name.split()[0].upper()
        new_env[f"REC_AUTHOR_{key}"] = r["id"]

    # ── 7. Add more posts ────────────────────────────────────────────────

    print("\n7. Adding more posts...")

    new_posts = create_records(POSTS_TABLE, [
        {
            "Title": "Street Photography in Tokyo: A Visual Essay",
            "Slug": "tokyo-street-photography",
            "Client Draft": "need a photo essay about tokyo streets. neon lights, quiet alleys, contrast between old and new. carol has the shots from her last trip",
            "Body": "<p>Tokyo reveals itself in layers. The neon-drenched chaos of Shibuya gives way to silent temple gardens just blocks away. This is a city of contradictions, and the camera loves every one of them.</p>\n\n<h2>Shibuya at Night</h2>\n<p>The crossing empties and fills like breathing. Thousands of people, none of them looking up. The light from a hundred screens paints their faces blue.</p>\n\n<h2>Morning in Yanaka</h2>\n<p>A cat sleeps on a stone wall older than anyone alive. The shopkeeper sweeps the same steps his grandfather swept. Time moves differently here.</p>",
            "SEO Description": "A photographic journey through Tokyo's streets: from Shibuya's neon chaos to Yanaka's timeless quiet.",
            "Tags": [tag_ids["Photography"], tag_ids["Travel"]],
            "Author": [author_ids["Carol Martinez"]],
            "Featured Image": att("https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=800", "tokyo-streets.jpg"),
            "Status": "Published",
            "Internal Notes": "Carol's best work. Consider as flagship piece for Photography section.",
        },
        {
            "Title": "The Science of Sleep: What We Got Wrong",
            "Slug": "science-of-sleep",
            "Client Draft": "article about sleep science. the 8 hour thing is kinda a myth? also chronotypes. david knows this stuff",
            "Body": "<p>For decades, we've been told to get eight hours of sleep. The reality is more nuanced — and more interesting — than any headline suggests.</p>\n\n<h2>The Eight-Hour Myth</h2>\n<p>The magic number varies by individual, age, and genetics. Some people thrive on 6.5 hours. Others need 9. The <em>quality</em> of sleep matters more than the quantity.</p>\n\n<h2>Chronotypes Are Real</h2>\n<p>Morning people and night owls aren't just preferences — they're genetic. Forcing a night owl into a 6 AM routine doesn't make them productive. It makes them sleep-deprived.</p>\n\n<h2>What Actually Helps</h2>\n<p>Consistent timing beats duration. Cool rooms beat warm ones. And yes, screens before bed really do mess with your melatonin — but the effect is smaller than you think.</p>",
            "SEO Description": "New research challenges the 8-hour sleep rule. What science actually says about sleep quality, chronotypes, and building better habits.",
            "Tags": [tag_ids["Science"], tag_ids["Health"]],
            "Author": [author_ids["David Park"]],
            "Status": "Published",
            "Internal Notes": "David's most-shared article. Plan a follow-up on circadian rhythm and productivity.",
        },
        {
            "Title": "Remote Work Gear: The 2025 Setup Guide",
            "Slug": "remote-work-gear-2025",
            "Client Draft": "best remote work gear for 2025. desk setup, monitors, chairs, accessories. keep it practical not aspirational. real stuff people actually buy",
            "Body": "<p>After five years of remote work becoming the norm, the gear landscape has matured. Here's what's actually worth your money in 2025.</p>\n\n<h2>The Essentials</h2>\n<p>A good chair isn't optional — it's healthcare. The <strong>Herman Miller Aeron</strong> is still the gold standard, but the <strong>Branch Ergonomic Chair</strong> gets you 80% of the way at half the price.</p>\n\n<h2>Monitors</h2>\n<p>Ultrawide or dual? After testing both extensively: ultrawide wins for focus work, dual wins for reference-heavy work (coding, design, writing with research).</p>\n\n<h2>The Overlooked Upgrade</h2>\n<p>Good lighting. A $40 desk lamp with adjustable color temperature will do more for your video calls and eye strain than a $400 webcam.</p>",
            "SEO Description": "The best remote work gear for 2025: chairs, monitors, lighting, and accessories that are actually worth the investment.",
            "Tags": [tag_ids["Tech"], tag_ids["Lifestyle"]],
            "Author": [author_ids["Bob Smith"]],
            "Featured Image": att("https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=800", "remote-desk.jpg"),
            "Status": "Published",
            "Internal Notes": "Update quarterly with new releases. Affiliate links pending approval.",
        },
        {
            "Title": "Building a Second Brain: What Works in Practice",
            "Slug": "second-brain-practical",
            "Client Draft": "pkm article. not the usual obsidian/notion fanboy stuff. what actually works long term. bob tried everything",
            "Body": "<p>I've used every note-taking system. Notion, Obsidian, Roam, Apple Notes, paper notebooks, index cards. Here's what I learned after five years of trying to build a \"second brain.\"</p>\n\n<h2>The Uncomfortable Truth</h2>\n<p>Most personal knowledge management is procrastination disguised as productivity. If you spend more time organizing notes than using them, you've lost the plot.</p>\n\n<h2>What Actually Stuck</h2>\n<p>Three things: a single place for tasks (I use Things), a single place for reference (Apple Notes — yes, really), and a weekly review where I delete 90% of what I saved.</p>\n\n<h2>The Deletion Habit</h2>\n<p>The best organizational system is aggressive deletion. If you haven't looked at a note in 90 days, it's not knowledge — it's hoarding.</p>",
            "SEO Description": "After 5 years of PKM systems, here's what actually works: simplicity, deletion, and stopping the tool-hopping cycle.",
            "Tags": [tag_ids["Tech"], tag_ids["Business"]],
            "Author": [author_ids["Bob Smith"]],
            "Status": "Published",
            "Internal Notes": "Controversial take but engagement was very high. Comments divided 50/50.",
        },
        {
            "Title": "Mexico City's Design Renaissance",
            "Slug": "mexico-city-design",
            "Client Draft": "carol's been living in CDMX and the design scene is incredible. architecture, furniture, ceramics, textiles. mix of traditional craft + modern design",
            "Body": "<p>Mexico City is having a design moment — though calling it a \"moment\" undersells a movement decades in the making. From Condesa's modernist apartments to Roma's ceramic studios, the city is producing some of the most exciting design work in the world.</p>\n\n<h2>The Craft Connection</h2>\n<p>What makes Mexican design distinct is the unbroken connection to craft traditions. A lamp isn't just a lamp — it's hand-blown glass from a family workshop in Tonalá that's been operating since the 1700s.</p>\n\n<h2>Studios to Visit</h2>\n<ul>\n<li><strong>Estudio Persona</strong> — furniture that blurs art and function</li>\n<li><strong>Cerámica Suro</strong> — contemporary ceramics with traditional techniques</li>\n<li><strong>Taller Lu'um</strong> — textiles that support indigenous cooperatives</li>\n</ul>",
            "SEO Description": "Inside Mexico City's thriving design scene: studios, ceramics, textiles, and the craft traditions driving a creative renaissance.",
            "Tags": [tag_ids["Design"], tag_ids["Travel"], tag_ids["Photography"]],
            "Author": [author_ids["Carol Martinez"]],
            "Featured Image": att("https://images.unsplash.com/photo-1518105779142-d975f22f1b0a?w=800", "cdmx-design.jpg"),
            "Status": "Published",
            "Internal Notes": "Part of Carol's CDMX series. Next: Food markets of CDMX.",
        },
        {
            "Title": "Why Your Gut Microbiome Matters More Than You Think",
            "Slug": "gut-microbiome-guide",
            "Client Draft": "gut health article. the microbiome stuff is finally getting mainstream. probiotics, fermented food, the gut-brain axis. david can make this accessible",
            "Body": "<p>Your gut contains roughly 39 trillion microorganisms — more than the number of human cells in your body. These tiny residents influence everything from your mood to your immune system to how you metabolize medication.</p>\n\n<h2>The Gut-Brain Axis</h2>\n<p>Your gut produces about 95% of your body's serotonin. When researchers gave anxious mice a fecal transplant from calm mice, the anxious mice calmed down. The connection is that direct.</p>\n\n<h2>What Actually Works</h2>\n<p>Forget expensive probiotic supplements — the research is mixed at best. What consistently shows benefits:</p>\n<ol>\n<li>Dietary fiber diversity (aim for 30+ plant species per week)</li>\n<li>Fermented foods (kimchi, kefir, sauerkraut — not kombucha, sorry)</li>\n<li>Avoiding unnecessary antibiotics</li>\n</ol>",
            "SEO Description": "Your gut microbiome affects mood, immunity, and metabolism. Here's what the science says about keeping it healthy.",
            "Tags": [tag_ids["Science"], tag_ids["Health"]],
            "Author": [author_ids["David Park"]],
            "Status": "Published",
            "Internal Notes": "Partner with a gastroenterologist for medical review before next update.",
        },
        {
            "Title": "The Case for Walking Meetings",
            "Slug": "walking-meetings",
            "Client Draft": "short piece on walking meetings. steve jobs did it, there's actual research now. good for creativity + health",
            "Body": "<p>The most productive meeting I've ever had was a 40-minute walk around the block. No slides, no screen-sharing, no \"you're on mute.\" Just two people thinking out loud.</p>\n\n<h2>The Research</h2>\n<p>Stanford found that walking increases creative output by an average of 60%. It doesn't matter where you walk — a treadmill works too. Something about bilateral movement unlocks divergent thinking.</p>\n\n<h2>When It Works</h2>\n<p>Brainstorming, 1:1s, difficult conversations, and status updates. Basically anything that doesn't require a screen.</p>\n\n<h2>When It Doesn't</h2>\n<p>Anything requiring detailed data review, group decisions with more than 3 people, or meetings where someone needs to take detailed notes.</p>",
            "SEO Description": "Walking meetings boost creativity by 60% according to Stanford research. When to use them and when to skip.",
            "Tags": [tag_ids["Business"], tag_ids["Health"]],
            "Author": [author_ids["David Park"]],
            "Status": "Published",
        },
        {
            "Title": "Vinyl Collecting in the Streaming Age",
            "Slug": "vinyl-collecting-streaming",
            "Client Draft": "vinyl is having a moment again. bob collects. why people buy physical media when everything is on spotify. the ritual, the sound, the artwork",
            "Body": "<p>I pay $10.99/month for access to virtually every song ever recorded. I also spent $340 last month on twelve vinyl records. This makes no rational sense, and I'm not alone.</p>\n\n<h2>It's Not About Sound Quality</h2>\n<p>Let's get this out of the way: most people can't tell the difference between vinyl and a high-bitrate stream in a blind test. The appeal is everything <em>around</em> the sound.</p>\n\n<h2>The Ritual</h2>\n<p>Sliding a record from its sleeve. Placing the needle. Sitting down because you can't skip tracks from across the room. Vinyl forces you to listen intentionally, which is the opposite of how we consume music now.</p>\n\n<h2>The Art</h2>\n<p>A 12-inch album cover is a canvas. Spotify gives you a 300-pixel thumbnail. There's no comparison.</p>",
            "SEO Description": "Why vinyl sales keep growing in the streaming era: the ritual, the artwork, and the case for intentional listening.",
            "Tags": [tag_ids["Music"], tag_ids["Lifestyle"]],
            "Author": [author_ids["Bob Smith"]],
            "Featured Image": att("https://images.unsplash.com/photo-1539375665275-f9de415ef9ac?w=800", "vinyl.jpg"),
            "Status": "Published",
            "Internal Notes": "Good engagement. Plan a follow-up: 'Starter Turntable Guide' with affiliate links.",
        },
        {
            "Title": "Fermentation for Beginners",
            "Slug": "fermentation-beginners",
            "Client Draft": "beginner fermentation guide. sauerkraut, kimchi, pickles. alice does this at home. keep it simple and not intimidating",
            "Body": "<p>Fermentation sounds like chemistry. It's actually just \"put vegetables in salt water and wait.\" Here's how to start without buying any special equipment.</p>\n\n<h2>Sauerkraut: Your First Ferment</h2>\n<p>You need: one cabbage, salt, a jar. That's it. Shred the cabbage, massage it with 2% salt by weight, pack it into a jar, push it under the brine, and wait 5-7 days. You've just made sauerkraut.</p>\n\n<h2>Common Fears</h2>\n<p><strong>\"Will I get food poisoning?\"</strong> Almost certainly not. Lacto-fermentation creates an environment where harmful bacteria can't survive. Humans have been doing this for 6,000 years without refrigeration.</p>\n\n<h2>Beyond Sauerkraut</h2>\n<p>Once you're comfortable: try kimchi (same process, more ingredients), pickled jalapeños (3 days), or fermented hot sauce (2 weeks).</p>",
            "SEO Description": "Start fermenting at home with just salt and vegetables. A no-fear beginner's guide to sauerkraut, kimchi, and pickles.",
            "Tags": [tag_ids["Food"], tag_ids["Lifestyle"]],
            "Author": [author_ids["Alice Chen"]],
            "Featured Image": att("https://images.unsplash.com/photo-1583224964978-2257b960c3d3?w=800", "fermentation.jpg"),
            "Status": "Published",
        },
        {
            "Title": "How to Read a Scientific Paper",
            "Slug": "how-to-read-scientific-paper",
            "Client Draft": "david gets asked this all the time. how regular people can read papers without a phd. pubmed, preprints, understanding limitations",
            "Body": "<p>You don't need a PhD to read a scientific paper. You need about 20 minutes and a willingness to skip the parts that don't matter to you.</p>\n\n<h2>The Shortcut</h2>\n<p>Read in this order: <strong>Abstract → Figures → Discussion → Methods</strong>. Skip the introduction (it's background you probably already know if you're reading the paper) and the results section (the figures tell the same story more clearly).</p>\n\n<h2>Red Flags</h2>\n<ul>\n<li>Sample size under 30 (interesting but not conclusive)</li>\n<li>No control group (correlation, not causation)</li>\n<li>\"Significant\" without effect size (statistically significant ≠ meaningful)</li>\n<li>Preprint not yet peer-reviewed (preliminary — treat as \"interesting if true\")</li>\n</ul>\n\n<h2>Where to Find Papers</h2>\n<p><a href=\"https://scholar.google.com\">Google Scholar</a> for searching. <a href=\"https://sci-hub.se\">Sci-Hub</a> for access (legally gray, ethically debatable, practically essential).</p>",
            "SEO Description": "A non-scientist's guide to reading scientific papers: what to read, what to skip, and how to spot bad research.",
            "Tags": [tag_ids["Science"]],
            "Author": [author_ids["David Park"]],
            "Status": "Published",
            "Internal Notes": "Evergreen content. Add video walkthrough when we have the bandwidth.",
        },
    ])

    for r in new_posts:
        slug = r["fields"].get("Slug", "")
        key = slug.upper().replace("-", "_")
        new_env[f"REC_POST_{key}"] = r["id"]

    print(f"  Added {len(new_posts)} posts")

    # ── 8. Add more pages ────────────────────────────────────────────────

    print("\n8. Adding more pages...")

    new_pages = create_records(PAGES_TABLE, [
        {
            "Title": "Our Mission",
            "Slug": "mission",
            "Content": "<h1>Our Mission</h1>\n<p>We believe content should flow freely between the tools teams already use. No vendor lock-in, no manual copy-paste, no lost formatting.</p>\n\n<p>Scratch connects your content sources — CMSes, databases, spreadsheets — and keeps them in sync. Edit in the tool you prefer, publish everywhere automatically.</p>",
        },
        {
            "Title": "Careers",
            "Slug": "careers",
            "Content": "<h1>Join Us</h1>\n<p>We're a small, remote team building tools for content teams. We value clear writing, simple code, and shipping early.</p>\n\n<h2>Open Positions</h2>\n<ul>\n<li><strong>Senior Rust Engineer</strong> — Work on our sync engine and git-based storage layer</li>\n<li><strong>Product Designer</strong> — Design the interface for content operations at scale</li>\n</ul>\n\n<p>No positions fit? Email us at careers@scratch.io — we're always open to exceptional people.</p>",
        },
        {
            "Title": "Privacy Policy",
            "Slug": "privacy",
            "Content": "<h1>Privacy Policy</h1>\n<p>Last updated: January 2025</p>\n\n<h2>What We Collect</h2>\n<p>Account information (email, name), usage analytics (anonymized), and the content you choose to sync through our platform.</p>\n\n<h2>What We Don't Do</h2>\n<p>We don't sell your data. We don't train AI on your content. We don't share anything with third parties except infrastructure providers necessary to operate the service.</p>\n\n<h2>Your Data</h2>\n<p>You can export or delete all your data at any time from your account settings. When you delete your account, we remove everything within 30 days.</p>",
        },
    ])

    page_ids_new = {}
    for r in new_pages:
        slug = r["fields"]["Slug"]
        page_ids_new[slug] = r["id"]
        new_env[f"REC_PAGE_{slug.upper()}"] = r["id"]

    # Set Mission as child of About
    print("  Setting Mission parent → About...")
    api("PATCH", f"/{BASE_ID}/{PAGES_TABLE}", {
        "records": [{
            "id": page_ids_new["mission"],
            "fields": {"Parent": [ENV["REC_PAGE_ABOUT"]]},
        }],
    })

    print(f"  Added {len(new_pages)} pages")

    # ── 9. Add 23 more products ──────────────────────────────────────────

    print("\n9. Adding products...")

    products = [
        # Candles (6)
        {
            "Name": "Cedar & Sage Candle",
            "Price": 34.00,
            "Description": "Hand-poured soy candle with notes of Pacific Northwest cedar, white sage, and a hint of campfire smoke. 60-hour burn time.",
            "Supplier Description": "Soy wax candle, cedar/sage fragrance oil blend, cotton wick, 8oz amber glass jar. Production: Portland OR. Shelf life 18mo.",
            "Images": att("https://images.unsplash.com/photo-1602607650602-ff77e0f3d0fa?w=800", "cedar-sage.jpg"),
            "Color": "Green", "SKU": "CDL-CDS-001", "Dimensions": "3.5\" x 3.5\"",
            "Category": "Candles", "Status": "Active", "In Stock": True, "Rating": 5,
            "Weight": "12 oz",
        },
        {
            "Name": "Lavender Fields Candle",
            "Price": 28.00,
            "Description": "Calming French lavender meets vanilla bean in this bestselling candle. Perfect for winding down.",
            "Supplier Description": "Soy wax, lavender EO + vanilla FO, cotton wick, 6oz white ceramic. MOQ 200.",
            "Images": att("https://images.unsplash.com/photo-1616401784845-180882ba9ba8?w=800", "lavender.jpg"),
            "Color": "Blue", "SKU": "CDL-LAV-001", "Dimensions": "3\" x 3\"",
            "Category": "Candles", "Status": "Active", "In Stock": True, "Rating": 4,
            "Weight": "9 oz",
        },
        {
            "Name": "Citrus Morning Candle",
            "Price": 32.00,
            "Description": "Bright grapefruit, bergamot, and lemongrass. An energizing scent for kitchens and workspaces.",
            "Supplier Description": "Coconut-soy blend, citrus EO mix, wood wick, 8oz clear glass. Crackling wick effect.",
            "Images": att("https://images.unsplash.com/photo-1603006905003-be475563bc59?w=800", "citrus.jpg"),
            "Color": "Green", "SKU": "CDL-CIT-001", "Dimensions": "3.5\" x 4\"",
            "Category": "Candles", "Status": "Active", "In Stock": True, "Rating": 4,
            "Weight": "11 oz",
        },
        {
            "Name": "Tobacco & Honey Candle",
            "Price": 38.00,
            "Description": "Rich, warm, and slightly sweet. Tobacco leaf, raw honey, and tonka bean create a sophisticated scent that fills a room without overwhelming it.",
            "Supplier Description": "Soy wax, tobacco/honey/tonka FO, cotton wick, 10oz matte black jar. Premium line.",
            "Images": att("https://images.unsplash.com/photo-1547592180-85f173990554?w=800", "tobacco-honey.jpg"),
            "Color": "Black", "SKU": "CDL-TBH-001", "Dimensions": "4\" x 4\"",
            "Category": "Candles", "Status": "Active", "In Stock": True, "Rating": 5,
            "Weight": "14 oz",
        },
        {
            "Name": "Sea Salt & Driftwood Candle",
            "Price": 30.00,
            "Description": "The smell of a beach house in October. Sea salt, sun-bleached wood, and a whisper of coconut.",
            "Supplier Description": "Soy wax, marine/wood FO blend, cotton wick, 7oz frosted glass. Seasonal — discontinue after summer.",
            "Images": att("https://images.unsplash.com/photo-1572726631638-4e74f02de0af?w=800", "sea-salt.jpg"),
            "Color": "Blue", "SKU": "CDL-SEA-001", "Dimensions": "3\" x 3.5\"",
            "Category": "Candles", "Status": "Active", "In Stock": False, "Rating": 4,
            "Weight": "10 oz",
        },
        {
            "Name": "Fireside Candle (Discontinued)",
            "Price": 36.00,
            "Description": "Smoky birch, black pepper, and aged leather. A winter limited edition that's not coming back.",
            "Supplier Description": "Soy-beeswax blend, smoky/leather FO, wood wick, 9oz copper tin. DISCONTINUED - final batch shipped.",
            "Color": "Red", "SKU": "CDL-FIR-001", "Dimensions": "3.5\" x 3\"",
            "Category": "Candles", "Status": "Discontinued", "In Stock": False, "Rating": 5,
            "Weight": "12 oz",
        },
        # Ceramics (5)
        {
            "Name": "Speckled Stoneware Mug",
            "Price": 24.00,
            "Description": "Wheel-thrown stoneware mug with a reactive glaze that makes each one unique. Microwave and dishwasher safe. 12oz capacity.",
            "Supplier Description": "Stoneware clay body, reactive speckle glaze, hand-dipped. Each piece varies. Kiln: cone 6 oxidation. Lead-free.",
            "Images": att("https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=800", "mug.jpg"),
            "Color": "Blue", "SKU": "CER-MUG-001", "Dimensions": "3.5\" x 4.5\"",
            "Category": "Ceramics", "Status": "Active", "In Stock": True, "Rating": 5,
            "Weight": "14 oz",
        },
        {
            "Name": "Ramen Bowl Set",
            "Price": 48.00,
            "Description": "Set of two deep bowls perfect for ramen, pho, or grain bowls. Matte exterior, glossy interior. Made in our Portland studio.",
            "Supplier Description": "Stoneware, matte/gloss combo glaze, set of 2. 32oz capacity each. Studio production, 3-week lead time.",
            "Images": att("https://images.unsplash.com/photo-1590794056226-79ef3a8147e1?w=800", "ramen-bowl.jpg"),
            "Color": "Black", "SKU": "CER-BWL-001", "Dimensions": "7\" x 3.5\"",
            "Category": "Ceramics", "Status": "Active", "In Stock": True, "Rating": 4,
            "Weight": "2.1 lbs",
        },
        {
            "Name": "Minimalist Vase",
            "Price": 42.00,
            "Description": "Clean lines, unglazed exterior. Designed to hold a single stem or a small arrangement. The raw clay surface develops a subtle patina over time.",
            "Supplier Description": "Stoneware, partial glaze (interior only), hand-turned. Watertight interior. 8\" tall.",
            "Images": att("https://images.unsplash.com/photo-1612196808214-b8e1d6145a8c?w=800", "vase.jpg"),
            "Color": "Red", "SKU": "CER-VAS-001", "Dimensions": "4\" x 8\"",
            "Category": "Ceramics", "Status": "Active", "In Stock": True, "Rating": 5,
            "Weight": "1.8 lbs",
        },
        {
            "Name": "Espresso Cup Pair",
            "Price": 32.00,
            "Description": "Two double-walled espresso cups. The air gap keeps your espresso hot and your fingers cool. 3oz capacity each.",
            "Supplier Description": "Porcelain, double-wall construction, clear glaze. Set of 2. 3oz/90ml. Dishwasher safe.",
            "Images": att("https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800", "espresso-cups.jpg"),
            "Color": "Green", "SKU": "CER-ESP-001", "Dimensions": "2.5\" x 2.5\"",
            "Category": "Ceramics", "Status": "Active", "In Stock": True, "Rating": 4,
            "Weight": "8 oz",
        },
        {
            "Name": "Serving Platter",
            "Price": 56.00,
            "Description": "A generous oval platter with an organic edge. Perfect for charcuterie, roasted vegetables, or as a decorative tray. Each glaze pattern is one of a kind.",
            "Supplier Description": "Stoneware slab construction, reactive glaze, food safe. 14\" x 9\". Heavy — ship with extra padding.",
            "Images": att("https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=800", "platter.jpg"),
            "Color": "Blue", "SKU": "CER-PLT-001", "Dimensions": "14\" x 9\" x 1.5\"",
            "Category": "Ceramics", "Status": "Active", "In Stock": True, "Rating": 5,
            "Weight": "3.2 lbs",
        },
        # Textiles (5)
        {
            "Name": "Alpaca Throw Blanket",
            "Price": 120.00,
            "Description": "Baby alpaca wool throw in a classic herringbone pattern. Incredibly soft, naturally hypoallergenic, and warmer than sheep's wool without the weight.",
            "Supplier Description": "100% baby alpaca fiber, herringbone weave, Peru origin. 50\" x 70\". Hand wash or dry clean. Ships rolled, not folded.",
            "Images": att("https://images.unsplash.com/photo-1580301762395-21ce5da33116?w=800", "alpaca-throw.jpg"),
            "Color": "Green", "SKU": "TXT-THR-001", "Dimensions": "50\" x 70\"",
            "Category": "Textiles", "Status": "Active", "In Stock": True, "Rating": 5,
            "Weight": "2.4 lbs",
        },
        {
            "Name": "Linen Napkin Set",
            "Price": 36.00,
            "Description": "Set of four stonewashed linen napkins. Pre-washed for softness — no ironing needed. Gets better with every wash.",
            "Supplier Description": "100% European flax linen, stonewashed, overlocked edges. Set of 4. 18\" x 18\". Machine washable.",
            "Images": att("https://images.unsplash.com/photo-1563241527-3004b7be0ffd?w=800", "linen-napkins.jpg"),
            "Color": "Blue", "SKU": "TXT-NAP-001", "Dimensions": "18\" x 18\" (each)",
            "Category": "Textiles", "Status": "Active", "In Stock": True, "Rating": 4,
            "Weight": "12 oz",
        },
        {
            "Name": "Hand-Block Print Pillow",
            "Price": 54.00,
            "Description": "Cotton canvas pillow with a hand-stamped botanical print from a family workshop in Jaipur. Insert included. Each print has slight variations — that's the point.",
            "Supplier Description": "Cotton canvas shell, hand-block printed (Jaipur). Polyester fill insert included. 20\" x 20\". Spot clean cover.",
            "Images": att("https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?w=800", "block-print-pillow.jpg"),
            "Color": "Blue", "SKU": "TXT-PIL-001", "Dimensions": "20\" x 20\"",
            "Category": "Textiles", "Status": "Active", "In Stock": True, "Rating": 5,
            "Weight": "1.6 lbs",
        },
        {
            "Name": "Wool Table Runner",
            "Price": 68.00,
            "Description": "A textured wool runner with a modern geometric pattern. Hand-woven in Oaxaca using naturally dyed fibers.",
            "Supplier Description": "Wool/cotton blend, hand-loomed, natural dyes (indigo, cochineal, marigold). 14\" x 72\". Dry clean only.",
            "Images": att("https://images.unsplash.com/photo-1606744824163-985d376605aa?w=800", "table-runner.jpg"),
            "Color": "Red", "SKU": "TXT-RUN-001", "Dimensions": "14\" x 72\"",
            "Category": "Textiles", "Status": "Active", "In Stock": False, "Rating": 5,
            "Weight": "1.1 lbs",
        },
        {
            "Name": "Cotton Dish Towel Set",
            "Price": 22.00,
            "Description": "Three-pack of absorbent cotton dish towels with a clean stripe pattern. The workhorse of any kitchen.",
            "Supplier Description": "100% cotton terry, woven stripe, set of 3 (white/gray/charcoal). 20\" x 28\". Machine wash.",
            "Images": att("https://images.unsplash.com/photo-1583845112239-97ef1341b271?w=800", "dish-towels.jpg"),
            "Color": "Black", "SKU": "TXT-DSH-001", "Dimensions": "20\" x 28\" (each)",
            "Category": "Textiles", "Status": "Active", "In Stock": True, "Rating": 3,
            "Weight": "14 oz",
        },
        # Stationery (4)
        {
            "Name": "Dot Grid Notebook",
            "Price": 18.00,
            "Description": "192 pages of 100gsm cream paper with a subtle dot grid. Lay-flat binding, ribbon bookmark, and an elastic closure. Our most popular item.",
            "Supplier Description": "A5 format, 100gsm FSC paper, dot grid 5mm, thread-sewn binding, linen cover. 192 pages. Colors: charcoal, forest, navy.",
            "Images": att("https://images.unsplash.com/photo-1531346878377-a5be20888e57?w=800", "notebook.jpg"),
            "Color": "Black", "SKU": "STN-DOT-001", "Dimensions": "5.5\" x 8.5\"",
            "Category": "Stationery", "Status": "Active", "In Stock": True, "Rating": 5,
            "Weight": "9 oz",
        },
        {
            "Name": "Brass Pen",
            "Price": 45.00,
            "Description": "Machined solid brass pen that develops a unique patina over years of use. Takes standard Parker-style refills. Hefty, balanced, and built to last decades.",
            "Supplier Description": "CNC machined C360 brass, knurled grip, Parker G2 refill (black ink included). Weight: 2.1oz. Ships in cotton pouch.",
            "Images": att("https://images.unsplash.com/photo-1585336261022-680e295ce3fe?w=800", "brass-pen.jpg"),
            "Color": "Red", "SKU": "STN-PEN-001", "Dimensions": "5.5\" x 0.4\"",
            "Category": "Stationery", "Status": "Active", "In Stock": True, "Rating": 5,
            "Weight": "2.1 oz",
        },
        {
            "Name": "Letterpress Card Set",
            "Price": 16.00,
            "Description": "Box of 12 blank cards with envelopes. Letterpress printed on thick cotton stock. Six designs featuring botanical illustrations.",
            "Supplier Description": "220lb cotton stock, letterpress printed (2 colors), A2 size, kraft envelopes. Box of 12 (2 each of 6 designs).",
            "Images": att("https://images.unsplash.com/photo-1579783483458-83d02161294e?w=800", "cards.jpg"),
            "Color": "Green", "SKU": "STN-CRD-001", "Dimensions": "4.25\" x 5.5\"",
            "Category": "Stationery", "Status": "Active", "In Stock": True, "Rating": 4,
            "Weight": "8 oz",
        },
        {
            "Name": "Desk Organizer",
            "Price": 38.00,
            "Description": "Walnut and brass desk organizer with slots for pens, cards, and a phone. CNC milled from a single block of American walnut.",
            "Supplier Description": "American black walnut, CNC milled, brass rod dividers, felt bottom. 8\" x 4\" x 2\". Finished with tung oil.",
            "Images": att("https://images.unsplash.com/photo-1544816155-12df9643f363?w=800", "desk-organizer.jpg"),
            "Color": "Red", "SKU": "STN-DSK-001", "Dimensions": "8\" x 4\" x 2\"",
            "Category": "Stationery", "Status": "Active", "In Stock": True, "Rating": 4,
            "Weight": "1.2 lbs",
        },
        # Accessories (3 — 2 already exist)
        {
            "Name": "Canvas Tote Bag",
            "Price": 28.00,
            "Description": "Heavy 18oz canvas tote with reinforced handles and an interior pocket. Carries groceries, books, laptops — basically your entire life.",
            "Supplier Description": "18oz cotton duck canvas, bar-tacked handles, interior phone pocket, flat bottom gusset. 15\" x 16\" x 5\". Blank — ready for printing.",
            "Images": att("https://images.unsplash.com/photo-1544816155-12df9643f363?w=800", "tote.jpg"),
            "Color": "Black", "SKU": "ACC-TOT-001", "Dimensions": "15\" x 16\" x 5\"",
            "Category": "Accessories", "Status": "Active", "In Stock": True, "Rating": 4,
            "Weight": "1.1 lbs",
        },
        {
            "Name": "Leather Card Wallet",
            "Price": 42.00,
            "Description": "Slim card wallet in vegetable-tanned leather. Holds 6 cards and folded bills. The leather darkens and softens beautifully over time.",
            "Supplier Description": "Veg-tan leather (Tuscany, Italy), hand-stitched, burnished edges. 3 card slots + center pocket. 4\" x 3\" folded.",
            "Images": att("https://images.unsplash.com/photo-1627123424574-724758594e93?w=800", "wallet.jpg"),
            "Color": "Red", "SKU": "ACC-WAL-001", "Dimensions": "4\" x 3\" (folded)",
            "Category": "Accessories", "Status": "Active", "In Stock": True, "Rating": 5,
            "Weight": "2 oz",
        },
        {
            "Name": "Waxed Canvas Pouch",
            "Price": 24.00,
            "Description": "Water-resistant waxed canvas pouch for cables, chargers, pens, or toiletries. YKK brass zipper. Gets better looking as it ages.",
            "Supplier Description": "Waxed 10oz cotton canvas, YKK #5 brass zipper, canvas pull tab. Lined with waterproof nylon. 9\" x 5\" x 3\".",
            "Images": att("https://images.unsplash.com/photo-1547949003-9792a18a2601?w=800", "waxed-pouch.jpg"),
            "Color": "Green", "SKU": "ACC-PCH-001", "Dimensions": "9\" x 5\" x 3\"",
            "Category": "Accessories", "Status": "Active", "In Stock": True, "Rating": 4,
            "Weight": "6 oz",
        },
    ]

    product_records = create_records(PRODUCTS_TABLE, products)

    for r in product_records:
        name = r["fields"]["Name"]
        sku = r["fields"].get("SKU", "")
        if sku:
            new_env[f"REC_PRODUCT_{sku.replace('-', '_')}"] = r["id"]

    print(f"  Added {len(product_records)} products (total: {len(product_records) + 2})")

    # ── 10. Append new IDs to .env ───────────────────────────────────────

    print("\n10. Appending new IDs to .env...")

    with open(env_path, "a") as f:
        f.write("\n# ── Added by enrich-airtable.py ──\n\n")
        for key in sorted(new_env):
            f.write(f"{key}={new_env[key]}\n")

    total_tags = 4 + 6
    total_authors = 2 + 2
    total_posts = 5 + len(new_posts)
    total_pages = 3 + len(new_pages)
    total_products = 2 + len(product_records)

    print(f"\nDone! Base enriched.")
    print(f"  Tags:     {total_tags}")
    print(f"  Authors:  {total_authors}")
    print(f"  Posts:    {total_posts}")
    print(f"  Pages:    {total_pages}")
    print(f"  Products: {total_products}")
    print(f"  Total:    {total_tags + total_authors + total_posts + total_pages + total_products} records")


if __name__ == "__main__":
    main()
