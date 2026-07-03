import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildAcceptBugWorkspace, workspaceDetailMock, workspaceRegistryYaml } from './fixtures/accept-bug-workspace';

/**
 * DEV-10654 — Review surface v2, Phase 7 cutover, driving the REAL built app via `_electron`.
 *
 * Proves the one-branch cutover in `WorkspaceContent`: with `DESKTOP_REVIEW_SURFACE_V2` on
 * (delivered on `GET /users/current`) the new `FolderReviewSurface` renders and its Phase 7 wiring
 * works end-to-end — the context banner + subbar chrome appear, the By-type view groups the pending
 * change, single-clicking a group row opens the `RecordChangesDrawer`, and Approve walks the record
 * up the review ladder (it lands in `accepted-patches.json`). A second test asserts the flag OFF
 * still renders the legacy `FolderDataGrid` unchanged, so the switch actually gates both ways.
 *
 * Reuses the DEV-10609 on-disk fixture (`buildAcceptBugWorkspace`): folder "Records" with record
 * "Alpha" carrying an unreviewed `body` edit (`a0` → `a1-edited`) and record "Bravo" already
 * approved. Hermetic: isolated HOME + userData, the built CLI, all server calls mocked.
 * Build first with `yarn build` (the `test:e2e` script does this).
 */

const MAIN_PROCESS_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');
const SCRATCHMD_BINARY = join(__dirname, '..', '..', 'scratch-git-2', 'target', 'debug', 'scratchmd');

const TEST_CREDENTIALS_ENV_VAR = 'SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON';
const USER_DATA_DIR_ENV_VAR = 'SCRATCH_DESKTOP_USER_DATA_DIR';
const SCRATCHMD_BINARY_ENV_VAR = 'SCRATCH_DESKTOP_SCRATCHMD_BINARY';

const FAKE_TEST_CREDENTIALS = {
  apiToken: 'test-api-token-not-a-real-secret',
  email: 'e2e@whalesync.com',
  tokenExpiresAt: '2099-01-01T00:00:00Z',
  serverUrl: 'https://test-api.scratch.md',
};

const BASE_CURRENT_USER = {
  id: 'user_e2e',
  clerkId: null,
  whalesyncUserId: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  isAdmin: false,
  email: 'e2e@whalesync.com',
  name: 'E2E Test User',
  waitlistApproved: true,
};

/** `GET /users/current` payload with the review-surface-v2 flag flipped to `reviewSurfaceV2On`. */
function currentUserWithFlag(reviewSurfaceV2On: boolean): Record<string, unknown> {
  return { ...BASE_CURRENT_USER, experimentalFlags: { DESKTOP_REVIEW_SURFACE_V2: reviewSurfaceV2On } };
}

const launchedApps: ElectronApplication[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Mock every backend call by pathname; `/users/current` carries the flag state under test. */
async function mockServer(window: Page, detail: string, workbookId: string, currentUser: string): Promise<void> {
  await window.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: string) => route.fulfill({ status: 200, contentType: 'application/json', body });
    if (path === '/users/current') return json(currentUser);
    if (path === `/workbook/${workbookId}`) return json(detail);
    if (path === '/workbook') return json(`[${detail}]`);
    if (url.hostname.endsWith('scratch.md')) {
      console.warn('[e2e] unmocked backend call →', route.request().method(), path);
      return json('[]');
    }
    return route.continue();
  });
}

/** Build the fixture + isolated HOME/userData and launch the app to the auto-opened workspace. */
async function launchAppAtFixture(reviewSurfaceV2On: boolean): Promise<{
  window: Page;
  workspace: ReturnType<typeof buildAcceptBugWorkspace>;
}> {
  const fixtureRoot = makeTempDir('sd-cutover-fixture-');
  const workspace = buildAcceptBugWorkspace(fixtureRoot);

  const homeDir = makeTempDir('sd-cutover-home-');
  mkdirSync(join(homeDir, '.scratchmd'), { recursive: true });
  writeFileSync(join(homeDir, '.scratchmd', 'workspaces.yaml'), workspaceRegistryYaml(workspace));

  const userDataDir = makeTempDir('sd-cutover-userdata-');
  writeFileSync(
    join(userDataDir, 'preferences.json'),
    JSON.stringify({ currentWorkspaceId: workspace.workbookId, workbookSettings: {} }),
  );

  const app = await electron.launch({
    args: [MAIN_PROCESS_ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      HOME: homeDir,
      USERPROFILE: homeDir,
      SCRATCH_DESKTOP_HOME_DIR: homeDir,
      [USER_DATA_DIR_ENV_VAR]: userDataDir,
      [TEST_CREDENTIALS_ENV_VAR]: JSON.stringify(FAKE_TEST_CREDENTIALS),
      [SCRATCHMD_BINARY_ENV_VAR]: SCRATCHMD_BINARY,
      SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE: '1',
    },
  });
  launchedApps.push(app);
  const window = await app.firstWindow();
  await mockServer(
    window,
    JSON.stringify(workspaceDetailMock(workspace)),
    workspace.workbookId,
    JSON.stringify(currentUserWithFlag(reviewSurfaceV2On)),
  );

  // Past the auth gate, StartupRedirect auto-opens the workspace (seeded preference). Generous
  // timeout: the first launch after a fresh build pays a cold-start cost.
  await expect(window.getByRole('button', { name: 'Log in' })).toBeHidden({ timeout: 45_000 });
  return { window, workspace };
}

test.afterEach(async () => {
  for (const app of launchedApps.splice(0)) await app.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('flag ON: the new review surface renders and its drawer approve lands (DEV-10654)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAppAtFixture(true);

  // Select the folder; the v2 context banner is proof the new surface (not FolderDataGrid) mounted.
  await window.getByText(workspace.folderName, { exact: false }).first().click({ timeout: 45_000 });
  await expect(window.getByText(/Review before publishing/i)).toBeVisible({ timeout: 20_000 });
  // Subbar chrome the legacy grid does not have.
  await expect(window.getByLabel('By type')).toBeVisible();
  // One unreviewed change (Alpha) — wait for the live count as the "rows loaded" signal.
  await expect(window.getByText(/Needs review \(1\)/)).toBeVisible({ timeout: 20_000 });
  // A folder with pending records defaults to the "Needs review" filter (pill pressed), so the user
  // lands straight on the work that needs review.
  await expect(window.getByRole('button', { name: /Needs review/, pressed: true })).toBeVisible({ timeout: 20_000 });

  // By-type view groups the one pending record; assert the group's bulk-approve button rendered.
  await window.getByLabel('By type').click();
  await expect(window.getByRole('button', { name: /Approve all/ })).toBeVisible({ timeout: 20_000 });

  // Single-clicking the group's record row opens the RecordChangesDrawer scoped to that group; the
  // drawer's "Approve" button (exact — distinct from the group's "Approve all 1") proves it opened.
  await window.getByText('New record').click();
  const approve = window.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeVisible({ timeout: 20_000 });

  // Approve walks the record up the ladder: no error toast, it lands in accepted-patches.json
  // (Bravo was already accepted by the fixture), and the surface refreshes so the pending pill zeroes.
  await approve.click();
  await expect(window.getByText(/Failed to approve/i)).toHaveCount(0);
  await expect
    .poll(
      () => {
        const data = JSON.parse(readFileSync(workspace.acceptedPatchesPath, 'utf8')) as { patches: { path: string }[] };
        return data.patches.map((patch) => patch.path);
      },
      { timeout: 15_000 },
    )
    .toEqual(expect.arrayContaining([`${workspace.folderName}/A.json`, `${workspace.folderName}/B.json`]));
  await expect(window.getByText(/Needs review \(0\)/)).toBeVisible({ timeout: 15_000 });
});

test('flag OFF: the legacy FolderDataGrid still renders (cutover gates both ways)', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAppAtFixture(false);

  await window.getByText(workspace.folderName, { exact: false }).first().click({ timeout: 45_000 });
  // The legacy grid's footer + Record-view toggle appear; the v2 banner never does.
  await expect(window.getByText(/needs review/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(window.getByLabel('Record view')).toBeVisible({ timeout: 20_000 });
  await expect(window.getByText(/Review before publishing/i)).toHaveCount(0);
});

test('flag ON: deselecting the folder shows the clean empty state, not the review chrome', async () => {
  // Headroom over the 60s default: whichever test launches first pays the post-build cold start.
  test.setTimeout(120_000);
  const { window, workspace } = await launchAppAtFixture(true);

  // Open the folder → the review surface renders.
  const folder = window.getByText(workspace.folderName, { exact: false }).first();
  await folder.click({ timeout: 45_000 });
  await expect(window.getByText(/Review before publishing/i)).toBeVisible({ timeout: 20_000 });

  // Clicking the selected folder again deselects it → the clean "Select a folder" panel, with none
  // of the review chrome (banner + subbar) that made a folderless render look broken.
  await folder.click();
  await expect(window.getByText('Select a folder to view data')).toBeVisible({ timeout: 20_000 });
  await expect(window.getByText(/Review before publishing/i)).toHaveCount(0);
  await expect(window.getByLabel('By type')).toHaveCount(0);
});

// Guard: the bundled fixture binary must exist (built by `yarn build` upstream or `cargo build`).
test.beforeAll(() => {
  try {
    execFileSync(SCRATCHMD_BINARY, ['--version'], { stdio: 'pipe' });
  } catch {
    throw new Error(
      `scratchmd binary not found/executable at ${SCRATCHMD_BINARY}. Run \`cargo build --bin scratchmd\` in scratch-git-2.`,
    );
  }
});
