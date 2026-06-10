import { Job } from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const progressApi = {
  getJobProgress: async <TPublicProgress extends object = object>(jobId: string): Promise<Job<TPublicProgress>> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Job<TPublicProgress>>(`/jobs/${jobId}/progress`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch job progress');
    }
  },

  cancelJob: async (jobId: string): Promise<{ success: boolean; message: string }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ success: boolean; message: string }>(`/jobs/${jobId}/cancel`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to cancel job');
    }
  },
};
