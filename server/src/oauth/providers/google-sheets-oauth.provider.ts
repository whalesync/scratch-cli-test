import { Injectable } from '@nestjs/common';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

/**
 * The ONLY scope we request — deliberately matching the Whalesync Google Sheets app
 * exactly (the OAuth client is shared, and its consent screen is verified for this
 * scope). `spreadsheets` grants read/write access to any spreadsheet the user can
 * access **by id** and allows creating new spreadsheets — but includes NO Drive
 * access, so the connector cannot browse/list the user's existing spreadsheets
 * (users paste a spreadsheet URL instead) and cannot delete spreadsheet files.
 * Do not add scopes here without also updating the Google Cloud consent screen.
 */
const GOOGLE_SHEETS_OAUTH_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * Standard Google authorization-code OAuth for the Google Sheets connector (same
 * endpoints as the YouTube provider — Google OAuth is per-scope, not per-product).
 */
@Injectable()
export class GoogleSheetsOAuthProvider implements OAuthProvider {
  generateAuthUrl(state: string, credentials: OAuthAppCredentials): string {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', credentials.clientId);
    authUrl.searchParams.set('redirect_uri', credentials.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GOOGLE_SHEETS_OAUTH_SCOPE);
    authUrl.searchParams.set('state', state);
    // Google only issues a refresh token for offline access, and only re-issues one
    // when consent is re-prompted — both required for reconnect to keep working.
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('include_granted_scopes', 'false');
    return authUrl.toString();
  }

  async exchangeCodeForTokens(code: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: credentials.redirectUri,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to exchange code for tokens: ${errorBody}`);
    }

    const tokenData = (await response.json()) as GoogleTokenResponse;
    return {
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
      refresh_token: tokenData.refresh_token,
    };
  }

  async refreshTokens(refreshToken: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to refresh tokens: ${errorBody}`);
    }

    const tokenData = (await response.json()) as GoogleTokenResponse;
    return {
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
      // Google typically omits the refresh token from refresh responses — keep the old one.
      refresh_token: tokenData.refresh_token || refreshToken,
    };
  }

  getServiceName(): string {
    return 'google-sheets';
  }
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}
