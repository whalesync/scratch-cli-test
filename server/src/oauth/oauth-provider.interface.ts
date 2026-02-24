export interface OAuthProvider {
  /**
   * Generate OAuth authorization URL for the service
   */
  generateAuthUrl(
    userId: string,
    state: string,
    overrides?: { clientId?: string; shopDomain?: string; codeChallenge?: string },
  ): string;

  /**
   * Exchange authorization code for access token
   */
  exchangeCodeForTokens(
    code: string,
    overrides?: { clientId?: string; clientSecret?: string; shopDomain?: string; codeVerifier?: string },
  ): Promise<OAuthTokenResponse>;

  /**
   * Refresh access token using refresh token
   */
  refreshTokens(refreshToken: string): Promise<OAuthTokenResponse>;

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
