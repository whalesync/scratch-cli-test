import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Security regression test for DEV-10996 (Oneleet pentest finding SCR-001, "Overly Permissive
 * Generic IPC Bridge").
 *
 * The app used to expose `@electron-toolkit/preload`'s generic `electronAPI` to the renderer as
 * `window.electron`, which handed renderer JS a raw `ipcRenderer` (`invoke`/`send`/`sendSync`/`on`)
 * that could call ANY `ipcMain` channel by name — turning any future renderer injection bug into
 * credential theft / arbitrary file read-write. We removed that bridge; the renderer now reaches
 * main only through the fixed-channel `window.scratch*` wrappers, and the one value it read off the
 * generic object (`process.platform`) moved onto `window.scratchDesktop.platform`.
 *
 * This test launches the BUILT app and asserts, from the renderer context, that the generic bridge
 * is gone while the curated surface still works. It is hermetic — no backend or credentials needed.
 * If someone re-adds `exposeInMainWorld('electron', electronAPI)`, this goes red.
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

test('does not expose the generic electron IPC bridge to the renderer', async () => {
  const app = await launchDesktopApp();
  const window = await app.firstWindow();

  // Probe the renderer's window globals. contextBridge exposures are present as soon as the page
  // context exists (they run in preload, before renderer scripts), so no need to wait for React.
  const probe = await window.evaluate(() => {
    const w = window as unknown as {
      electron?: unknown;
      scratchAuth?: { getCredentials?: unknown };
      scratchFiles?: { workspaceConfig?: unknown };
      scratchDesktop?: { platform?: unknown; getWorkspacesRegistry?: unknown };
      scratchPreferences?: { getCurrentWorkspaceId?: unknown };
    };
    return {
      electronDefined: typeof w.electron !== 'undefined',
      hasGetCredentials: typeof w.scratchAuth?.getCredentials === 'function',
      hasWorkspaceConfig: typeof w.scratchFiles?.workspaceConfig === 'function',
      hasWorkspacesRegistry: typeof w.scratchDesktop?.getWorkspacesRegistry === 'function',
      hasPreferences: typeof w.scratchPreferences?.getCurrentWorkspaceId === 'function',
      platform: w.scratchDesktop?.platform,
    };
  });

  // The generic bridge (and with it `ipcRenderer`/`webFrame`/`webUtils`/`process.env`) is gone.
  expect(probe.electronDefined).toBe(false);

  // The curated, fixed-channel wrappers the renderer actually uses are still present and callable.
  expect(probe.hasGetCredentials).toBe(true);
  expect(probe.hasWorkspaceConfig).toBe(true);
  expect(probe.hasWorkspacesRegistry).toBe(true);
  expect(probe.hasPreferences).toBe(true);

  // The one value the renderer read off the old generic object now lives on the curated surface.
  expect(typeof probe.platform).toBe('string');
  expect(probe.platform).not.toBe('');
});
