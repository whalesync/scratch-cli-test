import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Shared launch/mock scaffolding for the review-surface `_electron` specs. Every review spec builds a
 * real on-disk workspace, launches the built app hermetically (isolated HOME + userData, fake seeded
 * credentials, every backend call mocked), and drives the auto-opened workspace. The one thing that
 * varies per spec is the fixture, so callers pass a workspace builder + its registry/detail helpers.
 *
 * The `DESKTOP_REVIEW_SURFACE_V2` flag is delivered on the mocked `GET /users/current`; flip it to
 * render `FolderReviewSurface` (on) or the legacy `FolderDataGrid` (off).
 */

export const MAIN_PROCESS_ENTRY = join(__dirname, '..', '..', 'out', 'main', 'index.js');
export const SCRATCHMD_BINARY = join(__dirname, '..', '..', '..', 'scratch-git-2', 'target', 'debug', 'scratchmd');

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
export function currentUserWithFlag(reviewSurfaceV2On: boolean): Record<string, unknown> {
  return { ...BASE_CURRENT_USER, experimentalFlags: { DESKTOP_REVIEW_SURFACE_V2: reviewSurfaceV2On } };
}

const launchedApps: ElectronApplication[] = [];
const tempDirs: string[] = [];

/** Make a temp dir tracked for teardown by `closeLaunchedResources`. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Close every app launched by `launchReviewApp` and remove every tracked temp dir. Call in `afterEach`. */
export async function closeLaunchedResources(): Promise<void> {
  for (const app of launchedApps.splice(0)) await app.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

/** A workspace fixture must expose the id the app opens by preference and mocks its detail under. */
interface LaunchableWorkspace {
  workbookId: string;
}

export interface LaunchReviewAppOptions<W extends LaunchableWorkspace> {
  /** `DESKTOP_REVIEW_SURFACE_V2` state delivered on `/users/current`. */
  flag: boolean;
  /** Build the on-disk fixture under a fresh temp root (owned + cleaned up by the harness). */
  build: (rootDir: string) => W;
  /** YAML for `~/.scratchmd/workspaces.yaml` registering the fixture. */
  registryYaml: (workspace: W) => string;
  /** `GET /workbook/:id` (and list) payload matching the fixture. */
  detailMock: (workspace: W) => Record<string, unknown>;
}

/** Build the fixture + isolated HOME/userData and launch the app to the auto-opened workspace. */
export async function launchReviewApp<W extends LaunchableWorkspace>(
  options: LaunchReviewAppOptions<W>,
): Promise<{ window: Page; app: ElectronApplication; workspace: W }> {
  const fixtureRoot = makeTempDir('sd-review-fixture-');
  const workspace = options.build(fixtureRoot);

  const homeDir = makeTempDir('sd-review-home-');
  mkdirSync(join(homeDir, '.scratchmd'), { recursive: true });
  writeFileSync(join(homeDir, '.scratchmd', 'workspaces.yaml'), options.registryYaml(workspace));

  const userDataDir = makeTempDir('sd-review-userdata-');
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
    JSON.stringify(options.detailMock(workspace)),
    workspace.workbookId,
    JSON.stringify(currentUserWithFlag(options.flag)),
  );

  // Past the auth gate, StartupRedirect auto-opens the workspace (seeded preference). Generous
  // timeout: the first launch after a fresh build pays a cold-start cost.
  await expect(window.getByRole('button', { name: 'Log in' })).toBeHidden({ timeout: 45_000 });
  return { window, app, workspace };
}

/** Guard for `beforeAll`: the bundled `scratchmd` binary must exist (built by `cargo build --bin scratchmd`). */
export function assertScratchmdBinaryBuilt(): void {
  try {
    execFileSync(SCRATCHMD_BINARY, ['--version'], { stdio: 'pipe' });
  } catch {
    throw new Error(
      `scratchmd binary not found/executable at ${SCRATCHMD_BINARY}. Run \`cargo build --bin scratchmd\` in scratch-git-2.`,
    );
  }
}
