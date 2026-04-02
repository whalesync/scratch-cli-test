import { electronAPI } from '@electron-toolkit/preload';
import { contextBridge, ipcRenderer } from 'electron';

type ScratchCommandEvent =
  | {
      sessionId: string;
      type: 'chunk';
      stream: 'stdout' | 'stderr';
      chunk: string;
    }
  | {
      sessionId: string;
      type: 'exit';
      exitCode: number;
      error?: string;
    };

const scratchAuth = {
  getCredentials: (): Promise<{
    apiToken: string | null;
    email: string | null;
    tokenExpiresAt: string | null;
    serverUrl: string | null;
  }> => ipcRenderer.invoke('auth:get-credentials'),
  saveCredentials: (creds: {
    apiToken: string;
    email?: string;
    tokenExpiresAt?: string;
    serverUrl: string;
  }): Promise<void> => ipcRenderer.invoke('auth:save-credentials', creds),
  clearCredentials: (): Promise<void> => ipcRenderer.invoke('auth:clear-credentials'),
  isTokenExpired: (): Promise<boolean> => ipcRenderer.invoke('auth:is-token-expired'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('auth:open-external', url),
};

const scratchDesktop = {
  getWorkspacesRegistry: (): Promise<Array<{ id: string; path: string }>> =>
    ipcRenderer.invoke('scratch:get-workspaces-registry'),
  pickParentFolder: (): Promise<string | null> => ipcRenderer.invoke('scratch:pick-parent-folder'),
  initWorkspace: (workbookId: string, cwd: string): Promise<{ stdout: string; stderr: string }> =>
    ipcRenderer.invoke('scratch:init-workspace', workbookId, cwd),
  removeWorkspace: (workbookId: string): Promise<void> => ipcRenderer.invoke('scratch:remove-workspace', workbookId),
  pushWorkspaceChanges: (workspacePath: string): Promise<{ stdout: string; stderr: string }> =>
    ipcRenderer.invoke('scratch:push-workspace-changes', workspacePath),
  listLocalSyncs: (workspacePath: string): Promise<string[]> =>
    ipcRenderer.invoke('scratch:list-local-syncs', workspacePath),
  validateLocalSync: (
    workspacePath: string,
    syncName: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    ipcRenderer.invoke('scratch:validate-local-sync', workspacePath, syncName),
  startRunLocalSync: (workspacePath: string, syncName: string): Promise<{ sessionId: string }> =>
    ipcRenderer.invoke('scratch:start-run-local-sync', workspacePath, syncName),
  startPlanPublish: (workspacePath: string): Promise<{ sessionId: string }> =>
    ipcRenderer.invoke('scratch:start-plan-publish', workspacePath),
  startPublishFromGit: (workspacePath: string): Promise<{ sessionId: string }> =>
    ipcRenderer.invoke('scratch:start-publish-from-git', workspacePath),
  toggleDevTools: (): Promise<void> => ipcRenderer.invoke('scratch:toggle-devtools'),
  onCommandEvent: (callback: (event: ScratchCommandEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ScratchCommandEvent): void => {
      callback(payload);
    };
    ipcRenderer.on('scratch:command-event', listener);
    return () => {
      ipcRenderer.removeListener('scratch:command-event', listener);
    };
  },
};

const scratchFiles = {
  workspaceConfig: (
    workspacePath: string,
  ): Promise<{
    apiUrl: string;
    workbookId: string;
    orgId: string;
    authToken?: string;
  }> => ipcRenderer.invoke('files:workspace-config', workspacePath),
  listFolders: (
    workspacePath: string,
  ): Promise<
    Array<{
      name: string;
      path: string;
      fileCount: number;
      lastModified: number;
      totalSize: number;
    }>
  > => ipcRenderer.invoke('files:list-folders', workspacePath),
  getFolderMetadata: (
    folderPath: string,
    workspacePath: string,
  ): Promise<{
    name: string;
    path: string;
    fileCount: number;
    lastModified: number;
    totalSize: number;
    schema: Record<string, unknown> | null;
  }> => ipcRenderer.invoke('files:folder-metadata', folderPath, workspacePath),
  listFiles: (
    folderPath: string,
    opts: {
      offset: number;
      limit: number;
      sortBy?: 'name' | 'modified' | 'size';
      sortOrder?: 'asc' | 'desc';
      filter?: { search?: string; extensions?: string[] };
    },
  ): Promise<{
    files: Array<{
      name: string;
      path: string;
      size: number;
      lastModified: number;
      extension: string;
      isJson: boolean;
    }>;
    total: number;
    offset: number;
  }> => ipcRenderer.invoke('files:list-files', folderPath, opts),
  readFile: (
    filePath: string,
  ): Promise<
    | { type: 'json'; path: string; data: Record<string, unknown>; size: number }
    | { type: 'binary'; path: string; mimeType: string; size: number; base64?: string }
    | { type: 'error'; path: string; error: string }
  > => ipcRenderer.invoke('files:read-file', filePath),
  readBatch: (
    filePaths: string[],
    opts?: { maxSize?: number },
  ): Promise<
    Array<
      | { type: 'json'; path: string; data: Record<string, unknown>; size: number }
      | { type: 'binary'; path: string; mimeType: string; size: number; base64?: string }
      | { type: 'error'; path: string; error: string }
    >
  > => ipcRenderer.invoke('files:read-batch', filePaths, opts),
  readSchema: (workspacePath: string, folderName: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('files:read-schema', workspacePath, folderName),
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('scratchAuth', scratchAuth);
    contextBridge.exposeInMainWorld('scratchDesktop', scratchDesktop);
    contextBridge.exposeInMainWorld('scratchFiles', scratchFiles);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error -- fallback for non-isolated contexts
  window.electron = electronAPI;
  // @ts-expect-error -- fallback for non-isolated contexts
  window.scratchAuth = scratchAuth;
  // @ts-expect-error -- fallback for non-isolated contexts
  window.scratchDesktop = scratchDesktop;
  // @ts-expect-error -- fallback for non-isolated contexts
  window.scratchFiles = scratchFiles;
}
