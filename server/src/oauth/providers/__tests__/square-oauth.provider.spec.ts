import axios, { AxiosError } from 'axios';
import { SQUARE_CONNECTOR_API_VERSION } from '../../../remote-service/connectors/library/square/square-api-client';
import { OAuthAppCredentials } from '../../oauth-app-version';
import {
  SQUARE_MAXIMUM_RECORDED_ACCESS_TOKEN_LIFETIME_SECONDS,
  SquareOAuthProvider,
  squareAccessTokenLifetimeSecondsToRecord,
} from '../square-oauth.provider';

const axiosPostSpy = jest.spyOn(axios, 'post');

const productionCredentials: OAuthAppCredentials = {
  clientId: 'sq0idp-production-app',
  clientSecret: 'sq0csp-production-secret',
  redirectUri: 'https://app.whalesync.com/oauth-callback/connector/square',
};

const sandboxCredentials: OAuthAppCredentials = {
  clientId: 'sandbox-sq0idb-sandbox-app',
  clientSecret: 'sandbox-sq0csb-sandbox-secret',
  redirectUri: 'https://test.whalesync.com/oauth-callback/connector/square',
};

const SECONDS_PER_DAY = 24 * 60 * 60;

const provider = new SquareOAuthProvider();

function postedUrl(callIndex = 0): string {
  return axiosPostSpy.mock.calls[callIndex][0];
}

function postedBody(callIndex = 0): unknown {
  return axiosPostSpy.mock.calls[callIndex][1];
}

function postedHeaders(callIndex = 0): Record<string, unknown> | undefined {
  return axiosPostSpy.mock.calls[callIndex][2]?.headers as Record<string, unknown> | undefined;
}

function squareRejection(status: number, data: unknown): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`), {
    response: { status, data, headers: {}, config: {}, statusText: '' },
  });
}

function isoStringInDays(days: number): string {
  return new Date(Date.now() + days * SECONDS_PER_DAY * 1000).toISOString();
}

describe('SquareOAuthProvider', () => {
  beforeEach(() => axiosPostSpy.mockReset());

  describe('generateAuthUrl', () => {
    it('signs in at the production host with every read scope, forcing a fresh login', () => {
      const authorizeUrl = new URL(provider.generateAuthUrl('STATE', productionCredentials));
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://connect.squareup.com/oauth2/authorize');
      expect(Object.fromEntries(authorizeUrl.searchParams)).toEqual({
        client_id: 'sq0idp-production-app',
        scope:
          'MERCHANT_PROFILE_READ CUSTOMERS_READ ITEMS_READ ORDERS_READ PAYMENTS_READ INVOICES_READ EMPLOYEES_READ ' +
          'PAYOUTS_READ GIFTCARDS_READ SUBSCRIPTIONS_READ',
        redirect_uri: 'https://app.whalesync.com/oauth-callback/connector/square',
        state: 'STATE',
        session: 'false',
      });
    });

    it('signs a sandbox app in at the sandbox host, where session has no effect', () => {
      const authorizeUrl = new URL(provider.generateAuthUrl('STATE', sandboxCredentials));
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://connect.squareupsandbox.com/oauth2/authorize');
      expect(authorizeUrl.searchParams.get('client_id')).toBe('sandbox-sq0idb-sandbox-app');
      expect(authorizeUrl.searchParams.has('session')).toBe(false);
    });

    it('uses no PKCE, since the code flow authenticates with the app secret', () => {
      expect('usesPkce' in provider).toBe(false);
    });
  });

  describe('exchangeCodeForTokens', () => {
    it("exchanges the code at the app's environment and records that environment as the workspace id", async () => {
      axiosPostSpy.mockResolvedValue({
        data: {
          access_token: 'square-access',
          token_type: 'bearer',
          expires_at: isoStringInDays(30),
          merchant_id: 'MERCHANT',
          refresh_token: 'square-refresh',
          short_lived: false,
        },
      });

      const tokens = await provider.exchangeCodeForTokens('CODE', sandboxCredentials);

      expect(postedUrl()).toBe('https://connect.squareupsandbox.com/oauth2/token');
      expect(postedBody()).toEqual({
        client_id: 'sandbox-sq0idb-sandbox-app',
        client_secret: 'sandbox-sq0csb-sandbox-secret',
        grant_type: 'authorization_code',
        code: 'CODE',
        redirect_uri: 'https://test.whalesync.com/oauth-callback/connector/square',
      });
      expect(postedHeaders()).toMatchObject({ 'Square-Version': SQUARE_CONNECTOR_API_VERSION });
      expect(tokens).toEqual({
        access_token: 'square-access',
        refresh_token: 'square-refresh',
        expires_in: SQUARE_MAXIMUM_RECORDED_ACCESS_TOKEN_LIFETIME_SECONDS,
        workspace_id: 'sandbox',
      });
    });

    it('records a production sign-in as production', async () => {
      axiosPostSpy.mockResolvedValue({
        data: { access_token: 'a', refresh_token: 'r', expires_at: isoStringInDays(30) },
      });

      const tokens = await provider.exchangeCodeForTokens('CODE', productionCredentials);

      expect(postedUrl()).toBe('https://connect.squareup.com/oauth2/token');
      expect(tokens.workspace_id).toBe('production');
    });

    it('refuses a response without a refresh token', async () => {
      axiosPostSpy.mockResolvedValue({ data: { access_token: 'a', expires_at: isoStringInDays(30) } });

      await expect(provider.exchangeCodeForTokens('CODE', productionCredentials)).rejects.toThrow(
        'no refresh token was issued',
      );
    });

    it("reports Square's error detail when the exchange is refused", async () => {
      axiosPostSpy.mockRejectedValue(
        squareRejection(401, {
          errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'Authorization code is expired' }],
        }),
      );

      await expect(provider.exchangeCodeForTokens('CODE', productionCredentials)).rejects.toThrow(
        'Square authorization failed: Authorization code is expired',
      );
    });

    it("reports the token endpoint's older { message, type } error form", async () => {
      axiosPostSpy.mockRejectedValue(
        squareRejection(401, { message: 'Not Authorized', type: 'service.not_authorized' }),
      );

      await expect(provider.exchangeCodeForTokens('CODE', productionCredentials)).rejects.toThrow(
        'Square authorization failed: Not Authorized',
      );
    });
  });

  describe('refreshTokens', () => {
    it("refreshes at the app's environment with the app secret", async () => {
      axiosPostSpy.mockResolvedValue({
        data: { access_token: 'square-access-2', refresh_token: 'square-refresh', expires_at: isoStringInDays(30) },
      });

      const tokens = await provider.refreshTokens('square-refresh', productionCredentials);

      expect(postedUrl()).toBe('https://connect.squareup.com/oauth2/token');
      expect(postedBody()).toEqual({
        client_id: 'sq0idp-production-app',
        client_secret: 'sq0csp-production-secret',
        grant_type: 'refresh_token',
        refresh_token: 'square-refresh',
      });
      expect(tokens).toEqual({
        access_token: 'square-access-2',
        refresh_token: 'square-refresh',
        expires_in: SQUARE_MAXIMUM_RECORDED_ACCESS_TOKEN_LIFETIME_SECONDS,
      });
    });

    it('fails with a readable reason when the seller has revoked the app', async () => {
      axiosPostSpy.mockRejectedValue(
        squareRejection(401, {
          errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'Refresh token is revoked' }],
        }),
      );

      await expect(provider.refreshTokens('square-refresh', sandboxCredentials)).rejects.toThrow(
        'Square authorization failed: Refresh token is revoked',
      );
      expect(postedUrl()).toBe('https://connect.squareupsandbox.com/oauth2/token');
    });
  });

  describe('squareAccessTokenLifetimeSecondsToRecord', () => {
    it("records Square's own expiry when it is under 7 days away", () => {
      const lifetimeSeconds = squareAccessTokenLifetimeSecondsToRecord(isoStringInDays(2));
      expect(lifetimeSeconds).toBeGreaterThan(2 * SECONDS_PER_DAY - 5);
      expect(lifetimeSeconds).toBeLessThanOrEqual(2 * SECONDS_PER_DAY);
    });

    it('caps a 30-day token at 7 days, so it refreshes on the schedule Square asks for', () => {
      expect(squareAccessTokenLifetimeSecondsToRecord(isoStringInDays(30))).toBe(7 * SECONDS_PER_DAY);
    });

    it('records 7 days when Square sends no usable expiry', () => {
      expect(squareAccessTokenLifetimeSecondsToRecord(undefined)).toBe(7 * SECONDS_PER_DAY);
      expect(squareAccessTokenLifetimeSecondsToRecord('not a date')).toBe(7 * SECONDS_PER_DAY);
    });

    it('never records a zero lifetime, which would mean the token never expires', () => {
      expect(squareAccessTokenLifetimeSecondsToRecord(isoStringInDays(-1))).toBe(1);
    });
  });
});
