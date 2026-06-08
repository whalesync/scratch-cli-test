/** Types shared between main process (local-files.ts) and renderer for the local file access layer. */

export type {
  ColumnAttributes,
  ColumnDataType,
  ColumnDefinition,
  NormalizedRecordRow,
} from '../../../shared/schema-columns';

export interface WorkspaceConfig {
  apiUrl: string;
  workbookId: string;
  orgId: string;
  authToken?: string;
  connections: WorkspaceConnection[];
}

export interface WorkspaceConnection {
  id: string;
  displayName: string;
  service: string;
  dirName: string;
}

export interface ListFilesOptions {
  offset: number;
  limit: number;
  sortBy?: 'name' | 'modified' | 'size';
  sortOrder?: 'asc' | 'desc';
  filter?: {
    /** Substring match on filename */
    search?: string;
    /** e.g. ['.json', '.png'] */
    extensions?: string[];
  };
}

export interface ListFilesResult {
  files: FileEntry[];
  /** Total matching files (after filter, before pagination) */
  total: number;
  offset: number;
}

export interface FileEntry {
  name: string;
  /** Absolute path on disk */
  path: string;
  size: number;
  /** Epoch ms */
  lastModified: number;
  extension: string;
  isJson: boolean;
}

export type FileContent =
  | { type: 'json'; path: string; data: Record<string, unknown>; size: number }
  | { type: 'binary'; path: string; mimeType: string; size: number; base64?: string }
  | { type: 'error'; path: string; error: string };
