import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * LIVE end-to-end test against the deployed test backend (`test-api.scratch.md`).
 *
 * Unlike the hermetic `smoke.spec.ts`, this seeds a REAL session for a dedicated test account
 * (`testing@whalesync.com`) and lets the app make real authenticated calls — proving the whole
 * chain works: the test-credential seam → a real API-Token → live auth → the account's real data.
 *
 * It is gated twice so it never runs by accident:
 *   - only when `SCRATCH_E2E_LIVE=1` (set by the `test:e2e:live` script, which also builds the
 *     app with the test API baked into `VITE_SCRATCH_API_URL`), and
 *   - only when `TESTING_ACCOUNT_API_KEY` is available (via the shell or the gitignored
 *     `.env.e2e`, loaded by playwright.config.ts).
 *
 * Run it with: `yarn test:e2e:live`. See e2e/README.md.
 *
 * Read-only by design: it lists the account's workspaces and renders the first-run screen. It
 * does NOT download/publish (which would mutate local state or the test environment).
 */

// Built main-process entry produced by `yarn build` (electron-vite).
const MAIN_PROCESS_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');

// Source-of-truth strings defined in src/main (kept in sync by hand — the e2e runner can't
// import those modules, which pull in `electron`, unavailable in the test runner process).
const TEST_CREDENTIALS_ENV_VAR = 'SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON';
const USER_DATA_DIR_ENV_VAR = 'SCRATCH_DESKTOP_USER_DATA_DIR';

const liveTestsEnabled = process.env.SCRATCH_E2E_LIVE === '1';
const testingAccountApiKey = process.env.TESTING_ACCOUNT_API_KEY;
const testingAccountEmail = process.env.TESTING_ACCOUNT_EMAIL ?? 'testing@whalesync.com';
// https (not http): test-api 301-redirects http→https, and the credentials are keyed by
// hostname, so the seam's serverUrl must match what the build (VITE_SCRATCH_API_URL) targets.
const testApiUrl = process.env.SCRATCH_TEST_API_URL ?? 'https://test-api.scratch.md';

test.describe('live (test-api.scratch.md)', () => {
  test.skip(!liveTestsEnabled, 'Live E2E disabled — run `yarn test:e2e:live` (sets SCRATCH_E2E_LIVE=1).');
  test.skip(
    liveTestsEnabled && !testingAccountApiKey,
    'TESTING_ACCOUNT_API_KEY not set — cannot run the live test-api E2E (see e2e/README.md).',
  );

  const launchedApps: ElectronApplication[] = [];
  const createdUserDataDirs: string[] = [];

  test.afterEach(async () => {
    for (const app of launchedApps.splice(0)) {
      await app.close().catch(() => undefined);
    }
    for (const dir of createdUserDataDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('seeds the real account and loads it from the live backend', async () => {
    // Guaranteed present by the test.skip guards above.
    const apiToken = testingAccountApiKey as string;

    // Ask the live backend what this account can see, so the UI assertions self-adjust to the
    // account's real state rather than hardcoding workspace names. This also independently
    // confirms the token is valid against test-api before we launch the app.
    const workbooksResponse = await fetch(`${testApiUrl}/workbook`, {
      headers: { Authorization: `API-Token ${apiToken}` },
    });
    expect(workbooksResponse.status).toBe(200);
    const remoteWorkspaces = (await workbooksResponse.json()) as Array<{ id: string; name: string | null }>;

    const userDataDir = mkdtempSync(join(tmpdir(), 'scratch-desktop-e2e-live-'));
    createdUserDataDirs.push(userDataDir);

    const app = await electron.launch({
      args: [MAIN_PROCESS_ENTRY],
      env: {
        ...(process.env as Record<string, string>),
        [USER_DATA_DIR_ENV_VAR]: userDataDir,
        SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE: '1',
        [TEST_CREDENTIALS_ENV_VAR]: JSON.stringify({
          apiToken,
          email: testingAccountEmail,
          tokenExpiresAt: '2099-01-01T00:00:00Z',
          serverUrl: testApiUrl,
        }),
      },
    });
    launchedApps.push(app);
    const window: Page = await app.firstWindow();

    // The seam bypassed the device-code login.
    await expect(window.getByRole('button', { name: 'Log in' })).toBeHidden();

    // Real account data rendered from the live backend. Reaching these screens proves the full
    // chain worked end to end (auth-gate pass → real /users/current 200 → real /workbook list).
    //
    // For an account WITH remote workspaces, the app lands on one of two equally-healthy home
    // states, and which one it is depends on MACHINE state, not on auth/build:
    //   • the first-run "Download a workspace" WelcomePage — only when nothing is downloaded locally;
    //   • the "Your Workspaces" HomePage list — as soon as the GLOBAL scratchmd CLI registry
    //     (~/.scratchmd/workspaces.yaml) already has any workspace cloned on this machine. That
    //     registry is shared across the whole machine and is NOT isolated by this test's throwaway
    //     Electron profile, so a prior local download (e.g. left by a QA run) flips the screen.
    // Accept EITHER — both prove the same chain. (Asserting only the WelcomePage made this canary
    // fail as a false negative on any machine that had ever downloaded a workspace.)
    if (remoteWorkspaces.length > 0) {
      await expect(window.getByText(/Download a workspace|Your Workspaces/i).first()).toBeVisible();
      // The meaningful signal that holds on BOTH screens: a real workspace name renders.
      const firstWorkspaceName = remoteWorkspaces[0].name;
      if (firstWorkspaceName) {
        await expect(window.getByText(firstWorkspaceName, { exact: false }).first()).toBeVisible();
      }
    } else {
      await expect(window.getByText('Create your first workspace')).toBeVisible();
    }
  });
});
