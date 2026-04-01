import { ElectronAPI } from '@electron-toolkit/preload';

interface ScratchAuthAPI {
  getCredentials: () => Promise<{
    apiToken: string | null;
    email: string | null;
    tokenExpiresAt: string | null;
    serverUrl: string | null;
  }>;
  saveCredentials: (creds: {
    apiToken: string;
    email?: string;
    tokenExpiresAt?: string;
    serverUrl: string;
  }) => Promise<void>;
  clearCredentials: () => Promise<void>;
  isTokenExpired: () => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
}

interface ScratchDesktopAPI {
  getWorkspacesRegistry: () => Promise<Array<{ id: string; path: string }>>;
  pickParentFolder: () => Promise<string | null>;
  initWorkspace: (workbookId: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
  removeWorkspace: (workbookId: string) => Promise<void>;
  pushWorkspaceChanges: (workspacePath: string) => Promise<{ stdout: string; stderr: string }>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    scratchAuth: ScratchAuthAPI;
    scratchDesktop: ScratchDesktopAPI;
  }
}
