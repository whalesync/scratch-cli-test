export const WORKSPACE_FILE_WATCH_EVENT_CHANNEL = 'scratch:workspace-files-changed';

export type WorkspaceFilesChangedEvent = {
  workspacePath: string;
  source: 'external' | 'internal';
  singleFile?: string;
  changedFolderPaths: string[];
};

export const CONNECTION_FILE_CHANGED_EVENT_CHANNEL = 'scratch:connection-file-changed';

export type ConnectionFileChangedEvent = {
  workspacePath: string;
  filePath: string;
};
