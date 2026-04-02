import { API_CONFIG } from './api';

export interface JobStatus {
  bullJobId?: string | null;
  dbJobId?: string | null;
  workbookId?: string | null;
  dataFolderId?: string | null;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' | 'unknown' | 'canceled' | 'created';
  type: string;
  progressTimestamp?: number;
  publicProgress?: object;
  processedOn?: string | Date | null;
  finishedOn?: string | Date | null;
  failedReason?: string | null;
  runContext?: {
    runId: string;
    trigger: 'web' | 'scheduler' | 'cli' | 'job';
    parentJobId?: string;
  } | null;
}

export const jobApi = {
  getJobsStatus: async (jobIds: string[]): Promise<JobStatus[]> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<JobStatus[]>('/jobs/bulk-status', { jobIds });
    return res.data;
  },
};
