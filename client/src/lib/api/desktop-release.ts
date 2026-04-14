import type { DesktopReleaseResponse } from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const desktopReleaseApi = {
  getLatest: async (): Promise<DesktopReleaseResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<DesktopReleaseResponse>('/desktop-release/latest');
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch latest desktop release');
    }
  },
};
