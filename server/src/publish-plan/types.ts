export type PublishPlanPhase = 'edit' | 'create' | 'delete' | 'backfill' | 'rename-files';

export interface PipelinePhase {
  type: PublishPlanPhase;
  recordCount: number;
  commitHash?: string;
}

export type PhaseCountMap = Partial<Record<PublishPlanPhase, number>>;

export interface PublishPlanInfo {
  pipelineId: string;
  workbookId: string;
  userId: string;
  branchName: string;
  createdAt: Date;
  status: string;
  successCount?: number;
  failedCount?: number;
  successByPhase?: PhaseCountMap;
  totalByPhase?: PhaseCountMap;
}
