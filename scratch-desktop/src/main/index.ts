import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { spawn } from 'child_process';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { clearCredentials, getCredentials, isTokenExpired, saveCredentials } from './auth-store';

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

function runScratchmd(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
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
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const message = stderr.trim() || stdout.trim() || `scratchmd exited with code ${code ?? 'unknown'}`;
        reject(new Error(message));
      });
    };

    attempt();
  });
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
