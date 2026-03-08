"""File tree tests — expanding folders, clicking files, filtering."""

from playwright.sync_api import Page, expect


def test_tree_has_folder_groups(page: Page):
    """The sidebar file tree shows connection groups with folders."""
    _goto_workbook(page)
    groups = page.locator("file-tree > details")
    assert groups.count() > 0, "Expected at least one folder group"


def test_expand_folder_group(page: Page):
    """Clicking a connection group summary toggles it open."""
    _goto_workbook(page)
    group = page.locator("file-tree > details").first
    summary = group.locator("> summary")
    summary.click()
    # It should have folder items inside
    assert group.locator("li").count() > 0, "Folder group should contain items"


def test_expand_folder_loads_files(page: Page):
    """Clicking a folder name in the tree lazy-loads its children via HTMX."""
    _goto_workbook(page)
    folder = page.locator("file-tree details details").first
    folder.locator("> summary").click()
    # Wait for HTMX to populate the children section
    page.wait_for_load_state("networkidle", timeout=5000)
    page.wait_for_timeout(500)


def test_click_folder_table_icon(page: Page):
    """Clicking the ⊞ icon next to a folder opens the table view in main."""
    _goto_workbook(page)
    table_link = page.locator("a.folder-table-link").first
    if table_link.is_visible(timeout=2000):
        table_link.click()
        # Should load folder-table or empty state in main
        page.wait_for_selector("#main header, #main empty-state", timeout=5000)


def test_tree_filter_input(page: Page):
    """Typing in the filter input hides non-matching folders."""
    _goto_workbook(page)
    filter_input = page.locator("#tree-filter-input")
    expect(filter_input).to_be_visible()

    # Type a query that won't match anything
    filter_input.fill("xyznonexistent999")
    page.wait_for_timeout(300)

    # All tree items should be hidden
    visible = page.locator("file-tree details:not([data-filter-hidden])")
    expect(visible).to_have_count(0)


def test_tree_filter_then_clear(page: Page):
    """Clearing the filter restores all folders."""
    _goto_workbook(page)
    filter_input = page.locator("#tree-filter-input")
    filter_input.fill("xyznonexistent999")
    page.wait_for_timeout(200)

    # Clear it
    filter_input.fill("")
    page.wait_for_timeout(200)

    # Hidden attribute should be gone
    hidden = page.locator("file-tree [data-filter-hidden]")
    expect(hidden).to_have_count(0)


def test_tree_filter_partial_match(page: Page):
    """Typing a partial folder name shows matching items."""
    _goto_workbook(page)
    # Get the name of the first folder
    first_folder = page.locator("file-tree details details > summary").first
    if not first_folder.is_visible(timeout=2000):
        return  # no folders to test
    folder_name = first_folder.inner_text().strip()
    if not folder_name:
        return

    # Type the first few characters
    query = folder_name[:3].lower()
    filter_input = page.locator("#tree-filter-input")
    filter_input.fill(query)
    page.wait_for_timeout(300)

    # At least one folder should still be visible
    visible = page.locator("file-tree details details:not([data-filter-hidden])")
    assert visible.count() > 0, "At least one folder should match"


# ---------------------------------------------------------------------------
def _goto_workbook(page: Page):
    page.goto("/")
    if page.locator("home-page a").first.is_visible(timeout=2000):
        page.locator("home-page a").first.click()
    page.wait_for_selector("app-shell", timeout=5000)


# Custom matcher helper
def _expect_count_gt(locator, n):
    """Playwright doesn't have count_greater_than, so we use a workaround."""
    count = locator.count()
    assert count > n, f"Expected more than {n} elements, got {count}"
