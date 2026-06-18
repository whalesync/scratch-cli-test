import { RunContext } from '../../db/run-context';

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
    runContext?: RunContext | null;
  }[];
  total: number;
  limit: number;
  offset: number;
}
