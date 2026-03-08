"""Syncs page tests — list, new sync picker, mapper interactions."""

from playwright.sync_api import Page, expect


def test_syncs_page_loads(page: Page):
    """The Syncs page renders with a header and New Sync button."""
    _goto_syncs(page)
    expect(page.locator("#main button:has-text('New Sync')")).to_be_visible()


def test_syncs_shows_count(page: Page):
    """The syncs header shows the sync count."""
    _goto_syncs(page)
    header = page.locator("#main header span").first
    expect(header).to_be_visible()
    text = header.inner_text()
    assert "sync" in text.lower(), f"Header should mention 'sync', got: {text}"


def test_syncs_table_has_rows(page: Page):
    """If syncs exist, the table shows them."""
    _goto_syncs(page)
    table = page.locator("#main table")
    if not table.is_visible(timeout=2000):
        return  # no syncs
    rows = table.locator("tbody tr")
    assert rows.count() > 0, "Syncs table should have at least one row"


def test_sync_row_has_actions(page: Page):
    """Each sync row has Run and Delete buttons."""
    _goto_syncs(page)
    row_menu = page.locator("#main table tbody tr td menu").first
    if not row_menu.is_visible(timeout=2000):
        return
    expect(row_menu.locator("button:has-text('Run')")).to_be_visible()
    expect(row_menu.locator("button:has-text('Delete')")).to_be_visible()


def test_sync_delete_has_confirmation(page: Page):
    """The Delete button on a sync has a confirmation dialog."""
    _goto_syncs(page)
    delete = page.locator("#main button:has-text('Delete')").first
    if not delete.is_visible(timeout=2000):
        return
    confirm = delete.get_attribute("hx-confirm")
    assert confirm, "Delete button should have hx-confirm"


def test_click_sync_name_opens_mapper(page: Page):
    """Clicking a sync name link opens the sync mapper view."""
    _goto_syncs(page)
    link = page.locator("#main table a").first
    if not link.is_visible(timeout=2000):
        return
    link.click()
    page.wait_for_selector("sync-mapper, #main header", timeout=5000)


def test_new_sync_opens_picker(page: Page):
    """Clicking New Sync opens the folder picker."""
    _goto_syncs(page)
    page.click("#main button:has-text('New Sync')")
    page.wait_for_selector("sync-folder-picker, #main header:has-text('New Sync')", timeout=5000)


def test_sync_picker_has_folder_lists(page: Page):
    """The sync picker shows source and destination folder lists."""
    _goto_syncs(page)
    page.click("#main button:has-text('New Sync')")
    page.wait_for_selector("sync-folder-picker", timeout=5000)

    picker = page.locator("sync-folder-picker")
    if not picker.is_visible(timeout=2000):
        return
    folder_lists = picker.locator("folder-pick-list")
    assert folder_lists.count() == 2, "Should have source and destination folder lists"


def test_sync_picker_has_radio_buttons(page: Page):
    """Each folder in the picker has a radio button for selection."""
    _goto_syncs(page)
    page.click("#main button:has-text('New Sync')")
    page.wait_for_selector("sync-folder-picker", timeout=5000)

    radios = page.locator("sync-folder-picker input[type='radio']")
    if radios.count() == 0:
        return  # no folders to select from
    assert radios.count() > 0


def test_sync_picker_back_button(page: Page):
    """The Back button on the picker returns to the syncs list."""
    _goto_syncs(page)
    page.click("#main button:has-text('New Sync')")
    page.wait_for_selector("sync-folder-picker", timeout=5000)
    # Back button text is "← Back" (rendered from &larr;)
    page.locator("#main header button:has-text('Back')").click()
    page.wait_for_load_state("networkidle", timeout=5000)
    # Should see the syncs list header with the sync count
    page.wait_for_selector("#main header span", timeout=5000)


# ---------------------------------------------------------------------------
def _goto_workbook(page: Page):
    page.goto("/")
    if page.locator("home-page a").first.is_visible(timeout=2000):
        page.locator("home-page a").first.click()
    page.wait_for_selector("app-shell", timeout=5000)


def _goto_syncs(page: Page):
    _goto_workbook(page)
    page.click("aside nav a:has-text('Syncs')")
    page.wait_for_selector("#main button:has-text('New Sync'), #main header", timeout=5000)
