import { GenericApiFolderOptions } from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export interface GenericApiAiPromptResponse {
  version: string;
  text: string;
}

export interface ProbeEndpointResponse {
  probe: GenericApiFolderOptions['probe'];
  recordsWalked: number;
  page1RecordCount: number;
  page2RecordCount: number;
  page2Status: 'ok' | 'no-pagination';
}

export interface ReprobeDiff {
  extractionIdPathChanged: boolean;
  paginationStrategyChanged: boolean;
  schemaFieldsAdded: string[];
  schemaFieldsRemoved: string[];
}

export interface ReprobeResponse {
  applied: boolean;
  diff: ReprobeDiff;
  newProbe: GenericApiFolderOptions['probe'];
}

export const genericApiApi = {
  getAiPrompt: async (apiType: 'rest' | 'graphql'): Promise<GenericApiAiPromptResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<GenericApiAiPromptResponse>('/connectors/generic-api/ai-prompt', {
        params: { apiType },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch AI prompt');
    }
  },

  probeEndpoint: async (
    workbookId: string,
    connectorAccountId: string,
    endpointId: string,
  ): Promise<ProbeEndpointResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<ProbeEndpointResponse>(
        `/workbooks/${workbookId}/generic-api/${connectorAccountId}/probe-endpoint`,
        { endpointId },
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to probe endpoint');
    }
  },

  reprobe: async (workbookId: string, dataFolderId: string): Promise<ReprobeResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<ReprobeResponse>(
        `/workbooks/${workbookId}/generic-api/data-folders/${dataFolderId}/reprobe`,
        {},
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to re-probe data folder');
    }
  },
};
