"""Scratch Demo — Three real workflows with live services.

This is a scripted walkthrough for presenting Scratch to a live audience.
It uses real Airtable and WordPress connections with real data.

  Act 1: Connect Airtable → Pull → Edit → Review (discard one, keep other)
  Act 2: Download CSV → Edit offline → Upload CSV → Review
  Act 3: Connect WordPress → Create Sync → Map Fields → Run Sync → Review

Set environment variables before running:
  DEMO_AIRTABLE_KEY    Airtable Personal Access Token
  DEMO_WP_ENDPOINT     WordPress site URL (e.g. https://yoursite.com)
  DEMO_WP_USERNAME     WordPress username
  DEMO_WP_PASSWORD     WordPress application password

For a clean demo, reset the database first:
  cp scratch.db scratch.db.bak && sqlite3 scratch.db "DELETE FROM connector_account; DELETE FROM data_folder; DELETE FROM sync; DELETE FROM job;"

Run:
  .venv/bin/python -m pytest usability-tests/demo_walkthrough.py \
      --headed --browser chromium --slowmo 300 -s
"""

import csv
import io
import os
import time
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

# ---------------------------------------------------------------------------
# Load .env from scratch-ui root
# ---------------------------------------------------------------------------

_env_file = Path(__file__).resolve().parent.parent / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if value and key.strip() not in os.environ:
            os.environ[key.strip()] = value.strip()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

AIRTABLE_KEY = os.environ.get("DEMO_AIRTABLE_KEY", "")
WP_ENDPOINT = os.environ.get("DEMO_WP_ENDPOINT", "")
WP_USERNAME = os.environ.get("DEMO_WP_USERNAME", "")
WP_PASSWORD = os.environ.get("DEMO_WP_PASSWORD", "")

PAUSE = 2500        # ms — hold on key moments so the audience can read
QUICK_PAUSE = 1000  # ms — between mechanical steps


def narrate(msg: str):
    width = max(len(msg) + 4, 60)
    print(f"\n{'═' * width}")
    print(f"  {msg}")
    print(f"{'═' * width}\n")


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

def _require_airtable():
    if not AIRTABLE_KEY:
        pytest.skip("DEMO_AIRTABLE_KEY not set")


def _require_wordpress():
    for var in ("DEMO_WP_ENDPOINT", "DEMO_WP_USERNAME", "DEMO_WP_PASSWORD"):
        if not os.environ.get(var):
            pytest.skip(f"{var} not set")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _enter_workbook(page: Page):
    """Navigate to a workbook from the home page."""
    page.goto("/")
    page.wait_for_selector("home-page a, app-shell", timeout=5000)
    if page.locator("home-page a").count() > 0:
        page.locator("home-page a").first.click()
    page.wait_for_selector("app-shell", timeout=5000)


def _nav(page: Page, label: str):
    """Click a nav link (header nav or aside footer) and wait for content."""
    loc = page.locator(f"header nav a:has-text('{label}'), aside footer a:has-text('{label}')")
    loc.first.click()
    page.wait_for_load_state("networkidle", timeout=10000)


def _wait_htmx(page: Page, timeout: int = 10000):
    page.wait_for_load_state("networkidle", timeout=timeout)


def _count_finished_jobs(page: Page) -> int:
    """Count jobs that show completed or failed status."""
    return page.locator("mark[data-status='success'], mark[data-status='danger']").count()


def _wait_for_pull_job(page: Page, workbook_url: str, timeout: int = 60):
    """Poll the Runs page until a new job finishes (not just an old one)."""
    page.wait_for_timeout(2000)

    page.goto(f"{workbook_url}/runs")
    page.wait_for_selector("#runs-table", timeout=5000)
    baseline = _count_finished_jobs(page)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        page.wait_for_timeout(3000)
        page.goto(f"{workbook_url}/runs")
        page.wait_for_selector("#runs-table", timeout=5000)
        current = _count_finished_jobs(page)
        if current > baseline:
            return
        if not page.locator(".spinner:visible").first.is_visible(timeout=500):
            if current > 0:
                return
    raise TimeoutError("Pull job did not complete in time")


def _workbook_url(page: Page) -> str:
    """Extract the /w/{id} base URL from the current page URL."""
    url = page.url
    idx = url.find("/w/")
    if idx == -1:
        return url
    rest = url[idx + 3:]
    slash = rest.find("/")
    wid = rest[:slash] if slash != -1 else rest
    return url[:idx] + f"/w/{wid}"


# ═══════════════════════════════════════════════════════════════════════════
# THE DEMO
# ═══════════════════════════════════════════════════════════════════════════

def test_demo(page: Page):
    _require_airtable()
    _require_wordpress()

    # Accept all browser confirmation dialogs (Discard, Delete, etc.)
    page.on("dialog", lambda d: d.accept())

    # ------------------------------------------------------------------
    # OPENING — Enter the app
    # ------------------------------------------------------------------
    narrate("Welcome to Scratch")
    _enter_workbook(page)
    page.wait_for_timeout(PAUSE)

    wb_url = _workbook_url(page)

    # ==================================================================
    #  ACT 1 — Connect Airtable, pull data, edit, review, discard
    # ==================================================================

    narrate("ACT 1: Connect Airtable")

    # --- Connect ---
    narrate("1.1  New Connection → Airtable")
    _nav(page, "Connections")
    page.wait_for_selector("connections-page, empty-state", timeout=5000)
    page.wait_for_timeout(QUICK_PAUSE)

    page.locator("button:has-text('New Connection')").first.click()
    _wait_htmx(page)
    page.wait_for_selector("service-picker", timeout=5000)
    page.wait_for_timeout(PAUSE)

    page.locator("service-picker button:has-text('Airtable')").click()
    _wait_htmx(page)
    page.wait_for_selector("form[hx-post]", timeout=5000)
    page.wait_for_timeout(QUICK_PAUSE)

    narrate("1.2  Enter credentials and connect")
    page.locator("input#apiKey").fill(AIRTABLE_KEY)
    page.wait_for_timeout(QUICK_PAUSE)

    page.locator("button[data-primary]:has-text('Connect')").click()
    page.wait_for_selector(".table-list, mark[data-status='danger']", timeout=30000)
    page.wait_for_timeout(PAUSE)

    error = page.locator("mark[data-status='danger']")
    if error.is_visible(timeout=500):
        raise RuntimeError(f"Airtable connection failed: {error.inner_text()}")

    # --- Select tables ---
    narrate("1.3  Select the Blog Posts table")
    blog_label = page.locator(".table-list li label:has-text('Copier')")
    if blog_label.count() > 0:
        blog_label.first.click()
    else:
        page.locator(".table-list input[type='checkbox']").first.check()
    page.wait_for_timeout(PAUSE)

    narrate("1.4  Link tables — pulling data in the background")
    page.locator("button[data-primary]:has-text('Link')").click()
    _wait_htmx(page, timeout=30000)
    page.wait_for_selector("empty-state", timeout=30000)
    page.wait_for_timeout(PAUSE)

    # --- Wait for pull to finish ---
    narrate("1.5  Waiting for pull to complete...")
    _wait_for_pull_job(page, wb_url, timeout=90)
    page.wait_for_timeout(PAUSE)

    # --- Browse data ---
    narrate("1.6  Data pulled! Browsing the file tree")
    page.goto(wb_url)
    page.wait_for_selector("app-shell", timeout=5000)
    page.wait_for_timeout(QUICK_PAUSE)

    folder_links = page.locator("a.folder-table-link")
    folder_links.first.wait_for(timeout=10000)

    found_records = False
    for i in range(folder_links.count()):
        folder_links.nth(i).click()
        _wait_htmx(page)
        page.wait_for_selector("#main header, #main empty-state", timeout=5000)
        if page.locator("#main a.record-link").first.is_visible(timeout=2000):
            found_records = True
            break

    assert found_records, "No folders with records found after pull"
    page.wait_for_timeout(PAUSE)

    # --- Open and edit first record ---
    narrate("1.7  Open a record and edit it")
    record_links = page.locator("#main a.record-link")
    first_record = record_links.first
    first_record.click()
    page.wait_for_selector("editor-pane", timeout=5000)
    page.wait_for_timeout(PAUSE)

    # Edit the Title field (not Slug — we need slugs intact for Act 3 sync matching)
    title_field = page.locator("span.record-editable[data-field-path='fields.Title']")
    if not title_field.is_visible(timeout=1000):
        # Fallback: skip Slug, pick second editable
        title_field = page.locator("span.record-editable").nth(1)
    if title_field.is_visible(timeout=2000):
        title_field.click()
        title_field.press("End")
        title_field.press_sequentially(" — edited in Scratch", delay=40)
        page.locator("editor-pane header").click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)

    # --- Go back and edit a second record ---
    narrate("1.8  Edit a second record")
    table_link = page.locator("a.folder-table-link").first
    table_link.click()
    _wait_htmx(page)
    page.wait_for_selector("#main a.record-link", timeout=5000)

    second_record = page.locator("#main a.record-link").nth(1)
    if second_record.is_visible(timeout=2000):
        second_record.click()
        page.wait_for_selector("editor-pane", timeout=5000)
        page.wait_for_timeout(QUICK_PAUSE)

        title_field2 = page.locator("span.record-editable[data-field-path='fields.Title']")
        if not title_field2.is_visible(timeout=1000):
            title_field2 = page.locator("span.record-editable").nth(1)
        if title_field2.is_visible(timeout=2000):
            title_field2.click()
            title_field2.press("End")
            title_field2.press_sequentially(" — also edited", delay=40)
            page.locator("editor-pane header").click()
            _wait_htmx(page)
            page.wait_for_timeout(PAUSE)

    # --- Review changes ---
    narrate("1.9  Review: see what changed")
    _nav(page, "Review")
    page.wait_for_selector("review-page, empty-state", timeout=5000)
    page.wait_for_timeout(PAUSE)

    # Table view
    page.locator("button:has-text('Table')").first.click()
    _wait_htmx(page)
    page.wait_for_timeout(PAUSE)

    # Diff view
    page.locator("button:has-text('Diff')").first.click()
    _wait_htmx(page)
    page.wait_for_timeout(PAUSE)
    page.wait_for_timeout(PAUSE)  # let lazy diffs render

    # --- Discard one, keep the other ---
    narrate("1.10  Discard one change, keep the other")
    diff_cards = page.locator("diff-card")
    if diff_cards.count() >= 2:
        diff_cards.nth(1).locator("button:has-text('Discard')").click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)

    narrate("Act 1 complete — Airtable data pulled, edited, reviewed")
    page.wait_for_timeout(PAUSE)

    # ==================================================================
    #  ACT 2 — Download CSV, edit offline, upload, review
    # ==================================================================

    narrate("ACT 2: CSV Workflow")

    narrate("2.1  Navigate to a folder")
    page.goto(wb_url)
    page.wait_for_selector("app-shell", timeout=5000)
    table_link = page.locator("a.folder-table-link").first
    table_link.wait_for(timeout=10000)
    table_link.click()
    _wait_htmx(page)
    page.wait_for_timeout(PAUSE)

    # --- Download CSV ---
    narrate("2.2  Download as CSV")
    with page.expect_download() as download_info:
        page.locator("#main header menu a:has-text('CSV')").click()
    download = download_info.value
    csv_path = download.path()
    page.wait_for_timeout(PAUSE)

    # --- Edit the CSV ---
    narrate("2.3  Edit the CSV (simulating offline changes)")
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    # Find a meaningful text column to edit (prefer Title, skip metadata)
    skip_cols = {"_file", "id", "createdTime"}
    edit_col = None
    fallback_col = None
    for col in fieldnames:
        if col in skip_cols:
            continue
        sample = rows[0].get(col, "") if rows else ""
        if isinstance(sample, str) and sample and not sample.startswith("{"):
            if fallback_col is None:
                fallback_col = col
            if "title" in col.lower():
                edit_col = col
                break
    if not edit_col:
        edit_col = fallback_col

    if edit_col and len(rows) >= 2:
        rows[0][edit_col] = rows[0][edit_col] + " — CSV edit 1"
        rows[1][edit_col] = rows[1][edit_col] + " — CSV edit 2"

    modified_csv = io.StringIO()
    writer = csv.DictWriter(modified_csv, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    modified_csv_path = str(csv_path) + ".modified.csv"
    with open(modified_csv_path, "w", encoding="utf-8") as f:
        f.write(modified_csv.getvalue())

    page.wait_for_timeout(PAUSE)

    # --- Upload modified CSV ---
    narrate("2.4  Upload the edited CSV")
    file_input = page.locator("form.csv-upload-form input[type='file']")
    file_input.set_input_files(modified_csv_path)
    _wait_htmx(page, timeout=30000)
    page.wait_for_timeout(PAUSE)

    # --- Review ---
    narrate("2.5  Review the CSV changes")
    _nav(page, "Review")
    page.wait_for_selector("review-page, empty-state", timeout=5000)
    page.wait_for_timeout(PAUSE)

    if page.locator("review-page").is_visible(timeout=2000):
        page.locator("button:has-text('Table')").first.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)

        page.locator("button:has-text('Diff')").first.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)
        page.wait_for_timeout(PAUSE)  # let lazy diffs render

    narrate("Act 2 complete — CSV round-trip: download, edit, upload, review")
    page.wait_for_timeout(PAUSE)

    # ==================================================================
    #  ACT 3 — Connect WordPress, create sync, run, review
    # ==================================================================

    narrate("ACT 3: Connect WordPress and Sync")

    # --- Connect WordPress ---
    narrate("3.1  New Connection → WordPress")
    _nav(page, "Connections")
    page.wait_for_selector("connections-page, empty-state", timeout=5000)
    page.wait_for_timeout(QUICK_PAUSE)

    page.locator("button:has-text('New Connection')").first.click()
    _wait_htmx(page)
    page.wait_for_selector("service-picker", timeout=5000)
    page.wait_for_timeout(PAUSE)

    page.locator("service-picker button:has-text('WordPress')").click()
    _wait_htmx(page)
    page.wait_for_selector("form[hx-post]", timeout=5000)
    page.wait_for_timeout(QUICK_PAUSE)

    narrate("3.2  Enter WordPress credentials")
    page.locator("input#endpoint").fill(WP_ENDPOINT)
    page.wait_for_timeout(300)
    page.locator("input#username").fill(WP_USERNAME)
    page.wait_for_timeout(300)
    page.locator("input#password").fill(WP_PASSWORD)
    page.wait_for_timeout(QUICK_PAUSE)

    page.locator("button[data-primary]:has-text('Connect')").click()
    page.wait_for_selector(".table-list, mark[data-status='danger']", timeout=30000)
    page.wait_for_timeout(PAUSE)

    error = page.locator("mark[data-status='danger']")
    if error.is_visible(timeout=500):
        raise RuntimeError(f"WordPress connection failed: {error.inner_text()}")

    # Select WordPress Posts table specifically
    narrate("3.3  Select WordPress Posts table")
    posts_cb = page.locator(".table-list li label:has-text('Posts')")
    if posts_cb.count() > 0:
        posts_cb.first.click()
    else:
        page.locator(".table-list input[type='checkbox']").first.check()
    page.wait_for_timeout(PAUSE)

    narrate("3.4  Link tables and pull WordPress data")
    page.locator("button[data-primary]:has-text('Link')").click()
    _wait_htmx(page, timeout=30000)
    page.wait_for_selector("empty-state", timeout=30000)
    page.wait_for_timeout(PAUSE)

    narrate("3.5  Waiting for WordPress pull...")
    _wait_for_pull_job(page, wb_url, timeout=90)
    page.wait_for_timeout(PAUSE)

    # --- Create a sync ---
    narrate("3.6  Create a sync: Airtable → WordPress")
    _nav(page, "Syncs")
    page.wait_for_selector("#main button:has-text('New Sync')", timeout=5000)
    page.wait_for_timeout(PAUSE)

    page.locator("#main button:has-text('New Sync')").click()
    _wait_htmx(page)
    page.wait_for_selector("sync-folder-picker", timeout=5000)
    page.wait_for_timeout(PAUSE)

    # Pick Airtable Blog Posts as source, WordPress Posts as destination
    src_section = page.locator("sync-folder-picker section").first
    dst_section = page.locator("sync-folder-picker section").last

    src_item = src_section.locator("folder-pick-item:has(span:has-text('Blog Posts'))")
    if src_item.count() > 0:
        src_item.first.locator("input[type='radio']").click()
    else:
        src_section.locator("folder-pick-item").first.locator("input[type='radio']").click()
    page.wait_for_timeout(500)

    dst_items = dst_section.locator("folder-pick-item")
    picked_dst = False
    for i in range(dst_items.count()):
        name = dst_items.nth(i).locator("span").first.inner_text()
        if "posts" in name.lower() and "blog" not in name.lower():
            dst_items.nth(i).locator("input[type='radio']").click()
            picked_dst = True
            break
    if not picked_dst:
        dst_items.last.locator("input[type='radio']").click()
    page.wait_for_timeout(PAUSE)

    narrate("3.7  Map fields between source and destination")
    page.locator("button[data-primary]:has-text('Next')").click()
    _wait_htmx(page, timeout=30000)
    page.wait_for_selector("sync-mapper", timeout=15000)
    page.wait_for_timeout(PAUSE)

    # --- Map fields in the sync mapper ---
    # Phase 1: Set match key on "Slug" fields
    src_slug = page.locator("sync-record[data-side='source'] sync-field:has(sync-field-name:has-text('Slug'))")
    dst_slug = page.locator("sync-record[data-side='dest'] sync-field:has(sync-field-name:has-text('slug'))")

    if src_slug.count() > 0 and dst_slug.count() > 0:
        src_slug.first.click()
        page.wait_for_timeout(QUICK_PAUSE)
        dst_slug.first.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)
    else:
        src_fields = page.locator("sync-record[data-side='source'] sync-field:not([data-state='key'])")
        dst_fields = page.locator("sync-record[data-side='dest'] sync-field:not([data-state='key'])")
        if src_fields.count() > 0 and dst_fields.count() > 0:
            src_fields.first.click()
            page.wait_for_timeout(QUICK_PAUSE)
            dst_fields.first.click()
            _wait_htmx(page)
            page.wait_for_timeout(PAUSE)

    # Phase 2: Map fields by name
    FIELD_MAPS = [("Title", "title"), ("Meta Description", "excerpt"), ("Status", "status")]

    for src_name, dst_name in FIELD_MAPS:
        src_f = page.locator(
            "sync-record[data-side='source'] sync-field:not([data-state='key']):not([data-state='mapped'])"
        ).filter(has=page.locator(f"sync-field-name:text-is('{src_name}')"))
        if src_f.count() == 0 or not src_f.first.is_visible(timeout=500):
            continue

        src_f.first.click()
        page.wait_for_timeout(500)

        dst_f = page.locator(
            "sync-record[data-side='dest'] sync-field[data-state='target']"
        ).filter(has=page.locator(f"sync-field-name:text-is('{dst_name}')"))
        if dst_f.count() > 0 and dst_f.first.is_visible(timeout=500):
            dst_f.first.click()
            _wait_htmx(page)
            page.wait_for_timeout(QUICK_PAUSE)
        else:
            # Deselect by clicking source again
            src_f.first.click()
            page.wait_for_timeout(300)

    page.wait_for_timeout(PAUSE)

    # Save the sync
    narrate("3.8  Save the sync configuration")
    save_btn = page.locator("button[data-primary]:has-text('Save')")
    save_btn.wait_for(timeout=5000)
    assert not save_btn.is_disabled(), "Save button is disabled — no mappings were created"
    save_btn.click()
    _wait_htmx(page)
    page.wait_for_timeout(PAUSE)

    # --- Run the sync ---
    narrate("3.9  Run the sync")
    page.wait_for_selector("#main button:has-text('Run')", timeout=5000)
    page.locator("#main button:has-text('Run')").first.click()
    _wait_htmx(page, timeout=30000)
    page.wait_for_timeout(PAUSE)

    # --- Review sync changes ---
    narrate("3.10  Review sync changes")
    _nav(page, "Review")
    page.wait_for_selector("review-page, empty-state", timeout=5000)
    page.wait_for_timeout(PAUSE)

    if page.locator("review-page").is_visible(timeout=2000):
        page.locator("button:has-text('Table')").first.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)

        page.locator("button:has-text('Diff')").first.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)
        page.wait_for_timeout(PAUSE)  # let lazy diffs render

        page.locator("button:has-text('Summary')").first.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)

    # ==================================================================
    #  FINALE
    # ==================================================================

    narrate("DEMO COMPLETE")
    narrate("Three workflows demonstrated:")
    narrate("  1. Connect Airtable, pull, edit records, review changes")
    narrate("  2. Download CSV, edit offline, upload, review diffs")
    narrate("  3. Connect WordPress, sync fields by slug, review results")
    page.wait_for_timeout(PAUSE * 2)
