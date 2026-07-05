import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthType, ConnectorAccount, Prisma } from '@prisma/client';
import {
  createConnectorAccountId,
  isShopifyConnectorExtras,
  parseYouTubeAdditionalChannels,
  QuickBooksConnectorExtras,
  ShopifyConnectorExtras,
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
import { LinearOAuthProvider } from './providers/linear-oauth.provider';
import { NotionOAuthProvider } from './providers/notion-oauth.provider';
import { PipedriveOAuthProvider } from './providers/pipedrive-oauth.provider';
import { QuickBooksOAuthProvider } from './providers/quickbooks-oauth.provider';
import { ShopifyOAuthProvider } from './providers/shopify-oauth.provider';
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

@Injectable()
export class OAuthService {
  private readonly providers: Map<string, OAuthProvider> = new Map();

  constructor(
    private readonly db: DbService,
    private readonly airtableProvider: AirtableOAuthProvider,
    private readonly gohighlevelProvider: GoHighLevelOAuthProvider,
    private readonly notionProvider: NotionOAuthProvider,
    private readonly shopifyProvider: ShopifyOAuthProvider,
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
    this.providers.set('NOTION', this.notionProvider);
    this.providers.set('SHOPIFY', this.shopifyProvider);
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
  async initiateOAuth(
    service: string,
    actor: Actor,
    options: ValidatedOAuthInitiateOptionsDto,
  ): Promise<OAuthInitiateResponse> {
    // Pipedrive OAuth is wired for the private TEST app only; the public prod app
    // isn't live yet. The connect UI already hides OAuth for Pipedrive in production
    // (connectors-metadata.controller); refuse to initiate it here too as a backstop
    // against a crafted request.
    if (service.toUpperCase() === Service.PIPEDRIVE && this.config.isProductionEnvironment()) {
      throw new BadRequestException('Pipedrive OAuth is not available in production');
    }

    const provider = this.providers.get(service);
    if (!provider) {
      throw new BadRequestException(`Unsupported OAuth service: ${service}`);
    }

    // For reauthorization, look up the shop domain from the existing account's extras
    let shopDomain = options.shopDomain;
    if (options.connectorAccountId && service === 'SHOPIFY' && !shopDomain) {
      const existingAccount = await this.db.client.connectorAccount.findUnique({
        where: { id: options.connectorAccountId },
      });
      if (existingAccount && isShopifyConnectorExtras(existingAccount.extras)) {
        shopDomain = existingAccount.extras.shopDomain;
      }
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
      shopDomain,
      quickbooksSandbox: options.quickbooksSandbox,
      zohoDataCenter: options.zohoDataCenter,
      youtubeAdditionalChannels: options.youtubeAdditionalChannels,
      codeVerifier,
      oauthAppVersion,
      ts: Date.now(),
    };
    const state = Buffer.from(JSON.stringify(statePayload)).toString('base64');

    const authUrl = provider.generateAuthUrl(state, credentials, {
      shopDomain,
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
          shopDomain: statePayload.shopDomain,
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
   * Refreshes expired OAuth tokens for a connector account using the stored refresh token.
   * Fetches the account, decrypts credentials, calls the provider's refresh endpoint,
   * and updates the database with the new access token (and optionally new refresh token).
   * Throws if the account is not OAuth-based or lacks a refresh token.
   */
  async refreshOAuthTokens(connectorAccountId: string): Promise<void> {
    const account = await this.db.client.connectorAccount.findUnique({
      where: { id: connectorAccountId },
    });

    if (!account || account.authType !== AuthType.OAUTH) {
      throw new BadRequestException('Invalid OAuth connector account for token refresh');
    }

    const decryptedCredentials = await this.credentialEncryptionService.decryptCredentials(
      account.encryptedCredentials as unknown as EncryptedData,
    );

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
      const tokenResponse = await this.mintClientCredentialsToken(
        account.service,
        provider,
        installIdentifier,
        credentials,
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
      const tokenResponse = await provider.refreshTokens(decryptedCredentials.oauthRefreshToken, credentials, {
        dataCenter: decryptedCredentials.oauthWorkspaceId,
      });
      decryptedCredentials.oauthAccessToken = tokenResponse.access_token;
      decryptedCredentials.oauthRefreshToken = tokenResponse.refresh_token || decryptedCredentials.oauthRefreshToken;
      decryptedCredentials.oauthExpiresAt = this.expiresInToOAuthExpiresAt(tokenResponse.expires_in);
    }

    const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(decryptedCredentials);
    await this.db.client.connectorAccount.update({
      where: { id: connectorAccountId },
      data: { encryptedCredentials },
    });
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
    },
  ) {
    const serviceKey = service.toUpperCase();
    const isShopify = serviceKey === Service.SHOPIFY;
    const isQuickBooks = serviceKey === Service.QUICKBOOKS;
    const isYouTube = serviceKey === Service.YOUTUBE;

    // Load the workbook to get its organizationId (don't rely on actor's organizationId)
    const workbook = await this.db.client.workbook.findUniqueOrThrow({
      where: { id: workbookId },
    });

    // Prepare credentials for encryption
    // For Shopify/QuickBooks, workspace-specific IDs are stored in extras (not encrypted)
    const credentials: DecryptedCredentials = {
      oauthAccessToken: tokenResponse.access_token,
      oauthRefreshToken: tokenResponse.refresh_token,
      oauthExpiresAt: this.expiresInToOAuthExpiresAt(tokenResponse.expires_in),
      oauthWorkspaceId: isShopify || isQuickBooks ? undefined : tokenResponse.workspace_id,
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

    // Store non-sensitive metadata in extras for direct querying (e.g. GDPR shop/redact lookups)
    let extras: ShopifyConnectorExtras | QuickBooksConnectorExtras | YouTubeConnectorExtras | undefined;
    if (isShopify && tokenResponse.workspace_id) {
      extras = { shopDomain: tokenResponse.workspace_id };
    } else if (isQuickBooks && tokenResponse.workspace_id) {
      extras = { realmId: tokenResponse.workspace_id, sandbox: connectionInfo?.quickbooksSandbox ?? false };
    } else if (isYouTube) {
      // Brand/managed channels the OAuth identity doesn't own — parsed from the
      // connect form and listed as extra video tables. Only set when non-empty so
      // listTables' `'additionalChannels' in extras` check stays meaningful.
      const additionalChannels = parseYouTubeAdditionalChannels(connectionInfo?.youtubeAdditionalChannels);
      if (additionalChannels.length > 0) {
        extras = { additionalChannels };
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
    },
  ): Promise<void> {
    const isShopify = connectorAccount.service === 'SHOPIFY';
    const isQuickBooks = connectorAccount.service === 'QUICKBOOKS';

    // Prepare credentials for encryption
    // For Shopify/QuickBooks, workspace-specific IDs are stored in extras (not encrypted)
    const credentials: DecryptedCredentials = {
      oauthAccessToken: tokenResponse.access_token,
      oauthRefreshToken: tokenResponse.refresh_token,
      oauthExpiresAt: this.expiresInToOAuthExpiresAt(tokenResponse.expires_in),
      oauthWorkspaceId: isShopify || isQuickBooks ? undefined : tokenResponse.workspace_id,
      customOAuthClientId:
        connectionInfo?.connectionMethod === 'OAUTH_CUSTOM' ? connectionInfo.customClientId : undefined,
      customOAuthClientSecret:
        connectionInfo?.connectionMethod === 'OAUTH_CUSTOM' ? connectionInfo.customClientSecret : undefined,
    };

    const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(credentials);

    // Store non-sensitive metadata in extras for direct querying
    let extras: ShopifyConnectorExtras | QuickBooksConnectorExtras | undefined;
    if (isShopify && tokenResponse.workspace_id) {
      extras = { shopDomain: tokenResponse.workspace_id };
    } else if (isQuickBooks && tokenResponse.workspace_id) {
      extras = { realmId: tokenResponse.workspace_id };
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

    if (!decryptedCredentials.oauthExpiresAt) {
      return false; // No expiration set, assume valid
    }

    // Add 5 minute buffer to refresh before actual expiration
    const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
    return new Date() >= new Date(new Date(decryptedCredentials.oauthExpiresAt).getTime() - bufferTime);
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
      await this.refreshOAuthTokens(connectorAccountId);

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
