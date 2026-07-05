/**
 * OAuth *app* credential versioning.
 *
 * A refresh token issued by one OAuth app can only be refreshed with THAT app's
 * client_id/secret, so a connector's OAuth credentials can't just be swapped in place —
 * doing so breaks every existing connection at its next token refresh. Instead we version
 * the credentials: every connection records which app generation issued its tokens
 * ({@link ConnectorAccount.oauthAppVersion}), and the credential resolver hands back the
 * matching client_id/secret/redirect for that generation at authorize / exchange / refresh
 * time. New connections are minted at the current generation for their service, so
 * introducing a new app generation affects only new connections while existing ones keep
 * refreshing against the app that issued their refresh token.
 *
 * Today there is a single generation. Rotating a connector onto a different OAuth app is
 * simply the next generation — what each generation maps to lives in
 * {@link OAuthAppCredentialResolver}.
 */

/**
 * The known OAuth app generations, in ascending order. The per-service credential map
 * constrains its version keys to this union, so a service can only declare — and callers
 * can only request — a known generation. A service rolls forward independently by declaring
 * its next generation's env vars; new connections use the newest generation it declares.
 */
export const OAUTH_APP_VERSIONS = [1] as const;

/** A validated OAuth app generation (one of {@link OAUTH_APP_VERSIONS}). */
export type OAuthAppVersion = (typeof OAUTH_APP_VERSIONS)[number];

/** The generation new connections are minted at, and the fallback for missing/unknown values. */
export const DEFAULT_OAUTH_APP_VERSION: OAuthAppVersion = 1;

/**
 * The resolved credentials for one OAuth app generation. This is the ONLY shape the
 * OAuth providers accept for authorize/exchange/refresh — a provider cannot read an
 * un-versioned client_id/secret from the environment on its own, so every credential
 * access is forced to go through {@link OAuthAppCredentialResolver} with an explicit
 * {@link OAuthAppVersion}.
 */
export interface OAuthAppCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The redirect_uri registered on this app generation (must match at exchange time). */
  readonly redirectUri: string;
}

/**
 * Narrow a persisted / wire integer to a validated {@link OAuthAppVersion}.
 *
 * `undefined` (an OAuth `state` minted before this feature shipped, or a row written
 * before the column existed) and any unrecognized value both fall back to
 * {@link DEFAULT_OAUTH_APP_VERSION}. This never throws: a bad value must not be able to
 * hard-fail a token refresh.
 */
export function asOAuthAppVersion(value: number | undefined | null): OAuthAppVersion {
  if (value != null && (OAUTH_APP_VERSIONS as readonly number[]).includes(value)) {
    return value as OAuthAppVersion;
  }
  return DEFAULT_OAUTH_APP_VERSION;
}
