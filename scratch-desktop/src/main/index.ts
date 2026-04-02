import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { clearCredentials, getCredentials, isTokenExpired, saveCredentials } from './auth-store';
import {
  getFolderMetadata,
  listFiles,
  listFolders,
  readBatch,
  readFileContent,
  readGridData,
  readSchema,
  readWorkspaceConfig,
} from './local-files';

const appStartTime = performance.now();

function logPerf(message: string, elapsedMs: number): void {
  console.debug(`[perf] ${message}: ${elapsedMs.toFixed(1)}ms`);
}

interface LocalWorkspaceEntry {
  id: string;
  path: string;
}

interface ScratchmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface UnreviewedChangeEntry {
  connectionName: string;
  path: string;
  status: string;
}

interface LocalPublishPlan {
  planId: string;
  createdAt: string;
  connectionName: string;
  connectionId: string;
  summary: {
    edit: number;
    create: number;
    delete: number;
    backfill: number;
    rename: number;
  };
  tablePaths: string[];
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

function runScratchmdCapture(args: string[], cwd?: string): Promise<ScratchmdResult> {
  return new Promise((resolve, reject) => {
    const binaries = ['scratchmd', '/usr/local/bin/scratchmd'];
    let attemptIndex = 0;

    const attempt = (): void => {
      const command = binaries[attemptIndex];
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && attemptIndex < binaries.length - 1) {
          attemptIndex += 1;
          attempt();
          return;
        }
        reject(new Error(`Failed to start scratchmd: ${error.message}`));
      });

      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      });
    };

    attempt();
  });
}

async function runScratchmdJson<T>(args: string[], cwd?: string): Promise<T> {
  const result = await runScratchmdCapture(args, cwd);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `scratchmd exited with code ${result.exitCode}`;
    throw new Error(message);
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`Failed to parse scratchmd JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runScratchmd(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const result = await runScratchmdCapture(args, cwd);
  if (result.exitCode === 0) {
    return { stdout: result.stdout, stderr: result.stderr };
  }

  const message = result.stderr.trim() || result.stdout.trim() || `scratchmd exited with code ${result.exitCode}`;
  throw new Error(message);
}

function startScratchmdLiveCommand(
  sender: Electron.WebContents,
  args: string[],
  cwd?: string,
): Promise<{ sessionId: string }> {
  return new Promise((resolve, reject) => {
    const binaries = ['scratchmd', '/usr/local/bin/scratchmd'];
    const sessionId = randomUUID();
    let attemptIndex = 0;
    let started = false;
    let finished = false;

    const emit = (payload: Record<string, unknown>): void => {
      sender.send('scratch:command-event', { sessionId, ...payload });
    };

    const emitExit = (exitCode: number, error?: string): void => {
      if (finished) {
        return;
      }

      finished = true;
      emit({ type: 'exit', exitCode, error });
    };

    const attempt = (): void => {
      const command = binaries[attemptIndex];
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.on('spawn', () => {
        if (!started) {
          started = true;
          resolve({ sessionId });
        }
      });

      child.stdout.on('data', (chunk: Buffer | string) => {
        emit({ type: 'chunk', stream: 'stdout', chunk: chunk.toString() });
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        emit({ type: 'chunk', stream: 'stderr', chunk: chunk.toString() });
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && attemptIndex < binaries.length - 1) {
          attemptIndex += 1;
          attempt();
          return;
        }

        const message = `Failed to start scratchmd: ${error.message}`;
        if (!started) {
          reject(new Error(message));
          return;
        }

        emitExit(-1, message);
      });

      child.on('close', (code) => {
        emitExit(code ?? -1);
      });
    };

    attempt();
  });
}

function startScratchmdLiveSequence(
  sender: Electron.WebContents,
  steps: Array<{ label: string; args: string[] }>,
  cwd?: string,
): Promise<{ sessionId: string }> {
  return new Promise((resolve, reject) => {
    const binaries = ['scratchmd', '/usr/local/bin/scratchmd'];
    const sessionId = randomUUID();
    let started = false;
    let finished = false;
    let stepIndex = 0;

    const emit = (payload: Record<string, unknown>): void => {
      sender.send('scratch:command-event', { sessionId, ...payload });
    };

    const emitChunk = (chunk: string, stream: 'stdout' | 'stderr' = 'stdout'): void => {
      emit({ type: 'chunk', stream, chunk });
    };

    const emitExit = (exitCode: number, error?: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      emit({ type: 'exit', exitCode, error });
    };

    const runStep = (attemptIndex: number): void => {
      const step = steps[stepIndex];
      const binary = binaries[attemptIndex];
      const header = `\n$ scratchmd ${step.label}\n`;
      let abandoned = false;

      const child = spawn(binary, step.args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.on('spawn', () => {
        emitChunk(header);
        if (!started) {
          started = true;
          resolve({ sessionId });
        }
      });

      child.stdout.on('data', (chunk: Buffer | string) => {
        emitChunk(chunk.toString(), 'stdout');
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        emitChunk(chunk.toString(), 'stderr');
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && attemptIndex < binaries.length - 1) {
          abandoned = true;
          runStep(attemptIndex + 1);
          return;
        }

        const message = `Failed to start scratchmd: ${error.message}`;
        if (!started) {
          reject(new Error(message));
          return;
        }
        emitExit(-1, message);
      });

      child.on('close', (code) => {
        if (abandoned) {
          return;
        }
        if ((code ?? -1) !== 0) {
          emitExit(code ?? -1);
          return;
        }

        stepIndex += 1;
        if (stepIndex >= steps.length) {
          emitExit(0);
          return;
        }

        runStep(0);
      });
    };

    if (steps.length === 0) {
      resolve({ sessionId });
      emitExit(0);
      return;
    }

    runStep(0);
  });
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

async function listUnreviewedChanges(workspacePath: string): Promise<UnreviewedChangeEntry[]> {
  const result = await runScratchmdJson<{ count: number; entries: UnreviewedChangeEntry[] }>(
    ['--json', 'files', 'unreviewed'],
    workspacePath,
  );
  return result.entries ?? [];
}

async function listLocalPublishPlans(workspacePath: string): Promise<LocalPublishPlan[]> {
  const plansRoot = join(workspacePath, '.scratch', 'connections', 'scratch');

  try {
    const connectionEntries = await readdir(plansRoot, { withFileTypes: true });
    const plans = await Promise.all(
      connectionEntries
        .filter((entry) => entry.isDirectory())
        .map(async (connectionEntry) => {
          const manifestRoot = join(plansRoot, connectionEntry.name, '.publish-plans');

          try {
            const manifestEntries = await readdir(manifestRoot, { withFileTypes: true });
            const parsedPlans = await Promise.all(
              manifestEntries
                .filter((entry) => entry.isDirectory())
                .map(async (manifestEntry) => {
                  const manifestPath = join(manifestRoot, manifestEntry.name, 'plan.json');
                  const contents = await readFile(manifestPath, 'utf8');
                  return JSON.parse(contents) as LocalPublishPlan;
                }),
            );
            return parsedPlans;
          } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code === 'ENOENT') {
              return [];
            }
            throw error;
          }
        }),
    );

    return plans
      .flat()
      .sort(
        (left, right) =>
          left.connectionName.localeCompare(right.connectionName) || left.planId.localeCompare(right.planId),
      );
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function triggerPublishFromGit(
  workspacePath: string,
): Promise<{ stdout: string; stderr: string; jobIds: string[] }> {
  const result = await runScratchmdCapture(['publish-from-git'], workspacePath);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `scratchmd exited with code ${result.exitCode}`;
    throw new Error(message);
  }

  const jobIds = Array.from(result.stdout.matchAll(/jobId:\s*([^) \n]+)/g), (match) => match[1]).filter(
    (jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0,
  );
  const uniqueJobIds: string[] = Array.from(new Set(jobIds));
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    jobIds: uniqueJobIds,
  };
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
  const mainWindow = new BrowserWindow({
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
  (_, creds: { apiToken: string; email?: string; tokenExpiresAt?: string; serverUrl: string }) =>
    saveCredentials(creds),
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
  const result = await readWorkspaceRegistry();
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
ipcMain.handle('scratch:list-local-publish-plans', async (_, workspacePath: string) =>
  listLocalPublishPlans(workspacePath),
);
ipcMain.handle('scratch:push-workspace-changes', async (_, workspacePath: string) =>
  runScratchmd(['files', 'upload'], workspacePath),
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
ipcMain.handle('scratch:toggle-devtools', (event) => {
  event.sender.toggleDevTools();
});

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
    },
  ) => readGridData(folderPath, opts ?? {}),
);

void app.whenReady().then(() => {
  logPerf('main appReady (from app start)', performance.now() - appStartTime);
  electronApp.setAppUserModelId('md.scratch.desktop');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
