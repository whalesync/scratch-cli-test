/**
 * File system entity types for the file-based workbook database
 */

import { Service } from './enums';
import { DataFolderId } from './ids';

/**
 * Diff status of a file relative to the published branch.
 */
export type FileDiffStatus = 'added' | 'modified' | 'deleted';

/**
 * Response from the fast "has dirty files" check.
 * Compares root tree OIDs — instant regardless of repo size.
 */
export interface HasDirtyFilesResponse {
  dirty: boolean;
}

/**
 * Response from the dirty file count endpoint.
 */
export interface DirtyFileCountResponse {
  count: number;
}

/**
 * Response from the git count-objects endpoint.
 */
export interface GitObjectCountsResponse {
  stats: string;
  gcInProgress: number | null;
  engine?: string;
  repoPath?: string;
}

/**
 * Response from the git gc endpoint.
 */
export interface GitGcResponse {
  success: boolean;
  statsBefore: string;
  statsAfter: string;
}

/**
 * Reference to a file in the workbook
 */
export interface FileRefEntity {
  type: 'file';
  /** Full path of the file and the unique identifier, e.g. "/folder/file.md" */
  path: string;
  /** Name of the file, e.g. "file.md" */
  name: string;
  /** ID of the parent folder, or null if at workbook root */
  parentFolderId: DataFolderId | null;
  /** Whether the file has unpublished changes */
  dirty?: boolean;
  /** Diff status relative to the published branch */
  status?: FileDiffStatus;
}

/**
 * Reference to a folder in the workbook
 */
export interface FolderRefEntity {
  type: 'folder';
  id: DataFolderId;
  name: string;
  /** ID of the parent folder, or null if at workbook root */
  parentFolderId: DataFolderId | null;
  /** Full path of the folder, e.g. "/parent/child" */
  path: string;
  /** Service type if folder is linked to a snapshot table */
  connectorService?: Service | null;
  /** Remote ID of the source table if synced */
  remoteId?: string | string[] | null;
}

/**
 * Either a file or folder reference
 */
export type FileOrFolderRefEntity = FileRefEntity | FolderRefEntity;

export interface FileDetailsEntity {
  ref: FileRefEntity;
  content: string | null;
  originalContent: string | null;
  suggestedContent: string | null;
  createdAt: string; // ISO-8601 string
  updatedAt: string; // ISO-8601 string
}
