import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PipedriveOAuthProvider } from '../pipedrive-oauth.provider';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeProvider(): PipedriveOAuthProvider {
  const config = {
    get: (key: string) =>
      ({
        PIPEDRIVE_CLIENT_ID: 'test-client-id',
        PIPEDRIVE_CLIENT_SECRET: 'test-client-secret',
        REDIRECT_URI: 'https://test.scratch.md/oauth/callback',
      })[key],
  } as unknown as ConfigService;
  return new PipedriveOAuthProvider(config);
}

const expectedBasicAuth = Buffer.from('test-client-id:test-client-secret').toString('base64');

describe('PipedriveOAuthProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('generateAuthUrl', () => {
    it('builds the authorize URL with no scope param', () => {
      const url = new URL(makeProvider().generateAuthUrl('user1', 'STATE123'));
      expect(url.origin).toBe('https://oauth.pipedrive.com');
      expect(url.pathname).toBe('/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('test-client-id');
      expect(url.searchParams.get('redirect_uri')).toBe('https://test.scratch.md/oauth/callback');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('state')).toBe('STATE123');
      // Scopes are configured in the Developer Hub, not requested per-authorization.
      expect(url.searchParams.has('scope')).toBe(false);
    });

    it('honors a custom (private-app) client id override', () => {
      const url = new URL(makeProvider().generateAuthUrl('user1', 'S', { clientId: 'custom-id' }));
      expect(url.searchParams.get('client_id')).toBe('custom-id');
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('posts authorization_code with Basic auth and maps the response', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, api_domain: 'https://acme.pipedrive.com' },
      });
      const result = await makeProvider().exchangeCodeForTokens('CODE');
      expect(result).toEqual({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
      const [calledUrl, body, opts] = mockedAxios.post.mock.calls[0];
      expect(calledUrl).toBe('https://oauth.pipedrive.com/oauth/token');
      expect(String(body)).toContain('grant_type=authorization_code');
      expect(String(body)).toContain('code=CODE');
      expect(String(body)).toContain('redirect_uri=https%3A%2F%2Ftest.scratch.md%2Foauth%2Fcallback');
      expect((opts?.headers as Record<string, string>)?.Authorization).toBe(`Basic ${expectedBasicAuth}`);
    });

    it('honors a redirect_uri override (inbound flow)', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } });
      await makeProvider().exchangeCodeForTokens('CODE', {
        redirectUri: 'https://app.scratch.md/oauth/install/pipedrive',
      });
      const [, body] = mockedAxios.post.mock.calls[0];
      expect(String(body)).toContain('redirect_uri=https%3A%2F%2Fapp.scratch.md%2Foauth%2Finstall%2Fpipedrive');
    });
  });

  describe('refreshTokens', () => {
    it('posts refresh_token and returns the rotated refresh token', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 },
      });
      const result = await makeProvider().refreshTokens('rt1');
      expect(result.access_token).toBe('at2');
      // Pipedrive rotates the refresh token; the new one is returned.
      expect(result.refresh_token).toBe('rt2');
      const [calledUrl, body, opts] = mockedAxios.post.mock.calls[0];
      expect(calledUrl).toBe('https://oauth.pipedrive.com/oauth/token');
      expect(String(body)).toContain('grant_type=refresh_token');
      expect(String(body)).toContain('refresh_token=rt1');
      expect((opts?.headers as Record<string, string>)?.Authorization).toBe(`Basic ${expectedBasicAuth}`);
    });

    it('falls back to the old refresh token when none is returned', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'at2', expires_in: 3600 } });
      const result = await makeProvider().refreshTokens('rt1');
      expect(result.refresh_token).toBe('rt1');
    });
  });

  describe('getServiceName', () => {
    it('returns pipedrive', () => {
      expect(makeProvider().getServiceName()).toBe('pipedrive');
    });
  });
});
