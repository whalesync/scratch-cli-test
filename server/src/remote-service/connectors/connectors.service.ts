import { Injectable } from '@nestjs/common';
import { ConnectorAccount } from '@prisma/client';
import { DataFolderOptions, Service } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { JsonSafeObject } from 'src/utils/objects';
import { ExperimentsService } from '../../experiments/experiments.service';
import { AllFeatureFlags } from '../../experiments/flags';
import { OAuthService } from '../../oauth/oauth.service';
import { RateLimiterFactory } from '../../rate-limiter/rate-limiter-factory.service';
import { DecryptedCredentials } from '../connector-account/types/encrypted-credentials.interface';
import { AuthParser, Connector } from './connector';
import { ConnectorAuthTokenProvider } from './connector-auth-token';
import { connectorRegistry } from './connector-registry';
import { ConnectorInstantiationError } from './error';

// Side-effect import: triggers connector self-registration
import './library';

/**
 * How long a resolved OAuth access token is reused before the provider re-reads
 * the connection's credentials. `OAuthService.getValidAccessToken` refreshes a
 * token five minutes ahead of its real expiry, so a one-minute reuse window still
 * leaves at least four minutes of validity on every token handed out — while
 * keeping a high-throughput job from issuing a credential read per API call.
 */
const OAUTH_ACCESS_TOKEN_REUSE_WINDOW_MS = 60_000;

@Injectable()
export class ConnectorsService {
  /**
   * In-flight `getValidAccessToken` calls keyed by connector account, shared by
   * every connector instance this singleton service builds. See
   * {@link createOAuthAccessTokenProvider} for why the coalescing has to live here
   * rather than in each provider's closure. Entries are deleted as soon as the
   * resolution settles, so this never holds a token — only a pending promise.
   */
  private readonly inFlightAccessTokenResolutionByConnectorAccountId = new Map<string, Promise<string>>();

  constructor(
    private readonly oauthService: OAuthService,
    private readonly rateLimiterFactory: RateLimiterFactory,
    private readonly dbService: DbService,
    private readonly experimentsService: ExperimentsService,
  ) {}

  getAuthParser(params: { service: Service }): AuthParser | undefined {
    const reg = connectorRegistry.get(params.service);
    return reg?.createAuthParser?.();
  }

  async getConnector(params: {
    service: Service;
    connectorAccount: ConnectorAccount | null;
    decryptedCredentials: DecryptedCredentials | null;
    userId?: string;
  }): Promise<Connector<string, JsonSafeObject>> {
    const { service, connectorAccount, decryptedCredentials, userId } = params;

    const reg = connectorRegistry.get(service);
    if (!reg) {
      throw new ConnectorInstantiationError(`Unsupported service: ${String(service)}`, service);
    }

    return reg.createConnector({
      connectorAccount: connectorAccount
        ? {
            id: connectorAccount.id,
            authType: connectorAccount.authType,
            extras: connectorAccount.extras as Record<string, unknown> | null,
            version: connectorAccount.version,
          }
        : null,
      decryptedCredentials,
      userId,
      createOAuthAccessTokenProvider: (id) => this.createOAuthAccessTokenProvider(id),
      createRateLimiter: (id) => this.rateLimiterFactory.createLimiter({ service, connectorAccountId: id }),
      getFolderOptionsByTableId: (id, tableId) => this.lookupFolderOptions(id, tableId),
      listFolderTableIds: (id) => this.listFolderTableIds(id),
      isFeatureEnabled: (flagKey) => this.evaluateFeatureFlagForUser(flagKey, userId),
    });
  }

  /**
   * Implementation of `ConnectorFactoryContext.createOAuthAccessTokenProvider`.
   *
   * `OAuthService.getValidAccessToken` already refreshes an access token five
   * minutes before it expires — the bug it could not fix on its own was that
   * connectors called it exactly once, at instantiation, and then reused that
   * string for the whole job (DEV-11270). Handing connectors this provider instead
   * lets them re-resolve the token per outbound request, so a publish/pull/sync
   * that runs past the provider's token lifetime picks the refreshed token up.
   *
   * Two properties keep the per-request call cheap:
   *   - a resolved token is reused for {@link OAUTH_ACCESS_TOKEN_REUSE_WINDOW_MS}
   *     before the credentials are read again. This reuse window lives in the
   *     returned closure, i.e. it is scoped to the one connector instance this
   *     factory context is building, so a newly instantiated connector always
   *     starts from the stored credential and a connection re-authed elsewhere is
   *     picked up by the next job.
   *   - callers that do reach the credential store share one in-flight resolution
   *     per connection, via
   *     {@link inFlightAccessTokenResolutionByConnectorAccountId}. That map is on
   *     this (singleton) service rather than in the closure, so two connector
   *     instances on the same connection — a publish and a pull, or two publish
   *     plans — coalesce into one refresh instead of racing.
   *
   * The coalescing is an efficiency measure, not the safety mechanism: it saves
   * redundant credential reads within a process, but prod runs two API and two
   * worker instances, so it can never see a refresh happening on another one.
   * Correctness under concurrent refresh is enforced where it has to be — in
   * `OAuthService.refreshOAuthTokens`, behind a per-connection Postgres advisory
   * lock. Callers here therefore need no locking discipline of their own.
   */
  private createOAuthAccessTokenProvider(connectorAccountId: string): ConnectorAuthTokenProvider {
    let mostRecentlyResolvedAccessToken: { value: string; resolvedAtMs: number } | null = null;

    return async () => {
      if (
        mostRecentlyResolvedAccessToken &&
        Date.now() - mostRecentlyResolvedAccessToken.resolvedAtMs < OAUTH_ACCESS_TOKEN_REUSE_WINDOW_MS
      ) {
        return mostRecentlyResolvedAccessToken.value;
      }

      const accessToken = await this.resolveAccessTokenCoalescedPerConnection(connectorAccountId);
      mostRecentlyResolvedAccessToken = { value: accessToken, resolvedAtMs: Date.now() };
      return accessToken;
    };
  }

  /**
   * Read a currently-valid access token for a connection, joining any resolution
   * already in flight for that same connection rather than starting a second one.
   * The entry is removed once the resolution settles, so nothing is cached here
   * across time — only genuinely concurrent callers coalesce, which keeps each
   * connector instance's own reuse window the sole cache. A failed resolution is
   * likewise not retained, so the next caller retries.
   */
  private resolveAccessTokenCoalescedPerConnection(connectorAccountId: string): Promise<string> {
    const alreadyInFlight = this.inFlightAccessTokenResolutionByConnectorAccountId.get(connectorAccountId);
    if (alreadyInFlight) {
      return alreadyInFlight;
    }

    const accessTokenResolution = this.oauthService.getValidAccessToken(connectorAccountId).finally(() => {
      this.inFlightAccessTokenResolutionByConnectorAccountId.delete(connectorAccountId);
    });
    this.inFlightAccessTokenResolutionByConnectorAccountId.set(connectorAccountId, accessTokenResolution);
    return accessTokenResolution;
  }

  /**
   * Implementation of `ConnectorFactoryContext.isFeatureEnabled`. Binds a
   * connector's flag check to the user the connector is acting for. Fail-closed:
   * no user → false; user not found → false; a lookup error inside
   * `getBooleanFlag` resolves to its `false` default. The user is looked up
   * lazily so it costs a query only when a connector actually checks a flag (no
   * cost for connectors that never call it).
   */
  private async evaluateFeatureFlagForUser(flagKey: string, userId: string | undefined): Promise<boolean> {
    if (!userId) {
      return false;
    }
    const user = await this.dbService.client.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) {
      return false;
    }
    // The callback takes a plain flag-key string to keep connectors decoupled
    // from the flag enum; narrow it to the flag union for getBooleanFlag.
    return this.experimentsService.getBooleanFlag(flagKey as AllFeatureFlags, false, user);
  }

  /**
   * Implementation of `ConnectorFactoryContext.getFolderOptionsByTableId`.
   * Direct Prisma read instead of going through DataFolderService to avoid
   * a circular module dependency (workbook → remote-service → connectors).
   */
  private async lookupFolderOptions(connectorAccountId: string, tableId: string[]): Promise<DataFolderOptions | null> {
    const folder = await this.dbService.client.dataFolder.findFirst({
      where: { connectorAccountId, tableId: { equals: tableId } },
      select: { options: true },
    });
    if (!folder) return null;
    return (folder.options ?? {}) as DataFolderOptions;
  }

  /**
   * Implementation of `ConnectorFactoryContext.listFolderTableIds`. Same direct
   * Prisma read as `lookupFolderOptions` (and for the same circular-dependency
   * reason). Folders without a tableId (unlinked folders) are omitted.
   */
  private async listFolderTableIds(connectorAccountId: string): Promise<string[][]> {
    const folders = await this.dbService.client.dataFolder.findMany({
      where: { connectorAccountId },
      select: { tableId: true },
    });
    return folders.map((folder) => folder.tableId).filter((tableId): tableId is string[] => (tableId?.length ?? 0) > 0);
  }
}
