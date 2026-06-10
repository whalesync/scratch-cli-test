import { User } from '@/types/server-entities/users';
import type { UpdateSettingsDto } from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const usersApi = {
  activeUser: async (): Promise<User> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<User>('/users/current');
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch active user');
    }
  },

  updateSettings: async (dto: UpdateSettingsDto): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.patch('/users/current/settings', dto);
    } catch (error) {
      handleAxiosError(error, 'Failed to update user settings');
    }
  },

  generateApiToken: async (): Promise<{ apiToken: string }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ apiToken: string }>('/users/current/api-token');
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to generate API token');
    }
  },

  updateLastWorkbook: async (workbookId: string | null): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.patch('/users/current/last-workbook', { workbookId });
    } catch (error) {
      handleAxiosError(error, 'Failed to update last workbook');
    }
  },

  requestAccess: async (): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post('/users/current/request-access');
    } catch (error) {
      handleAxiosError(error, 'Failed to request access');
    }
  },
};
