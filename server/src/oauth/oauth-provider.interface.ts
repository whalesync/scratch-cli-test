export interface OAuthProvider {
  /**
   * Generate OAuth authorization URL for the service.
   *
   * `dataCenter` is for multi-region providers (e.g. Zoho's US/EU/IN/… data
   * centers) whose authorize/token hosts differ per region; it's the analog of
   * Shopify's `shopDomain`, selected by the user in the connect form and threaded
   * through the OAuth state.
   */
  generateAuthUrl(
    userId: string,
    state: string,
    overrides?: { clientId?: string; shopDomain?: string; codeChallenge?: string; dataCenter?: string },
  ): string;

  /**
   * Exchange authorization code for access token.
   *
   * `redirectUri` overrides the provider's default redirect URI for this one
   * exchange. Needed by the marketplace-initiated ("inbound") flow, whose code is
   * bound to the install endpoint (`/oauth/install/:service`) rather than the
   * app-initiated callback — the token request's `redirect_uri` must match the URL
   * the code was issued to. Ignored by providers that don't send `redirect_uri`.
   */
  exchangeCodeForTokens(
    code: string,
    overrides?: {
      clientId?: string;
      clientSecret?: string;
      shopDomain?: string;
      codeVerifier?: string;
      dataCenter?: string;
      redirectUri?: string;
    },
  ): Promise<OAuthTokenResponse>;

  /**
   * Refresh access token using refresh token. `opts.dataCenter` lets a
   * multi-region provider route the refresh to the correct regional host.
   */
  refreshTokens(refreshToken: string, opts?: { dataCenter?: string }): Promise<OAuthTokenResponse>;

  /**
   * Get the service name
   */
  getServiceName(): string;

  /**
   * Get the OAuth redirect URI for this service
   */
  getRedirectUri(): string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  workspace_id?: string;
  workspace_name?: string;
  // Additional service-specific fields can be added here
}
