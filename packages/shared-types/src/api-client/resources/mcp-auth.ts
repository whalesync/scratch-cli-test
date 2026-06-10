import type { Http } from '../http';

export interface McpApproveResponse {
  redirect_uri: string;
}

export function createMcpAuthApi(http: Http) {
  return {
    /**
     * Approve MCP OAuth authorization. Called from the consent page after the user clicks "Authorize".
     * Returns the redirect URI to send the user back to Claude with the authorization code.
     */
    approveMcpAuthorization: async (state: string): Promise<McpApproveResponse> => {
      const res = await http.post<McpApproveResponse>('/mcp-auth/approve', { state });
      return res.data;
    },
  };
}

export type McpAuthApi = ReturnType<typeof createMcpAuthApi>;
