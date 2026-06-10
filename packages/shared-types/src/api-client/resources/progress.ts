import type { Job } from '../../db/job';
import type { Http } from '../http';

export function createProgressApi(http: Http) {
  return {
    getJobProgress: async <TPublicProgress extends object = object>(jobId: string): Promise<Job<TPublicProgress>> => {
      const res = await http.get<Job<TPublicProgress>>(`/jobs/${jobId}/progress`, {
        fallbackMessage: 'Failed to fetch job progress',
      });
      return res.data;
    },

    cancelJob: async (jobId: string): Promise<{ success: boolean; message: string }> => {
      const res = await http.post<{ success: boolean; message: string }>(`/jobs/${jobId}/cancel`, undefined, {
        fallbackMessage: 'Failed to cancel job',
      });
      return res.data;
    },
  };
}

export type ProgressApi = ReturnType<typeof createProgressApi>;
