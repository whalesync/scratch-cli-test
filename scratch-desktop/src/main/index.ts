// Side-effect import: must run before any module that reads userData (e.g. auth-store).
import './setup-userdata';

import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { spawn } from 'child_process';
import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions, shell } from 'electron';
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import { performance } from 'perf_hooks';
import { CLI_INSTALL_EVENT_CHANNEL, type CliInstallEvent } from '../shared/cli-install-events';
import { APP_QUIT_CONFIRMED_CHANNEL, APP_WILL_QUIT_CHANNEL, type AppWillQuitPayload } from '../shared/lifecycle-events';
import { UPDATER_EVENT_CHANNEL, UpdaterEvent } from '../shared/updater-events';
import { clearCredentials, getCredentials, isTokenExpired, saveCredentials } from './auth-store';
import { initAutoDownloadScheduler, type AutoDownloadSchedulerController } from './auto-download-scheduler';
import { detectCloudSync, type CloudSyncDetection } from './cloud-sync';
import { installScratchmdToPath, isCliSymlinkInstalled, uninstallScratchmdFromPath } from './install-cli';
import {
  acceptFieldEditFromInputText,
  acceptUnreviewedFieldEdit,
  countWorkspaceFiles,
  dropApprovedFieldAndRestoreToMain,
  findRecordOffset,
  getFolderMetadata,
  listFiles,
  listFolders,
  readBatch,
  readConnectionSchema,
  readConnectionViewByName,
  readDiffGridDataPage,
  readDiffRecordData,
  readFileContent,
  readFileTextRaw,
  readFolderStatuses,
  readGridData,
  readSchema,
  readWorkspaceConfig,
  revertUnreviewedFieldEditToApproved,
  toWorkspaceRelativeCliFolder,
  writeFileTextRaw,
  type DiffGridFilter,
  type FilterStatus,
} from './local-files';
import {
  getCurrentWorkspaceId,
  getWorkbookSettings,
  isAutoDownloadEnabled,
  setCurrentWorkspaceId,
  setWorkbookSetting,
  type WorkbookSettings,
} from './preferences-store';
import { reviewStatsNotifier } from './review-stats-notifier';
import type { RerunValidationScope, RerunValidationSummary } from './scratchmd';
import {
  acceptFieldChanges,
  clearFolderIndex,
  discardCreatedRecord as discardCreatedRecordViaCli,
  getFolderValidationResults,
  getFolderValidationSample,
  getReviewStats,
  getValidationResults,
  getValidationStats,
  listUnpushedChanges,
  listUnreviewedChanges,
  pullWorkspaceChanges,
  reconcileAfterPublish,
  reconcilePublishedRecord,
  refreshFolderIndex,
  reindexFiles,
  rejectFieldChanges,
  rerunValidation,
  restoreDeletedRecord as restoreDeletedRecordViaCli,
  runScratchmd,
  runScratchmdCapture,
  runScratchmdJson,
  startScratchmdLiveCommand,
  syncCredentialsToScratchmdCli,
  uploadWorkspaceChanges,
  type DownloadWorkspaceResult,
  type ScratchmdResult,
} from './scratchmd';
import { configureBundledGitEnvironment } from './setup-git-env';
import { seedTestCredentialsFromEnvIfPresent } from './test-credentials';
import { initAutoUpdater } from './updater';
import {
  ensureSchemaValidatorSeededInEveryFolder,
  getValidationConfigs,
  writeValidationConfig,
} from './validation-config';
import { attachWindowStatePersistence, getRestoredWindowState } from './window-state';
import { WorkspaceFileWatchService } from './workspace-file-watch';
import {
  logApiCall,
  logPublishJob,
  logSession,
  type ApiLogEntry,
  type PublishJobEntry,
  type SessionEvent,
} from './workspace-logger';

// DEV-10318: point in-process (napi) git shell-outs at the bundled git binary
// before anything can invoke them, so a packaged build never falls back to
// /usr/bin/git (the Xcode CLT stub) on a clean macOS machine. No-op in dev.
configureBundledGitEnvironment();

// Test-only: when SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON is set in a dev build, seed a
// logged-in session so a Playwright (`_electron`) test can skip the interactive
// device-code login. This persists the credentials to the auth store and points
// SCRATCH_URL at the test server; the scratchmd CLI is synced once the app is ready
// (see the app.whenReady handler below). Returns null (no-op) outside tests.
const seededTestCredentials = seedTestCredentialsFromEnvIfPresent();

// Point the scratchmd CLI (spawned children) and the in-process napi at the
// same Scratch server the desktop authenticated against — credentials are keyed
// by hostname, so a mismatched compiled DEFAULT_SERVER_URL surfaces as "Not
// authenticated". scratchmdEnv() inherits process.env; refreshed on login in
// the auth:save-credentials handler below.
const storedServerUrlAtStartup = getCredentials().serverUrl;
if (storedServerUrlAtStartup) {
  process.env.SCRATCH_URL = storedServerUrlAtStartup;
}

const appStartTime = performance.now();

const PROTOCOL = 'scratch';

let mainWindow: BrowserWindow | null = null;
let pendingDeepLink: { route: string; query: string } | null = null;
let updaterController: ReturnType<typeof initAutoUpdater> = null;
let autoDownloadController: AutoDownloadSchedulerController | null = null;
const workspaceFileWatchService = new WorkspaceFileWatchService();

// Review-state dots derive live from git + `accepted-patches.json` on every
// `getReviewStats` call (DEV-10327), so any change — a record-file edit
// (internal OR external), or a change to a connection's `accepted-patches.json`
// — just needs the renderer nudged to re-fetch. No per-folder refresh, no
// source branch: the re-fetch's `gix status` already sees the current state.
workspaceFileWatchService.setMutationHandler((workspacePath) => {
  reviewStatsNotifier.notifyReviewStatsChanged(workspacePath);
});
workspaceFileWatchService.setAcceptedPatchesHandler((workspacePath) => {
  reviewStatsNotifier.notifyReviewStatsChanged(workspacePath);
});

function parseScratchDeepLink(url: string): { route: string; query: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'scratch:') {
      return null;
    }
    const route = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '');
    const isAllowedRoute =
      route.startsWith('workbook/') ||
      route === 'open' ||
      route === 'oauth-callback' ||
      route === 'settings' ||
      route.startsWith('settings/');
    if (!isAllowedRoute) {
      return null;
    }
    if (route.includes('..')) {
      return null;
    }
    return { route, query: parsed.search };
  } catch {
    return null;
  }
}

function flushPendingDeepLink(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !pendingDeepLink) {
    return;
  }
  mainWindow.webContents.send('deep-link', pendingDeepLink.route, pendingDeepLink.query);
  pendingDeepLink = null;
}

function handleDeepLink(url: string): void {
  const parsed = parseScratchDeepLink(url);
  if (!parsed) {
    console.debug('[deep-link] ignored (invalid URL):', url);
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deep-link', parsed.route, parsed.query);
  } else {
    pendingDeepLink = parsed;
  }
}

// Packaged builds use a single-instance lock by default.
// SCRATCH_DESKTOP_ALLOW_MULTIPLE_INSTANCES=1 to skip the lock for a packaged .app as well (e.g. two builds).
const allowMultipleInstances = process.env.SCRATCH_DESKTOP_ALLOW_MULTIPLE_INSTANCES === '1';
const gotTheLock = allowMultipleInstances ? true : app.requestSingleInstanceLock();

if (gotTheLock) {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on('second-instance', (_event, argv) => {
    const deepLinkArg = argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`));
    if (deepLinkArg) {
      handleDeepLink(deepLinkArg);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      void mainWindow.focus();
    }
  });
}

if (!gotTheLock) {
  app.quit();
}

function logPerf(message: string, elapsedMs: number): void {
  console.debug(`[perf] ${message}: ${elapsedMs.toFixed(1)}ms`);
}

interface LocalWorkspaceEntry {
  id: string;
  path: string;
}

function registryPath(): string {
  return join(app.getPath('home'), '.scratchmd', 'workspaces.yaml');
}

function toWorkspaceRecordPath(workspacePath: string, folderPath: string, filename: string): string {
  const recordPath = relative(workspacePath, join(folderPath, filename));
  if (!recordPath || recordPath.startsWith('..')) {
    throw new Error(`Record path is outside the workspace: ${join(folderPath, filename)}`);
  }
  return recordPath.split(sep).join('/');
}

/** Decode a YAML scalar from the registry (plain or double/single-quoted). */
function parseRegistryScalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function parseWorkspaceRegistry(contents: string): LocalWorkspaceEntry[] {
  const lines = contents.split(/\r?\n/);
  const workspaces: LocalWorkspaceEntry[] = [];
  let current: Partial<LocalWorkspaceEntry> | null = null;
  let inWorkspaces = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      continue;
    }

    if (line.startsWith('workspaces:')) {
      inWorkspaces = true;
      continue;
    }

    if (!inWorkspaces) {
      continue;
    }

    const trimmed = line.trimStart();
    if (trimmed.startsWith('- ')) {
      if (current?.id && current.path) {
        workspaces.push({ id: current.id, path: current.path });
      }

      current = {};
      const firstField = trimmed.slice(2);
      if (firstField.startsWith('id:')) {
        current.id = parseRegistryScalar(firstField.slice(3).trim());
      } else if (firstField.startsWith('path:')) {
        current.path = parseRegistryScalar(firstField.slice(5).trim());
      }
      continue;
    }

    if (!current) {
      continue;
    }

    if (trimmed.startsWith('id:')) {
      current.id = parseRegistryScalar(trimmed.slice(3).trim());
      continue;
    }

    if (trimmed.startsWith('path:')) {
      current.path = parseRegistryScalar(trimmed.slice(5).trim());
    }
  }

  if (current?.id && current.path) {
    workspaces.push({ id: current.id, path: current.path });
  }

  return workspaces;
}

async function readWorkspaceRegistry(): Promise<LocalWorkspaceEntry[]> {
  try {
    const contents = await readFile(registryPath(), 'utf8');
    return parseWorkspaceRegistry(contents);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** True when the path is still a valid local checkout (matches scratchmd `config::workspaces::get`). */
async function isLocalScratchWorkspaceRoot(workspacePath: string): Promise<boolean> {
  try {
    const st = await stat(workspacePath);
    if (!st.isDirectory()) {
      return false;
    }
    const marker = join(workspacePath, '.scratch', '.scratchmd');
    const mt = await stat(marker);
    return mt.isFile();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function writeWorkspaceRegistry(entries: LocalWorkspaceEntry[]): Promise<void> {
  const path = registryPath();
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [`version: '1'`, 'workspaces:'];
  if (sorted.length === 0) {
    lines.push('[]');
  } else {
    for (const e of sorted) {
      lines.push(`- id: ${JSON.stringify(e.id)}`);
      lines.push(`  path: ${JSON.stringify(e.path)}`);
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

/** Drops registry rows whose folder or workspace marker was removed outside the app; rewrites the file when needed. */
async function pruneStaleWorkspaceRegistryEntries(entries: LocalWorkspaceEntry[]): Promise<LocalWorkspaceEntry[]> {
  const valid: LocalWorkspaceEntry[] = [];
  for (const entry of entries) {
    if (await isLocalScratchWorkspaceRoot(entry.path)) {
      valid.push(entry);
    } else {
      console.debug(
        '[scratch] Removing stale workspace registry entry (path or marker missing):',
        entry.id,
        entry.path,
      );
    }
  }
  if (valid.length !== entries.length) {
    await writeWorkspaceRegistry(valid);
  }
  return valid;
}

async function listLocalSyncFiles(workspacePath: string): Promise<string[]> {
  const syncsDir = join(workspacePath, '.scratch', 'workspace', 'syncs');

  try {
    const entries = await readdir(syncsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function windowIconPath(): string {
  const relative =
    process.platform === 'win32'
      ? join('win', 'icon.ico')
      : process.platform === 'linux'
        ? join('png', '512x512.png')
        : join('mac', 'icon.icns');

  const root = app.isPackaged ? join(process.resourcesPath, 'icons') : join(__dirname, '../../build/icons');

  return join(root, relative);
}

function createWindow(): void {
  const windowStart = performance.now();
  const windowState = getRestoredWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(windowState.x != null && windowState.y != null ? { x: windowState.x, y: windowState.y } : {}),
    show: false,
    autoHideMenuBar: true,
    icon: windowIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Disable web security in dev so the renderer (served from localhost:5173)
      // can reach the production API without CORS blocking preflight requests.
      webSecurity: !is.dev,
    },
  });
  logPerf('main createBrowserWindow', performance.now() - windowStart);

  attachWindowStatePersistence(mainWindow);

  mainWindow.on('closed', () => {
    void workspaceFileWatchService.clearWorkspaceFileWatch();
    // Drop the now-destroyed WebContents subscriber and any pending notify —
    // see review-stats-notifier.ts module docstring.
    reviewStatsNotifier.setSubscriber(null);
    reviewStatsNotifier.clear();
    mainWindow = null;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    flushPendingDeepLink();
  });

  mainWindow.on('ready-to-show', () => {
    logPerf('main windowReadyToShow (from app start)', performance.now() - appStartTime);
    if (windowState.shouldMaximize) {
      mainWindow?.maximize();
    }
    mainWindow?.show();
    const openDevTools = process.env['OPEN_DEVTOOLS'] === '1' || is.dev;
    if (openDevTools) {
      mainWindow?.webContents.openDevTools({ mode: 'bottom' });
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

async function findWorkspaceRootForPath(filePath: string): Promise<string | null> {
  const absolutePath = resolve(filePath);
  const rawEntries = await readWorkspaceRegistry();
  const entries = await pruneStaleWorkspaceRegistryEntries(rawEntries);
  const matchingEntries = entries
    .filter((entry) => absolutePath === entry.path || absolutePath.startsWith(`${entry.path}${sep}`))
    .sort((a, b) => b.path.length - a.path.length);
  return matchingEntries[0]?.path ?? null;
}

async function withWorkspaceInternalMutation<T>(workspacePath: string, action: () => Promise<T>): Promise<T> {
  const endInternalMutation = workspaceFileWatchService.beginInternalWorkspaceMutation(workspacePath);
  try {
    return await action();
  } finally {
    endInternalMutation();
  }
  // Note: review-state dot refresh used to be triggered here. It now flows
  // through `setMutationHandler` / `setAcceptedPatchesHandler` on the file
  // watcher, which catches every relevant on-disk change — including ones
  // produced by external `scratchmd` CLI runs from a terminal.
}

/**
 * Seed the `enforce_schema` validator into every folder that still lacks it, then populate the
 * validation problems table for the folders that were just seeded.
 *
 * Seeding only writes `validation.json`. The cached `validation_results` table that powers the
 * Validation panel and sidebar counts is filled by an explicit validate run, so without this a
 * freshly-seeded folder shows zero problems until its grid is opened (the grid validates live).
 * We revalidate only the *newly-seeded* folders — `index refresh-folder --validate` is mtime-aware
 * and the seeder returns nothing once every folder already has the validator, so this is a no-op in
 * steady state. Best-effort throughout: a seeding or revalidation failure must never fail the pull
 * (or mount) that triggered it.
 */
async function seedSchemaValidatorsAndPopulateProblems(workspacePath: string): Promise<void> {
  let newlySeededFolders: Array<{ connectionDirName: string; folderPath: string }> = [];
  try {
    newlySeededFolders = await ensureSchemaValidatorSeededInEveryFolder(workspacePath);
  } catch (error) {
    console.debug('[validation] auto-seed enforce_schema failed:', error);
    return;
  }

  for (const { connectionDirName, folderPath } of newlySeededFolders) {
    const workspaceRelativeFolder = folderPath ? `${connectionDirName}/${folderPath}` : connectionDirName;
    try {
      await refreshFolderIndex(workspacePath, workspaceRelativeFolder, { validate: true });
    } catch (error) {
      console.debug(`[validation] revalidate after seeding ${workspaceRelativeFolder} failed:`, error);
    }
  }
}

/**
 * Pull the latest server `main` into a workspace, the single choke point shared
 * by the manual "Re-download files" IPC handler and the scheduled background
 * auto-download (DEV-10470).
 *
 * `files download` reindexes the affected folders itself (per-path, scoped to
 * the actually-changed records, plus a master diff for connections whose
 * published state advanced) — no follow-up CLI call. `opts.filePath`
 * (DEV-10413/DEV-10523) scopes only the single-record "Download and publish"
 * failure decision to that record; the whole workspace still pulls.
 *
 * Re-seeds schema validators after every pull: a pull can materialize folders
 * for a connection that was not on disk when the workspace was first seeded on
 * load (a newly-connected service, or a connection still being pulled when the
 * mount-time seed ran). Seeding here guarantees schema validation is present for
 * those late-arriving folders and populates the problems table so validation
 * counts surface without waiting for the grid to open. The writes land inside
 * the internal-mutation window, so they do not provoke a spurious file-watch
 * refresh.
 */
async function performWorkspaceDownload(
  workspacePath: string,
  opts?: { onDelete?: string; filePath?: string; connectionId?: string },
): Promise<DownloadWorkspaceResult> {
  return withWorkspaceInternalMutation(workspacePath, async () => {
    const downloadResult = await pullWorkspaceChanges(workspacePath, opts);
    await seedSchemaValidatorsAndPopulateProblems(workspacePath);
    return downloadResult;
  });
}

// Per-(workspace, connection) async queue for folder-index reads. The CLI stores one SQLite
// file per connection (workspace/.repos/{conn}.db), so two concurrent paginate-records calls
// against any folders within the same connection race on the same DB. During a large lazy
// reindex this surfaces as "database is locked". Serialize same-DB calls; different DBs still
// run in parallel.
const folderIndexQueues = new Map<string, Promise<unknown>>();

function folderIndexQueueKey(workspacePath: string, folderPath: string): string {
  const rel = relative(workspacePath, folderPath).replace(/^[/\\]+/, '');
  const conn = rel.split(/[/\\]/)[0] || rel;
  return `${workspacePath}::${conn}`;
}

async function withFolderIndexQueue<T>(
  workspacePath: string,
  folderPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = folderIndexQueueKey(workspacePath, folderPath);
  const previous = folderIndexQueues.get(key) ?? Promise.resolve();
  // Swallow the previous result/error so a single failure doesn't poison the queue for later calls.
  const next = previous.catch(() => undefined).then(() => action());
  folderIndexQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (folderIndexQueues.get(key) === next) {
      folderIndexQueues.delete(key);
    }
  }
}

async function withFilePathInternalMutation<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const workspacePath = await findWorkspaceRootForPath(filePath);
  if (!workspacePath) {
    return action();
  }
  return withWorkspaceInternalMutation(workspacePath, action);
}

/** Derive the workspace-relative folder from a workspace-relative record path. */
function folderFromRecordPath(recordPath: string): string {
  const parts = recordPath.split('/');
  return parts.slice(0, -1).join('/');
}

/** Derive the bare filename from a workspace-relative record path. */
function filenameFromRecordPath(recordPath: string): string {
  const parts = recordPath.split('/');
  return parts[parts.length - 1] ?? recordPath;
}

function startWorkspaceInternalLiveCommand(
  sender: Electron.WebContents,
  workspacePath: string,
  args: string[],
): Promise<{ sessionId: string }> {
  const endInternalMutation = workspaceFileWatchService.beginInternalWorkspaceMutation(workspacePath);
  return startScratchmdLiveCommand(sender, args, workspacePath, { onExit: endInternalMutation });
}

// Auth IPC handlers
ipcMain.handle('auth:get-credentials', () => {
  const start = performance.now();
  const result = getCredentials();
  logPerf('main ipc getCredentials', performance.now() - start);
  return result;
});
ipcMain.handle(
  'auth:save-credentials',
  async (_, creds: { apiToken: string; email?: string; tokenExpiresAt?: string; serverUrl: string }) => {
    saveCredentials(creds);
    // Keep scratchmd (spawned CLI + in-process napi) pointed at this server;
    // scratchmdEnv() inherits process.env. Credentials are keyed by hostname,
    // so SCRATCH_URL must match the server we just stored.
    if (creds.serverUrl) {
      process.env.SCRATCH_URL = creds.serverUrl;
    }

    // Sync credentials to the scratchmd CLI so it can authenticate without a separate login.
    await syncCredentialsToScratchmdCli(creds);
  },
);
ipcMain.handle('auth:clear-credentials', () => clearCredentials());
ipcMain.handle('auth:is-token-expired', () => {
  const start = performance.now();
  const result = isTokenExpired();
  logPerf('main ipc isTokenExpired', performance.now() - start);
  return result;
});
ipcMain.handle('auth:open-external', (_, url: string) => shell.openExternal(url));

// Preferences IPC handlers
ipcMain.handle('preferences:get-current-workspace-id', () => getCurrentWorkspaceId());
ipcMain.handle('preferences:set-current-workspace-id', (_, id: string | null) => setCurrentWorkspaceId(id));
ipcMain.handle('preferences:get-workbook-settings', (_, workbookId: string) => getWorkbookSettings(workbookId));
ipcMain.handle(
  'preferences:set-workbook-setting',
  (_, workbookId: string, key: keyof WorkbookSettings, value: unknown) => setWorkbookSetting(workbookId, key, value),
);

ipcMain.handle('scratch:get-workspaces-registry', async () => {
  const start = performance.now();
  const rawEntries = await readWorkspaceRegistry();
  const entries = await pruneStaleWorkspaceRegistryEntries(rawEntries);
  const result = await Promise.all(
    entries.map(async (entry) => {
      // Count files and detect cloud-sync concurrently — independent disk reads.
      // countWorkspaceFiles can throw if the path can't be read; fall back to 0
      // to honor LocalWorkspaceEntry.fileCount's documented contract. Stale paths
      // are already dropped by pruneStaleWorkspaceRegistryEntries above.
      const [fileCount, cloudSyncDetection] = await Promise.all([
        countWorkspaceFiles(entry.path).catch(() => 0),
        detectCloudSync(entry.path),
      ]);
      return {
        ...entry,
        fileCount,
        cloudSyncWarning: toCloudSyncWarning(cloudSyncDetection),
      };
    }),
  );
  logPerf('main ipc getWorkspacesRegistry', performance.now() - start);
  return result;
});

function toCloudSyncWarning(detection: CloudSyncDetection | null) {
  if (!detection) return null;
  return {
    provider: detection.provider,
    providerLabel: detection.providerLabel,
    evidencePath: detection.evidencePath,
  };
}
ipcMain.handle('scratch:pick-parent-folder', async () => {
  while (true) {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const picked = result.filePaths[0];
    if (!picked) return null;
    const detection = await detectCloudSync(picked);
    if (!detection) {
      return picked;
    }
    const refusal = await dialog.showMessageBox({
      type: 'warning',
      title: "Can't use this location",
      message: `Scratch can't store a workspace inside ${detection.providerLabel}.`,
      detail:
        `${detection.providerLabel} re-syncs files in the background, which can cause Scratch to lose edits or end up ` +
        `in a broken state. Pick a folder that isn't inside ${detection.evidencePath} — for example, ~/Scratch.`,
      buttons: ['Pick a different folder', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (refusal.response !== 0) {
      return null;
    }
  }
});
ipcMain.handle('scratch:create-workspace', async (_, name: string) =>
  runScratchmdJson<{ id: string; name: string }>(['--json', 'workspaces', 'create', name]),
);
ipcMain.handle('scratch:init-workspace', async (_, workbookId: string, cwd: string, opts?: { force?: boolean }) =>
  runScratchmd(['workspaces', 'init', workbookId, ...(opts?.force ? ['--force'] : [])], cwd),
);
ipcMain.handle('scratch:remove-workspace', async (_, workbookId: string) => {
  const ipcStart = performance.now();
  console.log('[remove-workspace] start', workbookId);

  // Look up the registered path so we can move it to Trash directly. Avoids
  // scratchmd's slow `remove_dir_all` on large workspaces (~15s on Monorepo).
  const lookupStart = performance.now();
  const entries = await readWorkspaceRegistry();
  const entry = entries.find((e) => e.id === workbookId);
  console.log(`[remove-workspace] registry lookup: ${(performance.now() - lookupStart).toFixed(0)}ms`);

  let trashed = false;
  if (entry) {
    const trashStart = performance.now();
    try {
      await shell.trashItem(entry.path);
      trashed = true;
      console.log(`[remove-workspace] trashItem: ${(performance.now() - trashStart).toFixed(0)}ms (${entry.path})`);
    } catch (err) {
      console.log(
        `[remove-workspace] trashItem failed after ${(performance.now() - trashStart).toFixed(0)}ms, falling back to delete:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    console.log('[remove-workspace] no registry entry — letting scratchmd surface the error');
  }

  if (trashed) {
    // Fire-and-forget the registry tidy. scratchmd sees the path is already
    // gone, skips remove_dir_all, just updates workspaces.yaml.
    void (async () => {
      const cliStart = performance.now();
      try {
        const result = await runScratchmd(['workspaces', 'unsync', workbookId, '--yes']);
        console.log(`[remove-workspace] background scratchmd unsync: ${(performance.now() - cliStart).toFixed(0)}ms`);
        if (result.stderr.trim()) {
          console.log('[remove-workspace] background scratchmd stderr:\n' + result.stderr.trimEnd());
        }
      } catch (err) {
        console.log(
          '[remove-workspace] background scratchmd unsync failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  } else {
    // Fallback: synchronous slow path (scratchmd does the delete).
    const cliStart = performance.now();
    const result = await runScratchmd(['workspaces', 'unsync', workbookId, '--yes']);
    console.log(
      `[remove-workspace] scratchmd unsync (fallback, awaited): ${(performance.now() - cliStart).toFixed(0)}ms`,
    );
    if (result.stderr.trim()) {
      console.log('[remove-workspace] scratchmd stderr:\n' + result.stderr.trimEnd());
    }
  }

  const watchStart = performance.now();
  workspaceFileWatchService.clearWorkspaceFileWatch();
  console.log(`[remove-workspace] clearWorkspaceFileWatch: ${(performance.now() - watchStart).toFixed(0)}ms`);

  console.log(`[remove-workspace] total IPC: ${(performance.now() - ipcStart).toFixed(0)}ms`);
});
ipcMain.handle('scratch:prepare-workspace-index', async () => {
  // No-op: the folder-index seeds itself lazily on first run_query call.
});

ipcMain.handle(
  'scratch:clear-folder-index',
  async (_, workspacePath: string, folderPath: string): Promise<{ rows_cleared: number }> => {
    return clearFolderIndex(workspacePath, folderPath);
  },
);
ipcMain.handle(
  'scratch:rerun-validation',
  async (event, workspacePath: string, scope: RerunValidationScope): Promise<RerunValidationSummary> => {
    // Forward per-folder stderr progress lines so the renderer can update a live toast.
    return rerunValidation(workspacePath, scope, (line) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('scratch:rerun-validation-progress', line);
      }
    });
  },
);
ipcMain.handle('scratch:refresh-paths', () => {
  // No-op: working-tree changes are detected automatically by `index find-stale-files`
  // on the next paginate-records call. Dirty/master mutations trigger explicit
  // `index refresh-files-full` / `index rebuild-folder` calls at the IPC handler
  // that performed the mutation.
  return { success: true };
});
// The bulk review handlers receive the absolute folder path the renderer holds
// (its `selectedFolderPath`) and relativize it to the CLI's workspace-relative
// POSIX form here — the single absolute→relative conversion seam, so the
// renderer never does fragile path math. `files <op>-all` reindexes the affected
// folders itself; no follow-up call needed.
//
// Resolve the optional absolute `folderPath` into the CLI's `--folder` args. A
// folder that was passed but does NOT resolve to a path inside the workspace is
// refused outright: we must never fall through to a folder-less (whole-workspace)
// run, which for `discard-all` would throw away every pending and approved change
// in the workbook. `''` (folder is the workspace root) and a `..`-prefixed result
// (folder is outside the workspace) both fail this check.
function resolveBulkReviewFolderArgs(
  workspacePath: string,
  folderPath: string | undefined,
): { ok: true; folderArgs: string[] } | { ok: false; result: ScratchmdResult } {
  if (!folderPath) return { ok: true, folderArgs: [] };
  const cliFolder = toWorkspaceRelativeCliFolder(workspacePath, folderPath);
  if (!cliFolder || cliFolder.startsWith('..')) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        stdout: '',
        stderr: `Folder ${JSON.stringify(folderPath)} is not inside workspace ${JSON.stringify(workspacePath)}.`,
      },
    };
  }
  return { ok: true, folderArgs: ['--folder', cliFolder] };
}
ipcMain.handle(
  'scratch:accept-all-changes',
  async (_, workspacePath: string, folderPath?: string, connectionId?: string) => {
    const folder = resolveBulkReviewFolderArgs(workspacePath, folderPath);
    if (!folder.ok) return folder.result;
    // DEV-10596: `connectionId` scopes the accept to one connection's data folders
    // (mutually exclusive with `folderPath`; the CLI also rejects the combination).
    const connectionArgs = connectionId ? ['--connection', connectionId] : [];
    const args = ['files', 'accept-all', ...folder.folderArgs, ...connectionArgs];
    return withWorkspaceInternalMutation(workspacePath, () => runScratchmdCapture(args, workspacePath));
  },
);
ipcMain.handle('scratch:discard-all-changes', async (_, workspacePath: string, folderPath?: string) => {
  const folder = resolveBulkReviewFolderArgs(workspacePath, folderPath);
  if (!folder.ok) return folder.result;
  const args = ['files', 'discard-all', ...folder.folderArgs];
  return withWorkspaceInternalMutation(workspacePath, () => runScratchmdCapture(args, workspacePath));
});
ipcMain.handle(
  'scratch:reject-all-changes',
  async (_, workspacePath: string, folderPath?: string, connectionId?: string) => {
    const folder = resolveBulkReviewFolderArgs(workspacePath, folderPath);
    if (!folder.ok) return folder.result;
    // DEV-10596: `connectionId` scopes the reject to one connection's data folders
    // (mutually exclusive with `folderPath`; the CLI also rejects the combination).
    const connectionArgs = connectionId ? ['--connection', connectionId] : [];
    const args = ['files', 'reject-all', ...folder.folderArgs, ...connectionArgs];
    return withWorkspaceInternalMutation(workspacePath, () => runScratchmdCapture(args, workspacePath));
  },
);
ipcMain.handle('scratch:accept-record', async (_, workspacePath: string, recordPath: string) =>
  withWorkspaceInternalMutation(workspacePath, async () => {
    const result = await runScratchmdCapture(['files', 'accept', recordPath], workspacePath);
    if (result.exitCode === 0) {
      // accept moves working → dirty; dirty changed so hot path won't detect it
      await reindexFiles(workspacePath, folderFromRecordPath(recordPath), [filenameFromRecordPath(recordPath)]);
    }
    return result;
  }),
);
ipcMain.handle('scratch:accept-records', async (_, workspacePath: string, recordPaths: string[]) =>
  withWorkspaceInternalMutation(workspacePath, async () => {
    if (recordPaths.length === 0) return { stdout: '', stderr: '', exitCode: 0 };
    // The CLI `files accept` takes many paths in one call (the by-type view's
    // "Approve all N" for a created/removed/invalid group), so this is one spawn
    // instead of N. accept moves working → dirty; dirty changed so the hot path
    // won't detect it — reindex the affected records, grouped by folder.
    const result = await runScratchmdCapture(['files', 'accept', ...recordPaths], workspacePath);
    if (result.exitCode === 0) {
      const filenamesByFolder = new Map<string, string[]>();
      for (const recordPath of recordPaths) {
        const folder = folderFromRecordPath(recordPath);
        const filenames = filenamesByFolder.get(folder) ?? [];
        filenames.push(filenameFromRecordPath(recordPath));
        filenamesByFolder.set(folder, filenames);
      }
      for (const [folder, filenames] of Array.from(filenamesByFolder.entries())) {
        await reindexFiles(workspacePath, folder, filenames);
      }
    }
    return result;
  }),
);
ipcMain.handle('scratch:reject-record', async (_, workspacePath: string, recordPath: string) =>
  withWorkspaceInternalMutation(workspacePath, async () => {
    // reject reverts working only; hot path detects working-tree changes automatically
    return runScratchmdCapture(['files', 'reject', recordPath], workspacePath);
  }),
);
ipcMain.handle('scratch:discard-record', async (_, workspacePath: string, recordPath: string) =>
  withWorkspaceInternalMutation(workspacePath, async () => {
    const result = await runScratchmdCapture(['files', 'discard', recordPath], workspacePath);
    if (result.exitCode === 0) {
      // discard resets both dirty and working to master; dirty changed so hot path won't detect it
      await reindexFiles(workspacePath, folderFromRecordPath(recordPath), [filenameFromRecordPath(recordPath)]);
    }
    return result;
  }),
);
ipcMain.handle('scratch:list-unreviewed-changes', async (_, workspacePath: string) =>
  listUnreviewedChanges(workspacePath),
);
ipcMain.handle('scratch:list-unpushed-changes', async (_, workspacePath: string) => listUnpushedChanges(workspacePath));
ipcMain.handle(
  'scratch:upload-workspace-changes',
  async (_, workspacePath: string, opts?: { filePath?: string; connectionId?: string }) =>
    // `files upload` reindexes the affected folders itself (per-path,
    // scoped to the actually-changed records). No follow-up CLI call.
    // `opts.filePath` (DEV-10413) scopes the upload to a single record;
    // `opts.connectionId` (DEV-10596) scopes it to a single connection.
    withWorkspaceInternalMutation(workspacePath, () => uploadWorkspaceChanges(workspacePath, opts)),
);
// Single-record post-publish reconcile (DEV-10413). The scoped analogue of the
// `files download` pull above — runs after a single-record publish lands so the
// other unreviewed edits in the workspace don't block the refresh.
ipcMain.handle(
  'scratch:reconcile-published-record',
  async (_, workspacePath: string, filePath: string, pipelineId?: string) =>
    withWorkspaceInternalMutation(workspacePath, () => reconcilePublishedRecord(workspacePath, filePath, pipelineId)),
);
// Per-connection post-publish reconcile (publish redesign, DEV-10048). Run after a
// connection's run-job: routes connector-rejected records into `failed-patches.json`,
// drops publish-no-op survivors, and re-surfaces failed edits as needs-approval —
// replacing the generic `pullWorkspaceChanges` for the publish path so failures
// aren't lost. `failedOpsJson` is the run-job's `failedOperations` as a JSON string.
ipcMain.handle(
  'scratch:reconcile-after-publish',
  async (_, workspacePath: string, connectionId: string, failedOpsJson: string, pipelineId?: string) =>
    withWorkspaceInternalMutation(workspacePath, async () => {
      const result = await reconcileAfterPublish(workspacePath, connectionId, failedOpsJson, pipelineId);
      // Mirror the pull handler: re-seed schema validators for any folders the
      // reconcile materialized so validation counts stay current.
      await seedSchemaValidatorsAndPopulateProblems(workspacePath);
      return result;
    }),
);
ipcMain.handle(
  'scratch:pull-workspace-changes',
  async (_, workspacePath: string, opts?: { onDelete?: string; filePath?: string; connectionId?: string }) =>
    performWorkspaceDownload(workspacePath, opts),
);
ipcMain.handle('scratch:list-local-syncs', async (_, workspacePath: string) => listLocalSyncFiles(workspacePath));
ipcMain.handle('scratch:validate-local-sync', async (_, workspacePath: string, syncName: string) =>
  runScratchmdCapture(['syncs', 'validate-local', '--sync', syncName], workspacePath),
);
ipcMain.handle('scratch:start-run-local-sync', async (event, workspacePath: string, syncName: string) =>
  startWorkspaceInternalLiveCommand(event.sender, workspacePath, ['syncs', 'run-local', '--sync', syncName]),
);

ipcMain.handle('scratch:pull-all-linked-tables', async (_, workspacePath: string) =>
  withWorkspaceInternalMutation(workspacePath, () =>
    runScratchmdJson<{ jobIds: string[] }>(['--json', 'linked', 'pull-all'], workspacePath),
  ),
);
// Derive the record tree of a folder whose schema declares `recordTree`
// parent-pointer paths (read-only one-shot — plain shell-out, no mutation lock).
ipcMain.handle('scratch:record-tree', async (_, workspacePath: string, folder: string) =>
  runScratchmdJson(['record-tree', '--folder', folder], workspacePath),
);
ipcMain.handle('scratch:watch-workspace-files', async (event, workspacePath: string) => {
  const folders = await listFolders(workspacePath);
  const folderPaths = folders.map((f) => f.path);
  // Register the renderer as the subscriber for review-stats notifications.
  // No cold-start sweep: the dots derive live from git on the renderer's
  // initial `getReviewStats` fetch (DEV-10327).
  reviewStatsNotifier.setSubscriber(event.sender);
  return workspaceFileWatchService.watchWorkspaceFiles(event.sender, workspacePath, folderPaths);
});
ipcMain.handle('scratch:clear-workspace-file-watch', (_, workspacePath?: string) => {
  workspaceFileWatchService.clearWorkspaceFileWatch();
  reviewStatsNotifier.setSubscriber(null);
  // Drop any pending notify for the workspace being closed/switched away from.
  if (workspacePath) {
    reviewStatsNotifier.cancelWorkspace(workspacePath);
  }
});
ipcMain.handle('scratch:show-in-folder', (_, folderPath: string) => {
  void shell.openPath(folderPath);
});
ipcMain.handle('scratch:show-item-in-folder', (_, filePath: string) => {
  shell.showItemInFolder(filePath);
});
ipcMain.handle('scratch:show-workspace-log', async (_, workspacePath: string) => {
  const logPath = join(workspacePath, 'workspace.log');
  try {
    await stat(logPath);
    shell.showItemInFolder(logPath);
  } catch {
    void shell.openPath(workspacePath);
  }
});
ipcMain.handle('scratch:open-in-terminal', (_, folderPath: string) => {
  if (process.platform === 'win32') {
    // Open a VISIBLE PowerShell window at the folder. Launch via `cmd /c start`
    // so PowerShell gets its own new console window (showing it is the whole
    // point); the transient cmd launcher is hidden via windowsHide. PowerShell
    // inherits the folder as its working directory from `cwd`, so there's no
    // path to quote. `start`'s first (empty) quoted arg is the window title.
    spawn('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit'], {
      cwd: folderPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return;
  }
  // macOS: open Terminal.app at the folder.
  spawn('open', ['-a', 'Terminal', folderPath], { stdio: 'ignore', detached: true }).unref();
});
ipcMain.on(
  'scratch:show-native-context-menu',
  (
    event,
    items: Array<{
      id: string;
      label: string;
      type?: 'separator';
      danger?: boolean;
      enabled?: boolean;
      checked?: boolean;
      submenu?: Array<{ id: string; label: string; checked?: boolean }>;
    }>,
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const template = items.map((item) => {
      if (item.type === 'separator') return { type: 'separator' as const };
      if (item.submenu) {
        return {
          label: item.label,
          enabled: item.enabled,
          submenu: item.submenu.map((sub) => ({
            label: sub.label,
            type: sub.checked !== undefined ? ('checkbox' as const) : undefined,
            checked: sub.checked,
            click: () => event.sender.send('scratch:native-context-menu-click', sub.id),
          })),
        };
      }
      return {
        label: item.label,
        enabled: item.enabled,
        type: item.checked !== undefined ? ('checkbox' as const) : undefined,
        checked: item.checked,
        click: () => event.sender.send('scratch:native-context-menu-click', item.id),
      };
    });
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: win });
  },
);
ipcMain.handle('scratch:toggle-devtools', (event) => {
  event.sender.toggleDevTools();
});

ipcMain.handle('scratch:get-app-version', () => app.getVersion());

// Updater IPC. Routes the renderer's "Check for updates" / "Restart & install"
// requests through the updater controller. When the controller is null
// (development build or SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE), we still surface
// a manual-check 'error' event so the menu click feels responsive.
ipcMain.handle('updater:check-now', async () => {
  if (!updaterController) {
    sendUpdaterEvent({
      type: 'error',
      manual: true,
      phase: 'check',
      message: 'Auto-update is unavailable in this build.',
    });
    return;
  }
  await updaterController.checkForUpdates();
});
ipcMain.handle('updater:quit-and-install', () => {
  updaterController?.quitAndInstall();
});

function sendUpdaterEvent(event: UpdaterEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(UPDATER_EVENT_CHANNEL, event);
}

function sendCliInstallEvent(event: CliInstallEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(CLI_INSTALL_EVENT_CHANNEL, event);
}

// Tracks whether our /usr/local/bin/scratchmd symlink exists. Seeded on app
// ready (see whenReady handler) and toggled by install/uninstall handlers,
// which then rebuild the app menu so the item label flips Install ↔ Uninstall.
let cliInstalled = false;

async function handleInstallCliMenuClick(): Promise<void> {
  const result = await installScratchmdToPath();
  if (result.status === 'installed') {
    cliInstalled = true;
    Menu.setApplicationMenu(buildApplicationMenu());
    sendCliInstallEvent({ type: 'installed' });
  } else if (result.status === 'failed') {
    sendCliInstallEvent({ type: 'failed', message: result.message });
  }
  // 'cancelled' is silent — user dismissed the admin prompt.
}

async function handleUninstallCliMenuClick(): Promise<void> {
  const result = await uninstallScratchmdFromPath();
  if (result.status === 'uninstalled') {
    cliInstalled = false;
    Menu.setApplicationMenu(buildApplicationMenu());
    sendCliInstallEvent({ type: 'uninstalled' });
  } else if (result.status === 'failed') {
    sendCliInstallEvent({ type: 'failed', message: result.message });
  }
  // 'cancelled' is silent.
}

function buildApplicationMenu(): Menu {
  const isMac = process.platform === 'darwin';
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => {
      if (!updaterController) {
        sendUpdaterEvent({
          type: 'error',
          manual: true,
          phase: 'check',
          message: 'Auto-update is unavailable in this build.',
        });
        return;
      }
      void updaterController.checkForUpdates();
    },
  };

  const installCliItem: MenuItemConstructorOptions = cliInstalled
    ? {
        label: 'Uninstall Command Line Tools…',
        click: () => void handleUninstallCliMenuClick(),
      }
    : {
        label: 'Install Command Line Tools…',
        click: () => void handleInstallCliMenuClick(),
      };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              checkForUpdatesItem,
              installCliItem,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: isMac ? [] : [checkForUpdatesItem],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// Local file access IPC handlers
ipcMain.handle('files:workspace-config', async (_, workspacePath: string) => readWorkspaceConfig(workspacePath));
ipcMain.handle('files:list-folders', async (_, workspacePath: string) => listFolders(workspacePath));
ipcMain.handle('files:folder-metadata', async (_, folderPath: string, workspacePath: string) =>
  getFolderMetadata(folderPath, workspacePath),
);
ipcMain.handle(
  'files:list-files',
  async (
    _,
    folderPath: string,
    opts: {
      offset: number;
      limit: number;
      sortBy?: 'name' | 'modified' | 'size';
      sortOrder?: 'asc' | 'desc';
      filter?: { search?: string; extensions?: string[] };
    },
  ) => {
    console.debug('files:list-files', folderPath);
    return listFiles(folderPath, opts);
  },
);
ipcMain.handle('files:read-file', async (_, filePath: string) => readFileContent(filePath));
ipcMain.handle('files:read-file-text-raw', async (_, filePath: string) => readFileTextRaw(filePath));
ipcMain.handle('files:write-file-text-raw', async (_, filePath: string, contents: string) =>
  withFilePathInternalMutation(filePath, async () => {
    const result = await writeFileTextRaw(filePath, contents);
    return result;
  }),
);
ipcMain.handle(
  'publish-plan:revert',
  async (
    _,
    workspacePath: string,
    planId: string,
    filter?: { filePath?: string; dataFolderId?: string; phase?: string; filename?: string },
  ) =>
    // Single-record AND bulk go through the same CLI command. `--file-path`
    // takes a single connection-relative path; the other filter flags work
    // against the plan's full record list (fetched fresh server-side).
    // Pre-publish blobs are read from the local bare repo at
    // `preMainCommitSha`, so the only network calls are two metadata
    // fetches (plan + records list).
    withWorkspaceInternalMutation(workspacePath, async () => {
      const args = ['files', 'revert-plan', '--plan-id', planId, '--json'];
      if (filter?.filePath) args.push('--file-path', filter.filePath);
      if (filter?.dataFolderId) args.push('--data-folder-id', filter.dataFolderId);
      if (filter?.phase) args.push('--phase', filter.phase);
      if (filter?.filename) args.push('--filename', filter.filename);
      try {
        const { stdout } = await runScratchmd(args, workspacePath);
        const parsed = JSON.parse(stdout) as {
          total: number;
          filesWritten: number;
          filesDeleted: number;
          elapsedMs: number;
        };
        return { ok: true as const, ...parsed };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: message };
      }
    }),
);
ipcMain.handle('files:read-batch', async (_, filePaths: string[], opts?: { maxSize?: number }) =>
  readBatch(filePaths, opts),
);
ipcMain.handle('files:read-schema', async (_, workspacePath: string, folderName: string) =>
  readSchema(workspacePath, folderName),
);
ipcMain.handle('files:read-connection-schema', async (_, workspacePath: string, relPath: string) =>
  readConnectionSchema(workspacePath, relPath),
);
ipcMain.handle('files:read-connection-view', async (_, folderPath: string, workspacePath: string, viewName: string) =>
  readConnectionViewByName(folderPath, workspacePath, viewName),
);
ipcMain.handle(
  'files:read-grid-data',
  async (
    _,
    folderPath: string,
    opts?: {
      offset?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      filter?: Record<string, unknown>;
      columns?: string[];
      filterStatus?: FilterStatus;
      workspacePath?: string;
    },
  ) => readGridData(folderPath, { ...opts }),
);

ipcMain.handle('files:read-folder-statuses', async (_, folderPath: string, workspacePath: string) =>
  readFolderStatuses(folderPath, workspacePath),
);
ipcMain.handle('files:find-record-offset', async (_, folderPath: string, workspacePath: string, filename: string) =>
  findRecordOffset(folderPath, workspacePath, filename),
);

ipcMain.handle(
  'files:read-diff-grid-data',
  async (
    event,
    folderPath: string,
    workspacePath: string,
    opts?: {
      offset?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      filters?: DiffGridFilter[];
      validate?: boolean;
    },
  ) => {
    return withFolderIndexQueue(workspacePath, folderPath, async () => {
      const onProgress = (line: string): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('scratch:grid-progress', line);
        }
      };
      return readDiffGridDataPage(folderPath, workspacePath, opts ?? {}, onProgress);
    });
  },
);
ipcMain.handle('files:read-diff-record-data', async (_, folderPath: string, workspacePath: string, filename: string) =>
  readDiffRecordData(folderPath, workspacePath, filename),
);
ipcMain.handle('files:get-validation-results', async (_, workspacePath: string, folderPath: string, filename: string) =>
  getValidationResults(workspacePath, folderPath, filename),
);
ipcMain.handle('files:get-folder-validation-results', async (_, workspacePath: string, folderPath: string) =>
  getFolderValidationResults(workspacePath, folderPath),
);
ipcMain.handle('files:get-validation-stats', async (_, workspacePath: string) => getValidationStats(workspacePath));
ipcMain.handle('files:get-review-stats', async (_, workspacePath: string) => getReviewStats(workspacePath));
ipcMain.handle('files:get-folder-validation-sample', async (_, workspacePath: string, folder: string) =>
  getFolderValidationSample(workspacePath, folder),
);
ipcMain.handle('files:get-validation-configs', async (_, workspacePath: string) => getValidationConfigs(workspacePath));
ipcMain.handle(
  'files:write-validation-config',
  async (_, workspacePath: string, connection: string, folderPath: string, entries: unknown[]) =>
    writeValidationConfig(
      workspacePath,
      connection,
      folderPath,
      entries as Parameters<typeof writeValidationConfig>[3],
    ),
);
ipcMain.handle('files:ensure-schema-validator-seeded', async (_, workspacePath: string) =>
  // Wrap in the internal-mutation window so the seeded `validation.json` writes (under `.scratch/`)
  // and the follow-up revalidation do not trip the workspace file watcher into a spurious
  // schema/view hot-reload in the renderer.
  withWorkspaceInternalMutation(workspacePath, () => seedSchemaValidatorsAndPopulateProblems(workspacePath)),
);
ipcMain.handle(
  'files:accept-cell-input-text',
  async (_, folderPath: string, workspacePath: string, filename: string, fieldName: string, value: string) =>
    withWorkspaceInternalMutation(workspacePath, async () => {
      const result = await acceptFieldEditFromInputText(folderPath, workspacePath, filename, fieldName, value);
      await reindexFiles(workspacePath, relative(workspacePath, folderPath), [filename], { validate: true });
      return result;
    }),
);
ipcMain.handle(
  'files:accept-cell-change',
  async (_, folderPath: string, workspacePath: string, filename: string, fieldName: string, value: string) =>
    withWorkspaceInternalMutation(workspacePath, async () => {
      const result = await acceptUnreviewedFieldEdit(folderPath, workspacePath, filename, fieldName, value);
      await reindexFiles(workspacePath, relative(workspacePath, folderPath), [filename], { validate: true });
      return result;
    }),
);
ipcMain.handle(
  'files:undo-approved-cell-change',
  async (_, folderPath: string, workspacePath: string, filename: string, fieldName: string) =>
    withWorkspaceInternalMutation(workspacePath, async () => {
      const result = await dropApprovedFieldAndRestoreToMain(folderPath, workspacePath, filename, fieldName);
      await reindexFiles(workspacePath, relative(workspacePath, folderPath), [filename], { validate: true });
      return result;
    }),
);
ipcMain.handle(
  'files:reject-cell-change',
  async (_, folderPath: string, workspacePath: string, filename: string, fieldName: string) =>
    withWorkspaceInternalMutation(workspacePath, async () => {
      const result = await revertUnreviewedFieldEditToApproved(folderPath, workspacePath, filename, fieldName);
      await reindexFiles(workspacePath, relative(workspacePath, folderPath), [filename], { validate: true });
      return result;
    }),
);
ipcMain.handle('files:restore-deleted-record', async (_, folderPath: string, workspacePath: string, filename: string) =>
  withWorkspaceInternalMutation(workspacePath, async () => {
    const result = await restoreDeletedRecordViaCli(
      workspacePath,
      toWorkspaceRecordPath(workspacePath, folderPath, filename),
    );
    return result;
  }),
);
ipcMain.handle('files:discard-created-record', async (_, folderPath: string, workspacePath: string, filename: string) =>
  withWorkspaceInternalMutation(workspacePath, async () => {
    const result = await discardCreatedRecordViaCli(
      workspacePath,
      toWorkspaceRecordPath(workspacePath, folderPath, filename),
    );
    return result;
  }),
);
ipcMain.handle('files:accept-field-changes', async (_, folderPath: string, workspacePath: string, fieldName: string) =>
  withWorkspaceInternalMutation(workspacePath, async () => {
    const result = await acceptFieldChanges(workspacePath, folderPath, fieldName);
    // result.paths has workspace-relative paths; all in the same folder
    if (result.paths.length > 0) {
      const folder = folderFromRecordPath(result.paths[0]);
      await reindexFiles(workspacePath, folder, result.paths.map(filenameFromRecordPath));
    }
    return result;
  }),
);
ipcMain.handle('files:reject-field-changes', async (_, folderPath: string, workspacePath: string, fieldName: string) =>
  withWorkspaceInternalMutation(workspacePath, async () => {
    const result = await rejectFieldChanges(workspacePath, folderPath, fieldName);
    // result.paths has workspace-relative paths; all in the same folder
    if (result.paths.length > 0) {
      const folder = folderFromRecordPath(result.paths[0]);
      await reindexFiles(workspacePath, folder, result.paths.map(filenameFromRecordPath));
    }
    return result;
  }),
);

ipcMain.on('scratch:log-api-call', (_event, workspacePath: string, entry: ApiLogEntry) => {
  if (typeof workspacePath !== 'string' || !workspacePath) return;
  logApiCall(workspacePath, entry);
});

ipcMain.on('scratch:log-session', (_event, workspacePath: string, event: SessionEvent) => {
  if (typeof workspacePath !== 'string' || !workspacePath) return;
  if (event !== 'start' && event !== 'end') return;
  logSession(workspacePath, event);
});

ipcMain.on('scratch:log-publish-job', (_event, workspacePath: string, entry: PublishJobEntry) => {
  if (typeof workspacePath !== 'string' || !workspacePath) return;
  logPublishJob(workspacePath, entry);
});

void app.whenReady().then(() => {
  if (!gotTheLock) {
    return;
  }

  logPerf('main appReady (from app start)', performance.now() - appStartTime);
  electronApp.setAppUserModelId('md.scratch.desktop');

  app.on('browser-window-created', (_, window) => {
    // Default toolkit behavior blocks Cmd/Ctrl+Minus and Cmd/Ctrl+Shift+Equal; allow OS zoom shortcuts.
    optimizer.watchWindowShortcuts(window, { zoom: true });
  });

  createWindow();

  // Sync any test-seeded credentials (SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON) to the scratchmd
  // CLI so CLI-backed operations are authenticated without going through the renderer's
  // save-credentials path (which never runs when login is bypassed). Best-effort.
  if (seededTestCredentials) {
    void syncCredentialsToScratchmdCli(seededTestCredentials);
  }

  cliInstalled = isCliSymlinkInstalled();
  Menu.setApplicationMenu(buildApplicationMenu());

  updaterController = initAutoUpdater({ getMainWindow: () => mainWindow });

  // DEV-10470: re-download each enabled workspace's latest server data on app
  // open and hourly, so files are fresh when the user sits down — the automated
  // analogue of clicking "Re-download files" every morning.
  autoDownloadController = initAutoDownloadScheduler({
    getMainWindow: () => mainWindow,
    listWorkspaces: async () => pruneStaleWorkspaceRegistryEntries(await readWorkspaceRegistry()),
    isEnabledForWorkbook: isAutoDownloadEnabled,
    hasValidCredentials: () => Boolean(getCredentials().apiToken) && !isTokenExpired(),
    performDownload: (workspacePath) => performWorkspaceDownload(workspacePath, { onDelete: 'keep' }),
  });

  const deepLinkArg = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`));
  if (deepLinkArg) {
    handleDeepLink(deepLinkArg);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Lets the renderer capture and flush an `app_exited` PostHog event before the
// process exits. We `preventDefault()` the first quit, ask the renderer to
// flush, and re-quit when it confirms (or after a short timeout, so a stuck
// renderer never blocks the user from quitting).
let quitConfirmedByRenderer = false;
const QUIT_FLUSH_TIMEOUT_MS = 2000;

app.on('before-quit', (event) => {
  if (quitConfirmedByRenderer) {
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  event.preventDefault();

  const payload: AppWillQuitPayload = {
    sessionDurationMs: Math.round(performance.now() - appStartTime),
  };

  let resolved = false;
  const finish = (): void => {
    if (resolved) return;
    resolved = true;
    ipcMain.removeListener(APP_QUIT_CONFIRMED_CHANNEL, finish);
    quitConfirmedByRenderer = true;
    app.quit();
  };

  ipcMain.once(APP_QUIT_CONFIRMED_CHANNEL, finish);
  setTimeout(finish, QUIT_FLUSH_TIMEOUT_MS);
  mainWindow.webContents.send(APP_WILL_QUIT_CHANNEL, payload);
});

app.on('window-all-closed', () => {
  autoDownloadController?.dispose();
  autoDownloadController = null;
  app.quit();
});
