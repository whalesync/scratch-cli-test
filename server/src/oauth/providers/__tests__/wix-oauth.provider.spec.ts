import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { WixOAuthProvider } from '../wix-oauth.provider';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const REDIRECT_URI = 'https://test.scratch.md/oauth/callback';

function makeProvider(overrides: Record<string, string> = {}): WixOAuthProvider {
  const env: Record<string, string> = {
    WIX_CLIENT_ID: 'wix-app-id',
    WIX_CLIENT_SECRET: 'wix-app-secret',
    REDIRECT_URI,
    ...overrides,
  };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new WixOAuthProvider(config);
}

describe('WixOAuthProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports the client-credentials strategy', () => {
    expect(makeProvider().strategyKind()).toBe('client_credentials');
  });

  describe('generateAuthUrl', () => {
    it('builds the Wix app-installer URL with appId and a postInstallationUrl carrying our state', () => {
      const url = new URL(makeProvider().generateAuthUrl('user1', 'STATE+123/=='));

      expect(url.origin).toBe('https://www.wix.com');
      expect(url.pathname).toBe('/app-installer');
      expect(url.searchParams.get('appId')).toBe('wix-app-id');
      expect(url.searchParams.has('shareUrlId')).toBe(false);

      // postInstallationUrl is our callback with the state round-tripped intact.
      const postInstallationUrl = url.searchParams.get('postInstallationUrl');
      expect(postInstallationUrl).toBeTruthy();
      const callback = new URL(postInstallationUrl ?? '');
      expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('state')).toBe('STATE+123/==');
    });

    it('includes shareUrlId for unlisted apps when configured', () => {
      const url = new URL(makeProvider({ WIX_SHARE_URL_ID: 'share-guid' }).generateAuthUrl('user1', 'S'));
      expect(url.searchParams.get('shareUrlId')).toBe('share-guid');
    });
  });

  describe('mintTokenFromInstall', () => {
    it('posts client_credentials with instance_id and returns a 4h token tagged with the instance', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'at', token_type: 'Bearer' } });

      const result = await makeProvider().mintTokenFromInstall('inst-123');

      expect(result).toEqual({ access_token: 'at', expires_in: 4 * 60 * 60, workspace_id: 'inst-123' });
      const [calledUrl, body] = mockedAxios.post.mock.calls[0];
      expect(calledUrl).toBe('https://www.wixapis.com/oauth2/token');
      expect(body).toEqual({
        grant_type: 'client_credentials',
        client_id: 'wix-app-id',
        client_secret: 'wix-app-secret',
        instance_id: 'inst-123',
      });
    });

    it('throws when Wix returns no access token', async () => {
      mockedAxios.post.mockResolvedValue({ data: {} });
      await expect(makeProvider().mintTokenFromInstall('inst-123')).rejects.toThrow(/did not return an access token/);
    });
  });

  describe('unsupported authorization-code methods', () => {
    it('rejects exchangeCodeForTokens (no code in client-credentials)', async () => {
      await expect(makeProvider().exchangeCodeForTokens()).rejects.toThrow(/mintTokenFromInstall/);
    });

    it('rejects refreshTokens (no refresh token in client-credentials)', async () => {
      await expect(makeProvider().refreshTokens()).rejects.toThrow(/mintTokenFromInstall/);
    });
  });
});
