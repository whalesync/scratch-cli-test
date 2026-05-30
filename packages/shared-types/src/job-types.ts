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
} as const;

export type JobType = (typeof JobType)[keyof typeof JobType];
