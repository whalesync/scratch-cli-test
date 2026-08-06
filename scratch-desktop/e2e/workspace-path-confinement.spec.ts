import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * End-to-end proof of the SCR-007 (DEV-11002) IPC path confinement, driven through the REAL
 * main-process handlers rather than the guard module in isolation.
 *
 * The unit suites cover the guard's decisions. What they cannot cover is the *wiring* — whether
 * each IPC channel actually consults the guard, and whether the one flow that legitimately targets
 * an unregistered directory (creating a new workspace) still works. That flow is the reason this
 * file exists: an earlier revision of the fix confined `scratch:init-workspace` without recording
 * what the native folder dialog returned, which silently made it impossible to create a workspace
 * at all. Nothing but an end-to-end check catches that.
 *
 * `dialog.showOpenDialog` is stubbed in the main process (the only piece a headless test cannot
 * drive), so the picker → init handshake runs for real on both sides.
 */

const MAIN_PROCESS_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');
const USER_DATA_DIR_ENV_VAR = 'SCRATCH_DESKTOP_USER_DATA_DIR';

const REGISTERED_WORKBOOK_ID = 'wkb_confinement_fixture';

const launchedApps: ElectronApplication[] = [];
const createdDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

test.afterEach(async () => {
  for (const app of launchedApps.splice(0)) {
    await app.close().catch(() => undefined);
  }
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Launch with an isolated HOME whose scratchmd registry lists exactly one workspace. */
async function launchWithRegisteredWorkspace(): Promise<{
  app: ElectronApplication;
  registeredWorkspacePath: string;
}> {
  const registeredWorkspacePath = makeTempDir('sd-confine-ws-');
  const homeDir = makeTempDir('sd-confine-home-');
  const userDataDir = makeTempDir('sd-confine-userdata-');

  const scratchmdDir = join(homeDir, '.scratchmd');
  mkdirSync(scratchmdDir, { recursive: true });
  writeFileSync(
    join(scratchmdDir, 'workspaces.yaml'),
    `version: '1'\nworkspaces:\n- id: ${JSON.stringify(REGISTERED_WORKBOOK_ID)}\n  path: ${JSON.stringify(
      registeredWorkspacePath,
    )}\n`,
  );

  const app = await electron.launch({
    args: [MAIN_PROCESS_ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      [USER_DATA_DIR_ENV_VAR]: userDataDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      SCRATCH_DESKTOP_HOME_DIR: homeDir,
      SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE: '1',
    },
  });
  launchedApps.push(app);
  await app.firstWindow();
  return { app, registeredWorkspacePath };
}

/**
 * Call a preload-exposed method from the renderer, returning the rejection message instead of
 * throwing (or the literal `'RESOLVED'` when it succeeds).
 *
 * Deliberately goes through the typed `scratchFiles` / `scratchDesktop` bridges rather than a raw
 * `ipcRenderer.invoke`: the generic bridge is locked down (DEV-10996), so these methods are the
 * actual reachable surface a compromised renderer would have.
 */
async function callBridge(
  app: ElectronApplication,
  bridgeName: 'scratchFiles' | 'scratchDesktop',
  methodName: string,
  args: unknown[],
): Promise<string> {
  const window = await app.firstWindow();
  return window.evaluate(
    async ([bridge, method, callArgs]) => {
      const bridgeObject = (window as unknown as Record<string, Record<string, unknown> | undefined>)[bridge as string];
      const bridgeMethod = bridgeObject?.[method as string];
      if (typeof bridgeMethod !== 'function') return `NO_METHOD:${String(bridge)}.${String(method)}`;
      try {
        await (bridgeMethod as (...a: unknown[]) => Promise<unknown>)(...(callArgs as unknown[]));
        return 'RESOLVED';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [bridgeName, methodName, args] as [string, string, unknown[]],
  );
}

/** Every confinement refusal surfaces one of these phrases. */
const CONFINEMENT_REFUSAL =
  /outside registered workspaces|outside every registered workspace|not a registered workspace root/i;

test('refuses reads and writes outside every registered workspace', async () => {
  const { app } = await launchWithRegisteredWorkspace();

  // The two primitives Oneleet demonstrated. A path outside the workspace must not be readable...
  expect(await callBridge(app, 'scratchFiles', 'readFileTextRaw', ['/etc/hosts'])).toMatch(CONFINEMENT_REFUSAL);

  // ...nor writable. This is the Startup-folder persistence vector.
  expect(
    await callBridge(app, 'scratchFiles', 'writeFileTextRaw', [join(tmpdir(), 'scr007-should-not-exist.txt'), 'pwned']),
  ).toMatch(CONFINEMENT_REFUSAL);

  // The credentials file is the escalation the finding did not mention: it holds the Scratch API
  // token in plaintext, so an unconfined read is account takeover, not local disclosure.
  expect(
    await callBridge(app, 'scratchFiles', 'readFileTextRaw', [
      join(process.env.HOME ?? tmpdir(), '.scratchmd', 'credentials.yaml'),
    ]),
  ).toMatch(CONFINEMENT_REFUSAL);
});

test('refuses to launch or reveal a path outside a workspace', async () => {
  const { app } = await launchWithRegisteredWorkspace();

  // `shell.openPath` LAUNCHES what it is handed, so this one is code execution, not disclosure.
  expect(await callBridge(app, 'scratchDesktop', 'showInFolder', ['/Applications'])).toMatch(CONFINEMENT_REFUSAL);
  expect(await callBridge(app, 'scratchDesktop', 'openInTerminal', [tmpdir()])).toMatch(CONFINEMENT_REFUSAL);
});

test('refuses a relative fragment that escapes a legitimate workspace root', async () => {
  const { app, registeredWorkspacePath } = await launchWithRegisteredWorkspace();

  // The half of SCR-007 the finding missed: the root is valid, but the fragment joined onto it
  // walks out before any filesystem call happens.
  expect(
    await callBridge(app, 'scratchFiles', 'readConnectionSchema', [registeredWorkspacePath, '../../../../../../etc']),
  ).toMatch(/must not traverse upward/i);

  // `viewName` is interpolated as `${viewName}.json`, so a separator alone redirects the read.
  expect(
    await callBridge(app, 'scratchFiles', 'readConnectionView', [
      registeredWorkspacePath,
      registeredWorkspacePath,
      '../../../../../../etc/passwd',
    ]),
  ).toMatch(/must not contain a path separator|must not traverse upward/i);
});

test('still allows a path inside a registered workspace', async () => {
  const { app, registeredWorkspacePath } = await launchWithRegisteredWorkspace();

  // Differential against the tests above: the guard rejects by LOCATION, not everything. A read
  // inside the workspace gets past the guard and reaches the handler, which reports the missing
  // file in its own return value rather than rejecting.
  expect(
    await callBridge(app, 'scratchFiles', 'readFileTextRaw', [join(registeredWorkspacePath, 'nonexistent.json')]),
  ).toBe('RESOLVED');
});

test('creating a workspace works for a folder the user picked, and only that folder', async () => {
  // The regression this file exists for. `scratch:init-workspace` targets a directory that is by
  // definition NOT yet in the registry, so it is confined to what the native dialog returned.
  const { app } = await launchWithRegisteredWorkspace();
  const pickedParentFolder = makeTempDir('sd-confine-picked-');
  const neverPickedFolder = makeTempDir('sd-confine-unpicked-');

  // A directory the renderer names on its own must be refused — otherwise the renderer chooses the
  // CLI's working directory.
  expect(await callBridge(app, 'scratchDesktop', 'initWorkspace', ['wkb_new', neverPickedFolder, {}])).toMatch(
    /was not chosen by the user/i,
  );

  // Stub the native dialog, then run the real picker -> init handshake.
  await app.evaluate(({ dialog }, folderToReturn) => {
    dialog.showOpenDialog = (): ReturnType<typeof dialog.showOpenDialog> =>
      Promise.resolve({ canceled: false, filePaths: [folderToReturn] });
  }, pickedParentFolder);

  const window = await app.firstWindow();
  const pickedResult = await window.evaluate(async () => {
    const bridge = (window as unknown as { scratchDesktop?: { pickParentFolder: () => Promise<string | null> } })
      .scratchDesktop;
    return bridge ? await bridge.pickParentFolder() : 'NO_BRIDGE';
  });
  expect(pickedResult).toBe(pickedParentFolder);

  // Now the SAME directory is accepted. The CLI itself fails here (no auth/backend in this test),
  // but it must fail for its own reasons — never with a confinement refusal.
  const initPicked = await callBridge(app, 'scratchDesktop', 'initWorkspace', ['wkb_new', pickedParentFolder, {}]);
  expect(initPicked).not.toMatch(/was not chosen by the user/i);
  expect(initPicked).not.toMatch(CONFINEMENT_REFUSAL);
});
