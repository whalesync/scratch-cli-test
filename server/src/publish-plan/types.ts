export type PublishPlanPhase = 'asset-upload' | 'edit' | 'create' | 'delete' | 'backfill' | 'rename-files';

/**
 * Phases whose operations carry a sparse `changedFields` partial that the connector
 * PATCHes. Other phases (create/delete/rename/asset-upload) never use changedFields.
 * Used to discriminate plan-operation types so missing changedFields is a compile-time error.
 */
export type PhaseRequiringChangedFields = Extract<PublishPlanPhase, 'edit' | 'backfill'>;

export interface PipelinePhase {
  type: PublishPlanPhase;
  recordCount: number;
  commitHash?: string;
}

export type PhaseCountMap = Partial<Record<PublishPlanPhase, number>>;

import { PublishPlanStatus, type PublishFailedOperation } from '@spinner/shared-types';
export { PublishPlanStatus };

export interface PublishPlanInfo {
  pipelineId: string;
  workbookId: string;
  userId: string;
  branchName: string;
  createdAt: Date;
  status: PublishPlanStatus;
  successCount?: number;
  failedCount?: number;
  successByPhase?: PhaseCountMap;
  totalByPhase?: PhaseCountMap;
  /**
   * Bounded sample of the run's per-record connector rejections (rows left
   * `failed-batch`). `failedCount` remains the authoritative total; this only
   * carries the inline detail the run-job surfaces on its terminal progress.
   * Capped server-side so the job-progress payload stays bounded.
   */
  failedOperations?: PublishFailedOperation[];
}
