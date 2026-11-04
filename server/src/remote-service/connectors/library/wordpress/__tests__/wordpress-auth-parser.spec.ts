import { DecryptedCredentials } from '@spinner/shared-types';
import { ConnectorAuthError, ConnectorInstantiationError } from '../../../error';
import { WordPressAuthParser } from '../wordpress-auth-parser';
import { WordPressHttpClient } from '../wordpress-http-client';

jest.mock('../wordpress-http-client');

const STORED_WORDPRESS_CREDENTIALS: DecryptedCredentials = {
  username: 'editor',
  password: 'stored-app-password',
  endpoint: 'https://site.example/wp-json/',
};

const wordPressHttpClientConstructor = jest.mocked(WordPressHttpClient);
// eslint-disable-next-line @typescript-eslint/unbound-method -- the automock's shared prototype method, never called unbound
const discoverAndValidateEndpoint = jest.mocked(WordPressHttpClient.prototype.discoverAndValidateEndpoint);

const wordPressAuthParser = new WordPressAuthParser();

function parseEdit(
  userProvidedParamsFromEdit: Record<string, string | undefined>,
  storedCredentials: DecryptedCredentials = STORED_WORDPRESS_CREDENTIALS,
): ReturnType<WordPressAuthParser['parseUserProvidedParams']> {
  return wordPressAuthParser.parseUserProvidedParams({
    userProvidedParams: userProvidedParamsFromEdit,
    existingCredentials: { ...storedCredentials },
  });
}

describe('WordPressAuthParser', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    discoverAndValidateEndpoint.mockResolvedValue('https://site.example/wp-json/');
  });

  it('handles edits, so the service runs it with the stored credentials', () => {
    expect(wordPressAuthParser.parsesCredentialEditsAgainstStoredCredentials).toBe(true);
  });

  describe('create', () => {
    it('stores the endpoint discovery finds for the site URL entered', async () => {
      const parsed = await wordPressAuthParser.parseUserProvidedParams({
        userProvidedParams: { username: 'editor', password: 'app-password', endpoint: 'https://site.example' },
      });

      expect(wordPressHttpClientConstructor).toHaveBeenCalledWith('https://site.example', 'editor', 'app-password');
      expect(parsed).toEqual({
        credentials: { username: 'editor', password: 'app-password', endpoint: 'https://site.example/wp-json/' },
        extras: {},
      });
    });

    it.each(['username', 'password', 'endpoint'])('requires %s', async (missingCredentialKey) => {
      const userProvidedParams: Record<string, string | undefined> = {
        username: 'editor',
        password: 'app-password',
        endpoint: 'https://site.example',
      };
      delete userProvidedParams[missingCredentialKey];

      await expect(wordPressAuthParser.parseUserProvidedParams({ userProvidedParams })).rejects.toThrow(
        ConnectorInstantiationError,
      );
      expect(discoverAndValidateEndpoint).not.toHaveBeenCalled();
    });
  });

  describe('edit', () => {
    it('runs discovery on the site URL the edit sends, with the stored username and password, and stores what it finds', async () => {
      const parsed = await parseEdit({ endpoint: 'https://site.example' });

      expect(wordPressHttpClientConstructor).toHaveBeenCalledWith(
        'https://site.example',
        'editor',
        'stored-app-password',
      );
      expect(parsed).toEqual({ credentials: STORED_WORDPRESS_CREDENTIALS, extras: {} });
    });

    it('runs discovery with the new password when the edit sends one with the site URL', async () => {
      discoverAndValidateEndpoint.mockResolvedValue('https://new-site.example/index.php?rest_route=/');

      const parsed = await parseEdit({ endpoint: 'https://new-site.example', password: 'new-app-password' });

      expect(wordPressHttpClientConstructor).toHaveBeenCalledWith(
        'https://new-site.example',
        'editor',
        'new-app-password',
      );
      expect(parsed.credentials).toEqual({
        username: 'editor',
        password: 'new-app-password',
        endpoint: 'https://new-site.example/index.php?rest_route=/',
      });
    });

    it('keeps the stored endpoint on a password-only edit, with no client and no request', async () => {
      const parsed = await parseEdit({ password: 'rotated-app-password' });

      expect(wordPressHttpClientConstructor).not.toHaveBeenCalled();
      expect(discoverAndValidateEndpoint).not.toHaveBeenCalled();
      expect(parsed).toEqual({
        credentials: { ...STORED_WORDPRESS_CREDENTIALS, password: 'rotated-app-password' },
        extras: {},
      });
    });

    it('keeps the stored endpoint and password on a username-only edit, with no request', async () => {
      const parsed = await parseEdit({ username: 'other-editor' });

      expect(wordPressHttpClientConstructor).not.toHaveBeenCalled();
      expect(parsed.credentials).toEqual({ ...STORED_WORDPRESS_CREDENTIALS, username: 'other-editor' });
    });

    it('treats a blank value as not sent and keeps the stored one, so a cleared site URL runs no discovery', async () => {
      const parsed = await parseEdit({ username: '', password: '   ', endpoint: '' });

      expect(wordPressHttpClientConstructor).not.toHaveBeenCalled();
      expect(parsed.credentials).toEqual(STORED_WORDPRESS_CREDENTIALS);
    });

    it('rejects with the user-friendly discovery error when no endpoint answers', async () => {
      const discoveryFailure = new ConnectorAuthError(
        'Could not find a valid WordPress REST API endpoint.',
        'Could not find a valid WordPress REST API endpoint. Please verify your WordPress URL and credentials.',
        'WORDPRESS',
      );
      discoverAndValidateEndpoint.mockRejectedValue(discoveryFailure);

      await expect(parseEdit({ endpoint: 'https://site.example/not-wordpress' })).rejects.toBe(discoveryFailure);
    });

    it.each([
      ['missing', {}],
      ['not text', { endpoint: ['https://site.example/wp-json/'] }],
    ])(
      'refuses an edit that does not send the site URL when the stored one is %s',
      async (_description, storedEndpoint) => {
        const storedCredentialsWithUnusableEndpoint = {
          username: 'editor',
          password: 'stored-app-password',
          ...storedEndpoint,
        } as unknown as DecryptedCredentials;

        await expect(
          parseEdit({ password: 'new-app-password' }, storedCredentialsWithUnusableEndpoint),
        ).rejects.toMatchObject({
          userFriendlyMessage: 'This connection has no saved WordPress URL. Enter the WordPress URL and save again.',
        });
        expect(discoverAndValidateEndpoint).not.toHaveBeenCalled();
      },
    );

    it('returns only the WordPress credentials, dropping any other key in the edit or the stored credentials', async () => {
      const parsed = await parseEdit(
        { password: 'new-app-password', apiKey: 'sent-by-mistake' },
        { ...STORED_WORDPRESS_CREDENTIALS, domain: 'left-over.example' },
      );

      expect(parsed.credentials).toEqual({ ...STORED_WORDPRESS_CREDENTIALS, password: 'new-app-password' });
    });
  });
});
