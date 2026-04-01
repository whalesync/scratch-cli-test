import { ElectronAPI } from '@electron-toolkit/preload';

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
  listLocalSyncs: (workspacePath: string) => Promise<string[]>;
  validateLocalSync: (
    workspacePath: string,
    syncName: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  startRunLocalSync: (workspacePath: string, syncName: string) => Promise<{ sessionId: string }>;
  startPlanPublish: (workspacePath: string) => Promise<{ sessionId: string }>;
  toggleDevTools: () => Promise<void>;
  onCommandEvent: (callback: (event: ScratchCommandEvent) => void) => () => void;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    scratchAuth: ScratchAuthAPI;
    scratchDesktop: ScratchDesktopAPI;
  }
}
