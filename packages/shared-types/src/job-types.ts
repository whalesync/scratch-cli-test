/**
 * Job type constants shared between client and server.
 *
 * Each value corresponds to the `type` field in job definitions
 * (server/src/worker/jobs/job-definitions/).
 */
export const JobType = {
  PullLinkedFolderFiles: 'pull-linked-folder-files',
  RefreshRecords: 'refresh-records',
  Publish: 'publish',
  PublishDataFolder: 'publish-data-folder',
  PublishFromGit: 'publish-from-git',
  SyncDataFolders: 'sync-data-folders',
  RehostAssets: 'rehost-assets',
  PlanPipeline: 'plan-pipeline',
  RunPipeline: 'run-pipeline',
} as const;

export type JobType = (typeof JobType)[keyof typeof JobType];
