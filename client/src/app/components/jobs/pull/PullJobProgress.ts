import type { PullLinkedFolderFilesPublicProgress } from '@spinner/shared-types';

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

// Combined type that can be any of these. The linked-folder-files shape is the shared authoritative
// type from @spinner/shared-types (the others are client-local legacy progress shapes).
export type PullProgress = PullRecordsProgress | PullFilesProgress | PullLinkedFolderFilesPublicProgress;

// Type guard for pull files progress (array of folders)
export function isPullFilesProgress(progress: PullProgress): progress is PullFilesProgress {
  return 'folders' in progress;
}

// Type guard for pull linked folder files progress (single folder)
// Distinguishes from PullFilesPublicProgress (which also has folderId/folderName) by checking for totalFiles
export function isPullLinkedFolderFilesProgress(
  progress: PullProgress,
): progress is PullLinkedFolderFilesPublicProgress {
  return 'folderId' in progress && 'folderName' in progress && 'totalFiles' in progress;
}
