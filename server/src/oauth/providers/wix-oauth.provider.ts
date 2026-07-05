import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthStrategyKind, OAuthTokenResponse } from '../oauth-provider.interface';

/**
 * Wix App OAuth Provider — server-to-server / OAuth Client Credentials.
 *
 * Replaces the deprecated Wix "Custom Authentication" 3-legged flow (redirect →
 * `?code` → refresh token). Wix retired custom authentication for new apps, which
 * broke the old app-initiated redirect; the current model is the OAuth Client
 * Credentials grant:
 *
 *   - There is NO authorization code and NO refresh token.
 *   - The one long-lived credential is the per-site **`instanceId`** (an "app
 *     instance"). We capture it from Wix's External Install Flow redirect.
 *   - A fresh access token is minted on demand from `client_id` + `client_secret`
 *     + `instance_id` at {@link tokenUrl}. Access tokens are valid 4 hours and the
 *     response carries no `expires_in`, so we supply it ourselves. "Refresh" is
 *     just a re-mint with the same `instance_id`.
 *
 * The `client_id`/`client_secret`/`redirect` come from the versioned
 * {@link OAuthAppCredentials} the orchestrator resolves and passes in — the same as
 * every other provider — so which Wix app is used is a versioned decision (see
 * OAuthAppCredentialResolver). `WIX_SHARE_URL_ID` (unlisted apps only) is read from
 * config: it is not a credential and is only consulted when building an install link
 * for the current app generation, so it need not be versioned.
 *
 * Connect UX (kept close to the previous app-initiated flow):
 *   1. {@link generateAuthUrl} builds Wix's app-installer URL, with our own OAuth
 *      `state` baked into the `postInstallationUrl` (the callback page).
 *   2. Wix runs the install/consent once, then redirects the browser back to our
 *      callback with `?state=<ours>&appId=&tenantId=&instanceId=` — no `code`.
 *   3. {@link OAuthService.handleOAuthCallback} sees a `client_credentials`
 *      provider and calls {@link mintTokenFromInstall} with that `instanceId`.
 *
 * Docs:
 * - About OAuth: https://dev.wix.com/docs/build-apps/develop-your-app/access/authentication/about-oauth
 * - Authenticate Using OAuth: https://dev.wix.com/docs/build-apps/develop-your-app/access/authentication/authenticate-using-oauth
 * - External Install Flow: https://dev.wix.com/docs/build-apps/launch-your-app/app-distribution/install-your-app/set-up-the-external-install-flow
 */
@Injectable()
export class WixOAuthProvider implements OAuthProvider {
  /** Only for *unlisted* apps — the GUID from the app dashboard's Share Install Link. */
  private readonly shareUrlId?: string;
  private readonly tokenUrl = 'https://www.wixapis.com/oauth2/token';
  /** Wix app access tokens are valid 4 hours; the token response has no expires_in. */
  private readonly accessTokenTtlSeconds = 4 * 60 * 60;

  constructor(private readonly configService: ConfigService) {
    this.shareUrlId = this.configService.get<string>('WIX_SHARE_URL_ID') || undefined;
  }

  strategyKind(): OAuthStrategyKind {
    return 'client_credentials';
  }

  /**
   * Build Wix's external app-installer URL. Our own OAuth `state` rides along as a
   * query param on the `postInstallationUrl` (the callback page) — Wix preserves
   * the query params we add and, after install, appends `appId`, `tenantId`, and
   * `instanceId` to it. `URL`/`URLSearchParams` handle the (correct) nested
   * encoding so `state` survives the round-trip intact.
   */
  generateAuthUrl(state: string, credentials: OAuthAppCredentials): string {
    const callbackUrl = new URL(credentials.redirectUri);
    callbackUrl.searchParams.set('state', state);

    const params = new URLSearchParams({
      appId: credentials.clientId,
      postInstallationUrl: callbackUrl.toString(),
    });
    // Unlisted apps must identify their share install link; listed apps omit it.
    if (this.shareUrlId) {
      params.set('shareUrlId', this.shareUrlId);
    }

    return `https://www.wix.com/app-installer?${params.toString()}`;
  }

  /**
   * Mint a fresh app access token from the install-scoped `instanceId`, using the
   * app generation's `credentials`.
   *
   *   POST https://www.wixapis.com/oauth2/token
   *   { grant_type: 'client_credentials', client_id, client_secret, instance_id }
   *   → { access_token }   // valid 4h; no expires_in, no refresh token
   */
  async mintTokenFromInstall(instanceId: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const response = await axios.post<{ access_token?: string }>(
      this.tokenUrl,
      {
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        instance_id: instanceId,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );

    if (!response.data.access_token) {
      throw new Error('Wix did not return an access token for the app instance');
    }

    return {
      access_token: response.data.access_token,
      // Wix omits expires_in; supply the documented 4h TTL so the token's expiry is
      // tracked and it is re-minted before it goes stale. Never leave this
      // undefined — an unset expiry makes the token look valid forever.
      expires_in: this.accessTokenTtlSeconds,
      // Persisted as the connector account's oauthWorkspaceId, then passed back to
      // mintTokenFromInstall on every re-mint.
      workspace_id: instanceId,
    };
  }

  /**
   * Not used by Wix's client-credentials flow — there is no authorization code to
   * exchange. Present only to satisfy the {@link OAuthProvider} interface.
   */
  exchangeCodeForTokens(): Promise<OAuthTokenResponse> {
    return Promise.reject(
      new Error(
        'Wix uses client-credentials OAuth; call mintTokenFromInstall(instanceId) instead of exchanging a code',
      ),
    );
  }

  /**
   * Not used by Wix's client-credentials flow — there is no refresh token. The
   * orchestrator re-mints via {@link mintTokenFromInstall} instead. Present only
   * to satisfy the {@link OAuthProvider} interface.
   */
  refreshTokens(): Promise<OAuthTokenResponse> {
    return Promise.reject(
      new Error(
        'Wix uses client-credentials OAuth; re-mint via mintTokenFromInstall(instanceId) instead of refreshing',
      ),
    );
  }

  getServiceName(): string {
    return 'wix';
  }
}
