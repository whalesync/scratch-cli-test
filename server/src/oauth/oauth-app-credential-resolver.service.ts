import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Service } from 'src/remote-service/connectors/service-constants';
import { OAuthAppCredentials, OAuthAppVersion } from './oauth-app-version';

/**
 * The env var that holds the redirect_uri when a service/generation doesn't override it.
 * A generation whose OAuth app registers a different callback declares its own via
 * {@link OAuthAppEnvVarNames.redirectUriEnvVar}.
 */
const DEFAULT_REDIRECT_URI_ENV_VAR = 'REDIRECT_URI';

/** The env var names that hold one OAuth app generation's credentials for one service. */
interface OAuthAppEnvVarNames {
  readonly clientIdEnvVar: string;
  readonly clientSecretEnvVar: string;
  /** Optional per-generation redirect override; defaults to {@link DEFAULT_REDIRECT_URI_ENV_VAR}. */
  readonly redirectUriEnvVar?: string;
}

/**
 * The env vars for each OAuth app generation a service declares. Every service declares a
 * base generation (1); newer generations are optional and added per service as it rolls
 * forward. Keys are constrained to {@link OAuthAppVersion}, so declaring an unknown
 * generation is a compile error.
 */
type OAuthAppEnvVarNamesByVersion = { 1: OAuthAppEnvVarNames } & Partial<Record<OAuthAppVersion, OAuthAppEnvVarNames>>;

/** The OAuth-capable services, as a const tuple so the map below is exhaustively typed. */
const OAUTH_APP_SERVICE_KEYS = [
  Service.AIRTABLE,
  Service.GOHIGHLEVEL,
  Service.NOTION,
  Service.SHOPIFY,
  Service.SUPABASE,
  Service.WEBFLOW,
  Service.WIX_BLOG,
  Service.YOUTUBE,
  Service.QUICKBOOKS,
  Service.LINEAR,
  Service.ZOHO,
  Service.PIPEDRIVE,
] as const;

type OAuthAppServiceKey = (typeof OAUTH_APP_SERVICE_KEYS)[number];

/**
 * The single source of truth mapping (service, generation) → the env vars holding that
 * app generation's credentials. `Record<OAuthAppServiceKey, ...>` forces every OAuth
 * service to appear; each declares a base generation (1) and, as it rolls forward, its
 * newer generations. New connections use the newest generation a service declares (see
 * {@link OAuthAppCredentialResolver.getCurrentVersionForNewConnections}).
 *
 * There is a single generation today. Rotating a connector onto a different OAuth app adds
 * its next generation here (with its own env vars, and a redirect override only if that
 * app's registered callback differs from REDIRECT_URI).
 */
const OAUTH_APP_ENV_VARS_BY_SERVICE: Record<OAuthAppServiceKey, OAuthAppEnvVarNamesByVersion> = {
  [Service.AIRTABLE]: {
    1: { clientIdEnvVar: 'AIRTABLE_CLIENT_ID', clientSecretEnvVar: 'AIRTABLE_CLIENT_SECRET' },
  },
  [Service.GOHIGHLEVEL]: {
    1: { clientIdEnvVar: 'GOHIGHLEVEL_CLIENT_ID', clientSecretEnvVar: 'GOHIGHLEVEL_CLIENT_SECRET' },
  },
  [Service.NOTION]: {
    1: { clientIdEnvVar: 'NOTION_CLIENT_ID', clientSecretEnvVar: 'NOTION_CLIENT_SECRET' },
  },
  [Service.SHOPIFY]: {
    1: { clientIdEnvVar: 'SHOPIFY_CLIENT_ID', clientSecretEnvVar: 'SHOPIFY_CLIENT_SECRET' },
  },
  [Service.SUPABASE]: {
    1: { clientIdEnvVar: 'SUPABASE_CLIENT_ID', clientSecretEnvVar: 'SUPABASE_CLIENT_SECRET' },
  },
  [Service.WEBFLOW]: {
    1: { clientIdEnvVar: 'WEBFLOW_CLIENT_ID', clientSecretEnvVar: 'WEBFLOW_CLIENT_SECRET' },
  },
  // Service key is WIX_BLOG but the env vars are WIX_* (the map decouples the two).
  [Service.WIX_BLOG]: {
    1: { clientIdEnvVar: 'WIX_CLIENT_ID', clientSecretEnvVar: 'WIX_CLIENT_SECRET' },
  },
  // YouTube authenticates against a Google OAuth app, hence GOOGLE_* (not YOUTUBE_*).
  [Service.YOUTUBE]: {
    1: { clientIdEnvVar: 'GOOGLE_CLIENT_ID', clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET' },
  },
  [Service.QUICKBOOKS]: {
    1: { clientIdEnvVar: 'QUICKBOOKS_CLIENT_ID', clientSecretEnvVar: 'QUICKBOOKS_CLIENT_SECRET' },
  },
  // Linear's env vars carry the `_OAUTH_` infix (LINEAR_API_KEY is a separate secret).
  [Service.LINEAR]: {
    1: { clientIdEnvVar: 'LINEAR_OAUTH_CLIENT_ID', clientSecretEnvVar: 'LINEAR_OAUTH_CLIENT_SECRET' },
  },
  [Service.ZOHO]: {
    1: { clientIdEnvVar: 'ZOHO_CLIENT_ID', clientSecretEnvVar: 'ZOHO_CLIENT_SECRET' },
  },
  [Service.PIPEDRIVE]: {
    1: { clientIdEnvVar: 'PIPEDRIVE_CLIENT_ID', clientSecretEnvVar: 'PIPEDRIVE_CLIENT_SECRET' },
  },
};

/**
 * Resolves the OAuth *app* credentials (client_id, client_secret, redirect_uri) to use
 * for a given service and {@link OAuthAppVersion}. This is the sole choke point for
 * system OAuth credentials: providers no longer read `*_CLIENT_ID` env vars directly,
 * so no code path can obtain credentials without naming the generation it wants.
 */
@Injectable()
export class OAuthAppCredentialResolver {
  constructor(private readonly configService: ConfigService) {}

  /**
   * The system-managed app credentials for `service` at `version`. Throws if the targeted
   * generation isn't configured (empty client id/secret) so a misconfiguration fails
   * loudly at the boundary rather than sending an empty client_id to the provider.
   */
  resolveSystemAppCredentials(service: string, version: OAuthAppVersion): OAuthAppCredentials {
    const serviceKey = service.toUpperCase();
    const envVarsByVersion = OAUTH_APP_ENV_VARS_BY_SERVICE[serviceKey as OAuthAppServiceKey];
    if (!envVarsByVersion) {
      throw new Error(`No system OAuth app is configured for service "${serviceKey}"`);
    }
    const envVars = envVarsByVersion[version];
    if (!envVars) {
      throw new Error(`${serviceKey} has no v${version} OAuth app generation declared`);
    }

    const clientId = this.configService.get<string>(envVars.clientIdEnvVar) ?? '';
    const clientSecret = this.configService.get<string>(envVars.clientSecretEnvVar) ?? '';
    const redirectUri = this.readRedirectUri(envVars.redirectUriEnvVar);

    if (!clientId || !clientSecret) {
      throw new Error(
        `System OAuth app credentials for ${serviceKey} v${version} are not configured ` +
          `(${envVars.clientIdEnvVar} / ${envVars.clientSecretEnvVar})`,
      );
    }

    return { clientId, clientSecret, redirectUri };
  }

  /**
   * Credentials for a user-supplied custom OAuth app (the "bring your own app" /
   * OAUTH_CUSTOM path). The redirect is always the default system callback, since a
   * custom app registers that same URL. App versioning does not apply to custom apps —
   * the connection carries the client id/secret directly.
   */
  resolveCustomAppCredentials(customClientId: string, customClientSecret: string): OAuthAppCredentials {
    return {
      clientId: customClientId,
      clientSecret: customClientSecret,
      redirectUri: this.readRedirectUri(),
    };
  }

  /**
   * The generation that NEW connections (and re-authorizations) for `service` should be
   * minted at: the newest generation the service declares. Generations are incremented
   * numerically, so declaring a service's next generation in the credential map is what
   * cuts its new connections over — existing connections keep their stamped generation and
   * refresh against it.
   */
  getCurrentVersionForNewConnections(service: string): OAuthAppVersion {
    const serviceKey = service.toUpperCase();
    const envVarsByVersion = OAUTH_APP_ENV_VARS_BY_SERVICE[serviceKey as OAuthAppServiceKey];
    if (!envVarsByVersion) {
      throw new Error(`No system OAuth app is configured for service "${serviceKey}"`);
    }
    const declaredVersions = Object.keys(envVarsByVersion).map(Number);
    return Math.max(...declaredVersions) as OAuthAppVersion;
  }

  /** Whether `service` has a registered, versioned system OAuth app. */
  isVersionedOAuthService(service: string): boolean {
    return (OAUTH_APP_SERVICE_KEYS as readonly string[]).includes(service.toUpperCase());
  }

  private readRedirectUri(redirectUriEnvVar?: string): string {
    return this.configService.get<string>(redirectUriEnvVar ?? DEFAULT_REDIRECT_URI_ENV_VAR) ?? '';
  }
}
