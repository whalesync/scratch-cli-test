import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Security regression test for DEV-11001 (Oneleet pentest finding SCR-006, "Renderer XSS Can Be
 * Escalated to Local Code Execution Through Exposed IPC Primitives").
 *
 * The app-layer HTML sanitizer is covered by unit tests (rich-text-sanitize.spec.ts). This suite
 * covers the platform-layer defense-in-depth that only exists in the real, packaged renderer and is
 * the "dynamic validation" the finding asked for: even if the sanitizer were ever bypassed, the
 * Content-Security-Policy must stop injected/remote scripts from running, and the main-process
 * navigation guard must stop the top-level frame from being navigated to attacker content.
 *
 * It launches the BUILT app and probes from the renderer context. Hermetic — no backend or
 * credentials needed (the app sits on the login screen). If someone drops the CSP meta tag or the
 * will-navigate guard, this goes red.
 */

// Built main-process entry produced by `yarn build` (electron-vite).
const MAIN_PROCESS_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');

// Kept in sync by hand with src/main (the e2e runner can't import those modules — they pull in
// `electron`, which is unavailable in the test-runner process).
const USER_DATA_DIR_ENV_VAR = 'SCRATCH_DESKTOP_USER_DATA_DIR';

const launchedApps: ElectronApplication[] = [];
const createdUserDataDirs: string[] = [];

async function launchDesktopApp(): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scratch-desktop-e2e-'));
  createdUserDataDirs.push(userDataDir);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    [USER_DATA_DIR_ENV_VAR]: userDataDir,
    // Don't let electron-updater reach out to GitHub during tests.
    SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE: '1',
  };
  // VS Code's integrated terminal sets ELECTRON_RUN_AS_NODE=1, which makes Playwright's `_electron`
  // launch die with "Process failed to launch!". Strip it so the test runs from any shell.
  delete env.ELECTRON_RUN_AS_NODE;

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

test('ships a Content-Security-Policy whose script-src/object-src cannot run injected code', async () => {
  const app = await launchDesktopApp();
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const csp = await window.evaluate(
    () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null,
  );
  expect(csp, 'renderer must ship a CSP meta tag').not.toBeNull();

  const directive = (name: string): string | undefined =>
    csp
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `) || part === name);

  // The load-bearing directives: scripts are same-origin only (no unsafe-inline / unsafe-eval /
  // remote hosts), and plugin/base surfaces are closed.
  expect(directive('script-src')).toBe("script-src 'self'");
  expect(directive('object-src')).toBe("object-src 'none'");
  expect(directive('base-uri')).toBe("base-uri 'none'");
});

test('CSP blocks an injected inline <script> in the renderer', async () => {
  const app = await launchDesktopApp();
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // Inserting a <script> element is gated by CSP at execution time regardless of what triggered the
  // DOM write, so this observes real enforcement. (We deliberately do NOT probe eval() here: Playwright's
  // evaluate runs via CDP, whose context is exempt from CSP's eval restriction, so it can't observe it;
  // the "script-src is exactly 'self'" assertion above is what pins that no 'unsafe-eval' is present.)
  const inlineScriptRan = await window.evaluate(() => {
    try {
      const script = document.createElement('script');
      script.textContent = 'window.__xssInlineRan = true;';
      document.body.appendChild(script);
      script.remove();
    } catch {
      // A throw here also means the payload did not run.
    }
    return (window as unknown as { __xssInlineRan?: boolean }).__xssInlineRan === true;
  });
  expect(inlineScriptRan, 'an injected inline <script> must not execute under the CSP').toBe(false);
});

test('the navigation guard denies a renderer-driven off-origin top-level navigation', async () => {
  const app = await launchDesktopApp();
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const beforeUrl = window.url();
  expect(beforeUrl).toContain('index.html');

  // A renderer XSS setting window.location off the app's own file:// origin. `file:///etc/passwd`
  // is NOT a safe external URL, so the guard blocks it outright (no shell.openExternal, no browser
  // popped) — the discriminator is that the top-level frame stays on the app document.
  await window.evaluate(() => {
    try {
      window.location.href = 'file:///etc/passwd';
    } catch {
      // preventDefault surfaces as a navigation error in some cases; either way we assert on the URL.
    }
  });
  await window.waitForTimeout(750);

  const afterUrl = window.url();
  expect(afterUrl, 'the guard must keep the top-level frame on the app document').toBe(beforeUrl);
});
