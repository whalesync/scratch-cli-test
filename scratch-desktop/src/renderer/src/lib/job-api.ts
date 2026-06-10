import type { Job } from '@spinner/shared-types';
import { API_CONFIG } from './api';

export const jobApi = {
  getJobsStatus: async (jobIds: string[]): Promise<Job[]> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<Job[]>('/jobs/bulk-status', { jobIds });
    return res.data;
  },

  getActiveJobs: async (workbookId: string): Promise<Job[]> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<Job[]>(`/jobs/workbook/${workbookId}/active`);
    return res.data;
  },

  getJobRaw: async (jobId: string): Promise<unknown> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<unknown>(`/jobs/${jobId}/raw`);
    return res.data;
  },
};
