/**
 * Job type constants shared between client and server.
 *
 * Each value corresponds to the `type` field in job definitions
 * (server/src/worker/jobs/job-definitions/).
 */
export type FolderError = {
  folderName: string;
  message: string;
  details?: string;
};

export const JobType = {
  PullLinkedFolderFiles: 'pull-linked-folder-files',
  RefreshRecords: 'refresh-records',
  Publish: 'publish',
  ApplyPatches: 'apply-patches',
  SyncDataFolders: 'sync-data-folders',
  RehostAssets: 'rehost-assets',
  DeleteWorkbook: 'delete-workbook',
  /**
   * Pre-flight cleanup for a routine run: discard every connection's leftover working-set edits so
   * the run starts from the published baseline. Backs the `discard-pending-changes` routine action.
   */
  DiscardPendingChanges: 'discard-pending-changes',
  // THROWAWAY (no Linear issue): temporary "pull then sync" job used to unblock
  // development of the real job-dependency system. Remove once dependencies land.
  TemporarySyncWithPull: 'temporary-sync-with-pull',
} as const;

export type JobType = (typeof JobType)[keyof typeof JobType];
