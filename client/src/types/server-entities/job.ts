export interface RunContext {
  runId: string;
  trigger: 'web' | 'scheduler' | 'cli' | 'job';
  parentJobId?: string;
}

export interface JobEntity<TPublicProgress = object> {
  bullJobId?: string | null;
  dbJobId?: string | null;
  workbookId?: string | null;
  dataFolderId?: string | null;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' | 'unknown' | 'canceled' | 'pending';
  type: string;
  progressTimestamp?: number;
  publicProgress?: TPublicProgress;
  processedOn?: Date | null;
  finishedOn?: Date | null;
  failedReason?: string | null;
  runContext?: RunContext | null;
}
