import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

const PIPEDRIVE_AUTH_URL = 'https://oauth.pipedrive.com/oauth/authorize';
const PIPEDRIVE_TOKEN_URL = 'https://oauth.pipedrive.com/oauth/token';

/**
 * Pipedrive OAuth 2.0 Provider
 *
 * Documentation:
 * - OAuth Flow: https://pipedrive.readme.io/docs/marketplace-oauth-authorization
 *
 * Key Points:
 * - Standard OAuth 2.0 Authorization Code flow.
 * - The authorize request takes NO `scope` param — scopes are configured on the
 *   app in the Pipedrive Developer Hub, not requested per-authorization.
 * - Access tokens expire after ~60 minutes; the service refreshes proactively
 *   with a 5-minute buffer (see OAuthService.isTokenExpired).
 * - Token endpoint uses Basic auth: Base64(clientId:clientSecret).
 * - Refresh tokens ROTATE: each refresh returns a new refresh token, so we return
 *   the new one (falling back to the old if Pipedrive ever omits it).
 * - Pipedrive returns `api_domain` in the token response, but the global
 *   `https://api.pipedrive.com` host works with company-scoped bearer tokens, so
 *   we don't persist it — the connector talks to the global host.
 * - A single Pipedrive app allows only one callback URL, which is why test and
 *   prod are separate apps (test = private, prod = public) with their own creds
 *   per env.
 */
@Injectable()
export class PipedriveOAuthProvider implements OAuthProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.get<string>('PIPEDRIVE_CLIENT_ID') || '';
    this.clientSecret = this.configService.get<string>('PIPEDRIVE_CLIENT_SECRET') || '';
    this.redirectUri = this.configService.get<string>('REDIRECT_URI') || '';
  }

  generateAuthUrl(_userId: string, state: string, overrides?: { clientId?: string }): string {
    const clientId = overrides?.clientId || this.clientId;

    // No `scope` param — Pipedrive derives scopes from the app's Developer Hub config.
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state: state,
    });

    return `${PIPEDRIVE_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    overrides?: { clientId?: string; clientSecret?: string; redirectUri?: string },
  ): Promise<OAuthTokenResponse> {
    const clientId = overrides?.clientId || this.clientId;
    const clientSecret = overrides?.clientSecret || this.clientSecret;
    // The token request's redirect_uri must match the URL the code was issued to.
    const redirectUri = overrides?.redirectUri || this.redirectUri;

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await axios.post<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
      api_domain?: string;
    }>(
      PIPEDRIVE_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      },
    );

    return {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in,
    };
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenResponse> {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await axios.post<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
      api_domain?: string;
    }>(
      PIPEDRIVE_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      },
    );

    return {
      access_token: response.data.access_token,
      // Pipedrive rotates the refresh token on each refresh; keep the new one,
      // falling back to the old if it's ever omitted.
      refresh_token: response.data.refresh_token || refreshToken,
      expires_in: response.data.expires_in,
    };
  }

  getServiceName(): string {
    return 'pipedrive';
  }

  getRedirectUri(): string {
    return this.redirectUri;
  }
}
