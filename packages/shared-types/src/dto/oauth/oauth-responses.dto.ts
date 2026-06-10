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
}

/** Response for `POST /oauth/:service/callback`. */
export interface OAuthCallbackResponse {
  connectorAccountId: string;
}
