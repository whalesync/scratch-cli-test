import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { clearCredentials, getCredentials, isTokenExpired, saveCredentials } from './auth-store';

interface LocalWorkspaceEntry {
  id: string;
  path: string;
}

interface ScratchmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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

  mainWindow.on('ready-to-show', () => {
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
ipcMain.handle('auth:get-credentials', () => getCredentials());
ipcMain.handle(
  'auth:save-credentials',
  (_, creds: { apiToken: string; email?: string; tokenExpiresAt?: string; serverUrl: string }) =>
    saveCredentials(creds),
);
ipcMain.handle('auth:clear-credentials', () => clearCredentials());
ipcMain.handle('auth:is-token-expired', () => isTokenExpired());
ipcMain.handle('auth:open-external', (_, url: string) => shell.openExternal(url));
ipcMain.handle('scratch:get-workspaces-registry', async () => readWorkspaceRegistry());
ipcMain.handle('scratch:pick-parent-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0] ?? null;
});
ipcMain.handle('scratch:init-workspace', async (_, workbookId: string, cwd: string) =>
  runScratchmd(['workspaces', 'init', workbookId], cwd),
);
ipcMain.handle('scratch:remove-workspace', async (_, workbookId: string) =>
  runScratchmd(['workspaces', 'unsync', workbookId, '--yes']),
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

void app.whenReady().then(() => {
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
