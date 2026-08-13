import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthType, ConnectorAccount, Prisma } from '@prisma/client';
import {
  createConnectorAccountId,
  GoogleSheetsConnectorExtras,
  isGoogleSheetsConnectorExtras,
  parseYouTubeAdditionalChannels,
  QuickBooksConnectorExtras,
  SupabaseProjectCredentials,
  ValidatedOAuthInitiateOptionsDto,
  WorkbookId,
  YouTubeConnectorExtras,
} from '@spinner/shared-types';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { capitalize } from 'lodash';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { WSLogger } from 'src/logger';
import { PostHogEventName, PostHogService } from 'src/posthog/posthog.service';
import { getServiceDisplayName } from 'src/remote-service/connectors/display-names';
import { splitGoogleSheetsSpreadsheetUrlInput } from 'src/remote-service/connectors/library/google-sheets/google-sheets-url-parsing';
import { KnexPGClient } from 'src/remote-service/connectors/library/pg-common';
import {
  buildConnectionString,
  buildCreateUserSQL,
  SupabaseApiClient,
} from 'src/remote-service/connectors/library/supabase';
import { Service } from 'src/remote-service/connectors/service-constants';
import { getDefaultRepoPath, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { checkWorkspacePermissions } from 'src/users/permissions';
import { canCreateDataSource } from 'src/users/subscription-utils';
import { Actor } from 'src/users/types';
import { DbService } from '../db/db.service';
import { DecryptedCredentials } from '../remote-service/connector-account/types/encrypted-credentials.interface';
import { EncryptedData } from '../utils/encryption';
import { OAuthAppCredentialResolver } from './oauth-app-credential-resolver.service';
import { asOAuthAppVersion, OAuthAppCredentials, OAuthAppVersion } from './oauth-app-version';
import { OAuthProvider, OAuthTokenResponse } from './oauth-provider.interface';
import { AirtableOAuthProvider } from './providers/airtable-oauth.provider';
import { GoHighLevelOAuthProvider } from './providers/gohighlevel-oauth.provider';
import { GoogleSheetsOAuthProvider } from './providers/google-sheets-oauth.provider';
import { LinearOAuthProvider } from './providers/linear-oauth.provider';
import { NotionOAuthProvider } from './providers/notion-oauth.provider';
import { PipedriveOAuthProvider } from './providers/pipedrive-oauth.provider';
import { QuickBooksOAuthProvider } from './providers/quickbooks-oauth.provider';
import { SupabaseOAuthProvider } from './providers/supabase-oauth.provider';
import { WebflowOAuthProvider } from './providers/webflow-oauth.provider';
import { WixOAuthProvider } from './providers/wix-oauth.provider';
import { YouTubeOAuthProvider } from './providers/youtube-oauth.provider';
import { ZohoOAuthProvider } from './providers/zoho-oauth.provider';
import { OAuthStatePayload } from './types';

/**
 * Response from the request to get the OAuth authorization redirect URL for a connector.
 */
export interface OAuthInitiateResponse {
  authUrl: string;
}

export interface OAuthCallbackRequest {
  code: string;
  state: string;
  realmId?: string;
  /**
   * Install-scoped identifier for `client_credentials` providers (Wix:
   * `instanceId`). These 2-legged flows return no `code` — the external-install
   * redirect hands back this id, which we mint the first access token from.
   */
  instanceId?: string;
}

/**
 * How early an access token is treated as expired. Refreshing ahead of the real
 * expiry keeps a token from lapsing between the moment it is handed out and the
 * moment the request carrying it reaches the provider.
 */
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Ceiling on a single provider token-endpoint round-trip, enforced by
 * {@link withProviderTokenRequestTimeout}.
 *
 * This is a correctness bound, not a politeness one. The vendor call happens
 * inside the transaction holding the refresh lock, and if it outran
 * {@link OAUTH_TOKEN_REFRESH_TRANSACTION_TIMEOUT_MS} Prisma would roll the
 * transaction back and close it — so the `update` persisting the new tokens would
 * fail with P2028 *after* the provider had already issued them and retired the old
 * refresh token. For the rotating providers (Airtable, Intuit, GoHighLevel,
 * Pipedrive) that strands the connection needing a manual reconnect: precisely the
 * outcome the lock exists to prevent. Failing first, with the stored credentials
 * untouched, is strictly better — the next attempt still holds a live refresh
 * token.
 *
 * Kept tight because this is also how long a Prisma pool connection is held across
 * a network call. Cloud Run runs these services on 1 vCPU and nothing sets
 * `connection_limit`, so the pool is Prisma's default `cpus * 2 + 1` — only a
 * handful of connections, and unrelated queries queue behind whatever is held.
 * Token endpoints answer in well under a second in the normal case.
 */
const OAUTH_PROVIDER_TOKEN_REQUEST_TIMEOUT_MS = 8_000;

/**
 * Ceiling on the refresh transaction, which spans: take the lock (non-blocking),
 * re-read credentials, one provider round-trip, encrypt and write.
 *
 * MUST stay comfortably above {@link OAUTH_PROVIDER_TOKEN_REQUEST_TIMEOUT_MS} —
 * see that constant for what breaks if the provider call can outlast this. The
 * margin covers the reads and the write either side of the provider call. Waiting
 * for a *contended* lock is deliberately not part of this budget: contenders leave
 * the transaction entirely rather than blocking inside it (see
 * {@link refreshOAuthTokensUnderConnectionLock}).
 */
const OAUTH_TOKEN_REFRESH_TRANSACTION_TIMEOUT_MS = 20_000;

/**
 * How long a contender keeps retrying for the refresh lock before giving up. Sized
 * above {@link OAUTH_PROVIDER_TOKEN_REQUEST_TIMEOUT_MS} so a caller normally
 * outlasts the holder's whole vendor round-trip and gets to use its result.
 */
const OAUTH_REFRESH_LOCK_WAIT_TIMEOUT_MS = 15_000;

/** Gap between attempts to take a contended refresh lock. */
const OAUTH_REFRESH_LOCK_RETRY_INTERVAL_MS = 250;

/**
 * How long a refresher waits for a free connection from the pool before giving up.
 * Queueing behind another refresh for the same connection happens *inside* the
 * transaction (on the advisory lock), not here.
 */
const OAUTH_TOKEN_REFRESH_TRANSACTION_MAX_WAIT_MS = 10_000;

/**
 * Whether these credentials' access token has expired or is about to, within
 * {@link ACCESS_TOKEN_EXPIRY_BUFFER_MS}. Pure so it can be evaluated against
 * credentials already read inside a transaction rather than costing another query.
 *
 * Returns false when no expiry is recorded — that is the historical behaviour, and
 * it means such a connection is never proactively refreshed at all.
 */
function isAccessTokenExpired(decryptedCredentials: DecryptedCredentials): boolean {
  if (!decryptedCredentials.oauthExpiresAt) {
    return false; // No expiration set, assume valid
  }
  return Date.now() >= new Date(decryptedCredentials.oauthExpiresAt).getTime() - ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}

/** Resolve after `durationMs`, used to back off between refresh-lock attempts. */
function delayMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/**
 * Bound a provider token-endpoint call so it can never outlast the transaction
 * holding the refresh lock. See {@link OAUTH_PROVIDER_TOKEN_REQUEST_TIMEOUT_MS}
 * for why exceeding that window loses a token pair rather than merely being slow.
 *
 * Enforced here, at the one place every provider is invoked from the locked path,
 * rather than inside each of the twelve provider implementations: this way the
 * bound holds no matter how a provider makes its request, and a provider added
 * later cannot forget it. The trade-off is that racing does not abort the
 * underlying socket, so a vendor that answers late may still have rotated the
 * refresh token — unavoidable for any external call, and no worse than the network
 * failures that could already strand a refresh.
 */
async function withProviderTokenRequestTimeout<T>(tokenRequest: Promise<T>, description: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutRejection = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () =>
        reject(
          new Error(`${description} did not respond within ${OAUTH_PROVIDER_TOKEN_REQUEST_TIMEOUT_MS}ms; not retried`),
        ),
      OAUTH_PROVIDER_TOKEN_REQUEST_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([tokenRequest, timeoutRejection]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

@Injectable()
export class OAuthService {
  private readonly providers: Map<string, OAuthProvider> = new Map();

  constructor(
    private readonly db: DbService,
    private readonly airtableProvider: AirtableOAuthProvider,
    private readonly gohighlevelProvider: GoHighLevelOAuthProvider,
    private readonly googleSheetsProvider: GoogleSheetsOAuthProvider,
    private readonly notionProvider: NotionOAuthProvider,
    private readonly supabaseProvider: SupabaseOAuthProvider,
    private readonly webflowProvider: WebflowOAuthProvider,
    private readonly wixProvider: WixOAuthProvider,
    private readonly youTubeProvider: YouTubeOAuthProvider,
    private readonly quickbooksProvider: QuickBooksOAuthProvider,
    private readonly linearProvider: LinearOAuthProvider,
    private readonly zohoProvider: ZohoOAuthProvider,
    private readonly pipedriveProvider: PipedriveOAuthProvider,
    private readonly posthogService: PostHogService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
    private readonly scratchGitService: ScratchGitService,
    private readonly config: ScratchConfigService,
    private readonly credentialResolver: OAuthAppCredentialResolver,
  ) {
    // Register OAuth providers
    this.providers.set('AIRTABLE', this.airtableProvider);
    this.providers.set('GOHIGHLEVEL', this.gohighlevelProvider);
    this.providers.set('GOOGLE_SHEETS', this.googleSheetsProvider);
    this.providers.set('NOTION', this.notionProvider);
    this.providers.set('SUPABASE', this.supabaseProvider);
    this.providers.set('WEBFLOW', this.webflowProvider);
    this.providers.set('WIX_BLOG', this.wixProvider);
    this.providers.set('YOUTUBE', this.youTubeProvider);
    this.providers.set('QUICKBOOKS', this.quickbooksProvider);
    this.providers.set('LINEAR', this.linearProvider);
    this.providers.set('ZOHO', this.zohoProvider);
    this.providers.set('PIPEDRIVE', this.pipedriveProvider);
  }

  /**
   * Initiates an OAuth authorization flow for a supported external service.
   * Builds a state payload containing user info, connection preferences, and security data,
   * then generates the authorization URL that the client should redirect the user to.
   * Supports both system-managed OAuth apps and custom OAuth client credentials.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async initiateOAuth(
    service: string,
    actor: Actor,
    options: ValidatedOAuthInitiateOptionsDto,
  ): Promise<OAuthInitiateResponse> {
    // Pipedrive OAuth is wired for the private TEST app only; the public prod app
    // isn't approved yet. The connector no longer offers OAuth as a connect option in
    // any environment (pipedrive-connector.ts declares no `oauth` metadata — DEV-11051),
    // but the provider plumbing stays wired for internal test-app use; refuse to initiate
    // in production here as a backstop against a crafted request.
    if (service.toUpperCase() === Service.PIPEDRIVE && this.config.isProductionEnvironment()) {
      throw new BadRequestException('Pipedrive OAuth is not available in production');
    }

    const provider = this.providers.get(service);
    if (!provider) {
      throw new BadRequestException(`Unsupported OAuth service: ${service}`);
    }

    // Embed connection method and optional custom client info into state (base64 JSON)
    // Generate PKCE values for providers that require it (e.g. Airtable)
    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    if (service === 'AIRTABLE') {
      codeVerifier = randomBytes(96).toString('base64url');
      codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    }

    // Which OAuth app generation this new connection (or re-auth) is minted against —
    // legacy Scratch apps vs the unified Whalesync apps. Stamped into state so the
    // callback exchanges the code with the SAME app's credentials and records the
    // version on the connection (so future token refreshes use the matching app).
    const connectionMethod = options.connectionMethod ?? 'OAUTH_SYSTEM';
    const oauthAppVersion = this.credentialResolver.getCurrentVersionForNewConnections(service);
    const credentials = this.resolveOAuthAppCredentials(service, oauthAppVersion, connectionMethod, {
      customClientId: options.customClientId,
      customClientSecret: options.customClientSecret,
    });

    const statePayload: OAuthStatePayload = {
      resultForwardUrl: options.resultForwardUrl,
      redirectPrefix: options.redirectPrefix,
      userId: actor.userId,
      organizationId: actor.organizationId,
      workbookId: options.workbookId,
      service,
      connectionMethod,
      customClientId: options.customClientId,
      customClientSecret: options.customClientSecret,
      connectionName: options.connectionName,
      returnPage: options.returnPage,
      connectorAccountId: options.connectorAccountId,
      quickbooksSandbox: options.quickbooksSandbox,
      zohoDataCenter: options.zohoDataCenter,
      youtubeAdditionalChannels: options.youtubeAdditionalChannels,
      googleSheetsSpreadsheetUrls: options.googleSheetsSpreadsheetUrls,
      codeVerifier,
      oauthAppVersion,
      ts: Date.now(),
    };
    const state = Buffer.from(JSON.stringify(statePayload)).toString('base64');

    const authUrl = provider.generateAuthUrl(state, credentials, {
      codeChallenge,
      dataCenter: options.zohoDataCenter,
    });

    return { authUrl };
  }

  /**
   * Handles the OAuth callback after the user authorizes the application.
   * Decodes and validates the state parameter to ensure the request matches the original user,
   * exchanges the authorization code for access/refresh tokens via the provider,
   * and creates a new ConnectorAccount record with the encrypted credentials.
   */
  async handleOAuthCallback(
    service: string,
    actor: Actor,
    callbackData: OAuthCallbackRequest,
  ): Promise<{ connectorAccountId: string }> {
    const provider = this.providers.get(service);
    if (!provider) {
      throw new BadRequestException(`Unsupported OAuth service: ${service}`);
    }

    // Decode state and validate
    let statePayload: OAuthStatePayload;
    try {
      const decoded = Buffer.from(callbackData.state, 'base64').toString();
      const parsed = JSON.parse(decoded) as OAuthStatePayload;
      statePayload = parsed;
    } catch {
      throw new BadRequestException('Invalid state parameter');
    }

    if (statePayload.userId !== actor.userId) {
      throw new BadRequestException('Invalid state parameter: invalid user Id ${statePayload.userId}');
    }

    if (statePayload.organizationId !== actor.organizationId) {
      throw new BadRequestException('Invalid state parameter: invalid organization Id ${statePayload.organizationId}');
    }

    // Validate workbookId
    const workbook = await this.db.client.workbook.findFirst({
      where: { id: statePayload.workbookId },
    });
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    checkWorkspacePermissions(actor, statePayload.workbookId as WorkbookId);

    let existingConnectorAccount: ConnectorAccount | null = null;
    if (statePayload.connectorAccountId) {
      existingConnectorAccount = await this.db.client.connectorAccount.findUnique({
        where: { id: statePayload.connectorAccountId },
      });
      if (!existingConnectorAccount) {
        throw new BadRequestException(
          'Invalid state parameter: invalid connector account Id ${statePayload.connectorAccountId}',
        );
      }
    }

    // Acquire the access token. Token-acquisition failures (bad/expired code,
    // region mismatch, redirect-uri mismatch, a rejected install) are the
    // provider's fault to explain — surface their message as a 400 so the user
    // sees the reason instead of a generic 500.
    //
    // Resolve the credentials for the SAME OAuth app generation the authorize URL / install
    // link used (carried in state). Missing/older states default to the legacy apps.
    const oauthAppVersion = asOAuthAppVersion(statePayload.oauthAppVersion);
    const credentials = this.resolveOAuthAppCredentials(service, oauthAppVersion, statePayload.connectionMethod, {
      customClientId: statePayload.customClientId,
      customClientSecret: statePayload.customClientSecret,
    });

    let tokenResponse: OAuthTokenResponse;
    try {
      if (provider.strategyKind?.() === 'client_credentials') {
        // 2-legged (client-credentials) connectors (e.g. Wix) return no
        // authorization code — the external-install redirect hands back an
        // install-scoped identifier (Wix: instanceId). Mint the first access token
        // directly from it (using the resolved app-generation credentials); there
        // is no code exchange and no refresh token.
        if (!callbackData.instanceId) {
          throw new Error('The install did not complete (missing instance id). Please try connecting again.');
        }
        tokenResponse = await this.mintClientCredentialsToken(service, provider, callbackData.instanceId, credentials);
      } else {
        tokenResponse = await provider.exchangeCodeForTokens(callbackData.code, credentials, {
          codeVerifier: statePayload.codeVerifier,
          dataCenter: statePayload.zohoDataCenter,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'token exchange failed';
      WSLogger.warn({
        source: 'OAuthService.handleOAuthCallback',
        message: `${service} OAuth callback failed: ${message}`,
      });
      throw new BadRequestException(message);
    }

    // QuickBooks sends realmId (company ID) as a query parameter on the callback URL.
    // Store it in workspace_id so createOAuthAccount can persist it in extras.
    if (service.toLowerCase() === 'quickbooks' && callbackData.realmId) {
      tokenResponse.workspace_id = callbackData.realmId;
    }

    // Zoho is multi-datacenter: persist the user-selected DC (in workspace_id →
    // oauthWorkspaceId) so token refreshes route to the right accounts host and
    // the connector can derive the regional API domain.
    if (service.toUpperCase() === Service.ZOHO && statePayload.zohoDataCenter) {
      tokenResponse.workspace_id = statePayload.zohoDataCenter;
    }

    if (existingConnectorAccount) {
      // Re-auth upgrades the connection to whatever app generation state carried, so an
      // explicit reconnect after a cutover moves the user onto the Whalesync app.
      await this.updateOAuthAccount(existingConnectorAccount, actor, tokenResponse, oauthAppVersion, {
        connectionMethod: statePayload.connectionMethod,
        customClientId: statePayload.customClientId,
        customClientSecret: statePayload.customClientSecret,
        connectionName: statePayload.connectionName,
        googleSheetsSpreadsheetUrls: statePayload.googleSheetsSpreadsheetUrls,
      });

      // Re-run Supabase project setup on re-auth to refresh credentials
      if (service.toLowerCase() === 'supabase') {
        await this.setupSupabaseProjects(existingConnectorAccount.id, tokenResponse.access_token);
      }

      return { connectorAccountId: existingConnectorAccount.id };
    } else {
      // Create new connector account (include connection method and custom client creds for storage)
      const connectorAccount = await this.createOAuthAccount(
        service,
        statePayload.workbookId as WorkbookId,
        actor,
        tokenResponse,
        oauthAppVersion,
        {
          connectionMethod: statePayload.connectionMethod,
          customClientId: statePayload.customClientId,
          customClientSecret: statePayload.customClientSecret,
          connectionName: statePayload.connectionName,
          quickbooksSandbox: statePayload.quickbooksSandbox,
          youtubeAdditionalChannels: statePayload.youtubeAdditionalChannels,
          googleSheetsSpreadsheetUrls: statePayload.googleSheetsSpreadsheetUrls,
        },
      );

      // Auto-setup all Supabase projects inline so the connection is immediately usable
      if (service.toLowerCase() === 'supabase') {
        await this.setupSupabaseProjects(connectorAccount.id, tokenResponse.access_token);
      }

      return { connectorAccountId: connectorAccount.id };
    }
  }

  // -------------------------------------------------------------------------
  // Inbound (marketplace-initiated) OAuth — generic primitives
  //
  // Unlike the app-initiated flow above, here the connector's marketplace starts
  // the OAuth: there is NO Scratch session, workbook, or `state` we minted. The
  // self-contained orchestration (redeem → stash → claim) lives in
  // OAuthInstallService; OAuthService only exposes the two connector-agnostic
  // OAuth primitives it needs. Kept separate from `handleOAuthCallback` so that
  // method's `state.userId === actor.userId` check (which inbound can't satisfy)
  // stays intact for the app-initiated path.
  // -------------------------------------------------------------------------

  /**
   * Exchange a marketplace-initiated ("inbound") OAuth `code` for tokens, for any
   * service with a registered provider. Surfaces provider failures (bad/expired
   * code) as a 400 with the provider's message, mirroring `handleOAuthCallback`.
   *
   * `redirectUri` is the install endpoint the marketplace redirected the code to;
   * it's forwarded to the provider so the token request's `redirect_uri` matches
   * the URL the code was issued for (required by providers that validate it).
   */
  async exchangeInboundCodeForTokens(service: string, code: string, redirectUri?: string): Promise<OAuthTokenResponse> {
    const serviceKey = service.toUpperCase();
    const provider = this.providers.get(serviceKey);
    if (!provider) {
      throw new BadRequestException(`Unsupported OAuth service: ${service}`);
    }
    // Inbound installs always create new connections, so use the current app generation.
    // The marketplace issued the code to the install endpoint, so the token request's
    // redirect_uri must be that endpoint — fold it into the resolved credentials.
    const version = this.credentialResolver.getCurrentVersionForNewConnections(serviceKey);
    const systemCredentials = this.credentialResolver.resolveSystemAppCredentials(serviceKey, version);
    const credentials: OAuthAppCredentials = redirectUri ? { ...systemCredentials, redirectUri } : systemCredentials;
    try {
      return await provider.exchangeCodeForTokens(code, credentials, {});
    } catch (error) {
      const message = error instanceof Error ? error.message : 'token exchange failed';
      WSLogger.warn({
        source: 'OAuthService.exchangeInboundCodeForTokens',
        message: `${service} inbound code exchange failed: ${message}`,
      });
      throw new BadRequestException(message);
    }
  }

  /**
   * Persist an already-exchanged {@link OAuthTokenResponse} into a new
   * ConnectorAccount under `workbookId` — the public entry point over the shared
   * account-creation tail, so the inbound install flow can finalize a claim once
   * it has created (or chosen) the target workbook. Always a system-managed OAuth
   * connection (inbound installs never carry custom client credentials).
   */
  async createConnectorAccountFromOAuthTokens(
    service: string,
    workbookId: WorkbookId,
    actor: Actor,
    tokenResponse: OAuthTokenResponse,
  ): Promise<ConnectorAccount> {
    const oauthAppVersion = this.credentialResolver.getCurrentVersionForNewConnections(service);
    return this.createOAuthAccount(service, workbookId, actor, tokenResponse, oauthAppVersion, {
      connectionMethod: 'OAUTH_SYSTEM',
    });
  }

  /**
   * Refreshes OAuth tokens for a connector account using the stored refresh token,
   * unconditionally — the caller has decided a refresh is wanted. Serialized per
   * connection; see {@link refreshOAuthTokensUnderConnectionLock}.
   * Throws if the account is not OAuth-based or lacks a refresh token.
   */
  async refreshOAuthTokens(connectorAccountId: string): Promise<void> {
    await this.refreshOAuthTokensUnderConnectionLock(connectorAccountId, {
      skipIfAnotherRefreshAlreadySucceeded: false,
    });
  }

  /**
   * Refresh this connection's tokens while holding a per-connection lock, so only
   * one refresh anywhere in the fleet is ever in flight for a given connection.
   *
   * **Why a database lock and not an in-process guard.** Refreshing is a
   * read-modify-write of `encryptedCredentials`: read the refresh token, hand it to
   * the provider, persist what comes back. Most providers issue a *new* refresh
   * token and retire the one presented — Airtable (single-use), Intuit, GoHighLevel
   * and Pipedrive all rotate. So two racing refreshes both read refresh token `A`;
   * the winner exchanges it for `B` and stores it; the loser then exchanges the
   * already-consumed `A` (failing, or succeeding and yielding `C`) and overwrites
   * `B`. Either way the connection is left holding a refresh token the provider has
   * retired, and the user has to reconnect. Prod runs two API and two worker
   * instances, so an in-process guard cannot see the other three; only a lock in
   * shared state can. `pg_advisory_xact_lock` is the same primitive
   * `SyncDraftService` uses, and it releases automatically on commit or rollback.
   *
   * Once the lock is held, credentials are re-read **inside** the transaction: the
   * winner may have just rotated them, so anything read before the lock is
   * potentially a retired token. With `skipIfAnotherRefreshAlreadySucceeded`, a
   * caller that only wanted a *usable* token (see {@link getValidAccessToken})
   * returns without burning a refresh token at all when the winner already
   * delivered one.
   *
   * **Contenders wait outside the transaction.** The lock is taken with
   * `pg_try_advisory_xact_lock`, which answers immediately, rather than the
   * blocking `pg_advisory_xact_lock`. Blocking would have queued *inside* the
   * transaction, which costs two things we can't afford: the wait would eat the
   * same budget as the provider call (so a caller could acquire the lock with
   * seconds left, start an 8-second request, and lose the result to P2028 — the
   * very stranding this guards against), and it would pin a Prisma pool connection
   * for the whole wait. That pool is Prisma's default `cpus * 2 + 1` on a 1-vCPU
   * Cloud Run instance, so connections parked on a lock are connections unrelated
   * queries can't have. Losing the race therefore ends the transaction at once and
   * retries from outside, holding nothing.
   */
  private async refreshOAuthTokensUnderConnectionLock(
    connectorAccountId: string,
    options: { skipIfAnotherRefreshAlreadySucceeded: boolean },
  ): Promise<void> {
    const waitDeadlineMs = Date.now() + OAUTH_REFRESH_LOCK_WAIT_TIMEOUT_MS;

    for (;;) {
      if (await this.attemptRefreshWhileHoldingConnectionLock(connectorAccountId, options)) {
        return;
      }

      // Someone else holds the lock. Everything below runs with no transaction and
      // no pool connection held.
      if (options.skipIfAnotherRefreshAlreadySucceeded && !(await this.isTokenExpired(connectorAccountId))) {
        // The holder already published a usable token — that is all this caller wanted.
        return;
      }

      if (Date.now() >= waitDeadlineMs) {
        throw new ServiceUnavailableException(
          `Timed out waiting for another in-progress token refresh for connection ${connectorAccountId}`,
        );
      }

      await delayMs(OAUTH_REFRESH_LOCK_RETRY_INTERVAL_MS);
    }
  }

  /**
   * One attempt at the guarded refresh. Returns false — having done nothing and
   * released the transaction immediately — when another refresher holds the lock.
   */
  private async attemptRefreshWhileHoldingConnectionLock(
    connectorAccountId: string,
    options: { skipIfAnotherRefreshAlreadySucceeded: boolean },
  ): Promise<boolean> {
    return this.db.client.$transaction(
      async (tx) => {
        // Transaction-scoped lock (auto-released on commit/rollback), keyed by the
        // connection. Non-blocking: see the caller for why we must not queue here.
        const lockKey = `oauth-token-refresh:${connectorAccountId}`;
        const [lockAttempt] = await tx.$queryRaw<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})::bigint) AS acquired`;
        if (!lockAttempt?.acquired) {
          return false;
        }

        // Re-read under the lock — a refresh that completed while we queued has
        // already rotated these, and the pre-lock copy would be a retired token.
        const account = await tx.connectorAccount.findUnique({ where: { id: connectorAccountId } });

        if (!account || account.authType !== AuthType.OAUTH) {
          throw new BadRequestException('Invalid OAuth connector account for token refresh');
        }

        const decryptedCredentials = await this.credentialEncryptionService.decryptCredentials(
          account.encryptedCredentials as unknown as EncryptedData,
        );

        if (options.skipIfAnotherRefreshAlreadySucceeded && !isAccessTokenExpired(decryptedCredentials)) {
          // Another process won the race and stored a usable token. Taking our turn
          // would spend a refresh token for nothing.
          WSLogger.info({
            source: 'OAuthService.attemptRefreshWhileHoldingConnectionLock',
            message: 'Skipping refresh — another refresh for this connection already produced a valid access token',
            connectorAccountId,
            service: account.service,
          });
          return true;
        }

        const provider = this.providers.get(account.service);
        if (!provider) {
          throw new BadRequestException(`No OAuth provider found for service: ${account.service}`);
        }

        // Both re-mint and refresh MUST use the credentials of the OAuth app that issued this
        // connection's tokens — the connection records which app generation that was, so
        // swapping the current app never breaks existing connections. Custom (BYO) apps use
        // their stored client id/secret (also fixes the prior bug where custom creds were
        // ignored on refresh).
        const credentials = this.resolveOAuthAppCredentialsForConnection(account, decryptedCredentials);

        if (provider.strategyKind?.() === 'client_credentials') {
          // 2-legged (client-credentials) connectors (e.g. Wix) have no refresh token —
          // "refresh" is a re-mint from the stored install identifier (oauthWorkspaceId),
          // using that app generation's credentials.
          const installIdentifier = decryptedCredentials.oauthWorkspaceId;
          if (!installIdentifier) {
            // A connection created before this identifier was captured (e.g. a legacy
            // Wix custom-auth account) can't be re-minted and must be reconnected.
            throw new BadRequestException('This connection is missing its install identifier and must be reconnected.');
          }
          const tokenResponse = await withProviderTokenRequestTimeout(
            this.mintClientCredentialsToken(account.service, provider, installIdentifier, credentials),
            `${account.service} token mint`,
          );
          decryptedCredentials.oauthAccessToken = tokenResponse.access_token;
          decryptedCredentials.oauthExpiresAt = this.expiresInToOAuthExpiresAt(tokenResponse.expires_in);
          // No refresh token to persist for client-credentials.
        } else {
          if (!decryptedCredentials.oauthRefreshToken) {
            throw new BadRequestException('No refresh token available');
          }
          // Multi-region providers (Zoho) need the stored data center to refresh
          // against the correct regional accounts host (persisted in oauthWorkspaceId).
          const tokenResponse = await withProviderTokenRequestTimeout(
            provider.refreshTokens(decryptedCredentials.oauthRefreshToken, credentials, {
              dataCenter: decryptedCredentials.oauthWorkspaceId,
            }),
            `${account.service} token refresh`,
          );
          decryptedCredentials.oauthAccessToken = tokenResponse.access_token;
          decryptedCredentials.oauthRefreshToken =
            tokenResponse.refresh_token || decryptedCredentials.oauthRefreshToken;
          decryptedCredentials.oauthExpiresAt = this.expiresInToOAuthExpiresAt(tokenResponse.expires_in);
        }

        const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(decryptedCredentials);
        await tx.connectorAccount.update({
          where: { id: connectorAccountId },
          data: { encryptedCredentials },
        });
        return true;
      },
      {
        // The provider's token endpoint is called while the lock is held, so the
        // transaction has to outlast a vendor round-trip — but still bound it,
        // since an indefinitely hung refresh would block every other refresher for
        // this connection and pin a pool connection while doing it.
        timeout: OAUTH_TOKEN_REFRESH_TRANSACTION_TIMEOUT_MS,
        maxWait: OAUTH_TOKEN_REFRESH_TRANSACTION_MAX_WAIT_MS,
      },
    );
  }

  /**
   * Mint a fresh access token for a 2-legged (client-credentials) provider — e.g.
   * Wix, whose token endpoint takes the app's `client_id`/`client_secret` plus the
   * install-scoped `instanceId` and returns a short-lived bearer token with no
   * refresh token. `installIdentifier` is that install-scoped id (Wix: instanceId),
   * captured on the external-install redirect and persisted in `oauthWorkspaceId`.
   * `credentials` are the resolved app-generation credentials — they MUST be the app
   * the install was created under, since a token is minted from the app's own secret
   * plus the install id (a different generation cannot mint for another app's install).
   * Both the initial connect and every later re-mint route through here.
   */
  private async mintClientCredentialsToken(
    service: string,
    provider: OAuthProvider,
    installIdentifier: string,
    credentials: OAuthAppCredentials,
  ): Promise<OAuthTokenResponse> {
    if (provider.strategyKind?.() !== 'client_credentials' || !provider.mintTokenFromInstall) {
      throw new BadRequestException(`${service} does not use client-credentials authentication`);
    }
    return provider.mintTokenFromInstall(installIdentifier, credentials);
  }

  /**
   * Create new OAuth connector account with OAuth data.
   */
  private async createOAuthAccount(
    service: string,
    workbookId: WorkbookId,
    actor: Actor,
    tokenResponse: OAuthTokenResponse,
    oauthAppVersion: OAuthAppVersion,
    connectionInfo?: {
      connectionMethod: 'OAUTH_SYSTEM' | 'OAUTH_CUSTOM';
      customClientId?: string;
      customClientSecret?: string;
      connectionName?: string;
      quickbooksSandbox?: boolean;
      youtubeAdditionalChannels?: string;
      googleSheetsSpreadsheetUrls?: string;
    },
  ) {
    const serviceKey = service.toUpperCase();
    const isQuickBooks = serviceKey === Service.QUICKBOOKS;
    const isYouTube = serviceKey === Service.YOUTUBE;
    const isGoogleSheets = serviceKey === Service.GOOGLE_SHEETS;

    // Load the workbook to get its organizationId (don't rely on actor's organizationId)
    const workbook = await this.db.client.workbook.findUniqueOrThrow({
      where: { id: workbookId },
    });

    // Prepare credentials for encryption
    // For QuickBooks, workspace-specific IDs are stored in extras (not encrypted)
    const credentials: DecryptedCredentials = {
      oauthAccessToken: tokenResponse.access_token,
      oauthRefreshToken: tokenResponse.refresh_token,
      oauthExpiresAt: this.expiresInToOAuthExpiresAt(tokenResponse.expires_in),
      oauthWorkspaceId: isQuickBooks ? undefined : tokenResponse.workspace_id,
      customOAuthClientId:
        connectionInfo?.connectionMethod === 'OAUTH_CUSTOM' ? connectionInfo.customClientId : undefined,
      customOAuthClientSecret:
        connectionInfo?.connectionMethod === 'OAUTH_CUSTOM' ? connectionInfo.customClientSecret : undefined,
    };

    const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(credentials);

    const numExistingDataSources = await this.db.client.connectorAccount.count({
      where: { workbookId, service: serviceKey },
    });

    if (!canCreateDataSource(actor.subscriptionStatus, numExistingDataSources)) {
      throw new ForbiddenException(
        `You have reached the maximum number of ${getServiceDisplayName(serviceKey)} data sources for your subscription`,
      );
    }

    // Create new account
    const accountId = createConnectorAccountId();
    const repoPath = getDefaultRepoPath(workbook.organizationId, workbookId, accountId);

    // Store non-sensitive metadata in extras for direct querying
    let extras: QuickBooksConnectorExtras | YouTubeConnectorExtras | GoogleSheetsConnectorExtras | undefined;
    if (isQuickBooks && tokenResponse.workspace_id) {
      extras = { realmId: tokenResponse.workspace_id, sandbox: connectionInfo?.quickbooksSandbox ?? false };
    } else if (isYouTube) {
      // Brand/managed channels the OAuth identity doesn't own — parsed from the
      // connect form and listed as extra video tables. Only set when non-empty so
      // listTables' `'additionalChannels' in extras` check stays meaningful.
      const additionalChannels = parseYouTubeAdditionalChannels(connectionInfo?.youtubeAdditionalChannels);
      if (additionalChannels.length > 0) {
        extras = { additionalChannels };
      }
    } else if (isGoogleSheets) {
      // Spreadsheet URL rows from the connect form, stored VERBATIM — the
      // spreadsheets-only scope can't browse Drive, so this is the table
      // picker's "known spreadsheets" list (ids derived at read time). Only set
      // when non-empty so a URL-less connect (e.g. Whalesync-initiated Live
      // Export, which bypasses the form) leaves extras null.
      const spreadsheetUrls = splitGoogleSheetsSpreadsheetUrlInput(connectionInfo?.googleSheetsSpreadsheetUrls);
      if (spreadsheetUrls.length > 0) {
        extras = { spreadsheetUrls };
      }
    }

    const newConnectorAccount = await this.db.client.connectorAccount.create({
      data: {
        id: accountId,
        userId: actor.userId,
        workbookId: workbookId,
        service: serviceKey,
        displayName:
          connectionInfo?.connectionName ??
          `${capitalize(service)} (${connectionInfo?.connectionMethod === 'OAUTH_CUSTOM' ? 'Private OAuth' : 'OAuth'})`,
        authType: AuthType.OAUTH,
        oauthAppVersion,
        repoPath,
        encryptedCredentials: encryptedCredentials as Prisma.InputJsonValue,
        extras: extras as Prisma.InputJsonValue | undefined,
        healthStatus: 'OK', // assume healthy because this connection is created via a successful oauth flow
        healthStatusLastCheckedAt: new Date(),
      },
    });

    this.posthogService.captureEvent(PostHogEventName.CONNECTOR_ACCOUNT_CREATED, actor, {
      service: serviceKey,
      authType: AuthType.OAUTH,
      healthStatus: 'OK',
    });

    // Init the connection's dedicated git repo immediately
    try {
      await this.scratchGitService.initRepo(repoPath);
    } catch (err) {
      WSLogger.error({
        source: 'OAuthService.createOAuthAccount',
        message: 'Failed to init git repo for OAuth connection',
        error: err,
        workbookId,
        connectorAccountId: accountId,
      });
    }

    return newConnectorAccount;
  }

  private async updateOAuthAccount(
    connectorAccount: ConnectorAccount,
    actor: Actor,
    tokenResponse: OAuthTokenResponse,
    oauthAppVersion: OAuthAppVersion,
    connectionInfo?: {
      connectionMethod: 'OAUTH_SYSTEM' | 'OAUTH_CUSTOM';
      customClientId?: string;
      customClientSecret?: string;
      connectionName?: string;
      googleSheetsSpreadsheetUrls?: string;
    },
  ): Promise<void> {
    const isQuickBooks = connectorAccount.service === 'QUICKBOOKS';
    const isGoogleSheets = connectorAccount.service === Service.GOOGLE_SHEETS;

    // Prepare credentials for encryption
    // For QuickBooks, workspace-specific IDs are stored in extras (not encrypted)
    const credentials: DecryptedCredentials = {
      oauthAccessToken: tokenResponse.access_token,
      oauthRefreshToken: tokenResponse.refresh_token,
      oauthExpiresAt: this.expiresInToOAuthExpiresAt(tokenResponse.expires_in),
      oauthWorkspaceId: isQuickBooks ? undefined : tokenResponse.workspace_id,
      customOAuthClientId:
        connectionInfo?.connectionMethod === 'OAUTH_CUSTOM' ? connectionInfo.customClientId : undefined,
      customOAuthClientSecret:
        connectionInfo?.connectionMethod === 'OAUTH_CUSTOM' ? connectionInfo.customClientSecret : undefined,
    };

    const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(credentials);

    // Store non-sensitive metadata in extras for direct querying
    let extras: QuickBooksConnectorExtras | GoogleSheetsConnectorExtras | undefined;
    if (isQuickBooks && tokenResponse.workspace_id) {
      extras = { realmId: tokenResponse.workspace_id };
    } else if (isGoogleSheets && connectionInfo?.googleSheetsSpreadsheetUrls) {
      // Re-auth with URLs typed on the form: UNION into the existing rows (the
      // reconnect form isn't prefilled, so replace semantics would silently
      // drop previously-connected spreadsheets). Dedupes by parsed id, existing
      // rows first. Managing/removing rows lives in Edit Connection instead.
      const existingSpreadsheetUrlRows = isGoogleSheetsConnectorExtras(connectorAccount.extras)
        ? connectorAccount.extras.spreadsheetUrls
        : [];
      const mergedSpreadsheetUrls = splitGoogleSheetsSpreadsheetUrlInput(
        [...existingSpreadsheetUrlRows, connectionInfo.googleSheetsSpreadsheetUrls].join('\n'),
      );
      if (mergedSpreadsheetUrls.length > 0) {
        extras = { spreadsheetUrls: mergedSpreadsheetUrls };
      }
    }

    await this.db.client.connectorAccount.update({
      where: { id: connectorAccount.id },
      data: {
        encryptedCredentials: encryptedCredentials as Prisma.InputJsonValue,
        // Re-auth re-mints against the current app generation — record it so future
        // refreshes use that app (this is how an explicit reconnect upgrades a
        // legacy connection onto the unified Whalesync app).
        oauthAppVersion,
        ...(extras ? { extras: { ...extras } } : {}),
        healthStatus: 'OK', // assume healthy because this connection is created via a successful oauth flow
        healthStatusLastCheckedAt: new Date(),
      },
    });

    this.posthogService.captureEvent(PostHogEventName.CONNECTOR_ACCOUNT_REAUTHORIZED, actor, {
      service: connectorAccount.service,
      authType: AuthType.OAUTH,
      healthStatus: 'OK',
    });
  }

  /**
   * Checks whether the OAuth access token for a connector account has expired or will expire soon.
   * Uses a 5-minute buffer to proactively refresh tokens before they actually expire,
   * preventing failed API calls due to race conditions. Returns false if no expiration is set.
   */
  async isTokenExpired(connectorAccountId: string): Promise<boolean> {
    const account = await this.db.client.connectorAccount.findUnique({
      where: { id: connectorAccountId },
      select: { encryptedCredentials: true },
    });

    if (!account?.encryptedCredentials) {
      return false; // No credentials, assume valid
    }

    const decryptedCredentials = await this.credentialEncryptionService.decryptCredentials(
      account.encryptedCredentials as unknown as EncryptedData,
    );

    return isAccessTokenExpired(decryptedCredentials);
  }

  /**
   * Retrieves a valid OAuth access token for making API calls to external services.
   * Automatically checks token expiration and refreshes if needed before returning.
   * This is the primary method other services should use to obtain tokens for API requests.
   */
  async getValidAccessToken(connectorAccountId: string): Promise<string> {
    const account = await this.db.client.connectorAccount.findUnique({
      where: { id: connectorAccountId },
    });

    if (!account || account.authType !== AuthType.OAUTH) {
      throw new BadRequestException('Invalid OAuth account');
    }

    const decryptedCredentials = await this.credentialEncryptionService.decryptCredentials(
      account.encryptedCredentials as unknown as EncryptedData,
    );

    if (!decryptedCredentials.oauthAccessToken) {
      throw new UnauthorizedException('No access token available');
    }

    // Check if token needs refresh
    if (await this.isTokenExpired(connectorAccountId)) {
      // This caller wants a *usable* token, not a refresh for its own sake: if a
      // concurrent refresh already delivered one, take it rather than spending
      // another (often single-use) refresh token.
      await this.refreshOAuthTokensUnderConnectionLock(connectorAccountId, {
        skipIfAnotherRefreshAlreadySucceeded: true,
      });

      // Fetch updated account with new token
      const updatedAccount = await this.db.client.connectorAccount.findUnique({
        where: { id: connectorAccountId },
      });

      if (!updatedAccount) {
        throw new UnauthorizedException('Failed to refresh access token');
      }

      const updatedCredentials = await this.credentialEncryptionService.decryptCredentials(
        updatedAccount.encryptedCredentials as unknown as EncryptedData,
      );

      if (!updatedCredentials.oauthAccessToken) {
        throw new UnauthorizedException('Failed to refresh access token');
      }

      return updatedCredentials.oauthAccessToken;
    }

    return decryptedCredentials.oauthAccessToken;
  }

  /**
   * Resolve the OAuth app credentials to use for a NEW connection or a re-auth, given
   * the chosen app generation and (for custom/BYO apps) the user-supplied client
   * id/secret carried in the OAuth state. Centralizes the "system app at version N vs
   * custom app" decision so the initiate and callback paths stay in lock-step.
   */
  private resolveOAuthAppCredentials(
    service: string,
    oauthAppVersion: OAuthAppVersion,
    connectionMethod: 'OAUTH_SYSTEM' | 'OAUTH_CUSTOM',
    custom: { customClientId?: string; customClientSecret?: string },
  ): OAuthAppCredentials {
    if (connectionMethod === 'OAUTH_CUSTOM') {
      if (!custom.customClientId || !custom.customClientSecret) {
        throw new BadRequestException('Custom OAuth connection requires a client id and secret');
      }
      return this.credentialResolver.resolveCustomAppCredentials(custom.customClientId, custom.customClientSecret);
    }
    return this.credentialResolver.resolveSystemAppCredentials(service, oauthAppVersion);
  }

  /**
   * Resolve the OAuth app credentials for an EXISTING connection (the refresh path). A
   * connection with stored custom (BYO) client creds uses those; otherwise it uses the
   * system app of the generation stamped on the connection at connect time.
   */
  private resolveOAuthAppCredentialsForConnection(
    account: ConnectorAccount,
    decryptedCredentials: DecryptedCredentials,
  ): OAuthAppCredentials {
    if (decryptedCredentials.customOAuthClientId && decryptedCredentials.customOAuthClientSecret) {
      return this.credentialResolver.resolveCustomAppCredentials(
        decryptedCredentials.customOAuthClientId,
        decryptedCredentials.customOAuthClientSecret,
      );
    }
    return this.credentialResolver.resolveSystemAppCredentials(
      account.service,
      asOAuthAppVersion(account.oauthAppVersion),
    );
  }

  /**
   * Auto-setup all active Supabase projects for a connector account.
   * Creates a dedicated DB role per project, retrieves pooler configs,
   * tests each connection, and stores the results in encrypted credentials.
   */
  private async setupSupabaseProjects(connectorAccountId: string, accessToken: string): Promise<void> {
    try {
      const apiClient = new SupabaseApiClient(accessToken);
      const allProjects = await apiClient.getProjects();
      const activeProjects = allProjects.filter((p) => p.status === 'ACTIVE_HEALTHY');

      if (activeProjects.length === 0) {
        WSLogger.warn({
          source: 'OAuthService',
          message: 'No active Supabase projects found during auto-setup',
          connectorAccountId,
        });
        return;
      }

      const configuredProjects: SupabaseProjectCredentials[] = [];

      for (const project of activeProjects) {
        try {
          const dbUsername = `scratch_svc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
          const dbPassword = randomUUID() + randomUUID().replace(/-/g, '');

          const createUserSQL = buildCreateUserSQL(dbUsername, dbPassword);
          await apiClient.executeQuery(project.id, createUserSQL);

          const poolerConfigs = await apiClient.getPoolerConfig(project.id);
          if (!poolerConfigs || poolerConfigs.length === 0) {
            WSLogger.warn({
              source: 'OAuthService',
              message: `No pooler config for Supabase project ${project.name} (${project.id}), skipping`,
              connectorAccountId,
            });
            continue;
          }

          const connectionString = buildConnectionString(
            poolerConfigs[0].connection_string,
            dbUsername,
            dbPassword,
            project.id,
          );

          // Verify the connection works
          const pgClient = new KnexPGClient(connectionString, { sslNoVerify: true });
          try {
            await pgClient.testQuery();
          } finally {
            await pgClient.dispose().catch(() => {});
          }

          configuredProjects.push({
            projectRef: project.id,
            projectName: project.name,
            connectionString,
            dbUsername,
            dbPassword,
          });
        } catch (error) {
          WSLogger.warn({
            source: 'OAuthService',
            message: `Failed to setup Supabase project ${project.name} (${project.id}): ${error instanceof Error ? error.message : String(error)}`,
            connectorAccountId,
          });
          // Continue with remaining projects
        }
      }

      // Update credentials with the configured projects
      const account = await this.db.client.connectorAccount.findUnique({
        where: { id: connectorAccountId },
      });
      if (!account) return;

      const decryptedCredentials = await this.credentialEncryptionService.decryptCredentials(
        account.encryptedCredentials as unknown as EncryptedData,
      );
      decryptedCredentials.supabaseProjects = configuredProjects;

      const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(decryptedCredentials);
      await this.db.client.connectorAccount.update({
        where: { id: connectorAccountId },
        data: { encryptedCredentials: encryptedCredentials as unknown as Prisma.InputJsonValue },
      });

      WSLogger.info({
        source: 'OAuthService',
        message: `Supabase auto-setup complete: ${configuredProjects.length}/${activeProjects.length} projects configured`,
        connectorAccountId,
      });
    } catch (error) {
      WSLogger.error({
        source: 'OAuthService',
        message: `Supabase auto-setup failed: ${error instanceof Error ? error.message : String(error)}`,
        connectorAccountId,
        error,
      });
      // Don't throw — the account is created, health check will fail and user can retry
    }
  }

  private expiresInToOAuthExpiresAt(tokenExpiresIn?: number): string | undefined {
    return tokenExpiresIn ? new Date(Date.now() + tokenExpiresIn * 1000).toISOString() : undefined;
  }
}
