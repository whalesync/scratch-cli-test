import axios from 'axios';
import { OAuthAppCredentials } from '../../oauth-app-version';
import { ZohoOAuthProvider } from '../zoho-oauth.provider';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeProvider(): ZohoOAuthProvider {
  return new ZohoOAuthProvider();
}

const credentials: OAuthAppCredentials = {
  clientId: '1000.TESTCLIENT',
  clientSecret: 'test-secret',
  redirectUri: 'http://localhost:3000/oauth/callback',
};

describe('ZohoOAuthProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('generateAuthUrl', () => {
    it('builds the authorize URL on the data center accounts host with offline+consent', () => {
      const url = new URL(makeProvider().generateAuthUrl('STATE123', credentials, { dataCenter: 'EU' }));
      expect(url.origin).toBe('https://accounts.zoho.eu');
      expect(url.pathname).toBe('/oauth/v2/auth');
      expect(url.searchParams.get('client_id')).toBe('1000.TESTCLIENT');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/oauth/callback');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('state')).toBe('STATE123');
      expect(url.searchParams.get('scope')).toContain('ZohoCRM.modules.ALL');
    });

    it('defaults to the US accounts host when no data center is given', () => {
      const url = new URL(makeProvider().generateAuthUrl('S', credentials));
      expect(url.origin).toBe('https://accounts.zoho.com');
    });

    it('uses the client id from the resolved credentials (e.g. a custom/private app)', () => {
      const url = new URL(
        makeProvider().generateAuthUrl('S', { ...credentials, clientId: '1000.CUSTOM' }, { dataCenter: 'IN' }),
      );
      expect(url.origin).toBe('https://accounts.zoho.in');
      expect(url.searchParams.get('client_id')).toBe('1000.CUSTOM');
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('posts authorization_code to the DC token host and maps the response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, api_domain: 'https://www.zohoapis.eu' },
      });
      const result = await makeProvider().exchangeCodeForTokens('CODE', credentials, { dataCenter: 'EU' });
      expect(result).toEqual({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
      const [calledUrl, body] = mockedAxios.post.mock.calls[0];
      expect(calledUrl).toBe('https://accounts.zoho.eu/oauth/v2/token');
      expect(String(body)).toContain('grant_type=authorization_code');
      expect(String(body)).toContain('code=CODE');
    });

    it('throws when Zoho returns no access_token', async () => {
      mockedAxios.post.mockResolvedValue({ data: { error: 'invalid_code' } });
      await expect(makeProvider().exchangeCodeForTokens('BAD', credentials, { dataCenter: 'US' })).rejects.toThrow(
        /invalid_code/,
      );
    });
  });

  describe('refreshTokens', () => {
    it('posts refresh_token to the stored DC host', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'at2', expires_in: 3600 } });
      const result = await makeProvider().refreshTokens('rt', credentials, { dataCenter: 'IN' });
      expect(result.access_token).toBe('at2');
      // Zoho omits a new refresh token on refresh — caller keeps the old one.
      expect(result.refresh_token).toBeUndefined();
      const [calledUrl, body] = mockedAxios.post.mock.calls[0];
      expect(calledUrl).toBe('https://accounts.zoho.in/oauth/v2/token');
      expect(String(body)).toContain('grant_type=refresh_token');
    });
  });
});
