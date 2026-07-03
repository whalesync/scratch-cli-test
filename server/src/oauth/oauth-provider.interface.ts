/**
 * Which OAuth grant family a provider uses, so the orchestrator can branch on the
 * *strategy* rather than on a hardcoded service list.
 *
 * - `'authorization_code'` (default) — the classic 3-legged flow every existing
 *   provider implements: redirect for consent, receive a `code`, exchange it for
 *   an access + refresh token, and later refresh the access token.
 * - `'client_credentials'` — a 2-legged / server-to-server flow with NO
 *   authorization code and NO refresh token. The one long-lived credential is an
 *   install-scoped identifier (e.g. Wix's `instanceId`) captured on the external
 *   install redirect; a fresh access token is *minted on demand* from the app's
 *   `client_id`/`client_secret` + that identifier. "Refresh" = re-mint.
 *
 * A provider that omits `strategyKind()` is treated as `'authorization_code'`, so
 * this addition is invisible to every provider that predates it.
 */
export type OAuthStrategyKind = 'authorization_code' | 'client_credentials';

export interface OAuthProvider {
  /**
   * Generate OAuth authorization URL for the service.
   *
   * `dataCenter` is for multi-region providers (e.g. Zoho's US/EU/IN/… data
   * centers) whose authorize/token hosts differ per region; it's the analog of
   * Shopify's `shopDomain`, selected by the user in the connect form and threaded
   * through the OAuth state.
   *
   * For a `'client_credentials'` provider this URL is not an OAuth *authorize*
   * URL but the vendor's external *install* link (e.g. Wix's app-installer URL);
   * the redirect it lands on carries an install identifier, not a `code`.
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

  /**
   * Which OAuth grant family this provider uses. Optional: a provider that omits
   * it is treated as `'authorization_code'`, so existing providers are unaffected.
   * A `'client_credentials'` provider implements {@link mintTokenFromInstall}
   * instead of `exchangeCodeForTokens`/`refreshTokens` (those may throw).
   */
  strategyKind?(): OAuthStrategyKind;

  /**
   * Mint a fresh access token for a `'client_credentials'` (2-legged) provider.
   *
   * `installIdentifier` is the install-scoped id captured on the external-install
   * redirect (Wix: `instanceId`); the same id is stored on the connector account
   * (in `oauthWorkspaceId`) and passed back here whenever the token needs
   * re-minting. Implementations MUST return a concrete `expires_in` (the vendor
   * response often omits it) so the token's expiry can be tracked and it gets
   * re-minted before it goes stale.
   */
  mintTokenFromInstall?(installIdentifier: string): Promise<OAuthTokenResponse>;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  workspace_id?: string;
  workspace_name?: string;
  // Additional service-specific fields can be added here
}
