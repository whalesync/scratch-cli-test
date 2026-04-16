import { ElectronAPI } from '@electron-toolkit/preload';
import type { ColumnDefinition, NormalizedRecordRow } from '../shared/schema-columns';

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

type DiffGridFilter =
  | { scope: 'global'; kind: 'unreviewed' | 'unpublished' }
  | { scope: 'column'; kind: 'unreviewed' | 'unpublished'; columnId: string; columnTitle: string }
  | { scope: 'text'; columnId: string; columnTitle: string; value: string };

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
  initWorkspace: (
    workbookId: string,
    cwd: string,
    opts?: { force?: boolean },
  ) => Promise<{ stdout: string; stderr: string }>;
  removeWorkspace: (workbookId: string) => Promise<void>;
  acceptAllChanges: (workspacePath: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  acceptRecord: (
    workspacePath: string,
    recordPath: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  rejectRecord: (
    workspacePath: string,
    recordPath: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
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
  deleteLocalPublishPlans: (workspacePath: string) => Promise<void>;
  pushWorkspaceChanges: (workspacePath: string) => Promise<{ stdout: string; stderr: string }>;
  pullWorkspaceChanges: (
    workspacePath: string,
    opts?: { onDelete?: string },
  ) => Promise<{ stdout: string; stderr: string }>;
  listLocalSyncs: (workspacePath: string) => Promise<string[]>;
  validateLocalSync: (
    workspacePath: string,
    syncName: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  startRunLocalSync: (workspacePath: string, syncName: string) => Promise<{ sessionId: string }>;
  startPlanPublish: (workspacePath: string, filterPath?: string) => Promise<{ sessionId: string }>;
  startPublishFromGit: (workspacePath: string) => Promise<{ sessionId: string }>;
  triggerPublishFromGit: (workspacePath: string) => Promise<{ stdout: string; stderr: string; jobIds: string[] }>;
  startPublishAll: (workspacePath: string) => Promise<{ sessionId: string }>;
  pullAllLinkedTables: (workspacePath: string) => Promise<{ jobIds: string[] }>;
  showInFolder: (folderPath: string) => Promise<void>;
  showItemInFolder: (filePath: string) => Promise<void>;
  showNativeContextMenu: (
    items: Array<{
      id: string;
      label: string;
      type?: 'separator';
      submenu?: Array<{ id: string; label: string }>;
    }>,
    onClick: (id: string) => void,
  ) => void;
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
    schema: Record<string, unknown>;
    columnDefinitions: ColumnDefinition[];
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
  readFileTextRaw: (filePath: string) => Promise<{ text: string } | { error: string }>;
  writeFileTextRaw: (filePath: string, contents: string) => Promise<{ ok: true } | { error: string }>;
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
    rows: NormalizedRecordRow[];
    columns: ColumnDefinition[];
    total: number;
    offset: number;
    invalidJsonFiles: Array<{ filename: string; error: string }>;
  }>;
  readFolderStatuses: (
    folderPath: string,
    workspacePath: string,
  ) => Promise<{ unreviewedFilenames: string[]; unpublishedFilenames: string[] }>;
  readDiffGridData: (
    folderPath: string,
    workspacePath: string,
    opts?: {
      offset?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      filters?: DiffGridFilter[];
    },
  ) => Promise<{
    rows: Array<
      Record<string, unknown> & {
        __rowStatus: 'added' | 'modified' | 'unpublished' | 'deleted' | 'unchanged' | 'invalidJson';
        __changedFields: string[];
        __fromFields: Record<string, unknown>;
        __unpublishedFields: string[];
        __masterFields: Record<string, unknown>;
        __filename: string;
        __parseError?: string;
      }
    >;
    columns: ColumnDefinition[];
    total: number;
    summary: {
      total: number;
      added: number;
      modified: number;
      unpublished: number;
      deleted: number;
      invalidJson: number;
    };
    filterCounts: { unreviewed: number; unpublished: number };
    invalidJsonFiles: Array<{
      filename: string;
      error: string;
      workingFilePath: string;
      reviewedFilePath: string;
      publishedFilePath: string;
    }>;
  }>;
  readDiffRecordData: (
    folderPath: string,
    workspacePath: string,
    filename: string,
  ) => Promise<{
    row: Record<string, unknown> & {
      __rowStatus: 'added' | 'modified' | 'unpublished' | 'deleted' | 'unchanged' | 'invalidJson';
      __changedFields: string[];
      __fromFields: Record<string, unknown>;
      __unpublishedFields: string[];
      __masterFields: Record<string, unknown>;
      __filename: string;
      __parseError?: string;
    };
    columns: ColumnDefinition[];
    workingData: Record<string, unknown> | null;
    dirtyData: Record<string, unknown> | null;
    masterData: Record<string, unknown> | null;
    displayData: Record<string, unknown> | null;
  } | null>;
  acceptCellInputText: (
    folderPath: string,
    workspacePath: string,
    filename: string,
    fieldName: string,
    value: string,
  ) => Promise<{ value: unknown }>;
  acceptCellChange: (
    folderPath: string,
    workspacePath: string,
    filename: string,
    fieldName: string,
    value: string,
  ) => Promise<{ value: unknown }>;
  undoApprovedCellChange: (
    folderPath: string,
    workspacePath: string,
    filename: string,
    fieldName: string,
  ) => Promise<void>;
  restoreDeletedRecord: (folderPath: string, workspacePath: string, filename: string) => Promise<void>;
  discardCreatedRecord: (folderPath: string, workspacePath: string, filename: string) => Promise<void>;
  acceptFieldChanges: (
    folderPath: string,
    workspacePath: string,
    fieldName: string,
  ) => Promise<{
    status: 'accepted' | 'rejected' | 'no_changes';
    field: string;
    folder: string;
    filesAccepted?: number;
    filesRejected?: number;
    paths: string[];
    elapsedMs: number;
  }>;
  rejectFieldChanges: (
    folderPath: string,
    workspacePath: string,
    fieldName: string,
  ) => Promise<{
    status: 'accepted' | 'rejected' | 'no_changes';
    field: string;
    folder: string;
    filesAccepted?: number;
    filesRejected?: number;
    paths: string[];
    elapsedMs: number;
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
