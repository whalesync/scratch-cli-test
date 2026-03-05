import { JobEntity } from '../../types/server-entities/job';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const jobApi = {
  getJobs: async (limit?: number, offset?: number, workbookId?: string): Promise<JobEntity[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<JobEntity[]>('/jobs', {
        params: { limit, offset, workbookId },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch jobs');
      return [];
    }
  },

  getJobsStatus: async (jobIds: string[]): Promise<JobEntity[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<JobEntity[]>('/jobs/bulk-status', { jobIds });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch bulk job status');
      return [];
    }
  },

  getActiveJobsByWorkbook: async (workbookId: string): Promise<JobEntity[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<JobEntity[]>(`/jobs/workbook/${workbookId}/active`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch active jobs for workspace');
      return [];
    }
  },

  getJobRaw: async (jobId: string): Promise<object> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<object>(`/jobs/${jobId}/raw`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch raw job data');
      throw error;
    }
  },

  cancelJob: async (jobId: string): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post(`/jobs/${jobId}/cancel`);
    } catch (error) {
      handleAxiosError(error, 'Failed to cancel job');
      throw error;
    }
  },

  getJobsByRunId: async (runId: string): Promise<JobEntity[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<JobEntity[]>(`/jobs/run/${runId}`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch jobs for run');
      return [];
    }
  },
};
