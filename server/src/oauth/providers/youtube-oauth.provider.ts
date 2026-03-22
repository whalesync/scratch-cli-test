import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

@Injectable()
export class YouTubeOAuthProvider implements OAuthProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.get<string>('GOOGLE_CLIENT_ID') || '';
    this.clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET') || '';
    this.redirectUri = this.configService.get<string>('REDIRECT_URI') || '';
  }

  generateAuthUrl(userId: string, state: string, overrides?: { clientId?: string }): string {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    const clientId = overrides?.clientId || this.clientId;
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', this.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.force-ssl');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    // Add parameters to help with channel selection
    authUrl.searchParams.set('include_granted_scopes', 'false');

    return authUrl.toString();
  }

  async exchangeCodeForTokens(
    code: string,
    overrides?: { clientId?: string; clientSecret?: string },
  ): Promise<OAuthTokenResponse> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: overrides?.clientId || this.clientId,
        client_secret: overrides?.clientSecret || this.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri,
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

  async refreshTokens(refreshToken: string): Promise<OAuthTokenResponse> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
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

  getRedirectUri(): string {
    return this.redirectUri;
  }

  getClientId(): string {
    return this.clientId;
  }

  getClientSecret(): string {
    return this.clientSecret;
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
