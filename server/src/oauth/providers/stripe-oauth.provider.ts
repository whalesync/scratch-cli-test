import { Injectable } from '@nestjs/common';
import axios, { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { OAuthAppCredentials } from '../oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';

const LOG_SOURCE = 'StripeOAuthProvider';

/** The public sign-in link of a published Stripe app. Environments outside production override it (see below). */
export const STRIPE_PUBLIC_AUTHORIZE_URL = 'https://marketplace.stripe.com/oauth/v2/authorize';

const STRIPE_TOKEN_ENDPOINT_URL = 'https://api.stripe.com/v1/oauth/token';

/**
 * How long a Stripe app access token lives. Stripe documents an hour, but its token response carries no
 * `expires_in`, and a connection with no recorded expiry is never refreshed, so it would die an hour after sign-in.
 * https://docs.stripe.com/stripe-apps/api-authentication/oauth#refresh-access-token
 */
export const STRIPE_ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;

interface StripeTokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  /** The Stripe account the app was installed in (`acct_…`). */
  stripe_user_id?: string;
  livemode?: boolean;
  /**
   * An OAuth error code (`invalid_grant`, …), or — when the request itself is refused, e.g. a restricted or wrong-mode
   * secret key — Stripe's usual API error object.
   */
  error?: string | { message?: string; type?: string };
  error_description?: string;
}

/** The most useful human-readable reason in a failed token response. */
function describeStripeTokenEndpointFailure(tokenEndpointResponse: StripeTokenEndpointResponse): string {
  if (tokenEndpointResponse.error_description) {
    return tokenEndpointResponse.error_description;
  }
  const { error } = tokenEndpointResponse;
  if (typeof error === 'string') {
    return error;
  }
  return error?.message ?? error?.type ?? 'no access_token in response';
}

/**
 * OAuth 2.0 for a Stripe app (authorization code with PKCE), through Whalesync's Stripe app.
 *
 * Signing in installs the app in the person's Stripe account. It differs from a standard OAuth provider in three ways:
 * - The token endpoint authenticates with the secret key of the Stripe account that owns the app, sent as the HTTP
 *   Basic user name with no password (`credentials.clientSecret`). It refuses restricted keys.
 * - Its requests send only `grant_type` plus `code` / `refresh_token` (and `code_verifier`): the redirect URI and
 *   client id stay out, matching Whalesync's Stripe connector, which this app's token handling was proven against.
 * - Every refresh returns a new refresh token, and the old one stops working.
 *
 * The sign-in link is per environment: production uses the public link, test and local the app's External test link
 * (`credentials.authorizeUrl`), which pairs with the test-mode client id and `sk_test_…` key.
 */
@Injectable()
export class StripeOAuthProvider implements OAuthProvider {
  generateAuthUrl(state: string, credentials: OAuthAppCredentials, overrides?: { codeChallenge?: string }): string {
    const authorizeUrl = new URL(credentials.authorizeUrl ?? STRIPE_PUBLIC_AUTHORIZE_URL);
    authorizeUrl.searchParams.set('client_id', credentials.clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', credentials.redirectUri);
    authorizeUrl.searchParams.set('state', state);
    if (overrides?.codeChallenge) {
      authorizeUrl.searchParams.set('code_challenge', overrides.codeChallenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    }
    return authorizeUrl.toString();
  }

  /** Stripe honors a `code_challenge` on the sign-in link, and then refuses a code exchanged without its verifier. */
  usesPkce(): boolean {
    return true;
  }

  async exchangeCodeForTokens(
    code: string,
    credentials: OAuthAppCredentials,
    overrides?: { codeVerifier?: string },
  ): Promise<OAuthTokenResponse> {
    const tokenResponse = await this.requestToken(credentials, {
      grant_type: 'authorization_code',
      code,
      ...(overrides?.codeVerifier ? { code_verifier: overrides.codeVerifier } : {}),
    });
    if (!tokenResponse.refresh_token) {
      throw new Error('Stripe authorization failed: no refresh token was issued.');
    }
    return {
      access_token: tokenResponse.accessToken,
      refresh_token: tokenResponse.refresh_token,
      expires_in: STRIPE_ACCESS_TOKEN_LIFETIME_SECONDS,
      workspace_id: tokenResponse.stripe_user_id,
    };
  }

  async refreshTokens(refreshToken: string, credentials: OAuthAppCredentials): Promise<OAuthTokenResponse> {
    const tokenResponse = await this.requestToken(credentials, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    return {
      access_token: tokenResponse.accessToken,
      refresh_token: tokenResponse.refresh_token,
      expires_in: STRIPE_ACCESS_TOKEN_LIFETIME_SECONDS,
    };
  }

  getServiceName(): string {
    return 'stripe';
  }

  /**
   * POST a token request and return the response, turning a failure (see {@link describeStripeTokenEndpointFailure})
   * into a message the user can act on.
   */
  private async requestToken(
    credentials: OAuthAppCredentials,
    formParameters: Record<string, string>,
  ): Promise<StripeTokenEndpointResponse & { accessToken: string }> {
    const appOwnerSecretKeyAsBasicAuthUserName = Buffer.from(`${credentials.clientSecret}:`).toString('base64');
    let tokenEndpointResponse: StripeTokenEndpointResponse;
    try {
      const response = await axios.post<StripeTokenEndpointResponse>(
        STRIPE_TOKEN_ENDPOINT_URL,
        new URLSearchParams(formParameters).toString(),
        {
          headers: {
            Authorization: `Basic ${appOwnerSecretKeyAsBasicAuthUserName}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        },
      );
      tokenEndpointResponse = response.data;
    } catch (error) {
      tokenEndpointResponse = (isAxiosError(error) &&
        (error.response?.data as StripeTokenEndpointResponse | undefined)) || {
        error: error instanceof Error ? error.message : 'request failed',
      };
    }

    if (!tokenEndpointResponse.access_token) {
      const reason = describeStripeTokenEndpointFailure(tokenEndpointResponse);
      WSLogger.error({
        source: LOG_SOURCE,
        message: `Stripe token request failed (${formParameters.grant_type}): ${reason}`,
      });
      throw new Error(`Stripe authorization failed: ${reason}`);
    }
    return { ...tokenEndpointResponse, accessToken: tokenEndpointResponse.access_token };
  }
}
