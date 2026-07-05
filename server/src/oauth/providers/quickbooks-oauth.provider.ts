import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { OAuthAppCredentials } from '../oauth-app-version';
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
  private readonly scopes = 'com.intuit.quickbooks.accounting';

  generateAuthUrl(state: string, credentials: OAuthAppCredentials): string {
    const params = new URLSearchParams({
      client_id: credentials.clientId,
      scope: this.scopes,
      redirect_uri: credentials.redirectUri,
      response_type: 'code',
      state: state,
    });

    return `${QBO_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const basicAuth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');

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
        redirect_uri: credentials.redirectUri,
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

  async refreshTokens(refreshToken: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const basicAuth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');

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
}
