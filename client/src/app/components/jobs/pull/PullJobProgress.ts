export type TableProgress = {
  id: string;
  name: string;
  connector: string;
  records: number;
  status: 'pending' | 'active' | 'completed' | 'failed';
  hasDirtyDiscoveredDeletes?: boolean;
};

export type FolderProgress = {
  id: string;
  name: string;
  connector: string;
  files: number;
  status: 'pending' | 'active' | 'completed' | 'failed';
  hasDirtyDiscoveredDeletes?: boolean;
};

// Pull records progress (existing)
export type PullRecordsProgress = {
  totalRecords: number;
  tables: TableProgress[];
};

// Pull files progress (array of folders)
export type PullFilesProgress = {
  totalFiles: number;
  folders: FolderProgress[];
};

import type { FolderError } from '@spinner/shared-types';

// Pull linked folder files progress (single folder from pull-linked-folder-files job)
export type PullLinkedFolderFilesProgress = {
  totalFiles: number;
  folderCount?: number;
  connectionName?: string;
  folderId: string;
  folderName: string;
  connector: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  /** All folder IDs being pulled (v2 multi-folder jobs). */
  dataFolderIds?: string[];
  createdPaths?: string[];
  updatedPaths?: string[];
  deletedPaths?: string[];
  /** Actual counts (not capped like path arrays). Available from newer server versions. */
  createdCount?: number;
  updatedCount?: number;
  deletedCount?: number;
  hasDirtyDiscoveredDeletes?: boolean;
  /** Per-folder errors populated when one or more folders fail. */
  folderErrors?: Record<string, FolderError>;
};

// Combined type that can be any of these
export type PullProgress = PullRecordsProgress | PullFilesProgress | PullLinkedFolderFilesProgress;

// Type guard for pull files progress (array of folders)
export function isPullFilesProgress(progress: PullProgress): progress is PullFilesProgress {
  return 'folders' in progress;
}

// Type guard for pull linked folder files progress (single folder)
// Distinguishes from PullFilesPublicProgress (which also has folderId/folderName) by checking for totalFiles
export function isPullLinkedFolderFilesProgress(progress: PullProgress): progress is PullLinkedFolderFilesProgress {
  return 'folderId' in progress && 'folderName' in progress && 'totalFiles' in progress;
}
