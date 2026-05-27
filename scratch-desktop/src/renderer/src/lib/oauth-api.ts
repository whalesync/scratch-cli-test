import { OAuthInitiateOptionsDto } from '@spinner/shared-types';
import { API_CONFIG } from './api';

export interface OAuthInitiateResponse {
  authUrl: string;
}

export interface OAuthCallbackRequest {
  code: string;
  state: string;
  realmId?: string;
}

export interface OAuthCallbackResponse {
  connectorAccountId: string;
}

export const oAuthApi = {
  initiate: async (service: string, options: OAuthInitiateOptionsDto): Promise<OAuthInitiateResponse> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<OAuthInitiateResponse>(`/oauth/${service}/initiate`, options);
    return res.data;
  },

  callback: async (service: string, data: OAuthCallbackRequest): Promise<OAuthCallbackResponse> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<OAuthCallbackResponse>(`/oauth/${service}/callback`, data);
    return res.data;
  },
};
