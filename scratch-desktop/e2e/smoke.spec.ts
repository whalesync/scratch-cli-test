import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * End-to-end smoke tests for the scratch-desktop Electron app.
 *
 * These launch the built app via Playwright's `_electron` driver and exercise the
 * test-credential seam (`src/main/test-credentials.ts`): seeding a session so the app skips
 * the interactive device-code login a headless test can't drive. The two tests form a
 * differential — login appears with no creds, and is gone once creds are seeded — so a broken
 * seam can't pass silently.
 *
 * Hermetic by design: the authenticated test mocks the renderer's first server calls, so it is
 * green regardless of which backend the build was compiled against. To drive the REAL test
 * backend (`test-api.scratch.md`) with a real token, see e2e/README.md.
 */

// Built main-process entry produced by `yarn build` (electron-vite).
const MAIN_PROCESS_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');

// Source-of-truth strings defined in src/main (kept in sync by hand — the e2e runner can't
// import those modules, which pull in `electron`, unavailable in the test runner process).
const TEST_CREDENTIALS_ENV_VAR = 'SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON';
const USER_DATA_DIR_ENV_VAR = 'SCRATCH_DESKTOP_USER_DATA_DIR';

// A far-future-expiry fake session. The renderer's auth gate is purely client-side (it only
// checks the token's presence + local expiry — see AuthProvider), so a fake token is enough
// to get past LoginPage; the authenticated test mocks the server calls that follow.
const FAKE_TEST_CREDENTIALS = {
  apiToken: 'test-api-token-not-a-real-secret',
  email: 'e2e@whalesync.com',
  tokenExpiresAt: '2099-01-01T00:00:00Z',
  serverUrl: 'https://test-api.scratch.md',
};

// Minimal `User` (GET /users/current) — only the fields the shared type marks required, plus
// name/email for display. Lets the app render the authenticated home screen without a backend.
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
const createdUserDataDirs: string[] = [];

async function launchDesktopApp(options: { seedCredentials: boolean }): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scratch-desktop-e2e-'));
  createdUserDataDirs.push(userDataDir);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    [USER_DATA_DIR_ENV_VAR]: userDataDir,
    // Don't let electron-updater reach out to GitHub during tests.
    SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE: '1',
  };
  if (options.seedCredentials) {
    env[TEST_CREDENTIALS_ENV_VAR] = JSON.stringify(FAKE_TEST_CREDENTIALS);
  }

  const app = await electron.launch({ args: [MAIN_PROCESS_ENTRY], env });
  launchedApps.push(app);
  return app;
}

test.afterEach(async () => {
  for (const app of launchedApps.splice(0)) {
    await app.close().catch(() => undefined);
  }
  for (const dir of createdUserDataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shows the login screen when no credentials are seeded', async () => {
  const app = await launchDesktopApp({ seedCredentials: false });
  const window = await app.firstWindow();

  // Empty (isolated) profile + no token → the auth gate renders LoginPage.
  await expect(window.getByRole('button', { name: 'Log in' })).toBeVisible();
});

test('skips the login screen when test credentials are seeded', async () => {
  const app = await launchDesktopApp({ seedCredentials: true });
  const window: Page = await app.firstWindow();

  // Mock the two server calls the app makes right after the auth gate so the test is
  // deterministic regardless of which backend the build targets (and whether the fake token
  // would be accepted). Registered before the renderer's React tree mounts and fires them
  // (several IPC round-trips happen first), so the handlers win the race.
  await window.route('**/users/current', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_CURRENT_USER) }),
  );
  await window.route('**/workbook**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );

  // The seam worked: we got past LoginPage and reached the authenticated home screen
  // (empty-workbook zero-state). If seeding had failed, LoginPage would render instead and
  // neither of these would hold.
  await expect(window.getByRole('button', { name: 'Log in' })).toBeHidden();
  await expect(window.getByText('Create your first workspace')).toBeVisible();
});
