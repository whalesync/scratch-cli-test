import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

/**
 * QuickBooks Online OAuth 2.0 Provider
 *
 * Documentation:
 * - OAuth Flow: https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
 *
 * Key Points:
 * - Uses standard OAuth 2.0 Authorization Code flow
 * - Access tokens expire after 1 hour (3600 seconds)
 * - Refresh tokens are valid for 100 days on a rolling basis
 * - Token endpoint uses Basic auth: Base64(clientId:clientSecret)
 * - The `realmId` (company ID) is returned as a query parameter on the OAuth callback,
 *   and is stored in the state payload so it's available during token exchange
 * - Scope: com.intuit.quickbooks.accounting for read access to all accounting data
 */
@Injectable()
export class QuickBooksOAuthProvider implements OAuthProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly scopes = 'com.intuit.quickbooks.accounting';

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.get<string>('QUICKBOOKS_CLIENT_ID') || '';
    this.clientSecret = this.configService.get<string>('QUICKBOOKS_CLIENT_SECRET') || '';
    this.redirectUri = this.configService.get<string>('REDIRECT_URI') || '';
  }

  generateAuthUrl(userId: string, state: string, overrides?: { clientId?: string }): string {
    const clientId = overrides?.clientId || this.clientId;

    const params = new URLSearchParams({
      client_id: clientId,
      scope: this.scopes,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state: state,
    });

    return `${QBO_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    overrides?: { clientId?: string; clientSecret?: string },
  ): Promise<OAuthTokenResponse> {
    const clientId = overrides?.clientId || this.clientId;
    const clientSecret = overrides?.clientSecret || this.clientSecret;

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await axios.post<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      x_refresh_token_expires_in: number;
      token_type: string;
    }>(
      QBO_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: this.redirectUri,
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
      // realmId is captured from the callback query params and stored in extras,
      // not via workspace_id. See oauth.service.ts handleOAuthCallback for QuickBooks handling.
    };
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenResponse> {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await axios.post<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      x_refresh_token_expires_in: number;
      token_type: string;
    }>(
      QBO_TOKEN_URL,
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
      refresh_token: response.data.refresh_token || refreshToken,
      expires_in: response.data.expires_in,
    };
  }

  getServiceName(): string {
    return 'quickbooks';
  }

  getRedirectUri(): string {
    return this.redirectUri;
  }
}
