import { Injectable } from '@nestjs/common';
import axios, { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import {
  parseSalesforceInstanceUrl,
  SALESFORCE_PRODUCTION_LOGIN_HOST,
  salesforceLoginHost,
} from '../../remote-service/connectors/library/salesforce/salesforce-types';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

const LOG_SOURCE = 'SalesforceOAuthProvider';

/**
 * How long a Salesforce access token is treated as valid.
 *
 * Salesforce's token response has no `expires_in`: a token lives as long as the org's session timeout, which an
 * admin can set anywhere from 15 minutes to 24 hours (2 hours by default). Assuming the shortest setting means the
 * host refreshes before any org's token lapses — a few refreshes an hour while a job runs, against a 401 mid-job
 * for orgs with short sessions.
 */
export const SALESFORCE_ASSUMED_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;

interface SalesforceTokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  error?: string;
  error_description?: string;
}

/**
 * Salesforce OAuth 2.0 (web server flow with PKCE).
 *
 * Sign-in and code exchange happen at login.salesforce.com, or test.salesforce.com for a sandbox; the connect
 * form's "Sandbox org" box only picks between those two hosts, never supplies one. The token response names the
 * org's own API host (`instance_url`, its My Domain), which is returned as `workspace_id` so the host persists it
 * in `oauthWorkspaceId`. The connector sends API calls there, and refreshes go there too — a My Domain's token
 * endpoint serves production and sandbox orgs alike, so refreshing needs no sandbox flag. (A reconnect does: the host
 * records the connect-time choice in the connection's extras and reuses it.)
 */
@Injectable()
export class SalesforceOAuthProvider implements OAuthProvider {
  generateAuthUrl(
    state: string,
    credentials: OAuthAppCredentials,
    overrides?: { codeChallenge?: string; sandbox?: boolean },
  ): string {
    const authorizeUrl = new URL(
      `https://${salesforceLoginHost(overrides?.sandbox === true)}/services/oauth2/authorize`,
    );
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', credentials.clientId);
    authorizeUrl.searchParams.set('redirect_uri', credentials.redirectUri);
    authorizeUrl.searchParams.set('state', state);
    // Always show the approval screen, so reconnecting re-grants the app's scopes.
    authorizeUrl.searchParams.set('prompt', 'consent');
    if (overrides?.codeChallenge) {
      authorizeUrl.searchParams.set('code_challenge', overrides.codeChallenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    }
    return authorizeUrl.toString();
  }

  usesPkce(): boolean {
    return true;
  }

  async exchangeCodeForTokens(
    code: string,
    credentials: OAuthAppCredentials,
    overrides?: { codeVerifier?: string; sandbox?: boolean },
  ): Promise<OAuthTokenResponse> {
    const tokenEndpointUrl = `https://${salesforceLoginHost(overrides?.sandbox === true)}/services/oauth2/token`;
    const tokenResponse = await this.requestToken(tokenEndpointUrl, {
      grant_type: 'authorization_code',
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: credentials.redirectUri,
      ...(overrides?.codeVerifier ? { code_verifier: overrides.codeVerifier } : {}),
    });
    if (!tokenResponse.refresh_token) {
      throw new Error(
        'Salesforce authorization failed: no refresh token was issued. The connected app must include the ' +
          '"Perform requests at any time (refresh_token, offline_access)" scope.',
      );
    }
    return {
      access_token: tokenResponse.accessToken,
      refresh_token: tokenResponse.refresh_token,
      expires_in: SALESFORCE_ASSUMED_ACCESS_TOKEN_LIFETIME_SECONDS,
      workspace_id: parseSalesforceInstanceUrl(tokenResponse.instance_url),
    };
  }

  /**
   * Refresh at the org's own instance (`opts.dataCenter` carries the stored `oauthWorkspaceId`, the instance URL
   * saved at connect time). A connection with no stored instance falls back to the production login host.
   */
  async refreshTokens(
    refreshToken: string,
    credentials: OAuthAppCredentials,
    opts?: { dataCenter?: string },
  ): Promise<OAuthTokenResponse> {
    const tokenHostOrigin = opts?.dataCenter
      ? parseSalesforceInstanceUrl(opts.dataCenter)
      : `https://${SALESFORCE_PRODUCTION_LOGIN_HOST}`;
    const tokenResponse = await this.requestToken(`${tokenHostOrigin}/services/oauth2/token`, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });
    return {
      access_token: tokenResponse.accessToken,
      // Present only when the connected app rotates refresh tokens; otherwise the stored one stays valid.
      refresh_token: tokenResponse.refresh_token,
      expires_in: SALESFORCE_ASSUMED_ACCESS_TOKEN_LIFETIME_SECONDS,
    };
  }

  getServiceName(): string {
    return 'salesforce';
  }

  /**
   * POST a token request and return the response, turning Salesforce's `{ error, error_description }` (sent with
   * HTTP 400) into a message the user can act on.
   */
  private async requestToken(
    tokenEndpointUrl: string,
    formParameters: Record<string, string>,
  ): Promise<SalesforceTokenEndpointResponse & { accessToken: string }> {
    let tokenEndpointResponse: SalesforceTokenEndpointResponse;
    try {
      const response = await axios.post<SalesforceTokenEndpointResponse>(
        tokenEndpointUrl,
        new URLSearchParams(formParameters).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } },
      );
      tokenEndpointResponse = response.data;
    } catch (error) {
      tokenEndpointResponse = (isAxiosError(error) &&
        (error.response?.data as SalesforceTokenEndpointResponse | undefined)) || {
        error: error instanceof Error ? error.message : 'request failed',
      };
    }

    if (!tokenEndpointResponse.access_token) {
      const reason =
        tokenEndpointResponse.error_description ?? tokenEndpointResponse.error ?? 'no access_token in response';
      WSLogger.error({
        source: LOG_SOURCE,
        message: `Salesforce token request failed (${formParameters.grant_type}): ${reason}`,
      });
      throw new Error(`Salesforce authorization failed: ${reason}`);
    }
    return { ...tokenEndpointResponse, accessToken: tokenEndpointResponse.access_token };
  }
}
