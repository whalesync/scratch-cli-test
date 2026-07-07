import { Injectable } from '@nestjs/common';
import axios, { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import {
  normalizeZohoDataCenter,
  ZOHO_DATA_CENTER_HOSTS,
} from '../../remote-service/connectors/library/zoho/zoho-types';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

const LOG_SOURCE = 'ZohoOAuthProvider';

/**
 * Scopes the Zoho CRM connector needs — mirrors the user-provided "Self Client"
 * scopes (full module + settings + users + org read + bulk). Comma-separated per
 * Zoho's spec.
 */
const ZOHO_SCOPES = 'ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.users.ALL,ZohoCRM.org.READ,ZohoCRM.bulk.ALL';

interface ZohoOAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  api_domain?: string;
  error?: string;
}

/**
 * Zoho CRM OAuth 2.0 provider (multi-datacenter).
 *
 * Zoho is split across data centers (US/EU/IN/AU/JP/CA/CN/SA); the **authorize,
 * token, and refresh endpoints all live on that DC's accounts host**
 * (`accounts.zoho.com` / `.eu` / …). The user selects their DC in the connect
 * form (threaded here via `overrides.dataCenter` / `opts.dataCenter`, a
 * per-connection knob that isn't part of the app identity); the OAuthService
 * persists the DC so refreshes route to the correct host. `access_type=offline` + `prompt=consent`
 * are required for Zoho to return a refresh token.
 *
 * The CRM API host (`zohoapis.<dc>`) is derived from the DC by the connector,
 * not stored separately — the DC is the single source of truth for both the
 * accounts host and the API host.
 */
@Injectable()
export class ZohoOAuthProvider implements OAuthProvider {
  /** Accounts host (where authorize/token/refresh live) for the selected data center. */
  private accountsDomain(dataCenter?: string): string {
    return ZOHO_DATA_CENTER_HOSTS[normalizeZohoDataCenter(dataCenter)].accountsDomain;
  }

  generateAuthUrl(state: string, credentials: OAuthAppCredentials, overrides?: { dataCenter?: string }): string {
    const params = new URLSearchParams({
      client_id: credentials.clientId,
      scope: ZOHO_SCOPES,
      redirect_uri: credentials.redirectUri,
      response_type: 'code',
      // Required for Zoho to issue a refresh token (offline access) and to
      // re-consent so a refresh token is returned on every authorize.
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${this.accountsDomain(overrides?.dataCenter)}/oauth/v2/auth?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    credentials: OAuthAppCredentials,
    overrides?: { dataCenter?: string },
  ): Promise<OAuthTokenResponse> {
    return this.requestToken(overrides?.dataCenter, {
      grant_type: 'authorization_code',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: credentials.redirectUri,
      code,
    });
  }

  async refreshTokens(
    refreshToken: string,
    credentials: OAuthAppCredentials,
    opts?: { dataCenter?: string },
  ): Promise<OAuthTokenResponse> {
    // Zoho's refresh response does NOT return a new refresh token — the caller
    // keeps the existing one (OAuthService falls back to it when undefined).
    return this.requestToken(opts?.dataCenter, {
      grant_type: 'refresh_token',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: refreshToken,
    });
  }

  getServiceName(): string {
    return 'zoho';
  }

  /**
   * POST the token endpoint at the selected data center and normalize the
   * response. Zoho returns token errors as **HTTP 200 with `{error}`** (and
   * occasionally a 4xx), so both shapes are surfaced as a clear, user-facing
   * message instead of a bare 500. An `invalid_code` almost always means the
   * selected data center doesn't match the authorized account, so we say so.
   */
  private async requestToken(
    dataCenter: string | undefined,
    params: Record<string, string>,
  ): Promise<OAuthTokenResponse> {
    const dc = normalizeZohoDataCenter(dataCenter);
    let body: ZohoOAuthTokenResponse;
    try {
      const response = await axios.post<ZohoOAuthTokenResponse>(
        `${ZOHO_DATA_CENTER_HOSTS[dc].accountsDomain}/oauth/v2/token`,
        new URLSearchParams(params).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      body = response.data;
    } catch (error) {
      body =
        (isAxiosError(error) && (error.response?.data as ZohoOAuthTokenResponse)) ||
        ({ error: error instanceof Error ? error.message : 'request failed' } as ZohoOAuthTokenResponse);
    }

    if (!body.access_token) {
      const reason = body.error ?? 'no access_token in response';
      const hint =
        reason === 'invalid_code'
          ? ` — the selected Data Center (${dc}) likely doesn't match the Zoho account you authorized`
          : '';
      WSLogger.error({ source: LOG_SOURCE, message: `Zoho token request failed (DC=${dc}): ${reason}` });
      throw new Error(`Zoho authorization failed: ${reason}${hint}`);
    }

    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_in: body.expires_in,
    };
  }
}
