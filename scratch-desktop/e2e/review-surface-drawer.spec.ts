import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import {
  buildReviewSurfaceWorkspace,
  reviewWorkspaceDetailMock,
  reviewWorkspaceRegistryYaml,
  type ReviewRecordSpec,
} from './fixtures/review-surface-workspace';
import { assertScratchmdBinaryBuilt, closeLaunchedResources, launchReviewApp } from './support/review-app-harness';

/**
 * DEV-10626 / DEV-10616 — the RecordReviewDrawer's multi-record behaviour, driven through the REAL
 * built app via `_electron`: ↑/↓ stepper cycling, the "Approve · next →" auto-advance (the reviewed
 * record lands in accepted-patches.json and the stepped set shrinks), and Reject walking an edit back.
 *
 * Needs several records with distinct states in one folder, which the single-record accept-bug fixture
 * lacks, so this uses the parameterized `buildReviewSurfaceWorkspace`: Ada + Ben (unreviewed) and Cam
 * (approved — it counts on the approved side of the ladder). A hermetic fixture that was never pulled
 * has no "published" baseline, so all three classify as `added` and the By-field view groups them under
 * one "New" record-level group. That is fine here: the drawer's stepper, ladder calls, and auto-advance
 * behave identically for a created vs a modified record.
 *
 * Records display by filename stem, so `getByText('Ada')` targets Ada's group row. Hermetic (see
 * `support/review-app-harness.ts`); build first with `yarn build`.
 */

const FIXTURE_RECORDS: ReviewRecordSpec[] = [
  { id: 'Ada', name: 'Ada', state: 'modified' },
  { id: 'Ben', name: 'Ben', state: 'modified' },
  { id: 'Cam', name: 'Cam', state: 'approved' },
];

async function launchAtReviewFixture() {
  return launchReviewApp({
    flag: true,
    build: (rootDir) => buildReviewSurfaceWorkspace(rootDir, FIXTURE_RECORDS),
    registryYaml: reviewWorkspaceRegistryYaml,
    detailMock: reviewWorkspaceDetailMock,
  });
}

/** Open the folder, switch to By-field, and wait for the group's bulk-approve (its "loaded" signal). */
async function openByFieldGroup(window: Page, folderName: string): Promise<void> {
  await window.getByText(folderName, { exact: false }).first().click({ timeout: 45_000 });
  await expect(window.getByText(/Review before publishing/i)).toBeVisible({ timeout: 20_000 });
  await window.getByLabel('By field').click();
  // The records land in one "New" group; its bulk action is the "group loaded" signal.
  await expect(window.getByRole('button', { name: /Approve all/ })).toBeVisible({ timeout: 20_000 });
}

/** The accepted-patches.json record paths. */
function acceptedPatchPaths(acceptedPatchesPath: string): string[] {
  const data = JSON.parse(readFileSync(acceptedPatchesPath, 'utf8')) as { patches: { path: string }[] };
  return data.patches.map((patch) => patch.path);
}

/** The header stepper "N / M" — the only node of that shape (the title block reads "record N of M"). */
function stepperLocator(window: Page) {
  return window.getByText(/\d+ \/ \d+/);
}

test.afterEach(closeLaunchedResources);
test.beforeAll(assertScratchmdBinaryBuilt);

test('flag ON: the drawer stepper cycles between the changed records (DEV-10616)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAtReviewFixture();

  await openByFieldGroup(window, workspace.folderName);

  // Open Ada's drawer; with multiple records in the group the stepper is enabled and the primary action
  // reads "Approve · next →".
  await window.getByText('Ada').first().click();
  await expect(window.getByRole('button', { name: 'Approve · next →' })).toBeVisible({ timeout: 20_000 });
  const stepper = stepperLocator(window);
  await expect(stepper).toBeVisible();
  const startPosition = (await stepper.textContent())?.trim() ?? '';

  // ↓ advances to another record (stepBy wraps, so this holds from any opening index)…
  await window.getByLabel('Next record').click();
  await expect(stepper).not.toHaveText(startPosition);
  // …and ↑ returns to the record we started on.
  await window.getByLabel('Previous record').click();
  await expect(stepper).toHaveText(startPosition);
});

test('flag ON: "Approve · next →" lands the record and auto-advances the stepper (DEV-10616)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAtReviewFixture();

  await openByFieldGroup(window, workspace.folderName);

  // Open Ada and approve it via the record-level primary action.
  await window.getByText('Ada').first().click();
  const approveNext = window.getByRole('button', { name: 'Approve · next →' });
  await expect(approveNext).toBeVisible({ timeout: 20_000 });
  const stepper = stepperLocator(window);
  const startPosition = (await stepper.textContent())?.trim() ?? '';
  await approveNext.click();

  // Ada walks up the ladder (no error toast) and lands in accepted-patches.json alongside the fixture's
  // pre-approved Cam.
  await expect(window.getByText(/Failed to approve/i)).toHaveCount(0);
  await expect
    .poll(() => acceptedPatchPaths(workspace.acceptedPatchesPath), { timeout: 15_000 })
    .toEqual(expect.arrayContaining([`${workspace.folderName}/Ada.json`, `${workspace.folderName}/Cam.json`]));

  // The reviewed record drops out of the stepped set, so the drawer stays open on the next record with
  // the count now smaller — proof of the auto-advance + live refresh.
  await expect(stepper).not.toHaveText(startPosition);
});

test('flag ON: Reject walks an unreviewed record back without approving it (DEV-10616)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAtReviewFixture();

  await openByFieldGroup(window, workspace.folderName);

  // Open Ben and reject the record via the footer action.
  await window.getByText('Ben').first().click();
  await expect(window.getByRole('button', { name: 'Approve · next →' })).toBeVisible({ timeout: 20_000 });
  await window.getByRole('button', { name: 'Reject', exact: true }).last().click();

  // Reject reverts Ben (no error toast) — it must NOT reach the approved set, so accepted-patches.json
  // still holds only the pre-approved Cam, and Ben leaves the needs-review count (2 → 1).
  await expect(window.getByText(/Failed to reject/i)).toHaveCount(0);
  await expect(window.getByText('1 needs review · 1 approved')).toBeVisible({ timeout: 15_000 });
  expect(acceptedPatchPaths(workspace.acceptedPatchesPath)).toEqual([`${workspace.folderName}/Cam.json`]);
});

// NOTE: the record-level approved-state chrome (the "✓ approved" header + "Next →" footer, which need a
// row whose `__rowStatus` is `addedUnpublished`) is intentionally NOT covered here. That status only
// appears after the app's own `acceptRecord` updates the folder index; a hermetic pre-seeded fixture
// yields `added` records that merely *count* as approved (see review-surface-grid-data.spec.ts's
// `filterCounts` partition). The approved-state rendering itself is owned by the unit tests
// (build-by-type-group-model.spec.ts, review-table-cell-drawing.spec.ts) and Storybook.
