import { electronAPI } from '@electron-toolkit/preload';
import { contextBridge, ipcRenderer } from 'electron';

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
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('scratchAuth', scratchAuth);
    contextBridge.exposeInMainWorld('scratchDesktop', scratchDesktop);
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
}
