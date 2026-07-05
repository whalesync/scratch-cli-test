import { Injectable } from '@nestjs/common';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

@Injectable()
export class YouTubeOAuthProvider implements OAuthProvider {
  generateAuthUrl(state: string, credentials: OAuthAppCredentials): string {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', credentials.clientId);
    authUrl.searchParams.set('redirect_uri', credentials.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.force-ssl');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    // Add parameters to help with channel selection
    authUrl.searchParams.set('include_granted_scopes', 'false');

    return authUrl.toString();
  }

  async exchangeCodeForTokens(code: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: credentials.redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code for tokens: ${error}`);
    }

    const tokenData = (await response.json()) as GoogleTokenResponse;

    // Map Google's response to our OAuthTokenResponse interface
    return {
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
      refresh_token: tokenData.refresh_token,
      // Google doesn't provide workspace_id, but we can use the user's Google ID
      workspace_id: tokenData.id_token ? this.extractUserIdFromIdToken(tokenData.id_token) : undefined,
    };
  }

  async refreshTokens(refreshToken: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to refresh tokens: ${error}`);
    }

    const tokenData = (await response.json()) as GoogleTokenResponse;

    // Map Google's response to our OAuthTokenResponse interface
    return {
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
      refresh_token: tokenData.refresh_token || refreshToken, // Google may not return a new refresh token
    };
  }

  getServiceName(): string {
    return 'youtube';
  }

  private extractUserIdFromIdToken(idToken: string): string | undefined {
    try {
      // Decode the JWT ID token to extract user ID
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString()) as Record<string, unknown>;
      const sub = payload.sub ?? payload.user_id;
      return typeof sub === 'string' ? sub : undefined;
    } catch {
      return undefined;
    }
  }
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
}
