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

interface ScratchDeepLinkAPI {
  onDeepLink: (callback: (route: string, query: string) => void) => () => void;
}

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
  getWorkspacesRegistry: () => Promise<Array<{ id: string; path: string; fileCount: number }>>;
  createWorkspace: (name: string) => Promise<{ id: string; name: string }>;
  pickParentFolder: () => Promise<string | null>;
  initWorkspace: (workbookId: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
  removeWorkspace: (workbookId: string) => Promise<void>;
  acceptAllChanges: (workspacePath: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  listUnreviewedChanges: (
    workspacePath: string,
  ) => Promise<Array<{ connectionName: string; path: string; status: string }>>;
  listUnpushedChanges: (
    workspacePath: string,
  ) => Promise<Array<{ connectionName: string; path: string; status: string }>>;
  listLocalPublishPlans: (workspacePath: string) => Promise<
    Array<{
      planId: string;
      createdAt: string;
      connectionName: string;
      connectionId: string;
      summary: { edit: number; create: number; delete: number; backfill: number; rename: number };
      tablePaths: string[];
    }>
  >;
  pushWorkspaceChanges: (workspacePath: string) => Promise<{ stdout: string; stderr: string }>;
  pullWorkspaceChanges: (workspacePath: string) => Promise<{ stdout: string; stderr: string }>;
  listLocalSyncs: (workspacePath: string) => Promise<string[]>;
  validateLocalSync: (
    workspacePath: string,
    syncName: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  startRunLocalSync: (workspacePath: string, syncName: string) => Promise<{ sessionId: string }>;
  startPlanPublish: (workspacePath: string) => Promise<{ sessionId: string }>;
  startPublishFromGit: (workspacePath: string) => Promise<{ sessionId: string }>;
  triggerPublishFromGit: (workspacePath: string) => Promise<{ stdout: string; stderr: string; jobIds: string[] }>;
  startPublishAll: (workspacePath: string) => Promise<{ sessionId: string }>;
  pullAllLinkedTables: (workspacePath: string) => Promise<{ jobIds: string[] }>;
  showInFolder: (folderPath: string) => Promise<void>;
  openInTerminal: (folderPath: string) => Promise<void>;
  toggleDevTools: () => Promise<void>;
  getAppVersion: () => Promise<string>;
  onCommandEvent: (callback: (event: ScratchCommandEvent) => void) => () => void;
}

interface ScratchFilesAPI {
  workspaceConfig: (workspacePath: string) => Promise<{
    apiUrl: string;
    workbookId: string;
    orgId: string;
    authToken?: string;
  }>;
  listFolders: (workspacePath: string) => Promise<
    Array<{
      name: string;
      path: string;
      fileCount: number;
      lastModified: number;
      totalSize: number;
    }>
  >;
  getFolderMetadata: (
    folderPath: string,
    workspacePath: string,
  ) => Promise<{
    name: string;
    path: string;
    fileCount: number;
    lastModified: number;
    totalSize: number;
    schema: Record<string, unknown> | null;
  }>;
  listFiles: (
    folderPath: string,
    opts: {
      offset: number;
      limit: number;
      sortBy?: 'name' | 'modified' | 'size';
      sortOrder?: 'asc' | 'desc';
      filter?: { search?: string; extensions?: string[] };
    },
  ) => Promise<{
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
  }>;
  readFile: (
    filePath: string,
  ) => Promise<
    | { type: 'json'; path: string; data: Record<string, unknown>; size: number }
    | { type: 'binary'; path: string; mimeType: string; size: number; base64?: string }
    | { type: 'error'; path: string; error: string }
  >;
  readBatch: (
    filePaths: string[],
    opts?: { maxSize?: number },
  ) => Promise<
    Array<
      | { type: 'json'; path: string; data: Record<string, unknown>; size: number }
      | { type: 'binary'; path: string; mimeType: string; size: number; base64?: string }
      | { type: 'error'; path: string; error: string }
    >
  >;
  readSchema: (workspacePath: string, folderName: string) => Promise<Record<string, unknown> | null>;
  readGridData: (
    folderPath: string,
    opts?: {
      offset?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      filter?: Record<string, unknown>;
      columns?: string[];
      filterStatus?: 'unreviewed' | 'unpublished' | 'published';
      workspacePath?: string;
    },
  ) => Promise<{
    rows: Array<Record<string, unknown>>;
    columns: string[];
    total: number;
    offset: number;
  }>;
  readFolderStatuses: (
    folderPath: string,
    workspacePath: string,
  ) => Promise<{ unreviewedFilenames: string[]; unpublishedFilenames: string[] }>;
  readDiffGridData: (
    folderPath: string,
    workspacePath: string,
  ) => Promise<{
    rows: Array<
      Record<string, unknown> & {
        __rowStatus: 'added' | 'modified' | 'deleted' | 'unchanged';
        __changedFields: string[];
        __fromFields: Record<string, unknown>;
        __filename: string;
      }
    >;
    columns: string[];
    total: number;
    summary: { total: number; added: number; modified: number; deleted: number };
  }>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    scratchDeepLink?: ScratchDeepLinkAPI;
    scratchAuth: ScratchAuthAPI;
    scratchDesktop: ScratchDesktopAPI;
    scratchFiles: ScratchFilesAPI;
  }
}
