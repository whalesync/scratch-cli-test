import type { TableView } from '@spinner/shared-types';
import type { AgentDeepLinkProduct } from '../shared/agent-deep-links';
import type { AutoDownloadCompletedEvent } from '../shared/auto-download-events';
import type { CliInstallEvent } from '../shared/cli-install-events';
import type { AppWillQuitPayload } from '../shared/lifecycle-events';
import type { RecordTreeResult } from '../shared/record-tree-types';
import type { ReviewStatsMayHaveChangedEvent } from '../shared/review-stats-events';
import type { ReviewStat } from '../shared/review-types';
import type { ColumnDefinition, NormalizedRecordRow } from '../shared/schema-columns';
import type { UpdaterEvent } from '../shared/updater-events';
import type {
  RerunValidationScope,
  RerunValidationSummary,
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
  | { scope: 'global'; kind: 'unreviewed' | 'unpublished' | 'pending' | 'has-problems' }
  | {
      scope: 'column';
      kind: 'unreviewed' | 'unpublished' | 'pending' | 'has-problems';
      columnId: string;
      columnTitle: string;
    }
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
  /** DEV-10470: scheduled daily auto-download of this workspace (default ON; absent = ON). */
  autoDownloadEnabled?: boolean;
}

type CloudSyncProvider = 'icloud' | 'dropbox' | 'onedrive' | 'googledrive' | 'box' | 'cloudstorage-other';

interface CloudSyncWarning {
  provider: CloudSyncProvider;
  providerLabel: string;
  evidencePath: string;
}

interface ScratchPreferencesAPI {
  getCurrentWorkspaceId: () => Promise<string | null>;
  setCurrentWorkspaceId: (id: string | null) => Promise<void>;
  getWorkbookSettings: (workbookId: string) => Promise<WorkbookSettings>;
  setWorkbookSetting: (workbookId: string, key: string, value: unknown) => Promise<void>;
}

interface ScratchDesktopAPI {
  /** OS platform, for Mac-vs-Windows UI hints (replaces the removed generic `window.electron`, DEV-10996). */
  platform: NodeJS.Platform;
  getWorkspacesRegistry: () => Promise<
    Array<{ id: string; path: string; fileCount: number; cloudSyncWarning: CloudSyncWarning | null }>
  >;
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
  rerunValidation: (workspacePath: string, scope: RerunValidationScope) => Promise<RerunValidationSummary>;
  onRerunValidationProgress: (callback: (line: string) => void) => () => void;
  refreshPaths: (workspacePath: string, paths: string[], singleFile?: string) => Promise<void>;
  acceptAllChanges: (
    workspacePath: string,
    folderPath?: string,
    connectionId?: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  discardAllChanges: (
    workspacePath: string,
    folderPath?: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  rejectAllChanges: (
    workspacePath: string,
    folderPath?: string,
    connectionId?: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  acceptRecord: (
    workspacePath: string,
    recordPath: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Accept several records in one CLI call (the by-type view's per-group bulk approve for created/removed/invalid groups). */
  acceptRecords: (
    workspacePath: string,
    recordPaths: string[],
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
  uploadWorkspaceChanges: (
    workspacePath: string,
    opts?: { filePath?: string; connectionId?: string },
  ) => Promise<
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
  /** DEV-10413: single-record post-publish reconcile (scoped `files reconcile-published`). */
  reconcilePublishedRecord: (
    workspacePath: string,
    filePath: string,
    pipelineId?: string,
  ) => Promise<{ status: string; path: string; patchDropped: boolean; conflicts: number }>;
  /**
   * DEV-10048 (publish redesign): per-connection post-publish reconcile. Routes
   * connector-rejected records into `failed-patches.json` (re-surfacing them as
   * needs-approval), drops publish-no-op survivors, preserves unreviewed edits.
   * `failedOpsJson` is the run-job's `failedOperations` array as a JSON string.
   */
  reconcileAfterPublish: (
    workspacePath: string,
    connectionId: string,
    failedOpsJson: string,
    pipelineId?: string,
  ) => Promise<{
    status: string;
    connection: string;
    filesCreated: number;
    filesUpdated: number;
    filesDeleted: number;
    failedCount: number;
  }>;
  /**
   * DEV-10523: pull re-applies unreviewed working-tree edits user-wins instead
   * of blocking. `opts.filePath` (single-record "Download and publish") scopes
   * only the failure decision to that record. Returns a structured result; the
   * `blocked_conflict` branch is a non-throwing refusal the renderer
   * pattern-matches on.
   */
  pullWorkspaceChanges: (
    workspacePath: string,
    opts?: { onDelete?: string; filePath?: string; connectionId?: string },
  ) => Promise<
    | {
        status: 'downloaded' | 'up_to_date' | 'downloaded_with_stashed_conflicts';
        filesCreated: number;
        filesUpdated: number;
        filesDeleted: number;
        filesMerged: number;
        conflictsAutoResolved: number;
        unreviewedConflictsAutoResolved: number;
        messages: string[];
        elapsedMs: number;
        /** Present only on `downloaded_with_stashed_conflicts`. */
        stashedConflictPaths?: string[];
        stashFiles?: string[];
        connectionsAdded?: string[];
        connectionsRemoved?: string[];
        connectionsDetached?: string[];
        /** Raw CLI stderr — warn-and-skip notices (e.g. DEV-10421) print here even under `--json`. */
        stderr?: string;
      }
    | {
        // DEV-10523: an unreviewed edit couldn't be re-applied (server deleted the
        // edited record, or the patch failed to reconstruct); saved to
        // unreviewed-changes.json. For a single-record pull, the TARGET conflicts.
        status: 'blocked_conflict';
        conflictCount: number;
        paths: string[];
        stashFiles: string[];
        elapsedMs: number;
        stderr?: string;
      }
  >;
  listLocalSyncs: (workspacePath: string) => Promise<string[]>;
  validateLocalSync: (
    workspacePath: string,
    syncName: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  startRunLocalSync: (workspacePath: string, syncName: string) => Promise<{ sessionId: string }>;
  pullAllLinkedTables: (workspacePath: string) => Promise<{ jobIds: string[] }>;
  /** Derive the record tree of a folder whose schema declares `recordTree` parent-pointer paths. */
  recordTree: (workspacePath: string, folder: string) => Promise<RecordTreeResult>;
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
  openAgentDeepLink: (
    product: AgentDeepLinkProduct,
    workspacePath: string,
    workspaceName: string | null,
    selectedFolderRelativePath: string | null,
  ) => Promise<void>;
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
  onWorkspaceFilesChanged: (callback: (event: WorkspaceFilesChangedEvent) => void) => () => void;
  onReviewStatsMayHaveChanged: (callback: (event: ReviewStatsMayHaveChangedEvent) => void) => () => void;
  onConnectionFileChanged: (callback: (event: ConnectionFileChangedEvent) => void) => () => void;
  onGridProgress: (callback: (line: string) => void) => () => void;
  onWorkspaceNeedsReinit: (callback: (event: WorkspaceNeedsReinitEvent) => void) => () => void;
  onAutoDownloadCompleted: (callback: (event: AutoDownloadCompletedEvent) => void) => () => void;
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
  /** Read a folder's connection schema.json (workspace-relative `<connection>/<folder>` path). */
  readConnectionSchema: (workspacePath: string, relPath: string) => Promise<Record<string, unknown> | null>;
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
        /** DEV-10048: per-field connector rejection messages from a prior failed publish. */
        __failedFields?: Record<string, string>;
        /** DEV-10048: record-level connector rejection message from a prior failed publish. */
        __failedError?: string;
        __raw: Record<string, unknown>;
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
    filterCounts: { unreviewed: number; unpublished: number; pending: number; errors: number };
    focusColumnIds: { unreviewed: string[]; unpublished: string[]; errors: string[] };
    invalidJsonFiles: Array<{
      filename: string;
      error: string;
      workingFilePath: string;
    }>;
    referenceLabels: Record<string, Record<string, string>>;
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
      /** DEV-10048: per-field connector rejection messages from a prior failed publish. */
      __failedFields?: Record<string, string>;
      /** DEV-10048: record-level connector rejection message from a prior failed publish. */
      __failedError?: string;
      __raw: Record<string, unknown>;
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
  ensureSchemaValidatorSeeded: (workspacePath: string) => Promise<void>;
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
    scratchDeepLink?: ScratchDeepLinkAPI;
    scratchAuth: ScratchAuthAPI;
    scratchPreferences: ScratchPreferencesAPI;
    scratchDesktop: ScratchDesktopAPI;
    scratchFiles: ScratchFilesAPI;
  }
}
