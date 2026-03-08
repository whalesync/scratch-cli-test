"""Connection management tests — list, new, service picker, form, actions."""

from playwright.sync_api import Page, expect


def test_connections_list_shows_table(page: Page):
    """Connections page shows a table of existing connections."""
    _goto_connections(page)
    page.wait_for_selector("connections-page table, empty-state", timeout=5000)


def test_connections_has_new_button(page: Page):
    """There's a New Connection button on the connections page."""
    _goto_connections(page)
    expect(page.locator("button:has-text('New Connection')").first).to_be_visible()


def test_new_connection_opens_picker(page: Page):
    """Clicking New Connection shows the service picker grid."""
    _goto_connections(page)
    page.locator("button:has-text('New Connection')").first.click()
    _wait_htmx(page)
    page.wait_for_selector("service-picker", timeout=5000)


def test_service_picker_has_services(page: Page):
    """The service picker shows at least one connectable service."""
    _open_service_picker(page)
    buttons = page.locator("service-picker button")
    assert buttons.count() > 0, "Expected at least one service button"


def test_pick_service_shows_form(page: Page):
    """Clicking a non-OAuth service opens the credential form."""
    _open_service_picker(page)
    enabled = page.locator("service-picker button:not([disabled])")
    if enabled.count() == 0:
        return
    enabled.first.click()
    _wait_htmx(page)
    page.wait_for_selector("form button[type='submit']", timeout=5000)


def test_form_has_display_name_field(page: Page):
    """The connection form has a display name input."""
    _open_first_service_form(page)
    expect(page.locator("input#displayName")).to_be_visible()


def test_form_back_button(page: Page):
    """The Back button on the form returns to the picker."""
    _open_first_service_form(page)
    page.click("button:has-text('← Back')")
    _wait_htmx(page)
    page.wait_for_selector("service-picker", timeout=5000)


def test_connection_row_has_actions(page: Page):
    """Each connection row has Test, Edit, Tables, Delete buttons."""
    _goto_connections(page)
    row_menu = page.locator("connections-page table tbody tr td menu").first
    if not row_menu.is_visible(timeout=2000):
        return
    for label in ["Test", "Edit", "Tables", "Delete"]:
        expect(row_menu.locator(f"button:has-text('{label}')")).to_be_visible()


def test_click_edit_shows_form(page: Page):
    """Clicking Edit on a connection opens the edit form."""
    _goto_connections(page)
    edit_btn = page.locator("connections-page button:has-text('Edit')").first
    if not edit_btn.is_visible(timeout=2000):
        return
    edit_btn.click()
    _wait_htmx(page)
    # Edit form has a "Save" submit button
    page.wait_for_selector("#main form button[type='submit']", timeout=5000)


def test_edit_form_back_to_list(page: Page):
    """The Back button on the edit form returns to the connections list."""
    _goto_connections(page)
    edit_btn = page.locator("connections-page button:has-text('Edit')").first
    if not edit_btn.is_visible(timeout=2000):
        return
    edit_btn.click()
    _wait_htmx(page)
    page.wait_for_selector("#main form", timeout=5000)

    page.click("button:has-text('← Back')")
    _wait_htmx(page)
    page.wait_for_selector("connections-page", timeout=5000)


def test_delete_button_has_confirmation(page: Page):
    """The Delete button triggers a browser confirmation dialog."""
    _goto_connections(page)
    delete_btn = page.locator("connections-page button:has-text('Delete')").first
    if not delete_btn.is_visible(timeout=2000):
        return
    confirm = delete_btn.get_attribute("hx-confirm")
    assert confirm, "Delete button should have hx-confirm attribute"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _wait_htmx(page: Page):
    """Wait for HTMX to finish swapping content."""
    page.wait_for_load_state("networkidle", timeout=5000)


def _goto_workbook(page: Page):
    page.goto("/")
    if page.locator("home-page a").first.is_visible(timeout=2000):
        page.locator("home-page a").first.click()
    page.wait_for_selector("app-shell", timeout=5000)


def _goto_connections(page: Page):
    _goto_workbook(page)
    page.click("aside nav a:has-text('Connections')")
    _wait_htmx(page)
    page.wait_for_selector("connections-page, empty-state", timeout=5000)


def _open_service_picker(page: Page):
    _goto_connections(page)
    page.locator("button:has-text('New Connection')").first.click()
    _wait_htmx(page)
    page.wait_for_selector("service-picker", timeout=5000)


def _open_first_service_form(page: Page):
    _open_service_picker(page)
    enabled = page.locator("service-picker button:not([disabled])")
    if enabled.count() == 0:
        return
    enabled.first.click()
    _wait_htmx(page)
    page.wait_for_selector("form[hx-post]", timeout=5000)
