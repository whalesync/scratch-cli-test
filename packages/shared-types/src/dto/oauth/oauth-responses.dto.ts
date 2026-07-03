/** Response for `POST /oauth/:service/initiate`. */
export interface OAuthInitiateResponse {
  authUrl: string;
  state: string;
}

/** Request body for `POST /oauth/:service/callback`. */
export interface OAuthCallbackRequest {
  code: string;
  state: string;
  realmId?: string;
  /**
   * Install-scoped identifier for `client_credentials` (2-legged) providers (Wix:
   * `instanceId`). Those flows return no authorization `code` — the external-install
   * redirect hands back this id, which the server mints the first access token from.
   */
  instanceId?: string;
}

/** Response for `POST /oauth/:service/callback`. */
export interface OAuthCallbackResponse {
  connectorAccountId: string;
}
