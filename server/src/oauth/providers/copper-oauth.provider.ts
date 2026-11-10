import { Injectable } from '@nestjs/common';
import axios, { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import {
  COPPER_OAUTH_AUTHORIZE_URL,
  COPPER_OAUTH_SCOPE,
  COPPER_OAUTH_TOKEN_URL,
} from '../../remote-service/connectors/library/copper/copper-types';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

const LOG_SOURCE = 'CopperOAuthProvider';

interface CopperTokenEndpointResponse {
  access_token?: string;
  token_type?: string;
  /** Copper answers a bad code with `invalid_grant` and a bad client with `invalid_client`. */
  error?: string;
  error_description?: string;
}

/**
 * Copper OAuth 2.0 (authorization code with PKCE), through Whalesync's Copper partner app.
 *
 * - One scope, `developer/v1/all`: the same access as an API key.
 * - The code exchange is a form-encoded POST carrying the client id and secret.
 * - Access tokens do not expire and Copper issues no refresh token, so no expiry is recorded and the host never
 *   refreshes; a connection only has to be reconnected if the user revokes the app.
 * - Copper's docs say it returns to the redirect URI with a form POST, but it sends a plain GET with `?code&state`, so
 *   Whalesync's callback forwards it like any other provider's.
 *
 * https://developer.copper.com/introduction/authentication.html
 */
@Injectable()
export class CopperOAuthProvider implements OAuthProvider {
  generateAuthUrl(state: string, credentials: OAuthAppCredentials, overrides?: { codeChallenge?: string }): string {
    const authorizeUrl = new URL(COPPER_OAUTH_AUTHORIZE_URL);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', credentials.clientId);
    authorizeUrl.searchParams.set('redirect_uri', credentials.redirectUri);
    authorizeUrl.searchParams.set('scope', COPPER_OAUTH_SCOPE);
    authorizeUrl.searchParams.set('state', state);
    if (overrides?.codeChallenge) {
      authorizeUrl.searchParams.set('code_challenge', overrides.codeChallenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    }
    return authorizeUrl.toString();
  }

  usesPkce(): boolean {
    return true;
  }

  async exchangeCodeForTokens(
    code: string,
    credentials: OAuthAppCredentials,
    overrides?: { codeVerifier?: string },
  ): Promise<OAuthTokenResponse> {
    const copperAccessToken = await this.requestAccessToken({
      grant_type: 'authorization_code',
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: credentials.redirectUri,
      ...(overrides?.codeVerifier ? { code_verifier: overrides.codeVerifier } : {}),
    });
    // No expires_in and no refresh_token: Copper's tokens last until the app is revoked.
    return { access_token: copperAccessToken };
  }

  /**
   * Never called for a Copper connection: its token has no recorded expiry, so the host doesn't refresh it, and there
   * is no refresh token to send. Fails clearly in case that ever changes.
   */
  refreshTokens(): Promise<OAuthTokenResponse> {
    return Promise.reject(
      new Error('Copper access tokens do not expire and cannot be refreshed. Reconnect Copper to sign in again.'),
    );
  }

  getServiceName(): string {
    return 'copper';
  }

  /**
   * POST a token request and return the access token, turning Copper's `{ error, error_description }` into a message
   * the user can act on.
   */
  private async requestAccessToken(formParameters: Record<string, string>): Promise<string> {
    let tokenEndpointResponse: CopperTokenEndpointResponse;
    try {
      const response = await axios.post<CopperTokenEndpointResponse>(
        COPPER_OAUTH_TOKEN_URL,
        new URLSearchParams(formParameters).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } },
      );
      tokenEndpointResponse = response.data;
    } catch (error) {
      tokenEndpointResponse = (isAxiosError(error) &&
        (error.response?.data as CopperTokenEndpointResponse | undefined)) || {
        error: error instanceof Error ? error.message : 'request failed',
      };
    }

    if (!tokenEndpointResponse.access_token) {
      const reason =
        tokenEndpointResponse.error_description ?? tokenEndpointResponse.error ?? 'no access_token in response';
      WSLogger.error({
        source: LOG_SOURCE,
        message: `Copper token request failed (${formParameters.grant_type}): ${reason}`,
      });
      throw new Error(`Copper authorization failed: ${reason}`);
    }
    return tokenEndpointResponse.access_token;
  }
}
