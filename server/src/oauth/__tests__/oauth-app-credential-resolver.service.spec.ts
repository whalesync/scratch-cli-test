import { ConfigService } from '@nestjs/config';
import { Service } from 'src/remote-service/connectors/service-constants';
import { OAuthAppCredentialResolver } from '../oauth-app-credential-resolver.service';
import { asOAuthAppVersion, DEFAULT_OAUTH_APP_VERSION } from '../oauth-app-version';

/** A ConfigService backed by a plain env map. */
function makeResolver(env: Record<string, string>): OAuthAppCredentialResolver {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new OAuthAppCredentialResolver(config);
}

// The redirect comes from a per-generation env var. REDIRECT_URI_SCRATCH is a full, flat callback
// used as-is. REDIRECT_URI_WHALESYNC is only the base URL — the resolver appends the per-connector
// path `/oauth-callback/connector/<connectorType>`.
const SCRATCH_REDIRECT = 'https://test.scratch.md/oauth/callback';
const WHALESYNC_BASE = 'https://app.whalesync.com';
const REDIRECTS = { REDIRECT_URI_SCRATCH: SCRATCH_REDIRECT, REDIRECT_URI_WHALESYNC: WHALESYNC_BASE };

describe('OAuthAppCredentialResolver', () => {
  describe('resolveSystemAppCredentials', () => {
    it('resolves the generation-1 app credentials, redirecting through REDIRECT_URI_SCRATCH', () => {
      const resolver = makeResolver({
        AIRTABLE_CLIENT_ID: 'the-id',
        AIRTABLE_CLIENT_SECRET: 'the-secret',
        ...REDIRECTS,
      });
      expect(resolver.resolveSystemAppCredentials(Service.AIRTABLE, DEFAULT_OAUTH_APP_VERSION)).toEqual({
        clientId: 'the-id',
        clientSecret: 'the-secret',
        redirectUri: SCRATCH_REDIRECT,
      });
    });

    it('resolves generation-2 from the *_V2 env vars, with a per-connector Whalesync callback appended to the base', () => {
      const resolver = makeResolver({
        AIRTABLE_CLIENT_ID: 'v1-id',
        AIRTABLE_CLIENT_SECRET: 'v1-secret',
        AIRTABLE_CLIENT_ID_V2: 'v2-id',
        AIRTABLE_CLIENT_SECRET_V2: 'v2-secret',
        ...REDIRECTS,
      });
      expect(resolver.resolveSystemAppCredentials(Service.AIRTABLE, 2)).toEqual({
        clientId: 'v2-id',
        clientSecret: 'v2-secret',
        redirectUri: 'https://app.whalesync.com/oauth-callback/connector/airtable',
      });
    });

    it('resolves generation-2 for a newly rolled-out connector (Notion → …/connector/notion)', () => {
      const resolver = makeResolver({
        NOTION_CLIENT_ID_V2: 'n2-id',
        NOTION_CLIENT_SECRET_V2: 'n2-secret',
        ...REDIRECTS,
      });
      expect(resolver.resolveSystemAppCredentials(Service.NOTION, 2)).toEqual({
        clientId: 'n2-id',
        clientSecret: 'n2-secret',
        redirectUri: 'https://app.whalesync.com/oauth-callback/connector/notion',
      });
    });

    it('has no generation 2 for connectors not yet rolled out (e.g. Shopify)', () => {
      const resolver = makeResolver({ SHOPIFY_CLIENT_ID: 's1', SHOPIFY_CLIENT_SECRET: 's1s', ...REDIRECTS });
      expect(() => resolver.resolveSystemAppCredentials(Service.SHOPIFY, 2)).toThrow(/SHOPIFY has no v2/);
    });

    it('honors the irregular env-var base names (GOOGLE_* for YouTube, LINEAR_OAUTH_*, WIX_* for WIX_BLOG)', () => {
      const resolver = makeResolver({
        GOOGLE_CLIENT_ID: 'yt-id',
        GOOGLE_CLIENT_SECRET: 'yt-secret',
        LINEAR_OAUTH_CLIENT_ID: 'ln-id',
        LINEAR_OAUTH_CLIENT_SECRET: 'ln-secret',
        WIX_CLIENT_ID: 'wix-id',
        WIX_CLIENT_SECRET: 'wix-secret',
        ...REDIRECTS,
      });
      expect(resolver.resolveSystemAppCredentials(Service.YOUTUBE, DEFAULT_OAUTH_APP_VERSION).clientId).toBe('yt-id');
      expect(resolver.resolveSystemAppCredentials(Service.LINEAR, DEFAULT_OAUTH_APP_VERSION).clientId).toBe('ln-id');
      expect(resolver.resolveSystemAppCredentials(Service.WIX_BLOG, DEFAULT_OAUTH_APP_VERSION).clientId).toBe('wix-id');
    });

    it('accepts a lowercase service key (normalizes to the registry key)', () => {
      const resolver = makeResolver({ NOTION_CLIENT_ID: 'id', NOTION_CLIENT_SECRET: 'secret', ...REDIRECTS });
      expect(resolver.resolveSystemAppCredentials('notion', DEFAULT_OAUTH_APP_VERSION).clientId).toBe('id');
    });

    it('throws when the targeted generation is not configured (e.g. v2 not provisioned yet)', () => {
      const resolver = makeResolver({
        AIRTABLE_CLIENT_ID: 'v1-id',
        AIRTABLE_CLIENT_SECRET: 'v1-secret',
        ...REDIRECTS,
      });
      expect(() => resolver.resolveSystemAppCredentials(Service.AIRTABLE, 2)).toThrow(/AIRTABLE v2 are not configured/);
    });

    it('throws for a service with no registered OAuth app', () => {
      const resolver = makeResolver({ ...REDIRECTS });
      expect(() => resolver.resolveSystemAppCredentials('HUBSPOT', DEFAULT_OAUTH_APP_VERSION)).toThrow(
        /No system OAuth app/,
      );
    });
  });

  describe('resolveCustomAppCredentials', () => {
    it('returns the user-supplied client id/secret with the scratch-direct redirect', () => {
      const resolver = makeResolver({ ...REDIRECTS });
      expect(resolver.resolveCustomAppCredentials('byo-id', 'byo-secret')).toEqual({
        clientId: 'byo-id',
        clientSecret: 'byo-secret',
        redirectUri: SCRATCH_REDIRECT,
      });
    });
  });

  describe('getCurrentVersionForNewConnections', () => {
    it('returns the newest declared generation — 2 for rolled-out connectors, 1 for the rest', () => {
      const resolver = makeResolver({});
      expect(resolver.getCurrentVersionForNewConnections(Service.AIRTABLE)).toBe(2);
      expect(resolver.getCurrentVersionForNewConnections(Service.NOTION)).toBe(2);
      expect(resolver.getCurrentVersionForNewConnections(Service.SHOPIFY)).toBe(1);
    });

    it('throws for a service with no registered OAuth app', () => {
      const resolver = makeResolver({});
      expect(() => resolver.getCurrentVersionForNewConnections('HUBSPOT')).toThrow(/No system OAuth app/);
    });
  });
});

describe('asOAuthAppVersion', () => {
  it('narrows known generations and falls back to the default for missing/unknown values', () => {
    expect(asOAuthAppVersion(1)).toBe(1);
    expect(asOAuthAppVersion(2)).toBe(2);
    expect(asOAuthAppVersion(undefined)).toBe(DEFAULT_OAUTH_APP_VERSION);
    expect(asOAuthAppVersion(null)).toBe(DEFAULT_OAUTH_APP_VERSION);
    expect(asOAuthAppVersion(99)).toBe(DEFAULT_OAUTH_APP_VERSION);
  });
});
