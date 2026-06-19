import { DbJob } from '@prisma/client';
import { Job } from '@spinner/shared-types';
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
  runId?: string | null;
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
    runId: dbJob.runId,
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

/**
 * Maps a {@link JobEntity} to the shared {@link Job} wire type. The only difference is the
 * timestamps: the entity holds `Date`s (which JSON-serialize to ISO strings on the wire), while the
 * shared wire type declares them as ISO `string | null` — so callers that return `Job` directly
 * (e.g. nesting a job inside a routine run) match the contract without a runtime serializer.
 */
export function jobEntityToJob(entity: JobEntity): Job {
  return {
    ...entity,
    processedOn: entity.processedOn ? entity.processedOn.toISOString() : null,
    finishedOn: entity.finishedOn ? entity.finishedOn.toISOString() : null,
  };
}
