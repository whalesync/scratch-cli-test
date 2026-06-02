import { Workspace } from '../types/workspace';
import { API_CONFIG } from './api';

export const workspacesApi = {
  list: async (): Promise<Workspace[]> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<Workspace[]>('/workbook', {
      params: { sortBy: 'updatedAt', sortOrder: 'desc' },
    });
    return res.data;
  },

  detail: async (id: string): Promise<Workspace> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<Workspace>(`/workbook/${id}`);
    return res.data;
  },

  pullFiles: async (
    id: string,
    dataFolderIds?: string[],
    mode?: 'full' | 'incremental',
  ): Promise<{ jobId?: string; jobIds?: string[]; warning?: string }> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<{ jobId?: string; jobIds?: string[]; warning?: string }>(
      `/workbook/${id}/pull-files`,
      {
        dataFolderIds,
        mode,
      },
    );
    return res.data;
  },
};
