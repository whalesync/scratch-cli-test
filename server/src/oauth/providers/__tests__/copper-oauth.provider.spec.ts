import axios, { AxiosError } from 'axios';
import { OAuthAppCredentials } from '../../oauth-app-version';
import { CopperOAuthProvider } from '../copper-oauth.provider';

const axiosPostSpy = jest.spyOn(axios, 'post');

const copperAppCredentials: OAuthAppCredentials = {
  clientId: 'copper-client-id',
  clientSecret: 'copper-client-secret',
  redirectUri: 'https://app.whalesync.com/oauth-callback/connector/copper',
};

const provider = new CopperOAuthProvider();

function copperRejection(status: number, data: unknown): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`), {
    response: { status, data, headers: {}, config: {}, statusText: '' },
  });
}

describe('CopperOAuthProvider', () => {
  beforeEach(() => axiosPostSpy.mockReset());

  describe('generateAuthUrl', () => {
    it("signs in at Copper with its one scope, Whalesync's callback, and a PKCE challenge", () => {
      const authorizeUrl = new URL(
        provider.generateAuthUrl('STATE', copperAppCredentials, { codeChallenge: 'CHALLENGE' }),
      );
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://app.copper.com/oauth/authorize');
      expect(Object.fromEntries(authorizeUrl.searchParams)).toEqual({
        response_type: 'code',
        client_id: 'copper-client-id',
        redirect_uri: 'https://app.whalesync.com/oauth-callback/connector/copper',
        scope: 'developer/v1/all',
        state: 'STATE',
        code_challenge: 'CHALLENGE',
        code_challenge_method: 'S256',
      });
    });

    it('uses PKCE', () => {
      expect(provider.usesPkce()).toBe(true);
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('exchanges the code with a form POST and records no expiry or refresh token', async () => {
      axiosPostSpy.mockResolvedValue({ data: { access_token: 'copper-access', token_type: 'Bearer' } });

      const tokens = await provider.exchangeCodeForTokens('CODE', copperAppCredentials, { codeVerifier: 'VERIFIER' });

      expect(axiosPostSpy.mock.calls[0][0]).toBe('https://app.copper.com/oauth/token');
      expect(Object.fromEntries(new URLSearchParams(axiosPostSpy.mock.calls[0][1] as string))).toEqual({
        grant_type: 'authorization_code',
        code: 'CODE',
        client_id: 'copper-client-id',
        client_secret: 'copper-client-secret',
        redirect_uri: 'https://app.whalesync.com/oauth-callback/connector/copper',
        code_verifier: 'VERIFIER',
      });
      expect(axiosPostSpy.mock.calls[0][2]?.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(tokens).toEqual({ access_token: 'copper-access' });
    });

    it("reports Copper's error description when the exchange is refused", async () => {
      axiosPostSpy.mockRejectedValue(
        copperRejection(400, { error: 'invalid_grant', error_description: 'The authorization code has expired' }),
      );

      await expect(provider.exchangeCodeForTokens('CODE', copperAppCredentials)).rejects.toThrow(
        'Copper authorization failed: The authorization code has expired',
      );
    });

    it('reports the bare error code when Copper sends no description', async () => {
      axiosPostSpy.mockRejectedValue(copperRejection(401, { error: 'invalid_client' }));

      await expect(provider.exchangeCodeForTokens('CODE', copperAppCredentials)).rejects.toThrow(
        'Copper authorization failed: invalid_client',
      );
    });
  });

  describe('refreshTokens', () => {
    it('refuses, since Copper tokens never expire and come with no refresh token', async () => {
      await expect(provider.refreshTokens()).rejects.toThrow('Reconnect Copper');
      expect(axiosPostSpy).not.toHaveBeenCalled();
    });
  });
});
