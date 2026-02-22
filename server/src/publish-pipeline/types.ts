export type PublishPlanPhase = 'edit' | 'create' | 'delete' | 'backfill';

export interface PipelinePhase {
  type: PublishPlanPhase;
  recordCount: number;
  commitHash?: string;
}

export interface PublishPlanInfo {
  pipelineId: string;
  workbookId: string;
  userId: string;
  phases: PipelinePhase[];
  branchName: string;
  createdAt: Date;
  status: string;
  successCount?: number;
  failedCount?: number;
}
