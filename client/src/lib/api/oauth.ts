import type {
  OAuthCallbackRequest,
  OAuthCallbackResponse,
  OAuthInitiateOptionsDto,
  OAuthInitiateResponse,
} from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const oAuthApi = {
  /**
   * Initiate OAuth flow for a service
   */
  initiate: async (service: string, options?: OAuthInitiateOptionsDto): Promise<OAuthInitiateResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<OAuthInitiateResponse>(`/oauth/${service}/initiate`, options);
      return res.data;
    } catch (error) {
      handleAxiosError(error, `Failed to initiate OAuth for ${service}`);
    }
  },

  /**
   * Handle OAuth callback and exchange code for tokens
   */
  callback: async (service: string, callbackData: OAuthCallbackRequest): Promise<OAuthCallbackResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<OAuthCallbackResponse>(`/oauth/${service}/callback`, callbackData);
      return res.data;
    } catch (error) {
      handleAxiosError(error, `Failed to handle OAuth callback for ${service}`);
    }
  },

  /**
   * Refresh OAuth tokens for a connector account
   */
  refresh: async (connectorAccountId: string): Promise<{ success: boolean }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ success: boolean }>('/oauth/refresh', { connectorAccountId });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to refresh OAuth tokens');
    }
  },
};
