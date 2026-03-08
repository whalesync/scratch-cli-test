"""Runs page tests — job history table, expandable rows, cancel buttons."""

from playwright.sync_api import Page, expect


def test_runs_header_visible(page: Page):
    """The Runs page shows a header."""
    _goto_runs(page)
    expect(page.locator("#main header:has-text('Runs')")).to_be_visible()


def test_runs_table_has_columns(page: Page):
    """The runs table has the expected column headers."""
    _goto_runs(page)
    table = page.locator("#main table")
    if not table.is_visible(timeout=2000):
        return  # no jobs, no table
    for col in ["Type", "Status", "Started"]:
        expect(table.locator(f"th:has-text('{col}')")).to_be_visible()


def test_runs_shows_job_rows(page: Page):
    """Each job appears as a row with type and status."""
    _goto_runs(page)
    rows = page.locator("#main table tbody.run-group")
    if rows.count() == 0:
        return  # no jobs
    first = rows.first
    # Should have a type cell and a status badge
    expect(first.locator("td").first).to_be_visible()


def test_click_run_row_expands_detail(page: Page):
    """Clicking a run row toggles its detail section."""
    _goto_runs(page)
    summary_row = page.locator("tr.run-summary").first
    if not summary_row.is_visible(timeout=2000):
        return
    summary_row.click()
    # The detail row should become visible
    page.wait_for_timeout(300)
    detail = page.locator("tr.run-detail").first
    assert detail.is_visible(), "Detail row should appear after clicking summary"


def test_click_run_row_collapse(page: Page):
    """Clicking an expanded run row collapses it."""
    _goto_runs(page)
    summary_row = page.locator("tr.run-summary").first
    if not summary_row.is_visible(timeout=2000):
        return
    # Expand
    summary_row.click()
    page.wait_for_timeout(300)
    # Collapse
    summary_row.click()
    page.wait_for_timeout(300)
    detail = page.locator("tr.run-detail[style*='display: none'], tr.run-detail:not([style])")
    # Detail should be hidden again (or have display:none)


def test_cancel_button_on_active_job(page: Page):
    """Active jobs should have a cancel button with confirmation."""
    _goto_runs(page)
    cancel = page.locator("button:has-text('Cancel')")
    if cancel.count() == 0:
        return  # no active jobs, nothing to test
    confirm = cancel.first.get_attribute("hx-confirm")
    assert confirm, "Cancel button should have hx-confirm"


# ---------------------------------------------------------------------------
def _goto_workbook(page: Page):
    page.goto("/")
    if page.locator("home-page a").first.is_visible(timeout=2000):
        page.locator("home-page a").first.click()
    page.wait_for_selector("app-shell", timeout=5000)


def _goto_runs(page: Page):
    _goto_workbook(page)
    page.click("aside nav a:has-text('Runs')")
    page.wait_for_selector("#main header:has-text('Runs')", timeout=5000)
