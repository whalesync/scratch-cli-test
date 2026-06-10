import { Job } from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const jobApi = {
  getJobs: async (
    limit?: number,
    offset?: number,
    workbookId?: string,
    filter?: { type?: string; syncId?: string; dataFolderId?: string },
  ): Promise<Job[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Job[]>('/jobs', {
        params: {
          limit,
          offset,
          workbookId,
          type: filter?.type,
          syncId: filter?.syncId,
          dataFolderId: filter?.dataFolderId,
        },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch jobs');
      return [];
    }
  },

  getJobsStatus: async (jobIds: string[]): Promise<Job[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<Job[]>('/jobs/bulk-status', { jobIds });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch bulk job status');
      return [];
    }
  },

  getActiveJobsByWorkbook: async (workbookId: string): Promise<Job[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Job[]>(`/jobs/workbook/${workbookId}/active`);
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

  getJobsByRunId: async (runId: string): Promise<Job[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Job[]>(`/jobs/run/${runId}`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch jobs for run');
      return [];
    }
  },
};
