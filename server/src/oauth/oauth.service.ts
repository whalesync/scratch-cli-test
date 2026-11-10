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
  isSalesforceConnectorExtras,
  OAuthStatePayload,
  parseYouTubeAdditionalChannels,
  QuickBooksConnectorExtras,
  SalesforceConnectorExtras,
  ValidatedOAuthInitiateOptionsDto,
  WorkbookId,
  YouTubeConnectorExtras,
} from '@spinner/shared-types';
import { createHash, randomBytes } from 'crypto';
import { capitalize, isEqual, omit } from 'lodash';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { WSLogger } from 'src/logger';
import { PostHogEventName, PostHogService } from 'src/posthog/posthog.service';
import { getServiceDisplayName } from 'src/remote-service/connectors/display-names';
import { splitGoogleSheetsSpreadsheetUrlInput } from 'src/remote-service/connectors/library/google-sheets/google-sheets-url-parsing';
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
import { OAuthPendingAuthorizationStore } from './oauth-pending-authorization-store.service';
import { OAuthProvider, OAuthTokenResponse } from './oauth-provider.interface';
import { AirtableOAuthProvider } from './providers/airtable-oauth.provider';
import { CopperOAuthProvider } from './providers/copper-oauth.provider';
import { GoHighLevelOAuthProvider } from './providers/gohighlevel-oauth.provider';
import { GoogleSheetsOAuthProvider } from './providers/google-sheets-oauth.provider';
import { LinearOAuthProvider } from './providers/linear-oauth.provider';
import { NotionOAuthProvider } from './providers/notion-oauth.provider';
import { PipedriveOAuthProvider } from './providers/pipedrive-oauth.provider';
import { QuickBooksOAuthProvider } from './providers/quickbooks-oauth.provider';
import { SalesforceOAuthProvider } from './providers/salesforce-oauth.provider';
import { SquareOAuthProvider } from './providers/square-oauth.provider';
import { StripeOAuthProvider } from './providers/stripe-oauth.provider';
import { SupabaseOAuthProvider } from './providers/supabase-oauth.provider';
import { WebflowOAuthProvider } from './providers/webflow-oauth.provider';
import { WixOAuthProvider } from './providers/wix-oauth.provider';
import { YouTubeOAuthProvider } from './providers/youtube-oauth.provider';
import { ZohoOAuthProvider } from './providers/zoho-oauth.provider';
import { PendingOAuthAuthorization } from './types';

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

/**
 * Advisory-lock key guarding every read-modify-write of one connection's
 * `encryptedCredentials`. Token refresh is the original (and busiest) writer, so
 * the key keeps its name; any other credential mutation — e.g. the Supabase
 * connector persisting a freshly provisioned per-project role (DEV-11875) — MUST
 * take this same key, or its write can clobber a concurrent refresh's rotated
 * token (and vice versa).
 */
function buildConnectionCredentialsLockKey(connectorAccountId: string): string {
  return `oauth-token-refresh:${connectorAccountId}`;
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
    private readonly salesforceProvider: SalesforceOAuthProvider,
    private readonly stripeProvider: StripeOAuthProvider,
    private readonly squareProvider: SquareOAuthProvider,
    private readonly copperProvider: CopperOAuthProvider,
    private readonly posthogService: PostHogService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
    private readonly scratchGitService: ScratchGitService,
    private readonly config: ScratchConfigService,
    private readonly credentialResolver: OAuthAppCredentialResolver,
    private readonly pendingAuthorizationStore: OAuthPendingAuthorizationStore,
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
    this.providers.set('SALESFORCE', this.salesforceProvider);
    this.providers.set('STRIPE', this.stripeProvider);
    this.providers.set('SQUARE', this.squareProvider);
    this.providers.set('COPPER', this.copperProvider);
  }

  /**
   * Initiates an OAuth authorization flow for a supported external service.
   * Stores everything the callback will act on — user info, the target workbook and
   * (on re-auth) connection, connection preferences, the PKCE verifier — server-side
   * (OAuthPendingAuthorizationStore), then generates the authorization URL that the
   * client should redirect the user to. The `state` on that URL carries only the
   * record's nonce plus the public routing fields in {@link OAuthStatePayload}.
   * Supports both system-managed OAuth apps and custom OAuth client credentials.
   */
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

    checkWorkspacePermissions(actor, options.workbookId as WorkbookId);

    // A re-auth may only target an OAuth connection of this service inside the workbook
    // the caller was just permission-checked for (DEV-12155). Checked here so a bad id
    // fails before the user is sent to the provider; the callback checks it again.
    let connectorAccountToReauthorize: ConnectorAccount | null = null;
    if (options.connectorAccountId) {
      connectorAccountToReauthorize = await this.findConnectorAccountEligibleForReauthorization(
        options.connectorAccountId,
        options.workbookId,
        service,
      );
      if (!connectorAccountToReauthorize) {
        this.logRejectedReauthorizationTarget('OAuthService.initiateOAuth', actor, service, {
          connectorAccountId: options.connectorAccountId,
          workbookId: options.workbookId,
        });
        throw new BadRequestException('Invalid connection for re-authorization');
      }
    }

    // Salesforce sandboxes sign in at a different host. A reconnect doesn't ask again, so it signs in
    // wherever the connection was made, as recorded in its extras.
    const salesforceSandbox =
      options.salesforceSandbox ??
      (isSalesforceConnectorExtras(connectorAccountToReauthorize?.extras)
        ? connectorAccountToReauthorize.extras.sandbox
        : undefined);

    // Generate PKCE values for providers that use it (Airtable, Salesforce)
    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    if (provider.usesPkce?.() === true) {
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

    // Standard base64 of JSON, NOT base64url or a `payload.signature` pair: dusky's redirect
    // page, the web callback pages and desktop all read these routing fields with
    // `JSON.parse(atob(state))`, and `atob` rejects `-`, `_` and `.`.
    const publicRoutingFields: Omit<OAuthStatePayload, 'pendingAuthorizationNonce'> = {
      resultForwardUrl: options.resultForwardUrl,
      service,
      workbookId: options.workbookId,
      returnPage: options.returnPage,
    };

    const pendingAuthorization: PendingOAuthAuthorization = {
      userId: actor.userId,
      organizationId: actor.organizationId,
      workbookId: options.workbookId,
      service,
      connectionMethod,
      customClientId: options.customClientId,
      customClientSecret: options.customClientSecret,
      connectionName: options.connectionName,
      connectorAccountId: options.connectorAccountId,
      quickbooksSandbox: options.quickbooksSandbox,
      zohoDataCenter: options.zohoDataCenter,
      salesforceSandbox,
      youtubeAdditionalChannels: options.youtubeAdditionalChannels,
      googleSheetsSpreadsheetUrls: options.googleSheetsSpreadsheetUrls,
      codeVerifier,
      oauthAppVersion,
      publicRoutingFieldsAsMinted: publicRoutingFields,
    };
    const pendingAuthorizationNonce =
      await this.pendingAuthorizationStore.savePendingAuthorizationAndReturnNonce(pendingAuthorization);

    const publicStatePayload: OAuthStatePayload = { ...publicRoutingFields, pendingAuthorizationNonce };
    const state = Buffer.from(JSON.stringify(publicStatePayload)).toString('base64');

    const authUrl = provider.generateAuthUrl(state, credentials, {
      codeChallenge,
      dataCenter: options.zohoDataCenter,
      sandbox: salesforceSandbox,
    });

    return { authUrl };
  }

  /**
   * Handles the OAuth callback after the user authorizes the application.
   * Consumes the server-side record `initiateOAuth` stored for this connect (the `state`
   * only names it), checks it was started by this caller for this service and workbook,
   * exchanges the authorization code for access/refresh tokens via the provider,
   * and creates — or, on re-auth, updates — the ConnectorAccount with the encrypted credentials.
   *
   * Nothing is exchanged or written until every check has passed.
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

    // The public state is untrusted: its nonce locates the record this server stored at
    // initiate, and its routing fields must match the record's copy. Every field the
    // callback acts on comes from the record.
    let publicStatePayload: Partial<OAuthStatePayload>;
    try {
      publicStatePayload = JSON.parse(
        Buffer.from(callbackData.state, 'base64').toString(),
      ) as Partial<OAuthStatePayload>;
    } catch {
      throw new BadRequestException('Invalid state parameter');
    }

    // Consumed up front, so a state works at most once even if a later check rejects it.
    // A state minted before DEV-12155 has no nonce and lands here too.
    const pendingAuthorization =
      typeof publicStatePayload?.pendingAuthorizationNonce === 'string' &&
      publicStatePayload.pendingAuthorizationNonce.length > 0
        ? await this.pendingAuthorizationStore.consumePendingAuthorizationForUser(
            actor.userId,
            publicStatePayload.pendingAuthorizationNonce,
          )
        : null;
    if (!pendingAuthorization) {
      throw new BadRequestException(
        'This connection request has expired or was already used. Please try connecting again.',
      );
    }

    // The state must come back exactly as initiate minted it. `JSON` drops undefined fields
    // on both sides — the stored copy went through Redis — so the comparison is like for like.
    const receivedPublicRoutingFields = omit(publicStatePayload, 'pendingAuthorizationNonce');
    if (!isEqual(receivedPublicRoutingFields, pendingAuthorization.publicRoutingFieldsAsMinted)) {
      WSLogger.warn({
        source: 'OAuthService.handleOAuthCallback',
        message: 'Rejected an OAuth callback whose state was edited after initiate',
        userId: actor.userId,
        organizationId: actor.organizationId,
        service,
      });
      throw new BadRequestException('Invalid state parameter');
    }

    if (pendingAuthorization.service.toUpperCase() !== service.toUpperCase()) {
      throw new BadRequestException('Invalid state parameter');
    }

    // The store keys records by userId, so this holds by construction; kept as a guard.
    if (pendingAuthorization.userId !== actor.userId) {
      throw new BadRequestException('Invalid state parameter');
    }

    if (pendingAuthorization.organizationId !== actor.organizationId) {
      throw new BadRequestException('Invalid state parameter');
    }

    // Validate workbookId
    const workbook = await this.db.client.workbook.findFirst({
      where: { id: pendingAuthorization.workbookId },
    });
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    checkWorkspacePermissions(actor, pendingAuthorization.workbookId as WorkbookId);

    // Re-checked even though initiate verified it, so the write below can only ever land
    // on an OAuth connection of this service in the permission-checked workbook.
    let existingConnectorAccount: ConnectorAccount | null = null;
    if (pendingAuthorization.connectorAccountId) {
      existingConnectorAccount = await this.findConnectorAccountEligibleForReauthorization(
        pendingAuthorization.connectorAccountId,
        pendingAuthorization.workbookId,
        service,
      );
      if (!existingConnectorAccount) {
        this.logRejectedReauthorizationTarget('OAuthService.handleOAuthCallback', actor, service, {
          connectorAccountId: pendingAuthorization.connectorAccountId,
          workbookId: pendingAuthorization.workbookId,
        });
        throw new BadRequestException('Invalid state parameter');
      }
    }

    // Acquire the access token. Token-acquisition failures (bad/expired code,
    // region mismatch, redirect-uri mismatch, a rejected install) are the
    // provider's fault to explain — surface their message as a 400 so the user
    // sees the reason instead of a generic 500.
    //
    // Resolve the credentials for the SAME OAuth app generation the authorize URL / install
    // link used (recorded at initiate).
    const oauthAppVersion = asOAuthAppVersion(pendingAuthorization.oauthAppVersion);
    const credentials = this.resolveOAuthAppCredentials(
      service,
      oauthAppVersion,
      pendingAuthorization.connectionMethod,
      {
        customClientId: pendingAuthorization.customClientId,
        customClientSecret: pendingAuthorization.customClientSecret,
      },
    );

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
          codeVerifier: pendingAuthorization.codeVerifier,
          dataCenter: pendingAuthorization.zohoDataCenter,
          sandbox: pendingAuthorization.salesforceSandbox,
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
    if (service.toUpperCase() === Service.ZOHO && pendingAuthorization.zohoDataCenter) {
      tokenResponse.workspace_id = pendingAuthorization.zohoDataCenter;
    }

    if (existingConnectorAccount) {
      // Re-auth upgrades the connection to the app generation chosen at initiate, so an
      // explicit reconnect after a cutover moves the user onto the Whalesync app.
      await this.updateOAuthAccount(existingConnectorAccount, actor, tokenResponse, oauthAppVersion, {
        connectionMethod: pendingAuthorization.connectionMethod,
        customClientId: pendingAuthorization.customClientId,
        customClientSecret: pendingAuthorization.customClientSecret,
        connectionName: pendingAuthorization.connectionName,
        googleSheetsSpreadsheetUrls: pendingAuthorization.googleSheetsSpreadsheetUrls,
        salesforceSandbox: pendingAuthorization.salesforceSandbox,
      });

      return { connectorAccountId: existingConnectorAccount.id };
    } else {
      // Create new connector account (include connection method and custom client creds for storage)
      const connectorAccount = await this.createOAuthAccount(
        service,
        pendingAuthorization.workbookId as WorkbookId,
        actor,
        tokenResponse,
        oauthAppVersion,
        {
          connectionMethod: pendingAuthorization.connectionMethod,
          customClientId: pendingAuthorization.customClientId,
          customClientSecret: pendingAuthorization.customClientSecret,
          connectionName: pendingAuthorization.connectionName,
          quickbooksSandbox: pendingAuthorization.quickbooksSandbox,
          salesforceSandbox: pendingAuthorization.salesforceSandbox,
          youtubeAdditionalChannels: pendingAuthorization.youtubeAdditionalChannels,
          googleSheetsSpreadsheetUrls: pendingAuthorization.googleSheetsSpreadsheetUrls,
        },
      );

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
        const lockKey = buildConnectionCredentialsLockKey(connectorAccountId);
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
          // Multi-region providers need their stored host to refresh against (persisted in
          // oauthWorkspaceId): Zoho's data center, Salesforce's org instance URL.
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
   * Apply a read-modify-write to a connection's stored credentials, serialized
   * against every other writer by the same advisory lock the token refresh takes
   * ({@link buildConnectionCredentialsLockKey}).
   *
   * This is the host side of `ConnectorFactoryContext.updateStoredCredentials` —
   * the seam a connector uses when an operation produces a credential the
   * connection must remember. Today's only caller is Supabase, which provisions
   * a per-project database role the first time a project is actually used and has
   * to persist that role's connection string (DEV-11875).
   *
   * `mutateCredentials` runs INSIDE the transaction, against credentials re-read
   * under the lock, and must be cheap and side-effect-free: do the external work
   * (creating the role, fetching the pooler config) BEFORE calling this, then use
   * the mutator only to decide what to store. It returns `null` to write nothing
   * — the way a caller that loses a race adopts the winner's value instead of
   * overwriting it.
   *
   * Resolves to the credentials now in storage: the mutated ones, or the
   * re-read current ones when the mutator declined to write.
   */
  async updateStoredCredentialsUnderConnectionLock(
    connectorAccountId: string,
    mutateCredentials: (
      currentCredentials: DecryptedCredentials,
    ) => DecryptedCredentials | null | Promise<DecryptedCredentials | null>,
  ): Promise<DecryptedCredentials> {
    return this.runWhileHoldingConnectionCredentialsLock(connectorAccountId, async (tx) => {
      const account = await tx.connectorAccount.findUnique({ where: { id: connectorAccountId } });
      if (!account) {
        throw new BadRequestException(`Connection ${connectorAccountId} not found`);
      }

      const currentCredentials = await this.credentialEncryptionService.decryptCredentials(
        account.encryptedCredentials as unknown as EncryptedData,
      );
      const updatedCredentials = await mutateCredentials(currentCredentials);
      if (!updatedCredentials) {
        return currentCredentials;
      }

      const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(updatedCredentials);
      await tx.connectorAccount.update({
        where: { id: connectorAccountId },
        data: { encryptedCredentials: encryptedCredentials as unknown as Prisma.InputJsonValue },
      });
      return updatedCredentials;
    });
  }

  /**
   * Run `workWhileHoldingLock` inside a transaction holding this connection's credentials
   * lock ({@link buildConnectionCredentialsLockKey}), retrying from outside the transaction
   * while another writer holds it — for the same reason the refresh path does not queue
   * inside its transaction (see {@link refreshOAuthTokensUnderConnectionLock}). Every
   * writer of `encryptedCredentials` on an existing connection other than the refresh itself
   * goes through here: the connector seam ({@link updateStoredCredentialsUnderConnectionLock}),
   * re-auth, and the connection PATCH (`ConnectorAccountService.update`).
   *
   * `workWhileHoldingLock` runs inside the transaction, so it must be cheap and must not call
   * out to a vendor: do any network work before taking the lock.
   */
  async runWhileHoldingConnectionCredentialsLock<ResultOfWorkWhileHoldingLock>(
    connectorAccountId: string,
    workWhileHoldingLock: (tx: Prisma.TransactionClient) => Promise<ResultOfWorkWhileHoldingLock>,
  ): Promise<ResultOfWorkWhileHoldingLock> {
    const waitDeadlineMs = Date.now() + OAUTH_REFRESH_LOCK_WAIT_TIMEOUT_MS;

    for (;;) {
      const outcome = await this.db.client.$transaction(
        async (tx): Promise<{ acquiredLock: true; result: ResultOfWorkWhileHoldingLock } | { acquiredLock: false }> => {
          const lockKey = buildConnectionCredentialsLockKey(connectorAccountId);
          const [lockAttempt] = await tx.$queryRaw<
            { acquired: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})::bigint) AS acquired`;
          if (!lockAttempt?.acquired) {
            // Done nothing; the transaction is released immediately.
            return { acquiredLock: false };
          }
          return { acquiredLock: true, result: await workWhileHoldingLock(tx) };
        },
      );
      if (outcome.acquiredLock) {
        return outcome.result;
      }

      if (Date.now() >= waitDeadlineMs) {
        throw new ServiceUnavailableException(
          `Timed out waiting for another in-progress credential update for connection ${connectorAccountId}`,
        );
      }
      await delayMs(OAUTH_REFRESH_LOCK_RETRY_INTERVAL_MS);
    }
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
   * The connection a re-auth may overwrite: an OAuth connection of `service` that lives in
   * `workbookId`. The lookup is scoped by workbook so a connection anywhere else — another
   * workbook, another org — is never loaded at all. Resolves to null when the id is unknown,
   * belongs elsewhere, is for another service, or isn't an OAuth connection; callers answer
   * all of those with the same error so the response doesn't reveal which.
   */
  private async findConnectorAccountEligibleForReauthorization(
    connectorAccountId: string,
    workbookId: string,
    service: string,
  ): Promise<ConnectorAccount | null> {
    const connectorAccountInWorkbook = await this.db.client.connectorAccount.findFirst({
      where: { id: connectorAccountId, workbookId },
    });
    if (
      !connectorAccountInWorkbook ||
      connectorAccountInWorkbook.service !== service.toUpperCase() ||
      connectorAccountInWorkbook.authType !== AuthType.OAUTH
    ) {
      return null;
    }
    return connectorAccountInWorkbook;
  }

  /**
   * A re-auth naming a connection the caller may not overwrite is either a stale client or
   * an attempt to take over someone else's connection (DEV-12155) — keep a record of it.
   */
  private logRejectedReauthorizationTarget(
    source: string,
    actor: Actor,
    service: string,
    target: { connectorAccountId: string; workbookId: string },
  ): void {
    WSLogger.warn({
      source,
      message: 'Rejected OAuth re-authorization of a connection outside the workbook, or of another service',
      userId: actor.userId,
      organizationId: actor.organizationId,
      service,
      connectorAccountId: target.connectorAccountId,
      workbookId: target.workbookId,
    });
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
      salesforceSandbox?: boolean;
      youtubeAdditionalChannels?: string;
      googleSheetsSpreadsheetUrls?: string;
    },
  ) {
    const serviceKey = service.toUpperCase();
    const isQuickBooks = serviceKey === Service.QUICKBOOKS;
    const isYouTube = serviceKey === Service.YOUTUBE;
    const isGoogleSheets = serviceKey === Service.GOOGLE_SHEETS;
    const isSalesforce = serviceKey === Service.SALESFORCE;

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
    let extras:
      | QuickBooksConnectorExtras
      | YouTubeConnectorExtras
      | GoogleSheetsConnectorExtras
      | SalesforceConnectorExtras
      | undefined;
    if (isQuickBooks && tokenResponse.workspace_id) {
      extras = { realmId: tokenResponse.workspace_id, sandbox: connectionInfo?.quickbooksSandbox ?? false };
    } else if (isSalesforce) {
      extras = { sandbox: connectionInfo?.salesforceSandbox ?? false };
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
      salesforceSandbox?: boolean;
    },
  ): Promise<void> {
    const isQuickBooks = connectorAccount.service === 'QUICKBOOKS';
    const isGoogleSheets = connectorAccount.service === Service.GOOGLE_SHEETS;
    const isSalesforce = connectorAccount.service === Service.SALESFORCE;

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
    let extras: QuickBooksConnectorExtras | GoogleSheetsConnectorExtras | SalesforceConnectorExtras | undefined;
    if (isQuickBooks && tokenResponse.workspace_id) {
      extras = { realmId: tokenResponse.workspace_id };
    } else if (isSalesforce) {
      // A re-auth may move the connection between production and sandbox; record where it signed in.
      extras = { sandbox: connectionInfo?.salesforceSandbox ?? false };
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

    // Under the connection's credentials lock, so a re-auth can't interleave with a token
    // refresh (or a Supabase role write) and have one overwrite the other. The new blob
    // replaces the old one outright, so the old one is deliberately never read: re-auth is
    // how a user repairs a connection, and must not depend on its current credentials.
    await this.runWhileHoldingConnectionCredentialsLock(connectorAccount.id, async (tx) => {
      await tx.connectorAccount.update({
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

  private expiresInToOAuthExpiresAt(tokenExpiresIn?: number): string | undefined {
    return tokenExpiresIn ? new Date(Date.now() + tokenExpiresIn * 1000).toISOString() : undefined;
  }
}
