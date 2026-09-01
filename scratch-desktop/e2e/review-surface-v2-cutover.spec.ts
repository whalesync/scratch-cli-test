import { expect, test, type Page } from '@playwright/test';
import { buildAcceptBugWorkspace, workspaceDetailMock, workspaceRegistryYaml } from './fixtures/accept-bug-workspace';
import { assertScratchmdBinaryBuilt, closeLaunchedResources, launchReviewApp } from './support/review-app-harness';

/**
 * DEV-10626 / DEV-10654 — Review surface v2 cutover + core review surface, driving the REAL built app
 * via `_electron`.
 *
 * Proves the one-branch cutover in `WorkspaceContent`: with `DESKTOP_REVIEW_SURFACE_V2` on (delivered
 * on `GET /users/current`) the new `FolderReviewSurface` renders and its Phase 7 wiring works
 * end-to-end — the context banner (partitioned `N needs review · M approved` counts) + subbar chrome
 * appear, the By-field view groups the pending changes (with its per-group "Approve all N" bulk
 * action), the Phase 9 change-type filter chips render + select (DEV-10656), and single-clicking a
 * group row opens the `RecordReviewDrawer` with its stepper enabled across the group. A flag-OFF test
 * asserts the legacy `FolderDataGrid` still renders unchanged, so the switch gates both ways. (The
 * drawer's approve/reject ladder + auto-advance are exercised in `review-surface-drawer.spec.ts`.)
 *
 * Uses the DEV-10609 on-disk fixture (`buildAcceptBugWorkspace`): folder "Records" with record A
 * (an unreviewed change) and record B (already approved). Hermetic: isolated HOME + userData, the
 * built CLI, all server calls mocked (see `support/review-app-harness.ts`). Build first with `yarn build`.
 *
 * NOTES on what the v2 surface actually renders here:
 *   - The chrome was renamed in phase 7b (`4f07f8992`): the view toggle is **By field** (not "By type")
 *     and the pending filter pill is **Pending** (not "Needs review"). The pill counts the de-duplicated
 *     union of unreviewed + approved-but-unpublished records, so it reads `Pending (2)`; the honest
 *     "1 record needs review" signal lives in the banner's `1 needs review · 1 approved` subtitle.
 *   - The desktop reads the published/approved snapshots straight from the bare repo's `refs/heads/main`
 *     + `accepted-patches.json` (Slice F.5 — `readDiffGridDataPage`), NOT the folder index, so records
 *     classify correctly without a pull: record A is a `modified` edit against main, record B an approved
 *     (`unpublished`) edit. Both changed the same `body` field, so the By-field view groups them under one
 *     `body` field group (title = the column name) — A's row is unreviewed, B's is the approved ✓ row.
 *     The group's bulk action approves only the not-yet-approved rows, so it reads `Approve all 1` (not
 *     2), while the change-type chip carries the group's row count → `body 2`. Rows read the record name
 *     (Alpha/Bravo) via the fixture schema's `titlePath`. This is why the fixture now writes a
 *     `schema.json`: with no schema the By-field view has no columns and renders "No pending changes".
 */

/** Launch the app at the accept-bug fixture with the review-surface-v2 flag in the given state. */
async function launchAtAcceptFixture(reviewSurfaceV2On: boolean) {
  return launchReviewApp({
    flag: reviewSurfaceV2On,
    build: buildAcceptBugWorkspace,
    registryYaml: workspaceRegistryYaml,
    detailMock: workspaceDetailMock,
  });
}

/** Open the fixture folder and wait for the v2 banner (proof the new surface, not FolderDataGrid, mounted). */
async function openFolderOnReviewSurface(window: Page, folderName: string): Promise<void> {
  await window.getByText(folderName, { exact: false }).first().click({ timeout: 45_000 });
  await expect(window.getByText(/Review before publishing/i)).toBeVisible({ timeout: 20_000 });
}

test.afterEach(closeLaunchedResources);
// Guard: the bundled fixture binary must exist (built by `yarn build` upstream or `cargo build`).
test.beforeAll(assertScratchmdBinaryBuilt);

test('flag ON: the new review surface renders, counts partition, and the drawer opens from a group row (DEV-10654, DEV-10616)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAtAcceptFixture(true);

  await openFolderOnReviewSurface(window, workspace.folderName);
  // Subbar chrome the legacy grid does not have.
  await expect(window.getByLabel('By field')).toBeVisible();
  // The banner partitions the pending set: one record needs review, the other is already approved — no
  // double count (DEV-10687). This doubles as the "rows loaded" signal.
  await expect(window.getByText('1 needs review · 1 approved')).toBeVisible({ timeout: 20_000 });
  // A folder with pending records defaults to the "Pending" filter (pill pressed); the pill counts the
  // union of both records → 2.
  await expect(window.getByRole('button', { name: /Pending/, pressed: true })).toBeVisible({ timeout: 20_000 });

  // By-field view groups both pending records (A modified, B unpublished) under one `body` field group;
  // its bulk action approves only the not-yet-approved rows → A alone → "Approve all 1".
  await window.getByLabel('By field').click();
  await expect(window.getByRole('button', { name: 'Approve all 1' })).toBeVisible({ timeout: 20_000 });

  // Single-clicking a group row opens the RecordReviewDrawer scoped to the group (2 records), so its
  // stepper is enabled and the primary action reads "Approve · next →". (The drawer's approve/reject
  // ladder + auto-advance are exercised in review-surface-drawer.spec.ts.) Rows read the record name, so
  // "Alpha" is record A's row.
  await window.getByText('Alpha').first().click();
  await expect(window.getByRole('button', { name: 'Approve · next →' })).toBeVisible({ timeout: 20_000 });
  await expect(window.getByLabel('Next record')).toBeEnabled();
});

test('flag ON: change-type filter chips render their group count, select exclusively, and toggle off (DEV-10656, DEV-10759)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAtAcceptFixture(true);

  await openFolderOnReviewSurface(window, workspace.folderName);
  // Switch to By-field so the folder-wide By-type set (which feeds both the group blocks and the Phase 9
  // change-type chips) is loaded; the group's bulk button is the "loaded" signal (only A is unreviewed).
  await window.getByLabel('By field').click();
  await expect(window.getByRole('button', { name: 'Approve all 1' })).toBeVisible({ timeout: 20_000 });

  // One chip per By-type group. Both pending records changed `body`, forming a single `body` field group,
  // so its chip carries the group's live row count → "body 2" (chip count == group row count by
  // construction — both A and B are rows, even though only A is unreviewed). There is no dedicated "All"
  // chip (DEV-10759) — nothing is selected by default, so the group chip starts unpressed.
  const bodyChip = window.getByRole('button', { name: 'body 2' });
  await expect(bodyChip).toBeVisible({ timeout: 20_000 });
  await expect(bodyChip).toHaveAttribute('aria-pressed', 'false');

  // Selecting the chip narrows the surface to that change type (an exclusive `change-type` entry in the
  // shared activeFilters store, DEV-10656): it becomes pressed and the By-field group it targets still
  // renders. (The narrowing / drawer-stepper-scoping math is unit-tested in change-type-chips.spec.ts;
  // a hermetic fixture only yields one change-type group, so e2e asserts the wiring, not multi-group
  // narrowing.)
  await bodyChip.click();
  await expect(bodyChip).toHaveAttribute('aria-pressed', 'true');
  await expect(window.getByRole('button', { name: 'Approve all 1' })).toBeVisible();

  // Toggle off (DEV-10759): clicking the active chip clears the change-type filter and returns to the
  // unfiltered state — the chip becomes unpressed again while its group is still present.
  await bodyChip.click();
  await expect(bodyChip).toHaveAttribute('aria-pressed', 'false');
  await expect(window.getByRole('button', { name: 'Approve all 1' })).toBeVisible();
});

test('flag OFF: the legacy FolderDataGrid still renders (cutover gates both ways)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAtAcceptFixture(false);

  await window.getByText(workspace.folderName, { exact: false }).first().click({ timeout: 45_000 });
  // The legacy grid's footer + Record-view toggle appear; the v2 banner never does.
  await expect(window.getByText(/needs review/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(window.getByLabel('Record view')).toBeVisible({ timeout: 20_000 });
  await expect(window.getByText(/Review before publishing/i)).toHaveCount(0);
});

test('flag ON: deselecting the folder shows the clean empty state, not the review chrome', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAtAcceptFixture(true);

  // Open the folder → the review surface renders.
  const folder = window.getByText(workspace.folderName, { exact: false }).first();
  await folder.click({ timeout: 45_000 });
  await expect(window.getByText(/Review before publishing/i)).toBeVisible({ timeout: 20_000 });

  // Clicking the selected folder again deselects it → the clean "Select a folder" panel, with none of
  // the review chrome (banner + subbar) that made a folderless render look broken.
  await folder.click();
  await expect(window.getByText('Select a folder to view data')).toBeVisible({ timeout: 20_000 });
  await expect(window.getByText(/Review before publishing/i)).toHaveCount(0);
  await expect(window.getByLabel('By field')).toHaveCount(0);
});
