export type PublishPlanPhase = 'asset-upload' | 'edit' | 'create' | 'delete' | 'backfill' | 'rename-files';

export interface PipelinePhase {
  type: PublishPlanPhase;
  recordCount: number;
  commitHash?: string;
}

export type PhaseCountMap = Partial<Record<PublishPlanPhase, number>>;

import { PublishPlanStatus } from '@spinner/shared-types';
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
}
