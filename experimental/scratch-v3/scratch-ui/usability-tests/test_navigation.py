"""Navigation smoke tests — can a user reach every section of the app?"""

from playwright.sync_api import Page, expect


def test_home_page_shows_workbooks(page: Page):
    """Home page lists workbooks the user can click into."""
    page.goto("/")
    # Either we see a list of workbooks or got redirected into one
    page.wait_for_selector("home-page a, app-shell", timeout=5000)


def test_click_into_workbook(page: Page):
    """Clicking a workbook on the home page loads the shell."""
    page.goto("/")
    loc = page.locator("home-page a").first
    if loc.is_visible():
        loc.click()
    page.wait_for_selector("app-shell", timeout=5000)
    expect(page.locator("app-shell header")).to_be_visible()


def test_shell_has_all_nav_links(page: Page):
    """Sidebar nav has Changes, Connections, Syncs, Runs."""
    _goto_workbook(page)
    for label in ["Changes", "Connections", "Syncs", "Runs"]:
        expect(page.locator(f"aside nav a:has-text('{label}')")).to_be_visible()


def test_workbook_switcher_opens(page: Page):
    """The workbook name in the header opens a dropdown when clicked."""
    _goto_workbook(page)
    page.click("details#switcher summary")
    expect(page.locator("details#switcher nav")).to_be_visible()


def test_nav_changes(page: Page):
    """Clicking Changes loads the review partial into main."""
    _goto_workbook(page)
    page.click("aside nav a:has-text('Changes')")
    page.wait_for_selector("#main header, #main empty-state", timeout=5000)


def test_nav_connections(page: Page):
    """Clicking Connections loads connections list or empty state."""
    _goto_workbook(page)
    page.click("aside nav a:has-text('Connections')")
    page.wait_for_selector("connections-page, empty-state", timeout=5000)


def test_nav_syncs(page: Page):
    """Clicking Syncs loads the syncs list."""
    _goto_workbook(page)
    page.click("aside nav a:has-text('Syncs')")
    page.wait_for_selector("#main button:has-text('New Sync'), #main header", timeout=5000)


def test_nav_runs(page: Page):
    """Clicking Runs loads the runs table."""
    _goto_workbook(page)
    page.click("aside nav a:has-text('Runs')")
    page.wait_for_selector("#main header:has-text('Runs')", timeout=5000)


def test_pull_button_visible(page: Page):
    """The Pull button is in the shell header."""
    _goto_workbook(page)
    expect(page.locator("app-shell header button:has-text('Pull')")).to_be_visible()


def test_rapid_nav_switching(page: Page):
    """Clicking between nav items rapidly doesn't break the UI."""
    _goto_workbook(page)
    for label in ["Runs", "Connections", "Syncs", "Changes", "Runs"]:
        page.click(f"aside nav a:has-text('{label}')")
        page.wait_for_timeout(300)
    # The last one (Runs) should be loaded
    page.wait_for_selector("#main header:has-text('Runs')", timeout=5000)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _goto_workbook(page: Page):
    """Navigate into the first available workbook."""
    page.goto("/")
    # If home has multiple workbooks, click the first one
    if page.locator("home-page a").first.is_visible(timeout=2000):
        page.locator("home-page a").first.click()
    page.wait_for_selector("app-shell", timeout=5000)
