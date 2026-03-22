import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AuthType, ConnectorAccount, Prisma } from '@prisma/client';
import type { Service } from '@spinner/shared-types';
import {
  ConnectorAccountId,
  createConnectorAccountId,
  ShopifyConnectorExtras,
  TableDiscoveryMode,
  UpdateConnectorAccountDto,
  ValidatedCreateConnectorAccountDto,
  WorkbookId,
} from '@spinner/shared-types';
import _ from 'lodash';
import { AuditLogService } from 'src/audit/audit-log.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { WSLogger } from 'src/logger';
import { OAuthService } from 'src/oauth/oauth.service';
import { Service as ServiceConst } from 'src/remote-service/connectors/service-constants';
import { getDefaultRepoPath, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { checkWorkspacePermissions } from 'src/users/permissions';
import { canCreateDataSource } from 'src/users/subscription-utils';
import { Actor, SYSTEM_ACTOR } from 'src/users/types';
import { DbService } from '../../db/db.service';
import { PostHogService } from '../../posthog/posthog.service';
import { EncryptedData } from '../../utils/encryption';
import { WorkbookEventService } from '../../workbook/workbook-event.service';
import { Connector } from '../connectors/connector';
import { ConnectorsService } from '../connectors/connectors.service';
import { getServiceAdvancedSettings, getServiceDisplayName } from '../connectors/display-names';
import { ConnectorAuthError, exceptionForConnectorError, isUserFriendlyError } from '../connectors/error';
import { TableList, TableSearchResult } from './entities/table-list.entity';
import { TableSchemaPreview } from './entities/table-schema-preview.entity';
import { TestConnectionResponse } from './entities/test-connection.entity';
import { DecryptedCredentials } from './types/encrypted-credentials.interface';

@Injectable()
export class ConnectorAccountService {
  constructor(
    private readonly db: DbService,
    private readonly connectorsService: ConnectorsService,
    private readonly oauthService: OAuthService,
    private readonly posthogService: PostHogService,
    private readonly auditLogService: AuditLogService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
    private readonly scratchGitService: ScratchGitService,
    private readonly workbookEventService: WorkbookEventService,
  ) {}

  private async loadWorkbook(workbookId: WorkbookId) {
    const workbook = await this.db.client.workbook.findUnique({ where: { id: workbookId } });
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }
    return workbook;
  }

  private async getDecryptedAccount(account: ConnectorAccount): Promise<ConnectorAccount & DecryptedCredentials> {
    const decryptedCredentials = await this.credentialEncryptionService.decryptCredentials(
      account.encryptedCredentials as unknown as EncryptedData,
    );
    return {
      ...account,
      ...decryptedCredentials,
    };
  }

  async create(
    workbookId: WorkbookId,
    createDto: ValidatedCreateConnectorAccountDto,
    actor: Actor,
  ): Promise<ConnectorAccount> {
    // Verify workbook access
    const workbook = await this.loadWorkbook(workbookId);

    checkWorkspacePermissions(actor, workbookId);

    if (!canCreateDataSource(actor.subscriptionStatus, await this.countForType(createDto.service, workbookId, actor))) {
      throw new ForbiddenException(
        `You have reached the maximum number of ${getServiceDisplayName(createDto.service)} data sources for your subscription`,
      );
    }

    const { credentials: parsedCredentials, extras: parsedExtras } = await this.parseUserProvidedParams(
      createDto.userProvidedParams || {},
      createDto.service,
    );

    // For Shopify, store the shop domain in extras (not encrypted) so it can be queried directly
    let extras: Record<string, string> = { ...parsedExtras };
    if (createDto.service === ServiceConst.SHOPIFY && parsedCredentials.shopDomain) {
      const shopifyExtras: ShopifyConnectorExtras = { shopDomain: parsedCredentials.shopDomain };
      extras = { ...extras, ...shopifyExtras };
      delete parsedCredentials.shopDomain;
    }

    const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(
      parsedCredentials as unknown as DecryptedCredentials,
    );

    const accountId = createConnectorAccountId();
    const repoPath = getDefaultRepoPath(workbook.organizationId, workbookId, accountId);

    const connectorAccount = await this.db.client.connectorAccount.create({
      data: {
        id: accountId,
        userId: actor.userId,
        workbookId: workbookId,
        service: createDto.service,
        displayName: createDto.displayName ?? `${_.startCase(createDto.service.toLowerCase())}`,
        authType: createDto.authType || AuthType.USER_PROVIDED_PARAMS,
        repoPath,
        encryptedCredentials: encryptedCredentials as unknown as Prisma.InputJsonValue,
        modifier: createDto.modifier,
        extras,
      },
    });

    const testResult = await this.testConnection(workbookId, connectorAccount.id, actor);

    this.posthogService.trackCreateDataSource(actor, connectorAccount, {
      authType: createDto.authType ?? connectorAccount.authType,
      healthStatus: testResult.health,
    });

    await this.auditLogService.logEvent({
      actor,
      eventType: 'create',
      message: `Created new connection ${connectorAccount.displayName}`,
      entityId: connectorAccount.id as ConnectorAccountId,
      organizationId: workbook.organizationId,
      context: {
        service: connectorAccount.service,
        authType: connectorAccount.authType,
      },
    });

    // Init the connection's dedicated git repo immediately
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccount.id);
    await this.scratchGitService.initRepo(repoId);

    // Re-fetch to include health status set by testConnection()
    return this.db.client.connectorAccount.findUniqueOrThrow({
      where: { id: connectorAccount.id },
    });
  }

  async findAll(workbookId: WorkbookId, actor: Actor): Promise<ConnectorAccount[]> {
    // Workbook ownership verified in controller; workbookId provides scoping
    void actor;
    return this.db.client.connectorAccount.findMany({
      where: { workbookId },
    });
  }

  /**
   * Find all connector accounts for an organization (admin purposes).
   * Queries through workbook relation since ConnectorAccount no longer has organizationId.
   */
  async findAllForOrganization(actor: Actor): Promise<ConnectorAccount[]> {
    return this.db.client.connectorAccount.findMany({
      where: { workbook: { organizationId: actor.organizationId } },
    });
  }

  async countForType(type: Service, workbookId: WorkbookId, actor: Actor): Promise<number> {
    // Workbook ownership verified in controller; workbookId provides scoping
    void actor;
    return this.db.client.connectorAccount.count({
      where: { workbookId, service: type },
    });
  }

  async findOne(workbookId: WorkbookId, id: string, actor: Actor): Promise<ConnectorAccount & DecryptedCredentials> {
    // Workbook ownership verified in controller; workbookId provides scoping
    void actor;
    const connectorAccount = await this.db.client.connectorAccount.findUnique({
      where: { id, workbookId },
    });
    if (!connectorAccount) {
      throw new NotFoundException('ConnectorAccount not found');
    }
    return this.getDecryptedAccount(connectorAccount);
  }

  /**
   * Find a connector account by ID only, without any scoping.
   * Admin-only: caller must enforce admin access.
   */
  async findOneByIdAdmin(id: string): Promise<ConnectorAccount & DecryptedCredentials> {
    const connectorAccount = await this.db.client.connectorAccount.findUnique({
      where: { id },
    });
    if (!connectorAccount) {
      throw new NotFoundException('ConnectorAccount not found');
    }
    return this.getDecryptedAccount(connectorAccount);
  }

  /**
   * Find a connector account by ID only, without workbook context.
   * Used for internal operations like OAuth callback where we need to look up an account.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async findOneById(id: string, _actor: Actor): Promise<ConnectorAccount & DecryptedCredentials> {
    const connectorAccount = await this.db.client.connectorAccount.findFirst({
      where: { id },
    });
    if (!connectorAccount) {
      throw new NotFoundException('ConnectorAccount not found');
    }
    return this.getDecryptedAccount(connectorAccount);
  }

  async update(
    workbookId: WorkbookId,
    id: string,
    updateDto: UpdateConnectorAccountDto,
    actor: Actor,
  ): Promise<ConnectorAccount & DecryptedCredentials> {
    // Workbook ownership verified in controller; workbookId provides scoping
    void actor;

    // Get current account to decrypt existing credentials
    const currentAccount = await this.db.client.connectorAccount.findUnique({
      where: { id, workbookId },
    });
    if (!currentAccount) {
      throw new NotFoundException('ConnectorAccount not found');
    }

    const decryptedCredentials = await this.credentialEncryptionService.decryptCredentials(
      currentAccount.encryptedCredentials as unknown as EncryptedData,
    );

    // Update credentials if provided (userProvidedParams are always string key-value pairs)
    if (updateDto.userProvidedParams) {
      Object.assign(decryptedCredentials, updateDto.userProvidedParams);
    }

    // For Shopify, store the shop domain in extras (not encrypted) so it can be queried directly
    let extras = updateDto.extras;
    const credentialsRecord = decryptedCredentials as Record<string, unknown>;
    if (currentAccount.service === 'SHOPIFY' && typeof credentialsRecord.shopDomain === 'string') {
      const shopifyExtras: ShopifyConnectorExtras = { shopDomain: credentialsRecord.shopDomain };
      extras = { ...(extras || (currentAccount.extras as Record<string, unknown> | null) || {}), ...shopifyExtras };
      delete credentialsRecord.shopDomain;
    }

    const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(decryptedCredentials);

    const account = await this.db.client.connectorAccount.update({
      where: { id, workbookId },
      data: {
        displayName: updateDto.displayName,
        encryptedCredentials: encryptedCredentials as unknown as Prisma.InputJsonValue,
        modifier: updateDto.modifier,
        extras,
        healthStatus: null,
        healthStatusLastCheckedAt: null,
      },
    });

    this.posthogService.trackUpdateDataSource(actor, account, {
      changedFields: Object.keys(updateDto),
    });

    const workbook = await this.loadWorkbook(workbookId);
    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Updated connection ${account.displayName}`,
      entityId: account.id as ConnectorAccountId,
      organizationId: workbook.organizationId,
      context: {
        service: account.service,
        authType: account.authType,
        changedFields: Object.keys(updateDto),
      },
    });

    return this.getDecryptedAccount(account);
  }

  async remove(workbookId: WorkbookId, id: string, actor: Actor): Promise<void> {
    const account = await this.findOne(workbookId, id, actor);
    if (!account) {
      throw new NotFoundException('ConnectorAccount not found');
    }

    const workbook = await this.loadWorkbook(workbookId);

    await this.removeConnectionData(account);

    this.workbookEventService.sendWorkbookEvent(workbookId, {
      type: 'workbook-updated',
      data: { source: 'user', entityId: id, message: `Connection ${account.displayName} removed` },
    });

    this.posthogService.trackRemoveDataSource(actor, account);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'delete',
      message: `Deleted connection ${account.displayName}`,
      entityId: account.id as ConnectorAccountId,
      organizationId: workbook.organizationId,
    });
  }

  /**
   * Remove a connection and all its data without requiring an Actor.
   * Used for system-level operations like Shopify GDPR shop/redact webhooks.
   *
   * TODO: Remerge this with remove() once there are system-level Actors to use.
   */
  async removeBySystem(workbookId: WorkbookId, id: string): Promise<void> {
    const workbook = await this.loadWorkbook(workbookId);
    const account = await this.findOneByIdAdmin(id);
    await this.removeConnectionData(account);

    this.workbookEventService.sendWorkbookEvent(workbookId, {
      type: 'workbook-updated',
      data: { source: 'user', entityId: id, message: `Connection ${account.displayName} removed` },
    });

    await this.auditLogService.logEvent({
      actor: SYSTEM_ACTOR,
      eventType: 'delete',
      message: `Deleted connection ${account.displayName} by system`,
      entityId: account.id as ConnectorAccountId,
      organizationId: workbook.organizationId,
    });
  }

  /**
   * Core cleanup logic shared by remove() and removeBySystem().
   * Deletes schedules, publish plans, DataFolders, git data, and the ConnectorAccount record.
   */
  private async removeConnectionData(account: ConnectorAccount): Promise<void> {
    const { id, workbookId } = account;

    // Fetch all DataFolders for this connection (needed for schedule cleanup)
    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId, connectorAccountId: id },
      select: { id: true, path: true },
    });

    const folderIds = dataFolders.map((f) => f.id);

    // Delete schedules targeting these folders (no FK cascade to DataFolder)
    if (folderIds.length > 0) {
      await this.db.client.schedule.deleteMany({
        where: { entityId: { in: folderIds } },
      });
    }

    // Delete publish plans for this connection (no FK cascade to ConnectorAccount)
    await this.db.client.publishPlan.deleteMany({
      where: { workbookId, connectorAccountId: id },
    });

    // Delete all DataFolders (cascades to SyncTablePair, SyncForeignKeyRecord, SyncRemoteIdMapping)
    await this.db.client.dataFolder.deleteMany({
      where: { workbookId, connectorAccountId: id },
    });

    // Clean up git data — delete the connection's dedicated repo
    if (account.repoPath) {
      try {
        await this.scratchGitService.deleteRepo(account.repoPath);
      } catch (err) {
        WSLogger.error({
          source: 'ConnectorAccountService.removeConnectionData',
          message: 'Failed to delete git repo during connection removal',
          error: err,
          workbookId,
          connectorAccountId: id,
        });
      }
    }

    // Delete the ConnectorAccount record
    await this.db.client.connectorAccount.delete({
      where: { id, workbookId },
    });
  }

  /**
   * Resets a single connection: deletes all its data folders and (for V2 workbooks)
   * deletes and re-initializes its git repository.
   */
  async resetConnection(workbookId: WorkbookId, id: string, actor: Actor): Promise<void> {
    const workbook = await this.loadWorkbook(workbookId);

    const account = await this.findOne(workbookId, id, actor);
    if (!account) {
      throw new NotFoundException('ConnectorAccount not found');
    }

    // Delete all data folders for this connection
    await this.db.client.dataFolder.deleteMany({
      where: { workbookId, connectorAccountId: id },
    });

    // Delete all publish plans for this connection
    await this.db.client.publishPlan.deleteMany({
      where: { workbookId, connectorAccountId: id },
    });

    // Delete and re-init the connection's dedicated git repo
    try {
      const repoId = await this.scratchGitService.resolveRepoId(workbookId, id);
      try {
        await this.scratchGitService.deleteRepo(repoId);
      } catch (err) {
        WSLogger.error({
          source: 'ConnectorAccountService.resetConnection',
          message: 'Failed to delete git repo during connection reset',
          error: err,
          workbookId,
          connectorAccountId: id,
        });
      }
      await this.scratchGitService.initRepo(repoId);
    } catch (err) {
      WSLogger.error({
        source: 'ConnectorAccountService.resetConnection',
        message: 'Failed to reset git repo during connection reset',
        error: err,
        workbookId,
        connectorAccountId: id,
      });
      throw err;
    }

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Reset connection ${account.displayName}`,
      entityId: account.id as ConnectorAccountId,
      organizationId: workbook.organizationId,
      context: { action: 'reset_connection' },
    });
  }

  async listTables(connectorAccountId: string, actor: Actor): Promise<TableList> {
    const account = await this.findOneById(connectorAccountId, actor);

    let connector: Connector;
    try {
      connector = await this.connectorsService.getConnector({
        service: account.service,
        connectorAccount: account,
        decryptedCredentials: account,
        userId: actor.userId,
      });
    } catch (error) {
      throw new InternalServerErrorException(error instanceof Error ? error.message : String(error), {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    try {
      const tables = await connector
        .listTables()
        .then((tables) => tables.sort((a, b) => a.displayName.localeCompare(b.displayName)));
      return {
        tables,
        discoveryMode: connector.tableDiscoveryMode,
        supportsFilters: connector.supportsFilters(),
        supportsFieldSelection: connector.supportsFieldSelection(),
        advancedSettings: getServiceAdvancedSettings(account.service),
      };
    } catch (error) {
      throw exceptionForConnectorError(error, connector);
    }
  }

  async searchTables(connectorAccountId: string, searchTerm: string, actor: Actor): Promise<TableSearchResult> {
    const account = await this.findOneById(connectorAccountId, actor);

    let connector: Connector;
    try {
      connector = await this.connectorsService.getConnector({
        service: account.service,
        connectorAccount: account,
        decryptedCredentials: account,
        userId: actor.userId,
      });
    } catch (error) {
      throw new InternalServerErrorException(error instanceof Error ? error.message : String(error), {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    if (connector.tableDiscoveryMode !== TableDiscoveryMode.SEARCH) {
      throw new BadRequestException('This connector does not support table search');
    }

    if (!searchTerm?.trim()) {
      return { tables: [], hasMore: false };
    }

    try {
      return await connector.searchTables(searchTerm);
    } catch (error) {
      throw exceptionForConnectorError(error, connector);
    }
  }

  async getTableSchema(
    workbookId: WorkbookId,
    connectorAccountId: string,
    tableRemoteId: string[],
    actor: Actor,
  ): Promise<TableSchemaPreview> {
    const account = await this.findOne(workbookId, connectorAccountId, actor);

    let connector: Connector;
    try {
      connector = await this.connectorsService.getConnector({
        service: account.service,
        connectorAccount: account,
        decryptedCredentials: account,
        userId: actor.userId,
      });
    } catch (error) {
      throw new InternalServerErrorException(error instanceof Error ? error.message : String(error), {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }

    try {
      return await connector.fetchJsonTableSpec({
        wsId: tableRemoteId[0],
        remoteId: tableRemoteId,
      });
    } catch (error) {
      throw exceptionForConnectorError(error, connector);
    }
  }

  async parseUserProvidedParams(
    userProvidedParams: Record<string, string>,
    service: Service,
  ): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }> {
    const authParser = this.connectorsService.getAuthParser({
      service,
    });
    if (!authParser) {
      return { credentials: userProvidedParams, extras: {} };
    }
    try {
      const result = await authParser.parseUserProvidedParams({ userProvidedParams });
      return { ...result };
    } catch (error) {
      // If the error is already a UserFriendlyError, re-throw it directly
      if (isUserFriendlyError(error)) {
        throw error;
      }
      throw new ConnectorAuthError(
        `Unexpected error in parseUserProvidedParams: ${_.toString(error)}`,
        `There was an unexpected error connecting to ${getServiceDisplayName(service)}`,
        service,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Test connection
  // ---------------------------------------------------------------------------

  async testConnection(workbookId: WorkbookId, id: string, actor: Actor): Promise<TestConnectionResponse> {
    const account = await this.findOne(workbookId, id, actor);
    let connector: Connector | undefined;
    try {
      connector = await this.connectorsService.getConnector({
        service: account.service,
        connectorAccount: account,
        decryptedCredentials: account,
      });

      await connector.testConnection();

      await this.db.client.connectorAccount.update({
        where: { id },
        data: {
          healthStatus: 'OK',
          healthStatusLastCheckedAt: new Date(),
          healthStatusMessage: null,
        },
      });

      return { health: 'ok' };
    } catch (error: unknown) {
      WSLogger.debug({
        source: 'ConnectorAccountService',
        message: 'Error testing connection',
        error,
        userId: actor.userId,
        connectorAccountId: id,
      });

      let errorMessage: string;
      if (connector) {
        errorMessage = connector.extractConnectorErrorDetails(error).userFriendlyMessage;
      } else {
        errorMessage = error instanceof Error ? error.message : 'Unknown error';
      }

      await this.db.client.connectorAccount.update({
        where: { id },
        data: {
          healthStatus: 'FAILED',
          healthStatusLastCheckedAt: new Date(),
          healthStatusMessage: errorMessage,
        },
      });

      return { health: 'error', error: errorMessage };
    }
  }
}
