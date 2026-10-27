import axios, { AxiosError } from 'axios';
import { OAuthAppCredentials } from '../../oauth-app-version';
import {
  SALESFORCE_ASSUMED_ACCESS_TOKEN_LIFETIME_SECONDS,
  SalesforceOAuthProvider,
} from '../salesforce-oauth.provider';

const axiosPostSpy = jest.spyOn(axios, 'post');

const credentials: OAuthAppCredentials = {
  clientId: '3MVG9-client',
  clientSecret: 'client-secret',
  redirectUri: 'https://app.whalesync.com/oauth-callback/connector/salesforce',
};

const provider = new SalesforceOAuthProvider();

function postedUrl(callIndex = 0): string {
  return axiosPostSpy.mock.calls[callIndex][0];
}

function postedForm(callIndex = 0): URLSearchParams {
  return new URLSearchParams(String(axiosPostSpy.mock.calls[callIndex][1]));
}

describe('SalesforceOAuthProvider', () => {
  beforeEach(() => axiosPostSpy.mockReset());

  describe('generateAuthUrl', () => {
    it('authorizes at login.salesforce.com with PKCE and a consent prompt', () => {
      const authorizeUrl = new URL(provider.generateAuthUrl('STATE', credentials, { codeChallenge: 'CHALLENGE' }));
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
        'https://login.salesforce.com/services/oauth2/authorize',
      );
      expect(Object.fromEntries(authorizeUrl.searchParams)).toEqual({
        response_type: 'code',
        client_id: '3MVG9-client',
        redirect_uri: 'https://app.whalesync.com/oauth-callback/connector/salesforce',
        state: 'STATE',
        prompt: 'consent',
        code_challenge: 'CHALLENGE',
        code_challenge_method: 'S256',
      });
      expect(provider.usesPkce()).toBe(true);
    });

    it('authorizes a sandbox at test.salesforce.com', () => {
      const authorizeUrl = new URL(provider.generateAuthUrl('STATE', credentials, { sandbox: true }));
      expect(authorizeUrl.host).toBe('test.salesforce.com');
    });
  });

  describe('exchangeCodeForTokens', () => {
    it("exchanges the code at the login host and keeps the org's instance URL as the workspace id", async () => {
      axiosPostSpy.mockResolvedValue({
        data: {
          access_token: '00D!access',
          refresh_token: '5Aep-refresh',
          instance_url: 'https://acme.my.salesforce.com',
          id: 'https://login.salesforce.com/id/00D/005',
          issued_at: '1793102730293',
        },
      });

      const tokens = await provider.exchangeCodeForTokens('CODE', credentials, { codeVerifier: 'VERIFIER' });

      expect(tokens).toEqual({
        access_token: '00D!access',
        refresh_token: '5Aep-refresh',
        expires_in: SALESFORCE_ASSUMED_ACCESS_TOKEN_LIFETIME_SECONDS,
        workspace_id: 'https://acme.my.salesforce.com',
      });
      expect(postedUrl()).toBe('https://login.salesforce.com/services/oauth2/token');
      expect(Object.fromEntries(postedForm())).toEqual({
        grant_type: 'authorization_code',
        code: 'CODE',
        client_id: '3MVG9-client',
        client_secret: 'client-secret',
        redirect_uri: 'https://app.whalesync.com/oauth-callback/connector/salesforce',
        code_verifier: 'VERIFIER',
      });
    });

    it('exchanges a sandbox code at test.salesforce.com', async () => {
      axiosPostSpy.mockResolvedValue({
        data: { access_token: 'a', refresh_token: 'r', instance_url: 'https://acme--uat.sandbox.my.salesforce.com' },
      });
      const tokens = await provider.exchangeCodeForTokens('CODE', credentials, { sandbox: true });
      expect(postedUrl()).toBe('https://test.salesforce.com/services/oauth2/token');
      expect(tokens.workspace_id).toBe('https://acme--uat.sandbox.my.salesforce.com');
    });

    it("explains Salesforce's own rejection", async () => {
      axiosPostSpy.mockRejectedValue(
        Object.assign(new AxiosError('Request failed with status code 400'), {
          response: {
            status: 400,
            data: { error: 'invalid_grant', error_description: 'authentication failure' },
            headers: {},
            config: {},
            statusText: '',
          },
        }),
      );
      await expect(provider.exchangeCodeForTokens('CODE', credentials)).rejects.toThrow(
        'Salesforce authorization failed: authentication failure',
      );
    });

    it('refuses a grant without a refresh token, which would die with the first access token', async () => {
      axiosPostSpy.mockResolvedValue({
        data: { access_token: 'a', instance_url: 'https://acme.my.salesforce.com' },
      });
      await expect(provider.exchangeCodeForTokens('CODE', credentials)).rejects.toThrow(/no refresh token was issued/);
    });

    it('refuses an instance URL that is not a bare https origin', async () => {
      axiosPostSpy.mockResolvedValue({
        data: { access_token: 'a', refresh_token: 'r', instance_url: 'http://acme.my.salesforce.com' },
      });
      await expect(provider.exchangeCodeForTokens('CODE', credentials)).rejects.toThrow(/unexpected instance URL/);
    });
  });

  describe('refreshTokens', () => {
    it("refreshes at the org's stored instance URL", async () => {
      axiosPostSpy.mockResolvedValue({
        data: { access_token: 'fresh', instance_url: 'https://acme.my.salesforce.com' },
      });
      const tokens = await provider.refreshTokens('5Aep-refresh', credentials, {
        dataCenter: 'https://acme.my.salesforce.com',
      });
      expect(tokens).toEqual({
        access_token: 'fresh',
        refresh_token: undefined,
        expires_in: SALESFORCE_ASSUMED_ACCESS_TOKEN_LIFETIME_SECONDS,
      });
      expect(postedUrl()).toBe('https://acme.my.salesforce.com/services/oauth2/token');
      expect(Object.fromEntries(postedForm())).toEqual({
        grant_type: 'refresh_token',
        refresh_token: '5Aep-refresh',
        client_id: '3MVG9-client',
        client_secret: 'client-secret',
      });
    });

    it('falls back to the production login host when no instance URL is stored', async () => {
      axiosPostSpy.mockResolvedValue({ data: { access_token: 'fresh' } });
      await provider.refreshTokens('5Aep-refresh', credentials);
      expect(postedUrl()).toBe('https://login.salesforce.com/services/oauth2/token');
    });

    it.each([
      ['an attacker host', 'https://attacker.example'],
      ['a host that only ends in the brand name', 'https://evilsalesforce.com'],
    ])('never sends the refresh token and client secret to %s', async (_description, storedInstanceUrl) => {
      await expect(
        provider.refreshTokens('5Aep-refresh', credentials, { dataCenter: storedInstanceUrl }),
      ).rejects.toThrow(/unexpected instance URL/);
      expect(axiosPostSpy).not.toHaveBeenCalled();
    });

    it('never sends the refresh token to a stored value that is not a bare https origin', async () => {
      await expect(
        provider.refreshTokens('5Aep-refresh', credentials, { dataCenter: 'https://evil.example/collect?x=' }),
      ).rejects.toThrow(/unexpected instance URL/);
      expect(axiosPostSpy).not.toHaveBeenCalled();
    });
  });
});
