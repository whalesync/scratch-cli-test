import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { isAxiosError } from 'axios';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

/**
 * Webflow OAuth 2.0 Provider
 *
 * Documentation:
 * - OAuth Flow: https://developers.webflow.com/data/reference/oauth-app
 *
 * Key Points:
 * - Webflow access tokens are long-lived and the standard flow returns no
 *   refresh token, so there is no refresh flow to implement.
 * - Authorize endpoint: https://webflow.com/oauth/authorize (browser redirect)
 * - Token exchange endpoint: https://api.webflow.com/oauth/access_token
 *
 * Previously this provider delegated to the `webflow-api` SDK's
 * `WebflowClient.authorizeURL` / `WebflowClient.getAccessToken` helpers. Those
 * are reimplemented here with a hand-built URL + axios so the connector no
 * longer needs the SDK (DEV-9754). The request shapes below mirror the SDK's
 * helpers exactly (param order, space-joined scopes, JSON body with
 * `grant_type=authorization_code`).
 */

/**
 * The Webflow OAuth scopes this app requests, inlined as a string-literal union
 * so we no longer depend on the SDK's `OauthScope` type. Mirrors the values the
 * SDK exposed for the CMS/pages/sites access we use.
 */
type WebflowOauthScope =
  | 'authorized_user:read'
  | 'cms:read'
  | 'cms:write'
  | 'pages:read'
  | 'pages:write'
  | 'sites:read'
  | 'sites:write';

@Injectable()
export class WebflowOAuthProvider implements OAuthProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.get<string>('WEBFLOW_CLIENT_ID') || '';
    this.clientSecret = this.configService.get<string>('WEBFLOW_CLIENT_SECRET') || '';
    this.redirectUri = this.configService.get<string>('REDIRECT_URI') || '';
  }

  generateAuthUrl(userId: string, state: string): string {
    // Scopes needed for CMS access.
    const requestedScopes: WebflowOauthScope[] = [
      'authorized_user:read',
      'cms:read',
      'cms:write',
      'pages:read',
      'pages:write',
      'sites:read',
      'sites:write',
    ];

    // Build the query in the same order the SDK's `WebflowClient.authorizeURL`
    // emitted it (response_type, client_id, redirect_uri, state, scope) and
    // encode values with `encodeURIComponent` so spaces become `%20` —
    // byte-identical to the SDK's `qs.stringify` output.
    const queryParameters: Array<[string, string]> = [
      ['response_type', 'code'],
      ['client_id', this.clientId],
      ['redirect_uri', this.redirectUri],
      ['state', state],
      ['scope', requestedScopes.join(' ')],
    ];
    const queryString = queryParameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');

    return `https://webflow.com/oauth/authorize?${queryString}`;
  }

  async exchangeCodeForTokens(code: string): Promise<OAuthTokenResponse> {
    try {
      const response = await axios.post<{ access_token: string }>(
        'https://api.webflow.com/oauth/access_token',
        {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: this.redirectUri,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      // Webflow doesn't provide refresh tokens in the standard OAuth flow; the
      // access token is long-lived.
      return {
        access_token: response.data.access_token,
        refresh_token: undefined,
        expires_in: undefined,
      };
    } catch (error) {
      // Surface the server's response body when present (axios omits it from
      // `error.message`) so token-exchange failures are debuggable.
      if (isAxiosError(error) && error.response) {
        throw new Error(
          `Failed to exchange code for tokens: ${error.response.status} ${JSON.stringify(error.response.data)}`,
        );
      }
      throw new Error(`Failed to exchange code for tokens: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  refreshTokens(): Promise<OAuthTokenResponse> {
    // Webflow doesn't support token refresh in the standard way
    // Access tokens are long-lived and don't expire
    throw new Error('Webflow does not support token refresh. Access tokens are long-lived.');
  }

  getServiceName(): string {
    return 'webflow';
  }

  getRedirectUri(): string {
    return this.redirectUri;
  }
}
