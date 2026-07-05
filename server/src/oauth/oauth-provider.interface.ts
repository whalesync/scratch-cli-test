import { OAuthAppCredentials } from './oauth-app-version';

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

/**
 * A per-service OAuth provider: pure HTTP mechanics for one external service's OAuth
 * endpoints. Providers hold NO credentials of their own — the caller resolves the
 * versioned {@link OAuthAppCredentials} (via OAuthAppCredentialResolver) and passes them
 * in, so which OAuth *app* is used is always an explicit, versioned decision made in one
 * place rather than each provider reaching into the environment.
 */
export interface OAuthProvider {
  /**
   * Generate the URL the user's browser is redirected to.
   *
   * Uses `credentials.clientId` and `credentials.redirectUri`. `overrides` carries the
   * per-connection knobs that aren't part of the app identity: `shopDomain` (Shopify),
   * `codeChallenge` (PKCE — Airtable), and `dataCenter` for multi-region providers
   * (Zoho's US/EU/IN/… hosts, the analog of Shopify's `shopDomain`).
   *
   * For a `'client_credentials'` provider this URL is not an OAuth *authorize* URL but
   * the vendor's external *install* link (e.g. Wix's app-installer URL); the redirect it
   * lands on carries an install identifier, not a `code`.
   */
  generateAuthUrl(
    state: string,
    credentials: OAuthAppCredentials,
    overrides?: { shopDomain?: string; codeChallenge?: string; dataCenter?: string },
  ): string;

  /**
   * Exchange an authorization code for access/refresh tokens using `credentials`.
   *
   * The token request's `redirect_uri` (for providers that send one) comes from
   * `credentials.redirectUri`, so the marketplace-initiated ("inbound") flow overrides
   * it by resolving credentials with the install endpoint as the redirect — providers
   * don't take a separate redirect override. Not used by `'client_credentials'`
   * providers (they have no code to exchange and may reject this).
   */
  exchangeCodeForTokens(
    code: string,
    credentials: OAuthAppCredentials,
    overrides?: { shopDomain?: string; codeVerifier?: string; dataCenter?: string },
  ): Promise<OAuthTokenResponse>;

  /**
   * Refresh an access token using the stored refresh token and `credentials`. The
   * credentials MUST be the ones that issued the refresh token (a refresh token from one
   * OAuth app cannot be refreshed with another app's client id/secret) — the caller
   * resolves them from the connection's stored {@link OAuthAppVersion}. `opts.dataCenter`
   * routes a multi-region provider's refresh to the correct regional host. Not used by
   * `'client_credentials'` providers (they re-mint via {@link mintTokenFromInstall}).
   */
  refreshTokens(
    refreshToken: string,
    credentials: OAuthAppCredentials,
    opts?: { dataCenter?: string },
  ): Promise<OAuthTokenResponse>;

  /**
   * Get the service name
   */
  getServiceName(): string;

  /**
   * Which OAuth grant family this provider uses. Optional: a provider that omits it is
   * treated as `'authorization_code'`, so existing providers are unaffected. A
   * `'client_credentials'` provider implements {@link mintTokenFromInstall} instead of
   * `exchangeCodeForTokens`/`refreshTokens` (those may throw).
   */
  strategyKind?(): OAuthStrategyKind;

  /**
   * Mint a fresh access token for a `'client_credentials'` (2-legged) provider, using
   * `credentials` — the app generation's client id/secret. Because the token is minted
   * from the app's own credentials plus the install identifier, the credentials MUST be
   * the ones the install was created under (a different app generation cannot mint for
   * another app's install), so the caller resolves them from the connection's stored
   * {@link OAuthAppVersion} exactly like the refresh path.
   *
   * `installIdentifier` is the install-scoped id captured on the external-install
   * redirect (Wix: `instanceId`); the same id is stored on the connector account (in
   * `oauthWorkspaceId`) and passed back here whenever the token needs re-minting.
   * Implementations MUST return a concrete `expires_in` (the vendor response often omits
   * it) so the token's expiry can be tracked and it gets re-minted before it goes stale.
   */
  mintTokenFromInstall?(installIdentifier: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse>;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  workspace_id?: string;
  workspace_name?: string;
  // Additional service-specific fields can be added here
}
