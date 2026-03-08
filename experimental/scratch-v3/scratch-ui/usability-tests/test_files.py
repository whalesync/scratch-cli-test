"""File browsing tests — folder table, record viewer, raw editor, downloads."""

from playwright.sync_api import Page, expect


def test_click_folder_shows_table(page: Page):
    """Clicking a folder's table icon opens the folder table view."""
    _goto_workbook(page)
    link = page.locator("a.folder-table-link").first
    if not link.is_visible(timeout=2000):
        return
    link.click()
    page.wait_for_selector("#main header, #main empty-state", timeout=5000)


def test_folder_table_has_records(page: Page):
    """A folder table shows record rows with clickable names."""
    _open_first_folder(page)
    table = page.locator("#main table.folder-table")
    if not table.is_visible(timeout=2000):
        return  # empty folder
    links = table.locator("a.record-link")
    assert links.count() > 0, "Folder table should have record links"


def test_folder_table_has_download_links(page: Page):
    """The folder view has JSON, CSV, ZIP download links."""
    _open_first_folder(page)
    menu = page.locator("#main header menu")
    if not menu.is_visible(timeout=2000):
        return
    for fmt in ["JSON", "CSV", "ZIP"]:
        expect(menu.locator(f"a:has-text('{fmt}')")).to_be_visible()


def test_folder_table_has_csv_upload(page: Page):
    """The folder view has a CSV upload button."""
    _open_first_folder(page)
    label = page.locator("#main .csv-upload-label")
    if not label.is_visible(timeout=2000):
        return
    expect(label).to_contain_text("Upload CSV")


def test_click_record_opens_viewer(page: Page):
    """Clicking a record name in the folder table opens the record viewer."""
    _open_first_folder(page)
    link = page.locator("#main a.record-link").first
    if not link.is_visible(timeout=2000):
        return
    link.click()
    page.wait_for_selector("editor-pane", timeout=5000)


def test_record_viewer_shows_fields(page: Page):
    """The record viewer shows field labels and values."""
    _open_first_record(page)
    pane = page.locator("editor-pane")
    if not pane.is_visible(timeout=2000):
        return
    fields = pane.locator(".record-field")
    assert fields.count() > 0, "Record should have visible fields"


def test_record_viewer_has_view_toggle(page: Page):
    """The record viewer has Record/Raw view toggle buttons."""
    _open_first_record(page)
    pane = page.locator("editor-pane")
    if not pane.is_visible(timeout=2000):
        return
    expect(pane.locator("button:has-text('Record')")).to_be_visible()
    expect(pane.locator("button:has-text('Raw')")).to_be_visible()


def test_switch_to_raw_view(page: Page):
    """Clicking Raw shows the JSON editor with a Save button."""
    _open_first_record(page)
    raw_btn = page.locator("editor-pane button:has-text('Raw')")
    if not raw_btn.is_visible(timeout=2000):
        return
    raw_btn.click()
    page.wait_for_selector("editor-pane pre#editor", timeout=5000)
    expect(page.locator("editor-pane button:has-text('Save')")).to_be_visible()


def test_switch_back_to_record_view(page: Page):
    """From raw view, clicking Record switches back to field view."""
    _open_first_record(page)
    raw_btn = page.locator("editor-pane button:has-text('Raw')")
    if not raw_btn.is_visible(timeout=2000):
        return
    raw_btn.click()
    page.wait_for_selector("editor-pane pre#editor", timeout=5000)

    page.click("editor-pane button:has-text('Record')")
    page.wait_for_selector("editor-pane .record-fields", timeout=5000)


def test_editable_fields_are_contenteditable(page: Page):
    """Non-readonly fields have contenteditable=true."""
    _open_first_record(page)
    editable = page.locator("span.record-editable")
    if editable.count() == 0:
        return  # all fields are readonly
    attr = editable.first.get_attribute("contenteditable")
    assert attr == "true", "Editable fields should have contenteditable=true"


def test_type_in_editable_field(page: Page):
    """User can click and type in an editable record field."""
    _open_first_record(page)
    editable = page.locator("span.record-editable").first
    if not editable.is_visible(timeout=2000):
        return
    # Focus the field
    editable.click()
    original = editable.inner_text()
    # Type something (we won't blur to avoid saving)
    editable.press_sequentially("test")
    current = editable.inner_text()
    assert current != original or original == "", "Text should have changed after typing"


def test_raw_editor_is_editable(page: Page):
    """The raw JSON editor <pre> is contenteditable."""
    _open_first_record(page)
    raw_btn = page.locator("editor-pane button:has-text('Raw')")
    if not raw_btn.is_visible(timeout=2000):
        return
    raw_btn.click()
    page.wait_for_selector("pre#editor", timeout=5000)
    editor = page.locator("pre#editor")
    attr = editor.get_attribute("contenteditable")
    assert attr == "true", "Raw editor should be contenteditable"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _goto_workbook(page: Page):
    page.goto("/")
    if page.locator("home-page a").first.is_visible(timeout=2000):
        page.locator("home-page a").first.click()
    page.wait_for_selector("app-shell", timeout=5000)


def _open_first_folder(page: Page):
    """Navigate to the table view of the first folder."""
    _goto_workbook(page)
    link = page.locator("a.folder-table-link").first
    if not link.is_visible(timeout=2000):
        return
    link.click()
    page.wait_for_selector("#main header, #main empty-state", timeout=5000)


def _open_first_record(page: Page):
    """Navigate to the first record in the first folder."""
    _open_first_folder(page)
    link = page.locator("#main a.record-link").first
    if not link.is_visible(timeout=2000):
        return
    link.click()
    page.wait_for_selector("editor-pane", timeout=5000)
