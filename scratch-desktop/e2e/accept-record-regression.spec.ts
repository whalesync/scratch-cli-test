import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildAcceptBugWorkspace,
  workspaceDetailMock,
  workspaceRegistryYaml,
  type AcceptBugWorkspace,
} from './fixtures/accept-bug-workspace';

/**
 * DEV-10609 regression — driving the REAL built app via `_electron`.
 *
 * Reproduces the user-reported bug: clicking **Approve** on record A did nothing when another
 * record (B) in the same connection already had an accepted edit. The single-record accept shells
 * out to `scratchmd files accept`, which used to crash replaying B's patch against a narrowed
 * `main`; the desktop then swallowed the non-zero exit. This test opens a real on-disk workspace
 * fixture carrying exactly that state, clicks the record-level Approve button, and asserts the
 * accept actually lands (record A gains an entry in `accepted-patches.json`) with no error toast.
 *
 * Hermetic: an isolated HOME (workspace registry), an isolated userData (seeded session +
 * auto-open preference), the built CLI via `SCRATCH_DESKTOP_SCRATCHMD_BINARY`, and all server
 * calls mocked. Build first with `yarn build` (the `test:e2e` script does this).
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

const FAKE_CURRENT_USER = {
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

const launchedApps: ElectronApplication[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Mock every backend call by pathname; benign 200 for anything unforeseen on a scratch.md host. */
async function mockServer(window: Page, ws: AcceptBugWorkspace): Promise<void> {
  const detail = JSON.stringify(workspaceDetailMock(ws));
  await window.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: string) => route.fulfill({ status: 200, contentType: 'application/json', body });
    if (path === '/users/current') return json(JSON.stringify(FAKE_CURRENT_USER));
    if (path === `/workbook/${ws.workbookId}`) return json(detail);
    if (path === '/workbook') return json(`[${detail}]`);
    if (url.hostname.endsWith('scratch.md')) {
      console.warn('[e2e] unmocked backend call →', route.request().method(), path);
      // Lists vs objects: arrays are the common list shape; an empty array is a safe default.
      return json('[]');
    }
    return route.continue();
  });
}

test.afterEach(async () => {
  for (const app of launchedApps.splice(0)) await app.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('approving a record works when another record in the connection has a pending approved edit (DEV-10609)', async () => {
  // 1. Build the on-disk workspace fixture (real bare repo + worktree + accepted-patches.json).
  const fixtureRoot = makeTempDir('sd-accept-fixture-');
  const ws = buildAcceptBugWorkspace(fixtureRoot);

  // 2. Isolated HOME holding the workspace registry (~/.scratchmd/workspaces.yaml).
  const homeDir = makeTempDir('sd-accept-home-');
  mkdirSync(join(homeDir, '.scratchmd'), { recursive: true });
  writeFileSync(join(homeDir, '.scratchmd', 'workspaces.yaml'), workspaceRegistryYaml(ws));

  // 3. Isolated userData with a seeded session + an auto-open preference for the fixture workspace.
  const userDataDir = makeTempDir('sd-accept-userdata-');
  writeFileSync(
    join(userDataDir, 'preferences.json'),
    JSON.stringify({ currentWorkspaceId: ws.workbookId, workbookSettings: {} }),
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
  await mockServer(window, ws);

  // 4. Past the auth gate, StartupRedirect auto-opens the workspace (seeded preference).
  await expect(window.getByRole('button', { name: 'Log in' })).toBeHidden({ timeout: 20_000 });

  // 5. Select the folder and wait for the grid to finish loading its rows before interacting.
  //    The "Record view" toggle is `disabled` while `pagedRows` is empty, so waiting for it to be
  //    enabled is a reliable "rows are loaded" signal — and avoids racing the toolbar re-mounts
  //    that happen during the async index/validation/review-stats loads.
  await window.getByText(ws.folderName, { exact: false }).first().click({ timeout: 20_000 });
  await expect(window.getByText(/needs review/i).first()).toBeVisible({ timeout: 20_000 });

  // 6. Open record A in the detail view. The "Record view" toggle opens the first row (records
  //    sort by filename, so A precedes B), which is the one carrying the unreviewed edit.
  const recordViewToggle = window.getByLabel('Record view');
  await expect(recordViewToggle).toBeEnabled({ timeout: 20_000 });
  await recordViewToggle.click();

  // 7. Click the RECORD-level Approve (handleAccept → acceptRecord → `files accept A`), NOT the
  //    folder-level "Approve all" (which uses `files accept-all` and wouldn't reproduce the bug).
  const approve = window.getByTestId('record-detail-approve');
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await approve.click();

  // 7. No error toast, and the accept actually landed: record A now has an entry in
  //    accepted-patches.json (pre-fix it would have crashed and A would be absent).
  await expect(window.getByText(/Failed to approve record/i)).toHaveCount(0);
  await expect
    .poll(
      () => {
        const data = JSON.parse(readFileSync(ws.acceptedPatchesPath, 'utf8')) as {
          patches: { path: string }[];
        };
        return data.patches.map((p) => p.path);
      },
      { timeout: 15_000 },
    )
    .toEqual(expect.arrayContaining([`${ws.folderName}/A.json`, `${ws.folderName}/B.json`]));
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
