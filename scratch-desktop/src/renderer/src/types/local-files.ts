/** Types shared between main process (local-files.ts) and renderer for the local file access layer. */

export interface WorkspaceConfig {
  apiUrl: string;
  workbookId: string;
  orgId: string;
  authToken?: string;
}

export interface FolderEntry {
  name: string;
  /** Absolute path on disk */
  path: string;
  fileCount: number;
  /** Epoch ms of most recently modified file */
  lastModified: number;
  /** Total size in bytes of all files */
  totalSize: number;
}

export interface FolderMetadata extends FolderEntry {
  /** Parsed .scratch/schemas/<name>.json, or null if no schema exists */
  schema: Record<string, unknown> | null;
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
