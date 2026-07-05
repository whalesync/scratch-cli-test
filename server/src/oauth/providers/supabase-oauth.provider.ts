import { Injectable } from '@nestjs/common';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

@Injectable()
export class SupabaseOAuthProvider implements OAuthProvider {
  generateAuthUrl(state: string, credentials: OAuthAppCredentials): string {
    const authUrl = new URL('https://api.supabase.com/v1/oauth/authorize');
    authUrl.searchParams.set('client_id', credentials.clientId);
    authUrl.searchParams.set('redirect_uri', credentials.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);

    return authUrl.toString();
  }

  async exchangeCodeForTokens(code: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    // Supabase requires application/x-www-form-urlencoded (not JSON)
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: credentials.redirectUri,
    });

    const response = await fetch('https://api.supabase.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code for Supabase tokens: ${error}`);
    }

    return response.json() as Promise<OAuthTokenResponse>;
  }

  async refreshTokens(refreshToken: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await fetch('https://api.supabase.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to refresh Supabase tokens: ${error}`);
    }

    return response.json() as Promise<OAuthTokenResponse>;
  }

  getServiceName(): string {
    return 'supabase';
  }
}
