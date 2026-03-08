"""Act 3 only — assumes Acts 1+2 already ran and state is in DB."""

import os
import time
from pathlib import Path

import pytest
from playwright.sync_api import Page

_env_file = Path(__file__).resolve().parent.parent / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if value and key.strip() not in os.environ:
            os.environ[key.strip()] = value.strip()

PAUSE = 2500
QUICK_PAUSE = 1000


def narrate(msg: str):
    width = max(len(msg) + 4, 60)
    print(f"\n{'=' * width}")
    print(f"  {msg}")
    print(f"{'=' * width}\n")


def _nav(page: Page, label: str):
    loc = page.locator(f"header nav a:has-text('{label}'), aside footer a:has-text('{label}')")
    loc.first.click()
    page.wait_for_load_state("networkidle", timeout=10000)


def _wait_htmx(page: Page, timeout: int = 10000):
    page.wait_for_load_state("networkidle", timeout=timeout)


def _workbook_url(page: Page) -> str:
    url = page.url
    idx = url.find("/w/")
    if idx == -1:
        return url
    rest = url[idx + 3:]
    slash = rest.find("/")
    wid = rest[:slash] if slash != -1 else rest
    return url[:idx] + f"/w/{wid}"


def test_act3(page: Page):
    page.on("dialog", lambda d: d.accept())

    page.goto("/")
    page.wait_for_selector("home-page a, app-shell", timeout=5000)
    if page.locator("home-page a").count() > 0:
        page.locator("home-page a").first.click()
    page.wait_for_selector("app-shell", timeout=5000)
    wb_url = _workbook_url(page)

    # --- Create a sync ---
    narrate("3.6  Create a sync: Airtable → WordPress")
    _nav(page, "Syncs")
    page.wait_for_selector("#main button:has-text('New Sync')", timeout=5000)
    page.wait_for_timeout(PAUSE)

    page.locator("#main button:has-text('New Sync')").click()
    _wait_htmx(page)
    page.wait_for_selector("sync-folder-picker", timeout=5000)
    page.wait_for_timeout(PAUSE)

    src_list = page.locator("sync-folder-picker section").first.locator("folder-pick-item")
    dst_list = page.locator("sync-folder-picker section").last.locator("folder-pick-item")

    if src_list.count() > 0:
        src_list.first.locator("input[type='radio']").click()
        page.wait_for_timeout(500)

    if dst_list.count() > 0:
        dst_list.last.locator("input[type='radio']").click()
        page.wait_for_timeout(500)
    page.wait_for_timeout(PAUSE)

    narrate("3.7  Map fields between source and destination")
    page.locator("button[data-primary]:has-text('Next')").click()
    _wait_htmx(page, timeout=30000)
    page.wait_for_selector("sync-mapper", timeout=15000)
    page.wait_for_timeout(PAUSE)

    # Phase 1: Set match key
    src_fields = page.locator("sync-record[data-side='source'] sync-field:not([data-state='key'])")
    dst_fields = page.locator("sync-record[data-side='dest'] sync-field:not([data-state='key'])")

    if src_fields.count() > 0 and dst_fields.count() > 0:
        src_fields.first.click()
        page.wait_for_timeout(QUICK_PAUSE)
        dst_fields.first.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)

    # Phase 2: Map additional fields
    src_unmapped = page.locator(
        "sync-record[data-side='source'] sync-field:not([data-state='key']):not([data-state='mapped'])"
    )
    dst_unmapped = page.locator(
        "sync-record[data-side='dest'] sync-field:not([data-state='key']):not([data-state='mapped'])"
    )

    n_maps = min(src_unmapped.count(), dst_unmapped.count(), 3)
    for i in range(n_maps):
        src_f = page.locator(
            "sync-record[data-side='source'] sync-field:not([data-state='key']):not([data-state='mapped'])"
        ).first
        dst_f = page.locator(
            "sync-record[data-side='dest'] sync-field:not([data-state='key']):not([data-state='mapped']):not([data-state='target'])"
        ).first

        if not src_f.is_visible(timeout=1000) or not dst_f.is_visible(timeout=1000):
            break

        src_f.click()
        page.wait_for_timeout(500)
        target = page.locator(
            "sync-record[data-side='dest'] sync-field[data-state='target']"
        ).first
        if target.is_visible(timeout=1000):
            target.click()
            _wait_htmx(page)
            page.wait_for_timeout(QUICK_PAUSE)

    page.wait_for_timeout(PAUSE)

    # Save the sync
    narrate("3.8  Save the sync configuration")
    save_btn = page.locator("button[data-primary]:has-text('Save')")
    if save_btn.is_visible(timeout=2000) and not save_btn.is_disabled():
        save_btn.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)

    # Run the sync
    narrate("3.9  Run the sync")
    page.wait_for_selector("#main button:has-text('Run')", timeout=5000)
    page.locator("#main button:has-text('Run')").first.click()
    _wait_htmx(page, timeout=30000)
    page.wait_for_timeout(PAUSE)

    # Review sync changes
    narrate("3.10  Review sync changes")
    _nav(page, "Review")
    page.wait_for_selector("review-page, empty-state", timeout=5000)
    page.wait_for_timeout(PAUSE)

    if page.locator("review-page").is_visible(timeout=2000):
        page.locator("button:has-text('Table')").first.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)

        page.locator("button:has-text('Summary')").first.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)

    # Publish sync changes
    narrate("3.11  Publish all sync changes")
    _nav(page, "Publish")
    page.wait_for_selector("review-page, empty-state", timeout=5000)
    page.wait_for_timeout(QUICK_PAUSE)
    push_btn = page.locator("button[data-primary]:has-text('All')")
    if push_btn.is_visible(timeout=2000):
        push_btn.click()
        _wait_htmx(page)
        page.wait_for_timeout(PAUSE)

    narrate("ACT 3 COMPLETE")
    page.wait_for_timeout(PAUSE)
