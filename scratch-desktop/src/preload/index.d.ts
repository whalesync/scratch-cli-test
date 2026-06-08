import { ElectronAPI } from '@electron-toolkit/preload';
import type { TableView } from '@spinner/shared-types';
import type { ClaudeChatAvailability, ClaudeChatEvent, StartClaudeChatTurnResult } from '../shared/claude-chat';
import type { CliInstallEvent } from '../shared/cli-install-events';
import type { AppWillQuitPayload } from '../shared/lifecycle-events';
import type { ReviewStatsMayHaveChangedEvent } from '../shared/review-stats-events';
import type { ReviewStat } from '../shared/review-types';
import type { ColumnDefinition, NormalizedRecordRow } from '../shared/schema-columns';
import type { UpdaterEvent } from '../shared/updater-events';
import type {
  ValidationResultRow,
  ValidationStat,
  ValidatorConfig,
  ValidatorConfigEntry,
} from '../shared/validation-types';
import type { ConnectionFileChangedEvent, WorkspaceFilesChangedEvent } from '../shared/workspace-file-watch';
import type { WorkspaceNeedsReinitEvent } from '../shared/workspace-reinit-events';

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
  | { scope: 'global'; kind: 'unreviewed' | 'unpublished' | 'has-problems' }
  | { scope: 'column'; kind: 'unreviewed' | 'unpublished' | 'has-problems'; columnId: string; columnTitle: string }
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

interface WorkbookSettings {
  validateEnabled?: boolean;
}

interface ScratchPreferencesAPI {
  getCurrentWorkspaceId: () => Promise<string | null>;
  setCurrentWorkspaceId: (id: string | null) => Promise<void>;
  getWorkbookSettings: (workbookId: string) => Promise<WorkbookSettings>;
  setWorkbookSetting: (workbookId: string, key: string, value: unknown) => Promise<void>;
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
  prepareWorkspaceIndex: (workspacePath: string) => Promise<void>;
  clearFolderIndex: (workspacePath: string, folderPath: string) => Promise<{ rows_cleared: number }>;
  refreshPaths: (workspacePath: string, paths: string[], singleFile?: string) => Promise<void>;
  acceptAllChanges: (
    workspacePath: string,
    folderPath?: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  discardAllChanges: (
    workspacePath: string,
    folderPath?: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  rejectAllChanges: (
    workspacePath: string,
    folderPath?: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  acceptRecord: (
    workspacePath: string,
    recordPath: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  rejectRecord: (
    workspacePath: string,
    recordPath: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  discardRecord: (
    workspacePath: string,
    recordPath: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  listUnreviewedChanges: (
    workspacePath: string,
  ) => Promise<Array<{ connectionName: string; path: string; status: string }>>;
  listUnpushedChanges: (
    workspacePath: string,
  ) => Promise<Array<{ connectionName: string; path: string; status: string }>>;
  uploadWorkspaceChanges: (workspacePath: string) => Promise<
    | {
        status: 'uploaded' | 'no_changes' | 'up_to_date';
        filesCreated: number;
        filesUpdated: number;
        filesDeleted: number;
        createdPaths: string[];
        updatedPaths: string[];
        deletedPaths: string[];
        messages: string[];
        stalenessWarning: { newHead: string } | null;
        connections: Array<{
          connectionName: string;
          status: 'uploaded' | 'no_changes' | 'up_to_date';
          filesCreated: number;
          filesUpdated: number;
          filesDeleted: number;
          createdPaths: string[];
          updatedPaths: string[];
          deletedPaths: string[];
          messages: string[];
          /** DEV-10316: post-apply dirty HEAD; carried to publish as expectedBaseDirtyHead. */
          dirtyHead?: string | null;
        }>;
        elapsedMs: number;
      }
    | {
        status: 'blocked_stale';
        blockedCount: number;
        connections: Array<{
          connectionName: string;
          baseHead?: string;
          currentRemoteHead: string;
          message?: string;
        }>;
        elapsedMs: number;
      }
    | {
        // DEV-10316: the connection has unpublished changes on the server.
        status: 'blocked_dirty';
        blockedCount: number;
        connections: Array<{
          connectionName: string;
          connectorAccountId: string;
          dirtyCount: number;
        }>;
        elapsedMs: number;
      }
    | {
        // DEV-10316: the dirty-gate check couldn't run; retryable.
        status: 'check_failed';
        blockedCount: number;
        connections: Array<{
          connectionName: string;
          connectorAccountId: string;
          message?: string;
        }>;
        message?: string;
        elapsedMs: number;
      }
  >;
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
  checkClaudeChatAvailable: () => Promise<ClaudeChatAvailability>;
  sendClaudeChatMessage: (
    workspacePath: string,
    message: string,
    requestId: string,
  ) => Promise<StartClaudeChatTurnResult>;
  stopClaudeChat: (requestId: string) => Promise<void>;
  resetClaudeChatSession: (workspacePath: string) => Promise<void>;
  pullAllLinkedTables: (workspacePath: string) => Promise<{ jobIds: string[] }>;
  showInFolder: (folderPath: string) => Promise<void>;
  showItemInFolder: (filePath: string) => Promise<void>;
  showWorkspaceLog: (workspacePath: string) => Promise<void>;
  showNativeContextMenu: (
    items: Array<{
      id: string;
      label: string;
      type?: 'separator';
      enabled?: boolean;
      checked?: boolean;
      submenu?: Array<{ id: string; label: string; checked?: boolean }>;
    }>,
    onClick: (id: string) => void,
  ) => void;
  openInTerminal: (folderPath: string) => Promise<void>;
  toggleDevTools: () => Promise<void>;
  getAppVersion: () => Promise<string>;
  logApiCall: (
    workspacePath: string,
    entry: { method: string; url: string; status?: number; durationMs: number; errorSummary?: string },
  ) => void;
  logSession: (workspacePath: string, event: 'start' | 'end') => void;
  logPublishJob: (
    workspacePath: string,
    entry:
      | {
          event: 'start';
          jobIds: string[];
          tables: string[];
          plans: number;
          summary: { edit: number; create: number; delete: number; backfill: number; rename: number };
        }
      | {
          event: 'complete';
          jobId: string;
          state: string;
          successCount?: number;
          failedCount?: number;
          summary?: { edit: number; create: number; delete: number; backfill: number; rename: number };
          errorSummary?: string;
        },
  ) => void;
  watchWorkspaceFiles: (workspacePath: string) => Promise<string[]>;
  clearWorkspaceFileWatch: () => Promise<void>;
  onCommandEvent: (callback: (event: ScratchCommandEvent) => void) => () => void;
  onClaudeChatEvent: (callback: (event: ClaudeChatEvent) => void) => () => void;
  onWorkspaceFilesChanged: (callback: (event: WorkspaceFilesChangedEvent) => void) => () => void;
  onReviewStatsMayHaveChanged: (callback: (event: ReviewStatsMayHaveChangedEvent) => void) => () => void;
  onConnectionFileChanged: (callback: (event: ConnectionFileChangedEvent) => void) => () => void;
  onGridProgress: (callback: (line: string) => void) => () => void;
  onWorkspaceNeedsReinit: (callback: (event: WorkspaceNeedsReinitEvent) => void) => () => void;
  cliInstall: {
    subscribe: (callback: (event: CliInstallEvent) => void) => () => void;
  };
  updater: {
    checkNow: () => Promise<void>;
    quitAndInstall: () => Promise<void>;
    subscribe: (callback: (event: UpdaterEvent) => void) => () => void;
  };
  lifecycle: {
    onWillQuit: (callback: (payload: AppWillQuitPayload) => void) => () => void;
    confirmQuit: () => void;
  };
}

interface ScratchFilesAPI {
  workspaceConfig: (workspacePath: string) => Promise<{
    apiUrl: string;
    workbookId: string;
    orgId: string;
    authToken?: string;
    connections: Array<{
      id: string;
      displayName: string;
      service: string;
      dirName: string;
    }>;
  }>;
  listFolders: (workspacePath: string) => Promise<
    Array<{
      name: string;
      path: string;
      fileCount: number;
    }>
  >;
  getFolderMetadata: (
    folderPath: string,
    workspacePath: string,
  ) => Promise<{
    name: string;
    path: string;
    fileCount: number;
    schema: Record<string, unknown>;
    columnDefinitions: ColumnDefinition[];
    view: TableView | null;
    availableViewNames: string[];
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
  revertPlan: (
    workspacePath: string,
    planId: string,
    filter?: { filePath?: string; dataFolderId?: string; phase?: string; filename?: string },
  ) => Promise<
    { ok: true; total: number; filesWritten: number; filesDeleted: number; elapsedMs: number } | { error: string }
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
  readConnectionView: (folderPath: string, workspacePath: string, viewName: string) => Promise<TableView | null>;
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
  findRecordOffset: (folderPath: string, workspacePath: string, filename: string) => Promise<number | null>;
  readDiffGridData: (
    folderPath: string,
    workspacePath: string,
    opts?: {
      offset?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      filters?: DiffGridFilter[];
      validate?: boolean;
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
    filterCounts: { unreviewed: number; unpublished: number; errors: number };
    focusColumnIds: { unreviewed: string[]; unpublished: string[]; errors: string[] };
    invalidJsonFiles: Array<{
      filename: string;
      error: string;
      workingFilePath: string;
    }>;
    staleCount: number;
    totalErrorCount: number;
    totalProblemsStaleCount: number;
    validationByCell: Record<
      string,
      Array<{
        field_path: string;
        validator_kind: string;
        level: string;
        message?: string;
        description?: string;
        fixable: boolean;
      }>
    >;
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
  getValidationResults: (workspacePath: string, folderPath: string, filename: string) => Promise<ValidationResultRow[]>;
  getFolderValidationResults: (workspacePath: string, folderPath: string) => Promise<ValidationResultRow[]>;
  getValidationStats: (workspacePath: string) => Promise<ValidationStat[]>;
  getReviewStats: (workspacePath: string) => Promise<ReviewStat[]>;
  getFolderValidationSample: (workspacePath: string, folder: string) => Promise<ValidationResultRow[]>;
  getValidationConfigs: (workspacePath: string) => Promise<ValidatorConfig[]>;
  writeValidationConfig: (
    workspacePath: string,
    connection: string,
    folderPath: string,
    entries: ValidatorConfigEntry[],
  ) => Promise<void>;
  acceptFieldEditFromInputText: (
    folderPath: string,
    workspacePath: string,
    filename: string,
    fieldName: string,
    value: string,
  ) => Promise<{ value: unknown }>;
  acceptUnreviewedFieldEdit: (
    folderPath: string,
    workspacePath: string,
    filename: string,
    fieldName: string,
    value: string,
  ) => Promise<{ value: unknown }>;
  dropApprovedFieldAndRestoreToMain: (
    folderPath: string,
    workspacePath: string,
    filename: string,
    fieldName: string,
  ) => Promise<void>;
  revertUnreviewedFieldEditToApproved: (
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
    scratchPreferences: ScratchPreferencesAPI;
    scratchDesktop: ScratchDesktopAPI;
    scratchFiles: ScratchFilesAPI;
  }
}
