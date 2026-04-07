import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { spawn } from 'child_process';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { performance } from 'perf_hooks';
import { clearCredentials, getCredentials, isTokenExpired, saveCredentials } from './auth-store';
import {
  type FilterStatus,
  acceptCellChange,
  countWorkspaceFiles,
  getFolderMetadata,
  listFiles,
  listFolders,
  readBatch,
  readDiffGridData,
  readFileContent,
  readFolderStatuses,
  readGridData,
  readSchema,
  readWorkspaceConfig,
} from './local-files';
import {
  listLocalPublishPlans,
  listUnpushedChanges,
  listUnreviewedChanges,
  runScratchmd,
  runScratchmdCapture,
  runScratchmdJson,
  startScratchmdLiveCommand,
  startScratchmdLiveSequence,
  triggerPublishFromGit,
} from './scratchmd';

const appStartTime = performance.now();

const PROTOCOL = 'scratch';

let mainWindow: BrowserWindow | null = null;
let pendingDeepLink: { route: string; query: string } | null = null;

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

const gotTheLock = app.requestSingleInstanceLock();

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
        current.id = firstField.slice(3).trim();
      } else if (firstField.startsWith('path:')) {
        current.path = firstField.slice(5).trim();
      }
      continue;
    }

    if (!current) {
      continue;
    }

    if (trimmed.startsWith('id:')) {
      current.id = trimmed.slice(3).trim();
      continue;
    }

    if (trimmed.startsWith('path:')) {
      current.path = trimmed.slice(5).trim();
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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon: windowIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });
  logPerf('main createBrowserWindow', performance.now() - windowStart);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    flushPendingDeepLink();
  });

  mainWindow.on('ready-to-show', () => {
    logPerf('main windowReadyToShow (from app start)', performance.now() - appStartTime);
    mainWindow.show();
    const openDevTools = process.env['OPEN_DEVTOOLS'] === '1' || is.dev;
    if (openDevTools) {
      mainWindow.webContents.openDevTools({ mode: 'bottom' });
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
  const entries = await readWorkspaceRegistry();
  const result = await Promise.all(
    entries.map(async (entry) => {
      try {
        const fileCount = await countWorkspaceFiles(entry.path);
        return { ...entry, fileCount };
      } catch (error) {
        console.debug('[scratch] countWorkspaceFiles failed:', entry.path, error);
        return { ...entry, fileCount: 0 };
      }
    }),
  );
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
ipcMain.handle('scratch:init-workspace', async (_, workbookId: string, cwd: string) =>
  runScratchmd(['workspaces', 'init', workbookId], cwd),
);
ipcMain.handle('scratch:remove-workspace', async (_, workbookId: string) =>
  runScratchmd(['workspaces', 'unsync', workbookId, '--yes']),
);
ipcMain.handle('scratch:accept-all-changes', async (_, workspacePath: string) =>
  runScratchmdCapture(['files', 'accept-all'], workspacePath),
);
ipcMain.handle('scratch:list-unreviewed-changes', async (_, workspacePath: string) =>
  listUnreviewedChanges(workspacePath),
);
ipcMain.handle('scratch:list-unpushed-changes', async (_, workspacePath: string) => listUnpushedChanges(workspacePath));
ipcMain.handle('scratch:list-local-publish-plans', async (_, workspacePath: string) =>
  listLocalPublishPlans(workspacePath),
);
ipcMain.handle('scratch:push-workspace-changes', async (_, workspacePath: string) =>
  runScratchmd(['files', 'upload'], workspacePath),
);
ipcMain.handle('scratch:pull-workspace-changes', async (_, workspacePath: string) =>
  runScratchmd(['files', 'download'], workspacePath),
);
ipcMain.handle('scratch:list-local-syncs', async (_, workspacePath: string) => listLocalSyncFiles(workspacePath));
ipcMain.handle('scratch:validate-local-sync', async (_, workspacePath: string, syncName: string) =>
  runScratchmdCapture(['syncs', 'validate-local', '--sync', syncName], workspacePath),
);
ipcMain.handle('scratch:start-run-local-sync', async (event, workspacePath: string, syncName: string) =>
  startScratchmdLiveCommand(event.sender, ['syncs', 'run-local', '--sync', syncName], workspacePath),
);
ipcMain.handle('scratch:start-plan-publish', async (event, workspacePath: string) =>
  startScratchmdLiveCommand(event.sender, ['plan-publish'], workspacePath),
);
ipcMain.handle('scratch:start-publish-from-git', async (event, workspacePath: string) =>
  startScratchmdLiveCommand(event.sender, ['publish-from-git'], workspacePath),
);
ipcMain.handle('scratch:trigger-publish-from-git', async (_, workspacePath: string) =>
  triggerPublishFromGit(workspacePath),
);
ipcMain.handle('scratch:pull-all-linked-tables', async (_, workspacePath: string) =>
  runScratchmdJson<{ jobIds: string[] }>(['--json', 'linked', 'pull-all'], workspacePath),
);
ipcMain.handle('scratch:start-publish-all', async (event, workspacePath: string) =>
  startScratchmdLiveSequence(
    event.sender,
    [
      { label: 'plan-publish', args: ['plan-publish'] },
      { label: 'files upload', args: ['files', 'upload'] },
      { label: 'publish-from-git', args: ['publish-from-git'] },
    ],
    workspacePath,
  ),
);
ipcMain.handle('scratch:show-in-folder', (_, folderPath: string) => {
  void shell.openPath(folderPath);
});
ipcMain.handle('scratch:open-in-terminal', (_, folderPath: string) => {
  spawn('open', ['-a', 'Terminal', folderPath], { stdio: 'ignore', detached: true }).unref();
});
ipcMain.handle('scratch:toggle-devtools', (event) => {
  event.sender.toggleDevTools();
});

ipcMain.handle('scratch:get-app-version', () => app.getVersion());

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
ipcMain.handle('files:read-batch', async (_, filePaths: string[], opts?: { maxSize?: number }) =>
  readBatch(filePaths, opts),
);
ipcMain.handle('files:read-schema', async (_, workspacePath: string, folderName: string) =>
  readSchema(workspacePath, folderName),
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

ipcMain.handle('files:read-diff-grid-data', async (_, folderPath: string, workspacePath: string) =>
  readDiffGridData(folderPath, workspacePath),
);
ipcMain.handle(
  'files:accept-cell-change',
  async (_, folderPath: string, workspacePath: string, filename: string, fieldName: string, value: string) =>
    acceptCellChange(folderPath, workspacePath, filename, fieldName, value),
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

  const deepLinkArg = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`));
  if (deepLinkArg) {
    handleDeepLink(deepLinkArg);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
