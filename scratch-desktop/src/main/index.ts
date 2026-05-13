// Side-effect import: must run before any module that reads userData (e.g. auth-store).
import './setup-userdata';

import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { spawn } from 'child_process';
import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions, shell } from 'electron';
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import { performance } from 'perf_hooks';
import { APP_QUIT_CONFIRMED_CHANNEL, APP_WILL_QUIT_CHANNEL, type AppWillQuitPayload } from '../shared/lifecycle-events';
import { UPDATER_EVENT_CHANNEL, UpdaterEvent } from '../shared/updater-events';
import { clearCredentials, getCredentials, isTokenExpired, saveCredentials } from './auth-store';
import {
  acceptCellChange,
  acceptCellInputText,
  getFolderMetadata,
  listFiles,
  listFolders,
  readBatch,
  readConnectionViewByName,
  readDiffGridDataPage,
  readDiffGridDataPageV2,
  readDiffRecordData,
  readFileContent,
  readFileTextRaw,
  readFolderStatuses,
  readGridData,
  readSchema,
  readWorkspaceConfig,
  undoApprovedCellChange,
  writeFileTextRaw,
  type DiffGridFilter,
  type FilterStatus,
} from './local-files';
import {
  acceptFieldChanges,
  clearFolderIndex,
  deleteLocalPublishPlans,
  discardCreatedRecord as discardCreatedRecordViaCli,
  getFolderValidationResults,
  getFolderValidationSample,
  getValidationResults,
  getValidationStats,
  listLocalPublishPlans,
  listUnpushedChanges,
  listUnreviewedChanges,
  reindexFiles,
  reindexFolderIndex,
  rejectFieldChanges,
  restoreDeletedRecord as restoreDeletedRecordViaCli,
  runScratchmd,
  runScratchmdCapture,
  runScratchmdJson,
  startScratchmdLiveCommand,
  startScratchmdLiveSequence,
  triggerPublishFromGit,
} from './scratchmd';
import { initAutoUpdater } from './updater';
import { attachWindowStatePersistence, getRestoredWindowState } from './window-state';
import { WorkspaceFileWatchService } from './workspace-file-watch';

const appStartTime = performance.now();

const PROTOCOL = 'scratch';

let mainWindow: BrowserWindow | null = null;
let pendingDeepLink: { route: string; query: string } | null = null;
let updaterController: ReturnType<typeof initAutoUpdater> = null;
const workspaceFileWatchService = new WorkspaceFileWatchService();

function parseScratchDeepLink(url: string): { route: string; query: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'scratch:') {
      return null;
    }
    const route = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '');
    if (!route.startsWith('workbook/')) {
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
}

async function withFilePathInternalMutation<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const workspacePath = await findWorkspaceRootForPath(filePath);
  if (!workspacePath) {
    return action();
  }
  return withWorkspaceInternalMutation(workspacePath, action);
}

/** Reindex the folder-index for every leaf folder in the workspace. */
async function reindexAllFolderIndexes(workspacePath: string): Promise<void> {
  const folders = await listFolders(workspacePath);
  for (const folder of folders) {
    const relFolder = relative(workspacePath, folder.path);
    await reindexFolderIndex(workspacePath, relFolder);
  }
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

function startWorkspaceInternalLiveSequence(
  sender: Electron.WebContents,
  workspacePath: string,
  steps: Array<{ label: string; args: string[] }>,
): Promise<{ sessionId: string }> {
  const endInternalMutation = workspaceFileWatchService.beginInternalWorkspaceMutation(workspacePath);
  return startScratchmdLiveSequence(sender, steps, workspacePath, { onExit: endInternalMutation });
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

    // Sync credentials to the scratchmd CLI so it can authenticate without a separate login
    if (creds.apiToken && creds.email && creds.tokenExpiresAt) {
      try {
        const args = [
          'auth',
          'set-credentials',
          '--apiToken',
          creds.apiToken,
          '--email',
          creds.email,
          '--expiresAt',
          creds.tokenExpiresAt,
          '--scratch-url',
          creds.serverUrl,
        ];
        const result = await runScratchmdCapture(args);
        if (result.exitCode !== 0) {
          console.debug('[auth] scratchmd set-credentials failed:', result.stderr.trim() || result.stdout.trim());
        }
      } catch (error) {
        console.debug('[auth] scratchmd set-credentials error:', error);
      }
    }
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
ipcMain.handle('scratch:get-workspaces-registry', async () => {
  const start = performance.now();
  const rawEntries = await readWorkspaceRegistry();
  const entries = await pruneStaleWorkspaceRegistryEntries(rawEntries);
  const result = entries.map((entry) => ({ ...entry, fileCount: 0 }));
  logPerf('main ipc getWorkspacesRegistry', performance.now() - start);
  return result;
});
ipcMain.handle('scratch:pick-parent-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0] ?? null;
});
ipcMain.handle('scratch:create-workspace', async (_, name: string) =>
  runScratchmdJson<{ id: string; name: string }>(['--json', 'workspaces', 'create', name]),
);
ipcMain.handle('scratch:init-workspace', async (_, workbookId: string, cwd: string, opts?: { force?: boolean }) =>
  runScratchmd(['workspaces', 'init', workbookId, ...(opts?.force ? ['--force'] : [])], cwd),
);
ipcMain.handle('scratch:remove-workspace', async (_, workbookId: string) => {
  const result = await runScratchmd(['workspaces', 'unsync', workbookId, '--yes']);
  workspaceFileWatchService.clearWorkspaceFileWatch();
  return result;
});
ipcMain.handle('scratch:prepare-workspace-index', async () => {
  // No-op: the folder-index seeds itself lazily on first run_query call.
});
ipcMain.handle('scratch:reindex-workspace', async (_, workbookId: string) => {
  const entries = await readWorkspaceRegistry();
  const entry = entries.find((e) => e.id === workbookId);
  if (!entry) return;
  await reindexAllFolderIndexes(entry.path);
});
ipcMain.handle(
  'scratch:clear-folder-index',
  async (_, workspacePath: string, folderPath: string): Promise<{ rows_cleared: number }> => {
    return clearFolderIndex(workspacePath, folderPath);
  },
);
ipcMain.handle('scratch:refresh-paths', () => {
  // No-op: working-tree changes are detected automatically by `index find-stale-files`
  // on the next paginate-records call. Dirty/master mutations trigger explicit
  // `index refresh-files-full` / `index rebuild-folder` calls at the IPC handler
  // that performed the mutation.
  return { success: true };
});
ipcMain.handle('scratch:accept-all-changes', async (_, workspacePath: string, folderPath?: string) => {
  // `files accept-all` reindexes the affected folders itself; no follow-up call needed.
  const args = ['files', 'accept-all'];
  if (folderPath) args.push('--folder', folderPath);
  return withWorkspaceInternalMutation(workspacePath, () => runScratchmdCapture(args, workspacePath));
});
ipcMain.handle('scratch:discard-all-changes', async (_, workspacePath: string, folderPath?: string) => {
  // `files discard-all` reindexes the affected folders itself; no follow-up call needed.
  const args = ['files', 'discard-all'];
  if (folderPath) args.push('--folder', folderPath);
  return withWorkspaceInternalMutation(workspacePath, () => runScratchmdCapture(args, workspacePath));
});
ipcMain.handle('scratch:reject-all-changes', async (_, workspacePath: string, folderPath?: string) => {
  // `files reject-all` reindexes the affected folders itself; no follow-up call needed.
  const args = ['files', 'reject-all'];
  if (folderPath) args.push('--folder', folderPath);
  return withWorkspaceInternalMutation(workspacePath, () => runScratchmdCapture(args, workspacePath));
});
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
ipcMain.handle('scratch:list-local-publish-plans', async (_, workspacePath: string) =>
  listLocalPublishPlans(workspacePath),
);
ipcMain.handle('scratch:delete-local-publish-plans', async (_, workspacePath: string) =>
  deleteLocalPublishPlans(workspacePath),
);
ipcMain.handle('scratch:push-workspace-changes', async (_, workspacePath: string) =>
  // `files upload` reindexes the affected folders itself (per-path,
  // scoped to the actually-changed records). No follow-up CLI call.
  withWorkspaceInternalMutation(workspacePath, () => runScratchmd(['files', 'upload'], workspacePath)),
);
ipcMain.handle('scratch:pull-workspace-changes', async (_, workspacePath: string, opts?: { onDelete?: string }) => {
  const args = ['files', 'download'];
  if (opts?.onDelete) {
    args.push('--on-delete', opts.onDelete);
  }
  // `files download` reindexes the affected folders itself (per-path,
  // scoped to the actually-changed records, plus a master diff for
  // connections whose published state advanced). No follow-up CLI call.
  return withWorkspaceInternalMutation(workspacePath, () => runScratchmd(args, workspacePath));
});
ipcMain.handle('scratch:list-local-syncs', async (_, workspacePath: string) => listLocalSyncFiles(workspacePath));
ipcMain.handle('scratch:validate-local-sync', async (_, workspacePath: string, syncName: string) =>
  runScratchmdCapture(['syncs', 'validate-local', '--sync', syncName], workspacePath),
);
ipcMain.handle('scratch:start-run-local-sync', async (event, workspacePath: string, syncName: string) =>
  startWorkspaceInternalLiveCommand(event.sender, workspacePath, ['syncs', 'run-local', '--sync', syncName]),
);
ipcMain.handle('scratch:start-plan-publish', async (event, workspacePath: string, filterPath?: string) => {
  const args = filterPath ? ['plan-publish', '--filter', filterPath] : ['plan-publish'];
  return startWorkspaceInternalLiveCommand(event.sender, workspacePath, args);
});
ipcMain.handle('scratch:start-publish-from-git', async (event, workspacePath: string) =>
  startWorkspaceInternalLiveCommand(event.sender, workspacePath, ['publish-from-git']),
);
ipcMain.handle('scratch:trigger-publish-from-git', async (_, workspacePath: string) =>
  triggerPublishFromGit(workspacePath),
);
ipcMain.handle('scratch:pull-all-linked-tables', async (_, workspacePath: string) =>
  withWorkspaceInternalMutation(workspacePath, () =>
    runScratchmdJson<{ jobIds: string[] }>(['--json', 'linked', 'pull-all'], workspacePath),
  ),
);
ipcMain.handle('scratch:start-publish-all', async (event, workspacePath: string) =>
  startWorkspaceInternalLiveSequence(event.sender, workspacePath, [
    { label: 'plan-publish', args: ['plan-publish'] },
    { label: 'files upload', args: ['files', 'upload'] },
    { label: 'publish-from-git', args: ['publish-from-git'] },
  ]),
);
ipcMain.handle('scratch:watch-workspace-files', async (event, workspacePath: string) => {
  const folders = await listFolders(workspacePath);
  const folderPaths = folders.map((f) => f.path);
  return workspaceFileWatchService.watchWorkspaceFiles(event.sender, workspacePath, folderPaths);
});
ipcMain.handle('scratch:clear-workspace-file-watch', () => {
  workspaceFileWatchService.clearWorkspaceFileWatch();
});
ipcMain.handle('scratch:show-in-folder', (_, folderPath: string) => {
  void shell.openPath(folderPath);
});
ipcMain.handle('scratch:show-item-in-folder', (_, filePath: string) => {
  shell.showItemInFolder(filePath);
});
ipcMain.handle('scratch:open-in-terminal', (_, folderPath: string) => {
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
            type: sub.checked !== undefined ? 'checkbox' : undefined,
            checked: sub.checked,
            click: () => event.sender.send('scratch:native-context-menu-click', sub.id),
          })),
        };
      }
      return {
        label: item.label,
        enabled: item.enabled,
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

function buildApplicationMenu(): Menu {
  const isMac = process.platform === 'darwin';
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => {
      if (!updaterController) {
        sendUpdaterEvent({
          type: 'error',
          manual: true,
          message: 'Auto-update is unavailable in this build.',
        });
        return;
      }
      void updaterController.checkForUpdates();
    },
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
ipcMain.handle('files:read-batch', async (_, filePaths: string[], opts?: { maxSize?: number }) =>
  readBatch(filePaths, opts),
);
ipcMain.handle('files:read-schema', async (_, workspacePath: string, folderName: string) =>
  readSchema(workspacePath, folderName),
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
    const fn = process.env.SCRATCH_USE_SQLITE_GRID === '0' ? readDiffGridDataPage : readDiffGridDataPageV2;
    const onProgress = (line: string): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('scratch:grid-progress', line);
      }
    };
    return fn(folderPath, workspacePath, opts ?? {}, onProgress);
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
ipcMain.handle('files:get-folder-validation-sample', async (_, workspacePath: string, folder: string) =>
  getFolderValidationSample(workspacePath, folder),
);
ipcMain.handle(
  'files:accept-cell-input-text',
  async (_, folderPath: string, workspacePath: string, filename: string, fieldName: string, value: string) =>
    withWorkspaceInternalMutation(workspacePath, async () => {
      const result = await acceptCellInputText(folderPath, workspacePath, filename, fieldName, value);
      await reindexFiles(workspacePath, relative(workspacePath, folderPath), [filename], { validate: true });
      return result;
    }),
);
ipcMain.handle(
  'files:accept-cell-change',
  async (_, folderPath: string, workspacePath: string, filename: string, fieldName: string, value: string) =>
    withWorkspaceInternalMutation(workspacePath, async () => {
      const result = await acceptCellChange(folderPath, workspacePath, filename, fieldName, value);
      await reindexFiles(workspacePath, relative(workspacePath, folderPath), [filename], { validate: true });
      return result;
    }),
);
ipcMain.handle(
  'files:undo-approved-cell-change',
  async (_, folderPath: string, workspacePath: string, filename: string, fieldName: string) =>
    withWorkspaceInternalMutation(workspacePath, async () => {
      const result = await undoApprovedCellChange(folderPath, workspacePath, filename, fieldName);
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

  Menu.setApplicationMenu(buildApplicationMenu());

  updaterController = initAutoUpdater({ getMainWindow: () => mainWindow });

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
  app.quit();
});
