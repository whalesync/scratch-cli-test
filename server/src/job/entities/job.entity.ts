import { DbJob } from '@prisma/client';
import { JobState } from 'bullmq';
import { Progress } from 'src/types/progress';
import { JsonSafeObject } from 'src/utils/objects';
import { RunContext } from 'src/worker/jobs/base-types';

export type DbJobStatus =
  | JobState
  | 'unknown'
  | 'created'
  // bullmq state will be completed
  | 'canceled';
export interface JobEntity<TPublicProgress = JsonSafeObject> {
  bullJobId?: string | null;
  dbJobId?: string | null;
  workbookId?: string | null;
  dataFolderId?: string | null;
  state: DbJobStatus;
  type: string;
  progressTimestamp?: number;
  publicProgress?: TPublicProgress;
  processedOn?: Date | null;
  finishedOn?: Date | null;
  failedReason?: string | null;
  runContext?: RunContext | null;
}

export function dbJobToJobEntity(dbJob: DbJob): JobEntity {
  const progress = dbJob.progress as Progress;
  return {
    dbJobId: dbJob.id,
    bullJobId: dbJob.bullJobId,
    workbookId: dbJob.workbookId,
    dataFolderId: dbJob.dataFolderId,
    type: dbJob.type,
    state: dbJob.status as DbJobStatus,
    progressTimestamp: progress?.timestamp,
    publicProgress: progress?.publicProgress,
    processedOn: dbJob.processedOn,
    finishedOn: dbJob.finishedOn,
    failedReason: dbJob.error,
    runContext: dbJob.runContext as RunContext | null,
  };
}
