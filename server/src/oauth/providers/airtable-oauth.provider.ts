import { Injectable } from '@nestjs/common';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

@Injectable()
export class AirtableOAuthProvider implements OAuthProvider {
  generateAuthUrl(state: string, credentials: OAuthAppCredentials, overrides?: { codeChallenge?: string }): string {
    const authUrl = new URL('https://airtable.com/oauth2/v1/authorize');
    authUrl.searchParams.set('client_id', credentials.clientId);
    authUrl.searchParams.set('redirect_uri', credentials.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);
    // `schema.bases:write` is required to create tables/fields (the sync-draft
    // materialize flow). Existing connections authorized before this scope was
    // added must reconnect to grant it — Airtable freezes scopes at token grant.
    authUrl.searchParams.set('scope', 'data.records:read data.records:write schema.bases:read schema.bases:write');

    if (overrides?.codeChallenge) {
      authUrl.searchParams.set('code_challenge', overrides.codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
    }

    return authUrl.toString();
  }

  async exchangeCodeForTokens(
    code: string,
    credentials: OAuthAppCredentials,
    overrides?: { codeVerifier?: string },
  ): Promise<OAuthTokenResponse> {
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: credentials.redirectUri,
      client_id: credentials.clientId,
    };

    if (overrides?.codeVerifier) {
      params.code_verifier = overrides.codeVerifier;
    }

    const encodedCredentials = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');

    const response = await fetch('https://airtable.com/oauth2/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${encodedCredentials}`,
      },
      body: new URLSearchParams(params),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code for tokens: ${error}`);
    }

    return response.json() as Promise<OAuthTokenResponse>;
  }

  async refreshTokens(refreshToken: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const encodedCredentials = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');

    const response = await fetch('https://airtable.com/oauth2/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${encodedCredentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: credentials.clientId,
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
}
