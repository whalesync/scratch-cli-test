import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

@Injectable()
export class AirtableOAuthProvider implements OAuthProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.get<string>('AIRTABLE_CLIENT_ID') || '';
    this.clientSecret = this.configService.get<string>('AIRTABLE_CLIENT_SECRET') || '';
    this.redirectUri = this.configService.get<string>('REDIRECT_URI') || '';
  }

  generateAuthUrl(userId: string, state: string): string {
    const authUrl = new URL('https://airtable.com/oauth2/v1/authorize');
    authUrl.searchParams.set('client_id', this.clientId);
    authUrl.searchParams.set('redirect_uri', this.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('scope', 'data.records:read data.records:write schema.bases:read');

    return authUrl.toString();
  }

  async exchangeCodeForTokens(code: string): Promise<OAuthTokenResponse> {
    const response = await fetch('https://airtable.com/oauth2/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code for tokens: ${error}`);
    }

    return response.json() as Promise<OAuthTokenResponse>;
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenResponse> {
    const response = await fetch('https://airtable.com/oauth2/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to refresh tokens: ${error}`);
    }

    return response.json() as Promise<OAuthTokenResponse>;
  }

  getServiceName(): string {
    return 'airtable';
  }

  getRedirectUri(): string {
    return this.redirectUri;
  }
}
