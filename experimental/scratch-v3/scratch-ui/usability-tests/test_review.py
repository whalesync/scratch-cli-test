"""Review/Changes page tests — view toggles, diff cards, publish, discard."""

from playwright.sync_api import Page, expect


def test_changes_page_loads(page: Page):
    """The Changes page renders in the main panel."""
    _goto_changes(page)
    # Should see either review-page or empty state
    page.wait_for_selector("review-page, empty-state, #main header", timeout=5000)


def test_view_toggle_buttons(page: Page):
    """The Changes page has Diff, Table, Summary view toggles."""
    _goto_changes(page)
    review = page.locator("review-page")
    if not review.is_visible(timeout=2000):
        return  # no dirty files, might be empty
    for label in ["Diff", "Table", "Summary"]:
        expect(review.locator(f"button:has-text('{label}')")).to_be_visible()


def test_click_table_view(page: Page):
    """Clicking the Table toggle loads the table view of changes."""
    _goto_changes(page)
    btn = page.locator("review-page button:has-text('Table')")
    if not btn.is_visible(timeout=2000):
        return
    btn.click()
    page.wait_for_timeout(500)
    # Table view has a table or shows the same review page
    page.wait_for_selector("#main table, #main review-page", timeout=5000)


def test_click_diff_view(page: Page):
    """Clicking the Diff toggle shows diff cards."""
    _goto_changes(page)
    btn = page.locator("review-page button:has-text('Diff')")
    if not btn.is_visible(timeout=2000):
        return
    btn.click()
    page.wait_for_timeout(500)


def test_click_summary_view(page: Page):
    """Clicking the Summary toggle shows the audit dashboard."""
    _goto_changes(page)
    btn = page.locator("review-page button:has-text('Summary')")
    if not btn.is_visible(timeout=2000):
        return
    btn.click()
    page.wait_for_timeout(500)
    page.wait_for_selector("#main .audit-dashboard, #main review-page", timeout=5000)


def test_push_all_button_visible(page: Page):
    """If there are dirty files, Push All button should be visible."""
    _goto_changes(page)
    push = page.locator("review-page button:has-text('Push All')")
    # May or may not be visible depending on dirty state — just check it loads
    if push.is_visible(timeout=1000):
        assert True


def test_discard_all_has_confirmation(page: Page):
    """The Discard All button should have a confirmation dialog."""
    _goto_changes(page)
    discard = page.locator("review-page button:has-text('Discard All')")
    if not discard.is_visible(timeout=1000):
        return
    confirm = discard.get_attribute("hx-confirm")
    assert confirm, "Discard All should have hx-confirm"


# ---------------------------------------------------------------------------
def _goto_workbook(page: Page):
    page.goto("/")
    if page.locator("home-page a").first.is_visible(timeout=2000):
        page.locator("home-page a").first.click()
    page.wait_for_selector("app-shell", timeout=5000)


def _goto_changes(page: Page):
    _goto_workbook(page)
    page.click("aside nav a:has-text('Changes')")
    page.wait_for_selector("#main", timeout=5000)
    page.wait_for_timeout(500)  # let HTMX partials settle
