import { defineConfig } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Load a gitignored local env file (if present) so the live test-api suite can pick up
// TESTING_ACCOUNT_API_KEY without it living in the shell. Dependency-free KEY=value parser;
// an already-exported variable always wins. No-op when the file is absent (the normal case
// for the hermetic suite, which needs no secrets). The config runs in the Playwright parent
// process before workers fork, so these vars are inherited by the test workers.
const localEnvFile = join(__dirname, '.env.e2e');
if (existsSync(localEnvFile)) {
  for (const line of readFileSync(localEnvFile, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

/**
 * Playwright config for the scratch-desktop Electron end-to-end tests.
 *
 * These tests launch the BUILT app (`out/main/index.js`) via Playwright's `_electron`
 * driver, so `yarn build` must run first (the `test:e2e` script does this for you). They are
 * intentionally separate from the vitest unit suites under `src/`; Playwright only collects
 * specs under `e2e/`.
 *
 * The bundled smoke test is hermetic — it needs no backend. To run the full flow against the
 * deployed test backend instead, build with the test API baked in and supply a real token:
 *
 *   VITE_SCRATCH_API_URL=https://test-api.scratch.md \
 *   VITE_SCRATCH_WEB_URL=https://test.scratch.md yarn build
 *   SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON='{"apiToken":"…","email":"…","tokenExpiresAt":"2099-01-01T00:00:00Z","serverUrl":"https://test-api.scratch.md"}' \
 *   yarn playwright test
 *
 * See e2e/README.md for the details.
 */
export default defineConfig({
  testDir: './e2e',
  // Each test launches its own Electron app — heavy and stateful, so run them serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
});
