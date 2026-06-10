import type { GenericApiAiPromptResponse, ProbeEndpointResponse } from '@spinner/shared-types';
import { API_CONFIG } from './api';

export const genericApiApi = {
  getAiPrompt: async (apiType: 'rest' | 'graphql'): Promise<GenericApiAiPromptResponse> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<GenericApiAiPromptResponse>('/connectors/generic-api/ai-prompt', {
      params: { apiType },
    });
    return res.data;
  },

  probeEndpoint: async (
    workbookId: string,
    connectorAccountId: string,
    endpointId: string,
  ): Promise<ProbeEndpointResponse> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<ProbeEndpointResponse>(
      `/workbooks/${workbookId}/generic-api/${connectorAccountId}/probe-endpoint`,
      { endpointId },
    );
    return res.data;
  },
};
