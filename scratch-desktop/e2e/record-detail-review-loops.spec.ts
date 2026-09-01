import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  buildReviewSurfaceWorkspace,
  reviewWorkspaceDetailMock,
  reviewWorkspaceRegistryYaml,
  type ReviewRecordSpec,
  type ReviewSurfaceWorkspace,
} from './fixtures/review-surface-workspace';
import { assertScratchmdBinaryBuilt, closeLaunchedResources, launchReviewApp } from './support/review-app-harness';

/**
 * DEV-10610 — the single-record **Reject** and **Discard** loops driven through the REAL built app via
 * `_electron`, closing the gap the QA pass called out: `accept-record-regression.spec.ts` drives the
 * record-detail **Approve** button, but Reject and Discard had only pure-helper unit coverage
 * (`record-optimistic-updates.spec.ts`). Here we click the actual `RecordDetailView` buttons and assert
 * both the optimistic UI flip AND the on-disk truth (working file + accepted-patches.json).
 *
 * Host: the legacy `FolderDataGrid` (flag OFF), whose "Record view" toggle opens `RecordDetailView` — the
 * same proven path `accept-record-regression.spec.ts` uses. `RecordDetailView` and its
 * `handleAccept`/`handleReject`/`handleDiscard` are host-agnostic; the flag-ON review loop is exercised
 * through the `RecordReviewDrawer` in `review-surface-drawer.spec.ts` (the deep-edit `RecordDetailView`
 * overlay is not first-class UI-reachable in the review surface — it opens only via ValidationPanel
 * navigate-to-field). Hermetic (see `support/review-app-harness.ts`); build first with `yarn build`.
 *
 * Classification note: the desktop reads published/approved from the bare repo's `refs/heads/main` +
 * `accepted-patches.json` (Slice F.5), so a `modified` fixture record classifies as `modified` (the
 * modified-header branch: Approve/Reject + the kebab "Discard all unpublished changes"), and a `created`
 * record as `added` (the create banner: Approve/Reject, then a single "Discard" when `addedUnpublished`).
 */

const RECORD_BODY_FIELD_POINTER = 'body';

/** The `fieldData.body` value of a record file on disk (the fixture's diffable field). */
function recordBody(ws: ReviewSurfaceWorkspace, id: string): string {
  const filePath = join(ws.workspacePath, ws.connectionDirName, ws.folderName, `${id}.json`);
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { fieldData: Record<string, string> };
  return parsed.fieldData[RECORD_BODY_FIELD_POINTER];
}

/** Absolute path to a record file in the worktree. */
function recordFilePath(ws: ReviewSurfaceWorkspace, id: string): string {
  return join(ws.workspacePath, ws.connectionDirName, ws.folderName, `${id}.json`);
}

/** The record paths currently in accepted-patches.json (approved side of the ladder). */
function acceptedPatchPaths(ws: ReviewSurfaceWorkspace): string[] {
  const data = JSON.parse(readFileSync(ws.acceptedPatchesPath, 'utf8')) as { patches: { path: string }[] };
  return data.patches.map((patch) => patch.path);
}

/** Launch flag-OFF (legacy FolderDataGrid) at a fixture built from the given records. */
async function launchAt(records: ReviewRecordSpec[]) {
  return launchReviewApp({
    flag: false,
    build: (rootDir) => buildReviewSurfaceWorkspace(rootDir, records),
    registryYaml: reviewWorkspaceRegistryYaml,
    detailMock: reviewWorkspaceDetailMock,
  });
}

/** Open the folder, wait for the grid to load, then open the first row in the record-detail view. */
async function openFirstRecordDetail(window: Page, folderName: string): Promise<void> {
  await window.getByText(folderName, { exact: false }).first().click({ timeout: 20_000 });
  await expect(window.getByText(/needs review/i).first()).toBeVisible({ timeout: 20_000 });
  // The "Record view" toggle is disabled until the grid's rows are loaded — a reliable "ready" signal.
  const recordViewToggle = window.getByLabel('Record view');
  await expect(recordViewToggle).toBeEnabled({ timeout: 20_000 });
  await recordViewToggle.click();
}

test.afterEach(closeLaunchedResources);
test.beforeAll(assertScratchmdBinaryBuilt);

test('record-detail Reject reverts a modified record without approving it (DEV-10610)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAt([{ id: 'Mod', name: 'Mod', state: 'modified' }]);

  await openFirstRecordDetail(window, workspace.folderName);

  const reject = window.getByTestId('record-detail-reject');
  const approve = window.getByTestId('record-detail-approve');
  await expect(reject).toBeVisible({ timeout: 20_000 });
  expect(recordBody(workspace, 'Mod')).toBe('Mod-edited'); // precondition: the unreviewed edit is on disk
  await reject.click();

  // Reject reverts the working edit to the approved/published value (no error toast), the record drops
  // out of review so the Approve/Reject block disappears, and it never reaches the approved set.
  await expect(window.getByText(/Failed to reject record/i)).toHaveCount(0);
  await expect(reject).toBeHidden({ timeout: 15_000 });
  await expect(approve).toBeHidden();
  await expect.poll(() => recordBody(workspace, 'Mod'), { timeout: 15_000 }).toBe('Mod-published');
  expect(acceptedPatchPaths(workspace)).toEqual([]);
});

test('record-detail Approve → Discard walks a modified record all the way back (DEV-10610)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAt([{ id: 'Mod', name: 'Mod', state: 'modified' }]);

  await openFirstRecordDetail(window, workspace.folderName);

  // Approve: the record walks up the ladder (Approve button hidden optimistically) and lands in
  // accepted-patches.json as an approved-but-unpublished edit.
  const approve = window.getByTestId('record-detail-approve');
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await approve.click();
  await expect(window.getByText(/Failed to approve record/i)).toHaveCount(0);
  await expect(approve).toBeHidden({ timeout: 15_000 });
  await expect
    .poll(() => acceptedPatchPaths(workspace), { timeout: 15_000 })
    .toEqual([`${workspace.folderName}/Mod.json`]);

  // Discard (kebab → "Discard all unpublished changes"): the approved edit is dropped and the working
  // file reverts to the published value — the record ends fully back at `unchanged`.
  await window.getByTestId('record-detail-more-actions').click();
  await window.getByTestId('record-detail-discard').click();
  await expect(window.getByText(/Failed to discard record/i)).toHaveCount(0);
  await expect.poll(() => acceptedPatchPaths(workspace), { timeout: 15_000 }).toEqual([]);
  await expect.poll(() => recordBody(workspace, 'Mod'), { timeout: 15_000 }).toBe('Mod-published');
});

test('record-detail Approve → Discard on a created record (DEV-10610)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAt([{ id: 'New', name: 'New', state: 'created' }]);

  await openFirstRecordDetail(window, workspace.folderName);

  // Approve a created (added) record: the create banner flips to the approved state, exposing the single
  // "Discard" button, and the record's create patch lands in accepted-patches.json.
  const approve = window.getByTestId('record-detail-approve');
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await approve.click();
  await expect(window.getByText(/Failed to approve record/i)).toHaveCount(0);
  const discardCreate = window.getByTestId('record-detail-discard-create');
  await expect(discardCreate).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => acceptedPatchPaths(workspace), { timeout: 15_000 })
    .toEqual([`${workspace.folderName}/New.json`]);

  // Discard the created record: its approval is dropped and the new file is removed from disk entirely.
  await discardCreate.click();
  await expect.poll(() => acceptedPatchPaths(workspace), { timeout: 15_000 }).toEqual([]);
  await expect.poll(() => existsSync(recordFilePath(workspace, 'New')), { timeout: 15_000 }).toBe(false);
});
