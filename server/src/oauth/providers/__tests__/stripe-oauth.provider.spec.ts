import axios, { AxiosError } from 'axios';
import { OAuthAppCredentials } from '../../oauth-app-version';
import {
  STRIPE_ACCESS_TOKEN_LIFETIME_SECONDS,
  STRIPE_PUBLIC_AUTHORIZE_URL,
  StripeOAuthProvider,
} from '../stripe-oauth.provider';

const axiosPostSpy = jest.spyOn(axios, 'post');

const productionCredentials: OAuthAppCredentials = {
  clientId: 'ca_live_client',
  clientSecret: 'sk_live_app_owner',
  redirectUri: 'https://app.whalesync.com/oauth-callback/connector/stripe',
};

const EXTERNAL_TEST_AUTHORIZE_URL = 'https://marketplace.stripe.com/oauth/v2/chnlink_test/authorize';

const testEnvironmentCredentials: OAuthAppCredentials = {
  clientId: 'ca_test_client',
  clientSecret: 'sk_test_app_owner',
  redirectUri: 'https://test.whalesync.com/oauth-callback/connector/stripe',
  authorizeUrl: EXTERNAL_TEST_AUTHORIZE_URL,
};

const provider = new StripeOAuthProvider();

function postedUrl(callIndex = 0): string {
  return axiosPostSpy.mock.calls[callIndex][0];
}

function postedForm(callIndex = 0): URLSearchParams {
  return new URLSearchParams(String(axiosPostSpy.mock.calls[callIndex][1]));
}

function postedAuthorizationHeader(callIndex = 0): unknown {
  const requestConfig = axiosPostSpy.mock.calls[callIndex][2];
  return (requestConfig?.headers as Record<string, unknown> | undefined)?.Authorization;
}

function stripeRejection(status: number, data: unknown): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`), {
    response: { status, data, headers: {}, config: {}, statusText: '' },
  });
}

describe('StripeOAuthProvider', () => {
  beforeEach(() => axiosPostSpy.mockReset());

  describe('generateAuthUrl', () => {
    it('signs in at the public link with PKCE in production', () => {
      const authorizeUrl = new URL(
        provider.generateAuthUrl('STATE', productionCredentials, { codeChallenge: 'CHALLENGE' }),
      );
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(STRIPE_PUBLIC_AUTHORIZE_URL);
      expect(Object.fromEntries(authorizeUrl.searchParams)).toEqual({
        client_id: 'ca_live_client',
        response_type: 'code',
        redirect_uri: 'https://app.whalesync.com/oauth-callback/connector/stripe',
        state: 'STATE',
        code_challenge: 'CHALLENGE',
        code_challenge_method: 'S256',
      });
      expect(provider.usesPkce()).toBe(true);
    });

    it("signs in at the environment's own link when one is configured (the External test link)", () => {
      const authorizeUrl = new URL(provider.generateAuthUrl('STATE', testEnvironmentCredentials));
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(EXTERNAL_TEST_AUTHORIZE_URL);
      expect(authorizeUrl.searchParams.get('client_id')).toBe('ca_test_client');
    });
  });

  describe('exchangeCodeForTokens', () => {
    it("exchanges the code with the app owner's secret key and keeps the installing account as the workspace id", async () => {
      axiosPostSpy.mockResolvedValue({
        data: {
          access_token: 'stripe-access',
          refresh_token: 'stripe-refresh',
          livemode: true,
          scope: 'stripe_apps',
          stripe_publishable_key: 'pk_live_x',
          stripe_user_id: 'acct_installer',
          token_type: 'bearer',
        },
      });

      const tokens = await provider.exchangeCodeForTokens('ac_CODE', productionCredentials, {
        codeVerifier: 'VERIFIER',
      });

      expect(tokens).toEqual({
        access_token: 'stripe-access',
        refresh_token: 'stripe-refresh',
        expires_in: STRIPE_ACCESS_TOKEN_LIFETIME_SECONDS,
        workspace_id: 'acct_installer',
      });
      expect(postedUrl()).toBe('https://api.stripe.com/v1/oauth/token');
      expect(postedAuthorizationHeader()).toBe(`Basic ${Buffer.from('sk_live_app_owner:').toString('base64')}`);
      // Only what Stripe expects: its API refuses parameters it doesn't know.
      expect(Object.fromEntries(postedForm())).toEqual({
        grant_type: 'authorization_code',
        code: 'ac_CODE',
        code_verifier: 'VERIFIER',
      });
    });

    it('leaves the verifier out when the sign-in carried no challenge', async () => {
      axiosPostSpy.mockResolvedValue({ data: { access_token: 'a', refresh_token: 'r', stripe_user_id: 'acct_x' } });
      await provider.exchangeCodeForTokens('ac_CODE', productionCredentials);
      expect(Object.fromEntries(postedForm())).toEqual({ grant_type: 'authorization_code', code: 'ac_CODE' });
    });

    it("explains Stripe's OAuth rejection", async () => {
      axiosPostSpy.mockRejectedValue(
        stripeRejection(400, { error: 'invalid_grant', error_description: 'Authorization code expired: ac_CODE.' }),
      );
      await expect(provider.exchangeCodeForTokens('ac_CODE', productionCredentials)).rejects.toThrow(
        'Stripe authorization failed: Authorization code expired: ac_CODE.',
      );
    });

    it('explains a refused secret key, which Stripe reports as an API error object', async () => {
      axiosPostSpy.mockRejectedValue(
        stripeRejection(401, {
          error: { message: 'Invalid API Key provided: sk_live_****ner', type: 'invalid_request_error' },
        }),
      );
      await expect(provider.exchangeCodeForTokens('ac_CODE', productionCredentials)).rejects.toThrow(
        'Stripe authorization failed: Invalid API Key provided: sk_live_****ner',
      );
    });

    it('refuses a grant without a refresh token, which would die with the first access token', async () => {
      axiosPostSpy.mockResolvedValue({ data: { access_token: 'a', stripe_user_id: 'acct_x' } });
      await expect(provider.exchangeCodeForTokens('ac_CODE', productionCredentials)).rejects.toThrow(
        /no refresh token was issued/,
      );
    });
  });

  describe('refreshTokens', () => {
    it('refreshes with the rotated refresh token and records the hour Stripe gives the new access token', async () => {
      axiosPostSpy.mockResolvedValue({
        data: { access_token: 'fresh-access', refresh_token: 'rotated-refresh', stripe_user_id: 'acct_installer' },
      });

      const tokens = await provider.refreshTokens('stripe-refresh', testEnvironmentCredentials);

      expect(tokens).toEqual({
        access_token: 'fresh-access',
        refresh_token: 'rotated-refresh',
        expires_in: STRIPE_ACCESS_TOKEN_LIFETIME_SECONDS,
      });
      expect(postedUrl()).toBe('https://api.stripe.com/v1/oauth/token');
      expect(postedAuthorizationHeader()).toBe(`Basic ${Buffer.from('sk_test_app_owner:').toString('base64')}`);
      expect(Object.fromEntries(postedForm())).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'stripe-refresh',
      });
    });

    it('surfaces a refresh token Stripe no longer honors', async () => {
      axiosPostSpy.mockRejectedValue(
        stripeRejection(400, { error: 'invalid_grant', error_description: 'Refresh token is invalid.' }),
      );
      await expect(provider.refreshTokens('stale-refresh', productionCredentials)).rejects.toThrow(
        'Stripe authorization failed: Refresh token is invalid.',
      );
    });
  });
});
