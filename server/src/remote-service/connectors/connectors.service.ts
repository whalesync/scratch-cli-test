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
import { connectorRegistry } from './connector-registry';
import { ConnectorInstantiationError } from './error';

// Side-effect import: triggers connector self-registration
import './library';

@Injectable()
export class ConnectorsService {
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
      getOAuthAccessToken: (id) => this.oauthService.getValidAccessToken(id),
      createRateLimiter: (id) => this.rateLimiterFactory.createLimiter({ service, connectorAccountId: id }),
      getFolderOptionsByTableId: (id, tableId) => this.lookupFolderOptions(id, tableId),
      listFolderTableIds: (id) => this.listFolderTableIds(id),
      isFeatureEnabled: (flagKey) => this.evaluateFeatureFlagForUser(flagKey, userId),
    });
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
