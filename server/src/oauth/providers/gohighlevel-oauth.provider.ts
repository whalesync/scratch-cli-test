import { Injectable } from '@nestjs/common';
import axios, { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

const LOG_SOURCE = 'GoHighLevelOAuthProvider';

/**
 * Consent screen. `chooselocation` forces a **Location-level** install, so the
 * token we get back is already scoped to a single sub-account and carries its
 * `locationId` — no agency->location exchange needed (that path stays deferred).
 */
const GOHIGHLEVEL_CHOOSE_LOCATION_URL = 'https://marketplace.gohighlevel.com/oauth/chooselocation';

/**
 * Token + refresh endpoint. Same v2 API host the connector uses for REST calls
 * (`services.leadconnectorhq.com`) — only the consent screen lives on the
 * marketplace host above.
 */
const GOHIGHLEVEL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';

/**
 * Scopes requested for full-CRUD parity with the Private Integration Token
 * connector (contacts/opportunities/custom-objects read+write, custom-field +
 * users read). Space-separated per GHL's spec.
 *
 * IMPORTANT: these must be a subset of the scopes enabled on the GHL Marketplace
 * app itself — the app config is the source of truth. If GHL rejects the
 * authorize request, reconcile this list against the app's "Scopes" tab. The
 * `users.readonly` scope is included so the inbound flow can later resolve the
 * installing user's email (see inbound-oauth-plan.md).
 */
const GOHIGHLEVEL_SCOPES = [
  'contacts.readonly',
  'contacts.write',
  'opportunities.readonly',
  'opportunities.write',
  'objects/schema.readonly',
  'objects/record.readonly',
  'objects/record.write',
  'locations/customFields.readonly',
  'locations/customFields.write',
  'locations/customValues.readonly',
  'users.readonly',
].join(' ');

/**
 * HighLevel token responses always identify the installed sub-account via
 * `locationId` (Location-level install). We surface that as `workspace_id` so
 * the OAuthService persists it (in `oauthWorkspaceId`) and the connector can read
 * it back at instantiation time — HighLevel REST calls are all Location-scoped.
 */
interface GoHighLevelOAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  locationId?: string;
  companyId?: string;
  userType?: string;
  error?: string;
  error_description?: string;
  message?: string;
}

/**
 * HighLevel (GoHighLevel) OAuth 2.0 provider.
 *
 * Auth-code flow against a Marketplace app: the user consents on the marketplace
 * `chooselocation` screen, picks one sub-account, and we exchange the returned
 * code for a Location-scoped access/refresh token at the v2 API host. Access
 * tokens are short-lived (~24h) so `refreshTokens` matters — it's wired into the
 * standard `oauthExpiresAt` refresh path.
 *
 * Distinct from the connector's existing Private Integration Token auth, which is
 * a long-lived bearer token the user pastes in by hand.
 */
@Injectable()
export class GoHighLevelOAuthProvider implements OAuthProvider {
  generateAuthUrl(state: string, credentials: OAuthAppCredentials): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: credentials.clientId,
      redirect_uri: credentials.redirectUri,
      scope: GOHIGHLEVEL_SCOPES,
      state,
    });
    return `${GOHIGHLEVEL_CHOOSE_LOCATION_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    return this.requestToken({
      grant_type: 'authorization_code',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      // Location-level install: the token (and its locationId) is scoped to the
      // single sub-account the user picked on the chooselocation screen.
      user_type: 'Location',
      // The token request's redirect_uri must match the URL the code was issued to.
      // App-initiated uses the app's REDIRECT_URI; the inbound install flow resolves
      // credentials with the install endpoint URL as the redirect.
      redirect_uri: credentials.redirectUri,
    });
  }

  async refreshTokens(refreshToken: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    return this.requestToken({
      grant_type: 'refresh_token',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: refreshToken,
      user_type: 'Location',
    });
  }

  getServiceName(): string {
    return 'gohighlevel';
  }

  /**
   * POST the form-encoded token endpoint and normalize the response. GHL returns
   * errors as a 4xx with `{error, error_description}` (or a bare `{message}`), so
   * both shapes are surfaced as a clear, user-facing message instead of a 500.
   */
  private async requestToken(params: Record<string, string>): Promise<OAuthTokenResponse> {
    let body: GoHighLevelOAuthTokenResponse;
    try {
      const response = await axios.post<GoHighLevelOAuthTokenResponse>(
        GOHIGHLEVEL_TOKEN_URL,
        new URLSearchParams(params).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } },
      );
      body = response.data;
    } catch (error) {
      body =
        (isAxiosError(error) && (error.response?.data as GoHighLevelOAuthTokenResponse)) ||
        ({ error: error instanceof Error ? error.message : 'request failed' } as GoHighLevelOAuthTokenResponse);
    }

    if (!body.access_token) {
      const reason = body.error_description ?? body.error ?? body.message ?? 'no access_token in response';
      WSLogger.error({ source: LOG_SOURCE, message: `HighLevel token request failed: ${reason}` });
      throw new Error(`HighLevel authorization failed: ${reason}`);
    }

    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_in: body.expires_in,
      // Persisted as oauthWorkspaceId; the connector reads it back as the Location ID.
      workspace_id: body.locationId,
    };
  }
}
