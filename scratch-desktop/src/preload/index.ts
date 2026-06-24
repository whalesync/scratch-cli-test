import { electronAPI } from '@electron-toolkit/preload';
import type { TableView } from '@spinner/shared-types';
import { contextBridge, ipcRenderer } from 'electron';
import { CLI_INSTALL_EVENT_CHANNEL, type CliInstallEvent } from '../shared/cli-install-events';
import { APP_QUIT_CONFIRMED_CHANNEL, APP_WILL_QUIT_CHANNEL, type AppWillQuitPayload } from '../shared/lifecycle-events';
import {
  REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL,
  type ReviewStatsMayHaveChangedEvent,
} from '../shared/review-stats-events';
import type { ReviewStat } from '../shared/review-types';
import type { ColumnDefinition, NormalizedRecordRow } from '../shared/schema-columns';
import { UPDATER_EVENT_CHANNEL, type UpdaterEvent } from '../shared/updater-events';
import type {
  ValidationResultRow,
  ValidationStat,
  ValidatorConfig,
  ValidatorConfigEntry,
} from '../shared/validation-types';
import {
  CONNECTION_FILE_CHANGED_EVENT_CHANNEL,
  WORKSPACE_FILE_WATCH_EVENT_CHANNEL,
  type ConnectionFileChangedEvent,
  type WorkspaceFilesChangedEvent,
} from '../shared/workspace-file-watch';
import { WORKSPACE_NEEDS_REINIT_CHANNEL, type WorkspaceNeedsReinitEvent } from '../shared/workspace-reinit-events';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invoke(channel: string, ...args: unknown[]): Promise<any> {
  console.log('[ipc:invoke]', channel, args);
  return ipcRenderer.invoke(channel, ...args);
}

export interface WorkbookSettings {
  validateEnabled?: boolean;
}

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

const scratchDeepLink = {
  onDeepLink: (callback: (route: string, query: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, route: string, query: string): void => {
      callback(route, query);
    };
    ipcRenderer.on('deep-link', listener);
    return () => {
      ipcRenderer.removeListener('deep-link', listener);
    };
  },
};

const scratchAuth = {
  getCredentials: (): Promise<{
    apiToken: string | null;
    email: string | null;
    tokenExpiresAt: string | null;
    serverUrl: string | null;
  }> => invoke('auth:get-credentials'),
  saveCredentials: (creds: {
    apiToken: string;
    email?: string;
    tokenExpiresAt?: string;
    serverUrl: string;
  }): Promise<void> => invoke('auth:save-credentials', creds),
  clearCredentials: (): Promise<void> => invoke('auth:clear-credentials'),
  isTokenExpired: (): Promise<boolean> => invoke('auth:is-token-expired'),
  openExternal: (url: string): Promise<void> => invoke('auth:open-external', url),
};

export type CloudSyncProvider = 'icloud' | 'dropbox' | 'onedrive' | 'googledrive' | 'box' | 'cloudstorage-other';

export interface CloudSyncWarning {
  provider: CloudSyncProvider;
  providerLabel: string;
  evidencePath: string;
}

const scratchPreferences = {
  getCurrentWorkspaceId: (): Promise<string | null> => invoke('preferences:get-current-workspace-id'),
  setCurrentWorkspaceId: (id: string | null): Promise<void> => invoke('preferences:set-current-workspace-id', id),
  getWorkbookSettings: (workbookId: string): Promise<WorkbookSettings> =>
    invoke('preferences:get-workbook-settings', workbookId),
  setWorkbookSetting: (workbookId: string, key: string, value: unknown): Promise<void> =>
    invoke('preferences:set-workbook-setting', workbookId, key, value),
};

const scratchDesktop = {
  getWorkspacesRegistry: (): Promise<
    Array<{ id: string; path: string; fileCount: number; cloudSyncWarning: CloudSyncWarning | null }>
  > => invoke('scratch:get-workspaces-registry'),
  createWorkspace: (name: string): Promise<{ id: string; name: string }> => invoke('scratch:create-workspace', name),
  pickParentFolder: (): Promise<string | null> => invoke('scratch:pick-parent-folder'),
  initWorkspace: (
    workbookId: string,
    cwd: string,
    opts?: { force?: boolean },
  ): Promise<{ stdout: string; stderr: string }> => invoke('scratch:init-workspace', workbookId, cwd, opts),
  removeWorkspace: (workbookId: string): Promise<void> => invoke('scratch:remove-workspace', workbookId),
  prepareWorkspaceIndex: (workspacePath: string): Promise<void> =>
    invoke('scratch:prepare-workspace-index', workspacePath),
  clearFolderIndex: (workspacePath: string, folderPath: string): Promise<{ rows_cleared: number }> =>
    invoke('scratch:clear-folder-index', workspacePath, folderPath),
  refreshPaths: (workspacePath: string, paths: string[], singleFile?: string): Promise<void> =>
    invoke('scratch:refresh-paths', workspacePath, paths, singleFile),
  acceptAllChanges: (
    workspacePath: string,
    folderPath?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    invoke('scratch:accept-all-changes', workspacePath, folderPath),
  discardAllChanges: (
    workspacePath: string,
    folderPath?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    invoke('scratch:discard-all-changes', workspacePath, folderPath),
  rejectAllChanges: (
    workspacePath: string,
    folderPath?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    invoke('scratch:reject-all-changes', workspacePath, folderPath),
  acceptRecord: (
    workspacePath: string,
    recordPath: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    invoke('scratch:accept-record', workspacePath, recordPath),
  rejectRecord: (
    workspacePath: string,
    recordPath: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    invoke('scratch:reject-record', workspacePath, recordPath),
  discardRecord: (
    workspacePath: string,
    recordPath: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    invoke('scratch:discard-record', workspacePath, recordPath),
  listUnreviewedChanges: (
    workspacePath: string,
  ): Promise<Array<{ connectionName: string; path: string; status: string }>> =>
    invoke('scratch:list-unreviewed-changes', workspacePath),
  listUnpushedChanges: (
    workspacePath: string,
  ): Promise<Array<{ connectionName: string; path: string; status: string }>> =>
    invoke('scratch:list-unpushed-changes', workspacePath),
  uploadWorkspaceChanges: (workspacePath: string, opts?: { filePath?: string }) =>
    invoke('scratch:upload-workspace-changes', workspacePath, opts),
  reconcilePublishedRecord: (
    workspacePath: string,
    filePath: string,
  ): Promise<{ status: string; path: string; patchDropped: boolean; conflicts: number }> =>
    invoke('scratch:reconcile-published-record', workspacePath, filePath),
  pullWorkspaceChanges: (workspacePath: string, opts?: { onDelete?: string; filePath?: string }) =>
    invoke('scratch:pull-workspace-changes', workspacePath, opts),
  listLocalSyncs: (workspacePath: string): Promise<string[]> => invoke('scratch:list-local-syncs', workspacePath),
  validateLocalSync: (
    workspacePath: string,
    syncName: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    invoke('scratch:validate-local-sync', workspacePath, syncName),
  startRunLocalSync: (workspacePath: string, syncName: string): Promise<{ sessionId: string }> =>
    invoke('scratch:start-run-local-sync', workspacePath, syncName),
  pullAllLinkedTables: (workspacePath: string): Promise<{ jobIds: string[] }> =>
    invoke('scratch:pull-all-linked-tables', workspacePath),
  showInFolder: (folderPath: string): Promise<void> => invoke('scratch:show-in-folder', folderPath),
  /** Reveals a file in Finder / Explorer (shell.showItemInFolder). */
  showItemInFolder: (filePath: string): Promise<void> => invoke('scratch:show-item-in-folder', filePath),
  /** Reveals <workspacePath>/workspace.log if it exists; otherwise opens the workspace folder. */
  showWorkspaceLog: (workspacePath: string): Promise<void> => invoke('scratch:show-workspace-log', workspacePath),
  showNativeContextMenu: (
    items: Array<{
      id: string;
      label: string;
      type?: 'separator';
      enabled?: boolean;
      submenu?: Array<{ id: string; label: string; checked?: boolean }>;
    }>,
    onClick: (id: string) => void,
  ): void => {
    ipcRenderer.send('scratch:show-native-context-menu', items);
    const handler = (_event: Electron.IpcRendererEvent, id: string): void => {
      ipcRenderer.removeListener('scratch:native-context-menu-click', handler);
      onClick(id);
    };
    ipcRenderer.once('scratch:native-context-menu-click', handler);
  },
  openInTerminal: (folderPath: string): Promise<void> => invoke('scratch:open-in-terminal', folderPath),
  toggleDevTools: (): Promise<void> => invoke('scratch:toggle-devtools'),
  getAppVersion: (): Promise<string> => invoke('scratch:get-app-version'),
  logApiCall: (
    workspacePath: string,
    entry: { method: string; url: string; status?: number; durationMs: number; errorSummary?: string },
  ): void => {
    ipcRenderer.send('scratch:log-api-call', workspacePath, entry);
  },
  logSession: (workspacePath: string, event: 'start' | 'end'): void => {
    ipcRenderer.send('scratch:log-session', workspacePath, event);
  },
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
  ): void => {
    ipcRenderer.send('scratch:log-publish-job', workspacePath, entry);
  },
  watchWorkspaceFiles: (workspacePath: string): Promise<string[]> =>
    invoke('scratch:watch-workspace-files', workspacePath),
  clearWorkspaceFileWatch: (): Promise<void> => invoke('scratch:clear-workspace-file-watch'),
  cliInstall: {
    subscribe: (callback: (event: CliInstallEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: CliInstallEvent): void => {
        callback(payload);
      };
      ipcRenderer.on(CLI_INSTALL_EVENT_CHANNEL, listener);
      return () => {
        ipcRenderer.removeListener(CLI_INSTALL_EVENT_CHANNEL, listener);
      };
    },
  },
  updater: {
    checkNow: (): Promise<void> => invoke('updater:check-now'),
    quitAndInstall: (): Promise<void> => invoke('updater:quit-and-install'),
    subscribe: (callback: (event: UpdaterEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: UpdaterEvent): void => {
        callback(payload);
      };
      ipcRenderer.on(UPDATER_EVENT_CHANNEL, listener);
      return () => {
        ipcRenderer.removeListener(UPDATER_EVENT_CHANNEL, listener);
      };
    },
  },
  lifecycle: {
    onWillQuit: (callback: (payload: AppWillQuitPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AppWillQuitPayload): void => {
        callback(payload);
      };
      ipcRenderer.on(APP_WILL_QUIT_CHANNEL, listener);
      return () => {
        ipcRenderer.removeListener(APP_WILL_QUIT_CHANNEL, listener);
      };
    },
    confirmQuit: (): void => {
      ipcRenderer.send(APP_QUIT_CONFIRMED_CHANNEL);
    },
  },
  onCommandEvent: (callback: (event: ScratchCommandEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ScratchCommandEvent): void => {
      callback(payload);
    };
    ipcRenderer.on('scratch:command-event', listener);
    return () => {
      ipcRenderer.removeListener('scratch:command-event', listener);
    };
  },
  onWorkspaceFilesChanged: (callback: (event: WorkspaceFilesChangedEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceFilesChangedEvent): void => {
      callback(payload);
    };
    ipcRenderer.on(WORKSPACE_FILE_WATCH_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(WORKSPACE_FILE_WATCH_EVENT_CHANNEL, listener);
    };
  },
  onReviewStatsMayHaveChanged: (callback: (event: ReviewStatsMayHaveChangedEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ReviewStatsMayHaveChangedEvent): void => {
      callback(payload);
    };
    ipcRenderer.on(REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL, listener);
    };
  },
  onConnectionFileChanged: (callback: (event: ConnectionFileChangedEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ConnectionFileChangedEvent): void => {
      callback(payload);
    };
    ipcRenderer.on(CONNECTION_FILE_CHANGED_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(CONNECTION_FILE_CHANGED_EVENT_CHANNEL, listener);
    };
  },
  onGridProgress: (callback: (line: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string): void => {
      callback(line);
    };
    ipcRenderer.on('scratch:grid-progress', listener);
    return () => {
      ipcRenderer.removeListener('scratch:grid-progress', listener);
    };
  },
  onWorkspaceNeedsReinit: (callback: (event: WorkspaceNeedsReinitEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceNeedsReinitEvent): void => {
      callback(payload);
    };
    ipcRenderer.on(WORKSPACE_NEEDS_REINIT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(WORKSPACE_NEEDS_REINIT_CHANNEL, listener);
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
    connections: Array<{
      id: string;
      displayName: string;
      service: string;
      dirName: string;
    }>;
  }> => invoke('files:workspace-config', workspacePath),
  listFolders: (
    workspacePath: string,
  ): Promise<
    Array<{
      name: string;
      path: string;
      fileCount: number;
    }>
  > => invoke('files:list-folders', workspacePath),
  getFolderMetadata: (
    folderPath: string,
    workspacePath: string,
  ): Promise<{
    name: string;
    path: string;
    fileCount: number;
    schema: Record<string, unknown>;
    columnDefinitions: ColumnDefinition[];
    view: TableView | null;
    availableViewNames: string[];
  }> => invoke('files:folder-metadata', folderPath, workspacePath),
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
  }> => invoke('files:list-files', folderPath, opts),
  readFile: (
    filePath: string,
  ): Promise<
    | { type: 'json'; path: string; data: Record<string, unknown>; size: number }
    | { type: 'binary'; path: string; mimeType: string; size: number; base64?: string }
    | { type: 'error'; path: string; error: string }
  > => invoke('files:read-file', filePath),
  readFileTextRaw: (filePath: string): Promise<{ text: string } | { error: string }> =>
    invoke('files:read-file-text-raw', filePath),
  writeFileTextRaw: (filePath: string, contents: string): Promise<{ ok: true } | { error: string }> =>
    invoke('files:write-file-text-raw', filePath, contents),
  revertPlan: (
    workspacePath: string,
    planId: string,
    filter?: { filePath?: string; dataFolderId?: string; phase?: string; filename?: string },
  ): Promise<
    { ok: true; total: number; filesWritten: number; filesDeleted: number; elapsedMs: number } | { error: string }
  > => invoke('publish-plan:revert', workspacePath, planId, filter),
  readBatch: (
    filePaths: string[],
    opts?: { maxSize?: number },
  ): Promise<
    Array<
      | { type: 'json'; path: string; data: Record<string, unknown>; size: number }
      | { type: 'binary'; path: string; mimeType: string; size: number; base64?: string }
      | { type: 'error'; path: string; error: string }
    >
  > => invoke('files:read-batch', filePaths, opts),
  readSchema: (workspacePath: string, folderName: string): Promise<Record<string, unknown> | null> =>
    invoke('files:read-schema', workspacePath, folderName),
  readConnectionView: (folderPath: string, workspacePath: string, viewName: string): Promise<unknown> =>
    invoke('files:read-connection-view', folderPath, workspacePath, viewName),
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
  ): Promise<{
    rows: NormalizedRecordRow[];
    columns: ColumnDefinition[];
    total: number;
    offset: number;
    invalidJsonFiles: Array<{ filename: string; error: string }>;
  }> => invoke('files:read-grid-data', folderPath, opts ?? {}),
  readFolderStatuses: (
    folderPath: string,
    workspacePath: string,
  ): Promise<{ unreviewedFilenames: string[]; unpublishedFilenames: string[] }> =>
    invoke('files:read-folder-statuses', folderPath, workspacePath),
  findRecordOffset: (folderPath: string, workspacePath: string, filename: string): Promise<number | null> =>
    invoke('files:find-record-offset', folderPath, workspacePath, filename),
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
  ): Promise<{
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
    focusColumnIds: { unreviewed: string[]; unpublished: string[] };
    invalidJsonFiles: Array<{
      filename: string;
      error: string;
      workingFilePath: string;
    }>;
  }> => invoke('files:read-diff-grid-data', folderPath, workspacePath, opts ?? {}),
  readDiffRecordData: (
    folderPath: string,
    workspacePath: string,
    filename: string,
  ): Promise<{
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
  } | null> => invoke('files:read-diff-record-data', folderPath, workspacePath, filename),
  getValidationResults: (workspacePath: string, folderPath: string, filename: string): Promise<ValidationResultRow[]> =>
    invoke('files:get-validation-results', workspacePath, folderPath, filename),
  getFolderValidationResults: (workspacePath: string, folderPath: string): Promise<ValidationResultRow[]> =>
    invoke('files:get-folder-validation-results', workspacePath, folderPath),
  getValidationStats: (workspacePath: string): Promise<ValidationStat[]> =>
    invoke('files:get-validation-stats', workspacePath),
  getReviewStats: (workspacePath: string): Promise<ReviewStat[]> => invoke('files:get-review-stats', workspacePath),
  getFolderValidationSample: (workspacePath: string, folder: string): Promise<ValidationResultRow[]> =>
    invoke('files:get-folder-validation-sample', workspacePath, folder),
  getValidationConfigs: (workspacePath: string): Promise<ValidatorConfig[]> =>
    invoke('files:get-validation-configs', workspacePath),
  writeValidationConfig: (
    workspacePath: string,
    connection: string,
    folderPath: string,
    entries: ValidatorConfigEntry[],
  ): Promise<void> => invoke('files:write-validation-config', workspacePath, connection, folderPath, entries),
  ensureSchemaValidatorSeeded: (workspacePath: string): Promise<void> =>
    invoke('files:ensure-schema-validator-seeded', workspacePath),
  acceptFieldEditFromInputText: (
    folderPath: string,
    workspacePath: string,
    filename: string,
    fieldName: string,
    value: string,
  ): Promise<{ value: unknown }> =>
    invoke('files:accept-cell-input-text', folderPath, workspacePath, filename, fieldName, value),
  acceptUnreviewedFieldEdit: (
    folderPath: string,
    workspacePath: string,
    filename: string,
    fieldName: string,
    value: string,
  ): Promise<{ value: unknown }> =>
    invoke('files:accept-cell-change', folderPath, workspacePath, filename, fieldName, value),
  dropApprovedFieldAndRestoreToMain: (
    folderPath: string,
    workspacePath: string,
    filename: string,
    fieldName: string,
  ): Promise<void> => invoke('files:undo-approved-cell-change', folderPath, workspacePath, filename, fieldName),
  revertUnreviewedFieldEditToApproved: (
    folderPath: string,
    workspacePath: string,
    filename: string,
    fieldName: string,
  ): Promise<void> => invoke('files:reject-cell-change', folderPath, workspacePath, filename, fieldName),
  restoreDeletedRecord: (folderPath: string, workspacePath: string, filename: string): Promise<void> =>
    invoke('files:restore-deleted-record', folderPath, workspacePath, filename),
  discardCreatedRecord: (folderPath: string, workspacePath: string, filename: string): Promise<void> =>
    invoke('files:discard-created-record', folderPath, workspacePath, filename),
  acceptFieldChanges: (
    folderPath: string,
    workspacePath: string,
    fieldName: string,
  ): Promise<{
    status: 'accepted' | 'rejected' | 'no_changes';
    field: string;
    folder: string;
    filesAccepted?: number;
    filesRejected?: number;
    paths: string[];
    elapsedMs: number;
  }> => invoke('files:accept-field-changes', folderPath, workspacePath, fieldName),
  rejectFieldChanges: (
    folderPath: string,
    workspacePath: string,
    fieldName: string,
  ): Promise<{
    status: 'accepted' | 'rejected' | 'no_changes';
    field: string;
    folder: string;
    filesAccepted?: number;
    filesRejected?: number;
    paths: string[];
    elapsedMs: number;
  }> => invoke('files:reject-field-changes', folderPath, workspacePath, fieldName),
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('scratchDeepLink', scratchDeepLink);
    contextBridge.exposeInMainWorld('scratchAuth', scratchAuth);
    contextBridge.exposeInMainWorld('scratchPreferences', scratchPreferences);
    contextBridge.exposeInMainWorld('scratchDesktop', scratchDesktop);
    contextBridge.exposeInMainWorld('scratchFiles', scratchFiles);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error -- fallback for non-isolated contexts
  window.electron = electronAPI;
  // @ts-expect-error -- fallback for non-isolated contexts
  window.scratchDeepLink = scratchDeepLink;
  // @ts-expect-error -- fallback for non-isolated contexts
  window.scratchAuth = scratchAuth;
  // @ts-expect-error -- fallback for non-isolated contexts
  window.scratchPreferences = scratchPreferences;
  // @ts-expect-error -- fallback for non-isolated contexts
  window.scratchDesktop = scratchDesktop;
  // @ts-expect-error -- fallback for non-isolated contexts
  window.scratchFiles = scratchFiles;
}
