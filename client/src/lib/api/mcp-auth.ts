import { API_CONFIG } from './config';

export interface McpApproveResponse {
  redirect_uri: string;
}

/**
 * Approve MCP OAuth authorization. Called from the consent page after the user clicks "Authorize".
 * Returns the redirect URI to send the user back to Claude with the authorization code.
 */
export async function approveMcpAuthorization(state: string): Promise<McpApproveResponse> {
  const response = await API_CONFIG.getAxiosInstance().post<McpApproveResponse>('/mcp-auth/approve', { state });
  return response.data;
}
