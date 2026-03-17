import { JobState } from 'bullmq';
import { Progress } from 'src/types/progress';
import { JsonSafeObject } from 'src/utils/objects';

// Mirrors the Job model from prisma/schema.prisma
export interface DbJob {
  id: string;
  workbookId: string | null;
  connectorAccountId: string | null;
  userId: string;
  type: string;
  status: string;
  data: unknown;
  progress: unknown;
  error: string | null;
  bullJobId: string | null;
  processedOn: Date | null;
  finishedOn: Date | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DbJobStatus = JobState | 'unknown' | 'created' | 'canceled';

export interface JobEntity<TPublicProgress = JsonSafeObject> {
  bullJobId?: string | null;
  dbJobId?: string | null;
  workbookId?: string | null;
  state: DbJobStatus;
  type: string;
  progressTimestamp?: number;
  publicProgress?: TPublicProgress;
  processedOn?: Date | null;
  finishedOn?: Date | null;
  failedReason?: string | null;
}

export function dbJobToJobEntity(dbJob: DbJob): JobEntity {
  const progress = dbJob.progress as Progress;
  return {
    dbJobId: dbJob.id,
    bullJobId: dbJob.bullJobId,
    workbookId: dbJob.workbookId,
    type: dbJob.type,
    state: dbJob.status as DbJobStatus,
    progressTimestamp: progress?.timestamp,
    publicProgress: progress?.publicProgress,
    processedOn: dbJob.processedOn,
    finishedOn: dbJob.finishedOn,
    failedReason: dbJob.error,
  };
}
