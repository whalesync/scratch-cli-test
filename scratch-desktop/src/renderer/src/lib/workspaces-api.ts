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
};
