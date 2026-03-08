"""Pull button tests — clicking Pull triggers a background job."""

from playwright.sync_api import Page, expect


def test_pull_button_click_shows_status(page: Page):
    """Clicking Pull shows a status message in the sidebar."""
    _goto_workbook(page)
    page.click("app-shell header button:has-text('Pull')")
    # The #status output should show a message
    page.wait_for_selector("#status [data-status]", timeout=5000)
    status = page.locator("#status")
    text = status.inner_text()
    # Should mention "Pull started" or "Pull" in some form
    assert text, "Status should have feedback text after clicking Pull"


def test_pull_then_check_runs(page: Page):
    """After pulling, navigating to Runs shows the new job."""
    _goto_workbook(page)
    page.click("app-shell header button:has-text('Pull')")
    page.wait_for_selector("#status [data-status]", timeout=5000)

    # Navigate to runs
    page.click("aside nav a:has-text('Runs')")
    page.wait_for_selector("#main header:has-text('Runs')", timeout=5000)

    # Should have at least one job row
    rows = page.locator("#main table tbody.run-group")
    assert rows.count() > 0, "Runs should have at least one job after pulling"


# ---------------------------------------------------------------------------
def _goto_workbook(page: Page):
    page.goto("/")
    if page.locator("home-page a").first.is_visible(timeout=2000):
        page.locator("home-page a").first.click()
    page.wait_for_selector("app-shell", timeout=5000)
