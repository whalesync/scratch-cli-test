import { RoutineRunId } from '@spinner/shared-types';
import { Job as BullMQPlainJob } from 'bullmq';
import { Progress } from './base-types';
import { ApplyPatchesJobDefinition } from './job-definitions/apply-patches.job';
import { DeleteWorkbookJobDefinition } from './job-definitions/delete-workbook.job';
import { DiscardPendingChangesJobDefinition } from './job-definitions/discard-pending-changes.job';
import { PublishJobDefinition } from './job-definitions/publish.job';
import { PullFilesJobDefinition } from './job-definitions/pull-files.job';
import { PullLinkedFolderFilesJobDefinition } from './job-definitions/pull-linked-folder-files.job';
import { RehostAssetsJobDefinition } from './job-definitions/rehost-assets.job';
import { SyncDataFoldersJobDefinition } from './job-definitions/sync-data-folders.job';
import { TemporarySyncWithPullJobDefinition } from './job-definitions/temporary-sync-with-pull.job';

export type JobDefinition =
  | ApplyPatchesJobDefinition
  | DeleteWorkbookJobDefinition
  | DiscardPendingChangesJobDefinition
  | PublishJobDefinition
  | PullLinkedFolderFilesJobDefinition
  | PullFilesJobDefinition
  | RehostAssetsJobDefinition
  | SyncDataFoldersJobDefinition
  | TemporarySyncWithPullJobDefinition;
export type JobData = JobDefinition['data'];
export type JobTypes = JobDefinition['type'];
export type JobProgress = Progress<JobDefinition['publicProgress'], JobDefinition['initialJobProgress']>;
export type BullMqJob<TDefinition extends JobDefinition = JobDefinition> = BullMQPlainJob<
  TDefinition['data'],
  TDefinition['result'],
  TDefinition['type']
>;
export type JobHandler<TDefinition extends JobDefinition> = {
  run: (params: {
    jobId: string;
    runId?: string;
    routineRunId?: RoutineRunId;
    data: TDefinition['data'];
    progress: Progress<TDefinition['publicProgress'], TDefinition['initialJobProgress']>;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<Progress<TDefinition['publicProgress'], TDefinition['initialJobProgress']>, 'timestamp'>,
    ) => Promise<void>;
  }) => Promise<TDefinition['result']>;
  terminate?: (params: {
    jobId: string;
    reason: 'canceled' | 'termina-failure';
    data: TDefinition['data'];
    progress: Progress<TDefinition['publicProgress']>;
  }) => Promise<TDefinition['result']>;
};
