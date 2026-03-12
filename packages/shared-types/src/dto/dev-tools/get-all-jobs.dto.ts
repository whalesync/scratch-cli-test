export interface JobRunContext {
  runId: string;
  trigger: 'web' | 'scheduler' | 'cli' | 'job';
  parentJobId?: string; // The DBJob ID of the job that triggered this job
}

export interface GetAllJobsResponseDto {
  jobs: {
    dbJobId: string;
    bullJobId?: string | null;
    runId?: string | null;
    workbookId?: string | null;
    dataFolderId?: string | null;
    userId: string;
    type: string;
    state: string;
    publicProgress?: Record<string, unknown>;
    processedOn?: string | null;
    finishedOn?: string | null;
    createdAt: string;
    failedReason?: string | null;
    runContext?: JobRunContext | null;
  }[];
  total: number;
  limit: number;
  offset: number;
}
