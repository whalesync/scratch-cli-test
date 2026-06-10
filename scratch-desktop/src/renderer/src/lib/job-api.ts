import type { Job } from '@spinner/shared-types';
import { API_CONFIG } from './api';

// `Job` is the shared contract; `JobStatus` is kept as an alias so existing importers keep working.
export type JobStatus = Job;

export const jobApi = {
  getJobsStatus: async (jobIds: string[]): Promise<JobStatus[]> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<JobStatus[]>('/jobs/bulk-status', { jobIds });
    return res.data;
  },

  getActiveJobs: async (workbookId: string): Promise<JobStatus[]> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<JobStatus[]>(`/jobs/workbook/${workbookId}/active`);
    return res.data;
  },

  getJobRaw: async (jobId: string): Promise<unknown> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<unknown>(`/jobs/${jobId}/raw`);
    return res.data;
  },
};
