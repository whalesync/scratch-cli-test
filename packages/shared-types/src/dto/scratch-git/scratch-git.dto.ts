/** A file/directory entry from `GET /scratch-git/:id/list`. */
export interface GitFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface GitIndexFile {
  folder: string;
  filename: string;
  remoteId: string | null;
}

export interface GitIndexReference {
  sourceFolder: string;
  sourceFilename: string;
  targetTableId: string;
  targetRemoteId: string;
}

/** Response for `GET /scratch-git/:id/index/dump`. */
export interface GitIndexDump {
  files: GitIndexFile[];
  references: GitIndexReference[];
}

/** Per-connection result of the admin "strip connection prefix" maintenance action. */
export interface StripPrefixConnectionResult {
  connectorAccountId: string;
  displayName: string;
  repoId: string;
  case: string;
  foldersUpdated: number;
  error?: string;
}
