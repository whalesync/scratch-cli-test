"""
Full walkthrough: a new user opens Scratch and explores every major feature.

This is ONE sequential test that mirrors a real user session:
  Land → pick a workbook → browse files → edit a record → review changes →
  check connections → create a sync → view runs → trigger a pull

Every step is annotated with what we're testing and why.
"""

from playwright.sync_api import Page, expect


def test_complete_user_journey(page: Page):

    # -----------------------------------------------------------------------
    # 1. LANDING — User opens the app for the first time
    # -----------------------------------------------------------------------
    page.goto("/")

    # The home page should show workbooks to choose from, or auto-redirect
    # if there's only one. Either way, we should see something clickable.
    home_links = page.locator("home-page a")
    shell = page.locator("app-shell")
    page.wait_for_selector("home-page a, app-shell", timeout=5000)

    if home_links.count() > 0:
        # Multiple workbooks — user picks the first one
        workbook_name = home_links.first.inner_text()
        home_links.first.click()
        page.wait_for_selector("app-shell", timeout=5000)
    else:
        # Single workbook — already redirected
        assert shell.is_visible()

    # -----------------------------------------------------------------------
    # 2. ORIENTATION — User sees the workspace shell
    # -----------------------------------------------------------------------

    # The header should show the workbook name and a Pull button
    expect(page.locator("app-shell header")).to_be_visible()
    expect(page.locator("app-shell header button:has-text('Pull')")).to_be_visible()

    # The sidebar should have a file tree and four navigation links
    for label in ["Changes", "Connections", "Syncs", "Runs"]:
        expect(page.locator(f"aside nav a:has-text('{label}')")).to_be_visible()

    # The file tree should show at least one connection group with folders
    tree_groups = page.locator("file-tree > details")
    assert tree_groups.count() > 0, "File tree should have folder groups"

    # -----------------------------------------------------------------------
    # 3. FILE TREE — User explores the folder structure
    # -----------------------------------------------------------------------

    # User types in the filter to narrow down folders
    filter_input = page.locator("#tree-filter-input")
    filter_input.fill("blog")
    page.wait_for_timeout(300)

    # Some folders should be hidden, some visible (if any match "blog")
    # Clear the filter to restore everything
    filter_input.fill("")
    page.wait_for_timeout(300)

    # User clicks a folder's table icon to see its contents
    table_link = page.locator("a.folder-table-link").first
    if table_link.is_visible(timeout=2000):
        table_link.click()
        page.wait_for_load_state("networkidle", timeout=5000)

        # -----------------------------------------------------------------------
        # 4. FOLDER TABLE — User browses records in a folder
        # -----------------------------------------------------------------------

        # Should see a header with the folder name and record count
        header = page.locator("#main header")
        expect(header).to_be_visible()

        # Download buttons should be available
        for fmt in ["JSON", "CSV", "ZIP"]:
            expect(page.locator(f"#main header menu a:has-text('{fmt}')")).to_be_visible()

        # CSV upload should be available
        expect(page.locator("#main .csv-upload-label")).to_be_visible()

        # If there are records, click the first one
        record_link = page.locator("#main a.record-link").first
        if record_link.is_visible(timeout=2000):
            record_name = record_link.inner_text()
            record_link.click()
            page.wait_for_selector("editor-pane", timeout=5000)

            # -------------------------------------------------------------------
            # 5. RECORD VIEWER — User views and edits a record
            # -------------------------------------------------------------------

            # Should see field labels and values
            fields = page.locator("editor-pane .record-field")
            assert fields.count() > 0, "Record should have fields"

            # Record/Raw toggle should be present
            expect(page.locator("editor-pane button:has-text('Record')")).to_be_visible()
            expect(page.locator("editor-pane button:has-text('Raw')")).to_be_visible()

            # User clicks an editable field and types something
            editable = page.locator("span.record-editable").first
            if editable.is_visible(timeout=1000):
                editable.click()
                # Remember the original value so we can verify the field is live
                original = editable.inner_text()
                editable.press_sequentially(" edited")

                # The field should now contain the appended text
                assert editable.inner_text().endswith(" edited")

                # User presses Escape / clicks away to NOT save (blur will PATCH,
                # but we don't want to actually mutate data — press Ctrl+Z to undo)
                editable.press("Control+z")
                editable.press("Control+z")
                editable.press("Control+z")
                editable.press("Control+z")
                editable.press("Control+z")
                editable.press("Control+z")
                editable.press("Control+z")

            # User switches to Raw JSON view
            page.click("editor-pane button:has-text('Raw')")
            page.wait_for_selector("pre#editor", timeout=5000)

            # The raw editor should show JSON and have a Save button
            editor = page.locator("pre#editor")
            expect(editor).to_be_visible()
            content = editor.inner_text()
            assert "{" in content, "Raw view should show JSON"
            expect(page.locator("editor-pane button:has-text('Save')")).to_be_visible()

            # User switches back to Record view
            page.click("editor-pane button:has-text('Record')")
            page.wait_for_selector("editor-pane .record-fields", timeout=5000)

    # -----------------------------------------------------------------------
    # 6. REVIEW / CHANGES — User checks for pending changes
    # -----------------------------------------------------------------------
    page.click("aside nav a:has-text('Changes')")
    page.wait_for_load_state("networkidle", timeout=5000)

    # Changes page loads (may be empty if no dirty files)
    review = page.locator("review-page")
    if review.is_visible(timeout=2000):
        # View toggles should be present
        for label in ["Diff", "Table", "Summary"]:
            expect(review.locator(f"button:has-text('{label}')")).to_be_visible()

        # User clicks through each view
        page.click("review-page button:has-text('Table')")
        page.wait_for_load_state("networkidle", timeout=5000)

        page.click("review-page button:has-text('Summary')")
        page.wait_for_load_state("networkidle", timeout=5000)

        page.click("review-page button:has-text('Diff')")
        page.wait_for_load_state("networkidle", timeout=5000)

        # Discard All should require confirmation
        discard = page.locator("review-page button:has-text('Discard All')")
        if discard.is_visible(timeout=1000):
            assert discard.get_attribute("hx-confirm"), "Discard should require confirmation"

    # -----------------------------------------------------------------------
    # 7. CONNECTIONS — User manages data source connections
    # -----------------------------------------------------------------------
    page.click("aside nav a:has-text('Connections')")
    page.wait_for_load_state("networkidle", timeout=5000)
    page.wait_for_selector("connections-page, empty-state", timeout=5000)

    # User sees their existing connections in a table
    conn_table = page.locator("connections-page table")
    if conn_table.is_visible(timeout=2000):
        # Each row should have action buttons
        first_row_menu = page.locator("connections-page table tbody tr td menu").first
        for label in ["Test", "Edit", "Tables", "Delete"]:
            expect(first_row_menu.locator(f"button:has-text('{label}')")).to_be_visible()

        # User clicks Edit on the first connection
        page.locator("connections-page button:has-text('Edit')").first.click()
        page.wait_for_load_state("networkidle", timeout=5000)

        # Edit form appears with Save button and credential fields
        expect(page.locator("#main form button[type='submit']")).to_be_visible()
        expect(page.locator("#main input#displayName")).to_be_visible()

        # User goes back to the connections list
        page.locator("#main button:has-text('Back')").click()
        page.wait_for_load_state("networkidle", timeout=5000)
        page.wait_for_selector("connections-page", timeout=5000)

    # User clicks New Connection to see what services are available
    page.locator("button:has-text('New Connection')").first.click()
    page.wait_for_load_state("networkidle", timeout=5000)
    page.wait_for_selector("service-picker", timeout=5000)

    # The picker shows connectable services
    services = page.locator("service-picker button")
    assert services.count() > 0, "Should show available services"

    # User picks the first enabled service to see the credential form
    enabled = page.locator("service-picker button:not([disabled])")
    if enabled.count() > 0:
        service_name = enabled.first.inner_text().strip()
        enabled.first.click()
        page.wait_for_load_state("networkidle", timeout=5000)
        page.wait_for_selector("form[hx-post]", timeout=5000)

        # The form has a display name and credential fields
        expect(page.locator("input#displayName")).to_be_visible()

        # User fills in the display name
        name_input = page.locator("input#displayName")
        name_input.clear()
        name_input.fill(f"Test {service_name}")

        # User decides not to connect and goes back to the picker
        page.locator("#main button:has-text('Back')").click()
        page.wait_for_load_state("networkidle", timeout=5000)
        page.wait_for_selector("service-picker", timeout=5000)

    # -----------------------------------------------------------------------
    # 8. SYNCS — User explores data sync configuration
    # -----------------------------------------------------------------------
    page.click("aside nav a:has-text('Syncs')")
    page.wait_for_load_state("networkidle", timeout=5000)
    page.wait_for_selector("#main button:has-text('New Sync')", timeout=5000)

    # Should see the syncs list with a count
    header_text = page.locator("#main header span").first.inner_text()
    assert "sync" in header_text.lower()

    # If syncs exist, user clicks one to see the mapper
    sync_link = page.locator("#main table a").first
    if sync_link.is_visible(timeout=2000):
        sync_link.click()
        page.wait_for_load_state("networkidle", timeout=5000)
        page.wait_for_selector("sync-mapper, #main header", timeout=5000)

        mapper = page.locator("sync-mapper")
        if mapper.is_visible(timeout=2000):
            # The mapper shows source and destination columns side by side
            columns = page.locator("sync-columns")
            expect(columns).to_be_visible()

            # There should be a save button
            expect(page.locator("#main button:has-text('Save')")).to_be_visible()

    # User opens the New Sync picker (fresh navigation to avoid HTMX state issues)
    workbook_url = page.url.split("/syncs")[0] if "/syncs" in page.url else page.url.split("/w/")[0] + "/w/" + page.url.split("/w/")[1].split("/")[0]
    page.goto(workbook_url + "/syncs/new")
    page.wait_for_selector("sync-folder-picker", timeout=5000)

    # The picker shows source and destination folder lists with radio buttons
    folder_lists = page.locator("sync-folder-picker folder-pick-list")
    assert folder_lists.count() == 2, "Should have source and dest folder lists"

    # User selects a source folder
    src_radio = page.locator("sync-folder-picker folder-pick-list").first.locator("input[type='radio']").first
    if src_radio.is_visible(timeout=1000):
        src_radio.click()
        page.wait_for_timeout(200)

    # -----------------------------------------------------------------------
    # 9. RUNS — User checks job history
    # -----------------------------------------------------------------------
    page.click("aside nav a:has-text('Runs')")
    page.wait_for_load_state("networkidle", timeout=5000)
    page.wait_for_selector("#main header:has-text('Runs')", timeout=5000)

    # The runs table shows past jobs
    runs_table = page.locator("#main table")
    if runs_table.is_visible(timeout=2000):
        # User expands the first job to see details
        summary_row = page.locator("tr.run-summary").first
        if summary_row.is_visible(timeout=1000):
            summary_row.click()
            page.wait_for_timeout(300)

            # Detail row should be visible
            detail = page.locator("tr.run-detail").first
            if detail.is_visible(timeout=1000):
                # User reads the detail then collapses it
                summary_row.click()
                page.wait_for_timeout(300)

    # -----------------------------------------------------------------------
    # 10. PULL — User triggers a data pull
    # -----------------------------------------------------------------------
    page.click("app-shell header button:has-text('Pull')")
    page.wait_for_selector("#status [data-status]", timeout=5000)

    # Status bar should show feedback
    status_text = page.locator("#status").inner_text()
    assert status_text, "Pull should show a status message"

    # User checks runs to see the new pull job
    page.click("aside nav a:has-text('Runs')")
    page.wait_for_load_state("networkidle", timeout=5000)
    page.wait_for_selector("#main header:has-text('Runs')", timeout=5000)

    # Should have at least one job now
    job_rows = page.locator("#main table tbody.run-group")
    assert job_rows.count() > 0, "Should see the pull job in runs"

    # -----------------------------------------------------------------------
    # 11. WORKBOOK SWITCHER — User switches to a different workbook
    # -----------------------------------------------------------------------
    switcher = page.locator("details#switcher")
    page.click("details#switcher summary")
    expect(switcher.locator("nav")).to_be_visible()

    # If there are multiple workbooks, click the second one
    switcher_links = switcher.locator("nav a")
    if switcher_links.count() > 1:
        switcher_links.nth(1).click()
        page.wait_for_selector("app-shell", timeout=5000)
        # Should still have the full shell with nav
        for label in ["Changes", "Connections", "Syncs", "Runs"]:
            expect(page.locator(f"aside nav a:has-text('{label}')")).to_be_visible()

    # -----------------------------------------------------------------------
    # Done. The user has touched every major surface of the app.
    # -----------------------------------------------------------------------
