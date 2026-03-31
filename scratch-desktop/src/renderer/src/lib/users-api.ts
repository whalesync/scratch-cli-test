import { User } from '../types/user';
import { API_CONFIG } from './api';

export const usersApi = {
  currentUser: async (): Promise<User> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<User>('/users/current');
    return res.data;
  },

  updateSettings: async (updates: Record<string, string | number | boolean | null>): Promise<void> => {
    const axios = API_CONFIG.getAxiosInstance();
    await axios.patch('/users/current/settings', { updates });
  },
};
