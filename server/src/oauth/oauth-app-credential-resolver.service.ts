import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { max } from 'lodash';
import { Service } from 'src/remote-service/connectors/service-constants';
import { OAuthAppCredentials, OAuthAppVersion } from './oauth-app-version';

/** The redirect_uri env var per OAuth app generation family (scratch-direct vs whalesync-proxy). */
enum REDIRECT_URI_ENV_VAR {
  SCRATCH = 'REDIRECT_URI_SCRATCH',
  WHALESYNC = 'REDIRECT_URI_WHALESYNC',
}

/** The env var names that hold one OAuth app generation's client credentials for one service. */
interface OAuthAppEnvVarNames {
  readonly clientIdEnvVar: string;
  readonly clientSecretEnvVar: string;
  readonly redirectUri: (configService: ConfigService) => string;
}

function scratchRedirectUri(configService: ConfigService): string {
  return configService.get<string>(REDIRECT_URI_ENV_VAR.SCRATCH) ?? '';
}

/**
 * Build the Whalesync OAuth callback URL for a connector. Unlike Scratch's flat callback, the
 * Whalesync callback is per-connector: `<base>/oauth-callback/connector/<connectorType>`, where
 * `<base>` is the REDIRECT_URI_WHALESYNC env var (e.g. https://app.whalesync.com — set per env).
 * NOTE! Connector type is Whalesync's IDs.
 */
function whalesyncRedirectUri(configService: ConfigService, wsConnectorId: string): string {
  const base = configService.get<string>(REDIRECT_URI_ENV_VAR.WHALESYNC) ?? '';
  return `${base}/oauth-callback/connector/${wsConnectorId}`;
}

/**
 * The env vars for each OAuth app generation a service declares. Every service declares a
 * base generation (1); newer generations are optional and added per service as it rolls
 * forward. Keys are constrained to {@link OAuthAppVersion}, so declaring an unknown
 * generation is a compile error.
 */
type OAuthAppEnvVarNamesByVersion = { 1: OAuthAppEnvVarNames } & Partial<Record<OAuthAppVersion, OAuthAppEnvVarNames>>;

// type OAuthAppServiceKey = (typeof OAUTH_APP_SERVICE_KEYS)[number];
type OAuthAppServiceKey =
  | typeof Service.AIRTABLE
  | typeof Service.GOHIGHLEVEL
  | typeof Service.LINEAR
  | typeof Service.NOTION
  | typeof Service.PIPEDRIVE
  | typeof Service.QUICKBOOKS
  | typeof Service.SUPABASE
  | typeof Service.WEBFLOW
  | typeof Service.WIX_BLOG
  | typeof Service.YOUTUBE
  | typeof Service.ZOHO;

/**
 * Secrets for authorizing an OAuth connection.
 *
 * These are versioned for each connector.
 * - The latest version will be used for a new connection.
 * - Existing connections store their version.
 *
 * NOTE: A version can be deleted once there are no more connections in the DB that uses it, except for the most recent.
 */
const OAUTH_APP_ENV_VARS_BY_SERVICE: Record<OAuthAppServiceKey, OAuthAppEnvVarNamesByVersion> = {
  [Service.AIRTABLE]: {
    1: {
      clientIdEnvVar: 'AIRTABLE_CLIENT_ID',
      clientSecretEnvVar: 'AIRTABLE_CLIENT_SECRET',
      redirectUri: scratchRedirectUri,
    },
    2: {
      clientIdEnvVar: 'AIRTABLE_CLIENT_ID_V2',
      clientSecretEnvVar: 'AIRTABLE_CLIENT_SECRET_V2',
      redirectUri: (config) => whalesyncRedirectUri(config, 'airtable'),
    },
  },
  [Service.GOHIGHLEVEL]: {
    1: {
      clientIdEnvVar: 'GOHIGHLEVEL_CLIENT_ID',
      clientSecretEnvVar: 'GOHIGHLEVEL_CLIENT_SECRET',
      redirectUri: (config) => whalesyncRedirectUri(config, 'gohighlevel'),
    },
  },
  [Service.NOTION]: {
    1: {
      clientIdEnvVar: 'NOTION_CLIENT_ID',
      clientSecretEnvVar: 'NOTION_CLIENT_SECRET',
      redirectUri: scratchRedirectUri,
    },
    2: {
      clientIdEnvVar: 'NOTION_CLIENT_ID_V2',
      clientSecretEnvVar: 'NOTION_CLIENT_SECRET_V2',
      redirectUri: (config) => whalesyncRedirectUri(config, 'notion'),
    },
  },
  [Service.SUPABASE]: {
    1: {
      clientIdEnvVar: 'SUPABASE_CLIENT_ID',
      clientSecretEnvVar: 'SUPABASE_CLIENT_SECRET',
      redirectUri: scratchRedirectUri,
    },
    2: {
      clientIdEnvVar: 'SUPABASE_CLIENT_ID_V2',
      clientSecretEnvVar: 'SUPABASE_CLIENT_SECRET_V2',
      redirectUri: (config) => whalesyncRedirectUri(config, 'supabase-oauth'),
    },
  },
  [Service.WEBFLOW]: {
    1: {
      clientIdEnvVar: 'WEBFLOW_CLIENT_ID',
      clientSecretEnvVar: 'WEBFLOW_CLIENT_SECRET',
      redirectUri: scratchRedirectUri,
    },
    2: {
      clientIdEnvVar: 'WEBFLOW_CLIENT_ID_V2',
      clientSecretEnvVar: 'WEBFLOW_CLIENT_SECRET_V2',
      redirectUri: (config) => whalesyncRedirectUri(config, 'webflow'),
    },
  },
  // Service key is WIX_BLOG but the env vars are WIX_* (the map decouples the two).
  [Service.WIX_BLOG]: {
    1: {
      clientIdEnvVar: 'WIX_CLIENT_ID',
      clientSecretEnvVar: 'WIX_CLIENT_SECRET',
      redirectUri: scratchRedirectUri,
    },
    2: {
      clientIdEnvVar: 'WIX_CLIENT_ID_V2',
      clientSecretEnvVar: 'WIX_CLIENT_SECRET_V2',
      redirectUri: (config) => whalesyncRedirectUri(config, 'wix'),
    },
  },
  // YouTube authenticates against a Google OAuth app, hence GOOGLE_* (not YOUTUBE_*).
  [Service.YOUTUBE]: {
    1: {
      clientIdEnvVar: 'GOOGLE_CLIENT_ID',
      clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
      redirectUri: scratchRedirectUri,
    },
    // 2: {
    //   clientIdEnvVar: 'GOOGLE_CLIENT_ID_V2',
    //   clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET_V2',
    //   redirectUri: (config) => whalesyncRedirectUri(config, 'sheets TODO'),
    // },
  },
  [Service.QUICKBOOKS]: {
    1: {
      clientIdEnvVar: 'QUICKBOOKS_CLIENT_ID',
      clientSecretEnvVar: 'QUICKBOOKS_CLIENT_SECRET',
      redirectUri: (config) => whalesyncRedirectUri(config, 'quickbooks'),
    },
  },
  // Linear's env vars carry the `_OAUTH_` infix (LINEAR_API_KEY is a separate secret).
  [Service.LINEAR]: {
    1: {
      clientIdEnvVar: 'LINEAR_OAUTH_CLIENT_ID',
      clientSecretEnvVar: 'LINEAR_OAUTH_CLIENT_SECRET',
      redirectUri: (config) => whalesyncRedirectUri(config, 'linear'),
    },
  },
  [Service.ZOHO]: {
    1: {
      clientIdEnvVar: 'ZOHO_CLIENT_ID',
      clientSecretEnvVar: 'ZOHO_CLIENT_SECRET',
      redirectUri: scratchRedirectUri,
    },
    2: {
      clientIdEnvVar: 'ZOHO_CLIENT_ID_V2',
      clientSecretEnvVar: 'ZOHO_CLIENT_SECRET_V2',
      redirectUri: (config) => whalesyncRedirectUri(config, 'zoho'),
    },
  },
  [Service.PIPEDRIVE]: {
    1: {
      clientIdEnvVar: 'PIPEDRIVE_CLIENT_ID',
      clientSecretEnvVar: 'PIPEDRIVE_CLIENT_SECRET',
      redirectUri: scratchRedirectUri,
    },
    // TODO: Switch pipedrive over to whalesync creds.
    // Secrets are already populated, but the oauth app is awaiting approval from the migration away from iapp.
    // Once that's done, you should just have to uncomment this. To test locally, make sure you have defined these
    // vars in your .env
    // 2: {
    //   clientIdEnvVar: 'PIPEDRIVE_CLIENT_ID_V2',
    //   clientSecretEnvVar: 'PIPEDRIVE_CLIENT_SECRET_V2',
    //   redirectUri: (config) => whalesyncRedirectUri(config, 'pipedrive'),
    // },
  },
};

/**
 * Resolves the OAuth *app* credentials. Providers *must* not read `*_CLIENT_ID` env vars directly.
 */
@Injectable()
export class OAuthAppCredentialResolver {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Resolves the credentials requested.
   *
   * Throws if the requested client id/secret aren't configured.
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
    const redirectUri = envVars.redirectUri(this.configService);

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
   * OAUTH_CUSTOM path). The redirect is always the default scratch.md callback, since a
   * custom app registers that same URL. App versioning does not apply to custom apps —
   * the connection carries the client id/secret directly.
   */
  resolveCustomAppCredentials(customClientId: string, customClientSecret: string): OAuthAppCredentials {
    return {
      clientId: customClientId,
      clientSecret: customClientSecret,
      redirectUri: this.configService.get<string>(REDIRECT_URI_ENV_VAR.SCRATCH) ?? '',
    };
  }

  /**
   * The Oauth app that a new connection should use (the most recent).
   * Throws an error if it is missing secrets.
   */
  getCurrentVersionForNewConnections(service: string): OAuthAppVersion {
    const serviceKey = service.toUpperCase();
    const envVarsByVersion = OAUTH_APP_ENV_VARS_BY_SERVICE[serviceKey as OAuthAppServiceKey];
    if (!envVarsByVersion) {
      throw new Error(`No system OAuth app is configured for service "${serviceKey}"`);
    }
    const maxVersion = max(Object.keys(envVarsByVersion).map(Number));
    if (maxVersion === undefined) {
      throw new Error(`No max OAuth version for service "${serviceKey}"`);
    }
    return maxVersion as OAuthAppVersion;
  }
}
