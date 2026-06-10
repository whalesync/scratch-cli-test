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
   * Exchange authorization code for access token
   */
  exchangeCodeForTokens(
    code: string,
    overrides?: {
      clientId?: string;
      clientSecret?: string;
      shopDomain?: string;
      codeVerifier?: string;
      dataCenter?: string;
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
