import type {
  GenericApiAiPromptResponse,
  ProbeEndpointResponse,
  ReprobeResponse,
} from '../../dto/generic-api/generic-api-responses.dto';
import type { Http } from '../http';

/**
 * Generic-API connector operations — the AI prompt helper, endpoint probing, and data-folder
 * re-probing. `getAiPrompt` and `probeEndpoint` are shared by the web client and the desktop app
 * (identical route, body, and response). `reprobe` is WEB-ONLY — the desktop module does not expose
 * it. Reached as `client.generic.*`.
 */
export function createGenericApi(http: Http) {
  return {
    getAiPrompt: async (apiType: 'rest' | 'graphql'): Promise<GenericApiAiPromptResponse> => {
      const res = await http.get<GenericApiAiPromptResponse>('/connectors/generic-api/ai-prompt', {
        params: { apiType },
        fallbackMessage: 'Failed to fetch AI prompt',
      });
      return res.data;
    },

    probeEndpoint: async (
      workbookId: string,
      connectorAccountId: string,
      endpointId: string,
    ): Promise<ProbeEndpointResponse> => {
      const res = await http.post<ProbeEndpointResponse>(
        `/workbooks/${workbookId}/generic-api/${connectorAccountId}/probe-endpoint`,
        { endpointId },
        { fallbackMessage: 'Failed to probe endpoint' },
      );
      return res.data;
    },

    /** WEB-ONLY: re-probe a data folder. The desktop generic-api module does not expose this. */
    reprobe: async (workbookId: string, dataFolderId: string): Promise<ReprobeResponse> => {
      const res = await http.post<ReprobeResponse>(
        `/workbooks/${workbookId}/generic-api/data-folders/${dataFolderId}/reprobe`,
        {},
        { fallbackMessage: 'Failed to re-probe data folder' },
      );
      return res.data;
    },
  };
}

export type GenericApi = ReturnType<typeof createGenericApi>;
