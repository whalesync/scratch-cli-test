import { ConfigService } from '@nestjs/config';
import { Service } from 'src/remote-service/connectors/service-constants';
import { OAuthAppCredentialResolver } from '../oauth-app-credential-resolver.service';
import { asOAuthAppVersion, DEFAULT_OAUTH_APP_VERSION } from '../oauth-app-version';

/** A ConfigService backed by a plain env map. */
function makeResolver(env: Record<string, string>): OAuthAppCredentialResolver {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new OAuthAppCredentialResolver(config);
}

const REDIRECT = 'https://test.scratch.md/oauth/callback';

describe('OAuthAppCredentialResolver', () => {
  describe('resolveSystemAppCredentials', () => {
    it('resolves the app credentials from the service env vars', () => {
      const resolver = makeResolver({
        AIRTABLE_CLIENT_ID: 'the-id',
        AIRTABLE_CLIENT_SECRET: 'the-secret',
        REDIRECT_URI: REDIRECT,
      });
      expect(resolver.resolveSystemAppCredentials(Service.AIRTABLE, DEFAULT_OAUTH_APP_VERSION)).toEqual({
        clientId: 'the-id',
        clientSecret: 'the-secret',
        redirectUri: REDIRECT,
      });
    });

    it('honors the irregular env-var base names (GOOGLE_* for YouTube, LINEAR_OAUTH_*, WIX_* for WIX_BLOG)', () => {
      const resolver = makeResolver({
        GOOGLE_CLIENT_ID: 'yt-id',
        GOOGLE_CLIENT_SECRET: 'yt-secret',
        LINEAR_OAUTH_CLIENT_ID: 'ln-id',
        LINEAR_OAUTH_CLIENT_SECRET: 'ln-secret',
        WIX_CLIENT_ID: 'wix-id',
        WIX_CLIENT_SECRET: 'wix-secret',
        REDIRECT_URI: REDIRECT,
      });
      expect(resolver.resolveSystemAppCredentials(Service.YOUTUBE, DEFAULT_OAUTH_APP_VERSION).clientId).toBe('yt-id');
      expect(resolver.resolveSystemAppCredentials(Service.LINEAR, DEFAULT_OAUTH_APP_VERSION).clientId).toBe('ln-id');
      expect(resolver.resolveSystemAppCredentials(Service.WIX_BLOG, DEFAULT_OAUTH_APP_VERSION).clientId).toBe('wix-id');
    });

    it('accepts a lowercase service key (normalizes to the registry key)', () => {
      const resolver = makeResolver({ NOTION_CLIENT_ID: 'id', NOTION_CLIENT_SECRET: 'secret', REDIRECT_URI: REDIRECT });
      expect(resolver.resolveSystemAppCredentials('notion', DEFAULT_OAUTH_APP_VERSION).clientId).toBe('id');
    });

    it('throws when the app credentials are not configured (empty env)', () => {
      const resolver = makeResolver({ REDIRECT_URI: REDIRECT });
      expect(() => resolver.resolveSystemAppCredentials(Service.AIRTABLE, DEFAULT_OAUTH_APP_VERSION)).toThrow(
        /AIRTABLE v1 are not configured/,
      );
    });

    it('throws for a service with no registered OAuth app', () => {
      const resolver = makeResolver({ REDIRECT_URI: REDIRECT });
      expect(() => resolver.resolveSystemAppCredentials('HUBSPOT', DEFAULT_OAUTH_APP_VERSION)).toThrow(
        /No system OAuth app/,
      );
    });
  });

  describe('resolveCustomAppCredentials', () => {
    it('returns the user-supplied client id/secret with the default system redirect', () => {
      const resolver = makeResolver({ REDIRECT_URI: REDIRECT });
      expect(resolver.resolveCustomAppCredentials('byo-id', 'byo-secret')).toEqual({
        clientId: 'byo-id',
        clientSecret: 'byo-secret',
        redirectUri: REDIRECT,
      });
    });
  });

  describe('getCurrentVersionForNewConnections', () => {
    it('mints new connections at the newest generation a service declares (max declared key)', () => {
      const resolver = makeResolver({});
      // Only one generation is declared today, so the max declared key is 1.
      expect(resolver.getCurrentVersionForNewConnections(Service.AIRTABLE)).toBe(DEFAULT_OAUTH_APP_VERSION);
    });

    it('throws for a service with no registered OAuth app', () => {
      const resolver = makeResolver({});
      expect(() => resolver.getCurrentVersionForNewConnections('HUBSPOT')).toThrow(/No system OAuth app/);
    });
  });

  describe('isVersionedOAuthService', () => {
    it('is true for OAuth connectors and false otherwise', () => {
      const resolver = makeResolver({});
      expect(resolver.isVersionedOAuthService(Service.AIRTABLE)).toBe(true);
      expect(resolver.isVersionedOAuthService('airtable')).toBe(true);
      expect(resolver.isVersionedOAuthService('HUBSPOT')).toBe(false);
    });
  });
});

describe('asOAuthAppVersion', () => {
  it('narrows known generations and falls back to the default for missing/unknown values', () => {
    expect(asOAuthAppVersion(1)).toBe(1);
    expect(asOAuthAppVersion(undefined)).toBe(DEFAULT_OAUTH_APP_VERSION);
    expect(asOAuthAppVersion(null)).toBe(DEFAULT_OAUTH_APP_VERSION);
    expect(asOAuthAppVersion(99)).toBe(DEFAULT_OAUTH_APP_VERSION);
  });
});
