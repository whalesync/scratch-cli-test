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
  CreateDestination,
  CreateDestinationList,
  CreateDestinationLookup,
  CreateDestinationSearchResult,
  GenericApiConnectorExtras,
  isGenericApiConnectorExtras,
  ShopifyConnectorExtras,
  TableDiscoveryMode,
  UpdateConnectorAccountDto,
  ValidatedCreateConnectorAccountDto,
  WorkbookId,
} from '@spinner/shared-types';
import _ from 'lodash';
import { AuditLogService } from 'src/audit/audit-log.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { WSLogger } from 'src/logger';
import { OAuthService } from 'src/oauth/oauth.service';
import { Service as ServiceConst } from 'src/remote-service/connectors/service-constants';
import { getDefaultRepoPath, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { checkWorkspacePermissions } from 'src/users/permissions';
import { canCreateDataSource } from 'src/users/subscription-utils';
import { Actor, SYSTEM_ACTOR } from 'src/users/types';
import { extractApiDomain } from 'src/utils/urls';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { DbService } from '../../db/db.service';
import { PostHogService } from '../../posthog/posthog.service';
import { EncryptedData } from '../../utils/encryption';
import { WorkbookEventService } from '../../workbook/workbook-event.service';
import { Connector } from '../connectors/connector';
import { ConnectorsService } from '../connectors/connectors.service';
import {
  getConnectorCurrentVersion,
  getServiceAdvancedSettings,
  getServiceDisplayName,
  getServiceMetadata,
} from '../connectors/display-names';
import { ConnectorAuthError, exceptionForConnectorError, isUserFriendlyError } from '../connectors/error';
import { probeAuthOnly } from '../connectors/library/generic-api/generic-api-probe';
import { ApiQuotaResponse } from './entities/api-quota.entity';
import { TableList, TableSearchResult } from './entities/table-list.entity';
import { TableSchemaPreview } from './entities/table-schema-preview.entity';
import { TestConnectionResponse } from './entities/test-connection.entity';
import { DecryptedCredentials } from './types/encrypted-credentials.interface';

/**
 * Cap for the in-process create-destination search fallback (connectors that only
 * implement `listCreateDestinations` and have small lists — Airtable bases,
 * Postgres schemas). Search-backed connectors (Notion) apply their own cap.
 */
const CREATE_DESTINATION_SEARCH_RESULT_CAP = 50;

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
    private readonly experimentsService: ExperimentsService,
    private readonly bullEnqueuerService: BullEnqueuerService,
  ) {}

  /**
   * Fail-closed gate for the GENERIC_API connector. No-op when the operation
   * targets a different service or when invoked from the system actor; throws
   * 403 when the user does not have ENABLE_GENERIC_CONNECTOR set.
   */
  private async assertGenericConnectorEnabled(serviceType: string, actor: Actor): Promise<void> {
    if (serviceType !== ServiceConst.GENERIC_API) return;
    if (actor.userId === SYSTEM_ACTOR.userId) return;
    const enabled = await this.experimentsService.isGenericConnectorEnabledForUser(actor.userId);
    if (!enabled) {
      throw new ForbiddenException('The Generic API connector is not enabled for your account.');
    }
  }

  /**
   * Find a unique display name for a connector account within a workbook.
   * Display names are used as folder names, so they must be unique per workbook.
   * If the base name is taken, appends an incrementing suffix (e.g. "Postgres 1", "Postgres 2").
   * Throws if no unique name is found within MAX_DISPLAY_NAME_ATTEMPTS suffix attempts.
   */
  private async findUniqueDisplayName(workbookId: WorkbookId, baseDisplayName: string): Promise<string> {
    const MAX_DISPLAY_NAME_ATTEMPTS = 20;

    const existing = await this.db.client.connectorAccount.findMany({
      where: { workbookId, displayName: { startsWith: baseDisplayName } },
      select: { displayName: true },
    });
    const existingNames = new Set(existing.map((a) => a.displayName));

    if (!existingNames.has(baseDisplayName)) {
      return baseDisplayName;
    }

    for (let i = 1; i <= MAX_DISPLAY_NAME_ATTEMPTS; i++) {
      const candidate = `${baseDisplayName} ${i}`;
      if (!existingNames.has(candidate)) {
        return candidate;
      }
    }

    throw new BadRequestException(
      `Could not find a unique display name for "${baseDisplayName}" within the workbook after ${MAX_DISPLAY_NAME_ATTEMPTS} attempts`,
    );
  }

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

    await this.assertGenericConnectorEnabled(createDto.service, actor);

    if (!canCreateDataSource(actor.subscriptionStatus, await this.countForType(createDto.service, workbookId, actor))) {
      throw new ForbiddenException(
        `You have reached the maximum number of ${getServiceDisplayName(createDto.service)} data sources for your subscription`,
      );
    }

    // ──────────────────────────────────────────────────────────────────────
    // GENERIC_API: probe BEFORE persist — no orphan rows on auth failure.
    // The custom modal posts { userProvidedParams: { apiKey }, extras: { apiType, authHeader, endpoints[] } }.
    // We validate the extras shape, run a one-call probe against the first
    // endpoint, and only proceed with row creation if it returns 2xx.
    // ──────────────────────────────────────────────────────────────────────
    let parsedCredentials: Record<string, string>;
    let extras: Record<string, unknown>;
    if (createDto.service === ServiceConst.GENERIC_API) {
      if (!isGenericApiConnectorExtras(createDto.extras)) {
        throw new BadRequestException('Generic API requires structured extras: { apiType, authHeader, endpoints[] }.');
      }
      const apiKey = createDto.userProvidedParams?.apiKey;
      if (typeof apiKey !== 'string' || apiKey === '') {
        throw new BadRequestException('Generic API requires an API key in userProvidedParams.apiKey.');
      }
      // Pre-create probe — throws on auth failure, network error, non-JSON,
      // or non-2xx. No DB row created on failure (we haven't called .create() yet).
      try {
        await probeAuthOnly({ extras: createDto.extras as GenericApiConnectorExtras, apiKey });
      } catch (e) {
        // Log verbose detail server-side. For SSRF rejections specifically,
        // `internalDetails` includes the resolved IP / hostname / block reason;
        // surfacing that to the API caller turns the connector into an internal
        // DNS / IP oracle, so the public message stays generic.
        //
        // undici/native fetch throws TypeError("fetch failed") with the real
        // network error on `.cause` — flatten the chain so logs name the
        // actual failure (ENOTFOUND, ECONNREFUSED, TLS error, etc.).
        const internalDetails =
          e !== null && typeof e === 'object' && 'internalDetails' in e && typeof e.internalDetails === 'string'
            ? e.internalDetails
            : describeErrorChain(e);
        WSLogger.warn({
          source: 'connector-account',
          message: 'GENERIC_API pre-create probe failed',
          workbookId,
          service: createDto.service,
          internalDetails,
        });
        const publicMsg = e instanceof Error ? e.message : 'Unknown probe failure';
        throw new BadRequestException(`Generic API connection check failed: ${publicMsg}`);
      }
      parsedCredentials = { apiKey };
      extras = { ...createDto.extras } as Record<string, unknown>;
    } else {
      const parsed = await this.parseUserProvidedParams(createDto.userProvidedParams || {}, createDto.service);
      parsedCredentials = parsed.credentials;
      extras = { ...parsed.extras };

      // For Shopify, store the shop domain in extras (not encrypted) so it can be queried directly
      if (createDto.service === ServiceConst.SHOPIFY && parsedCredentials.shopDomain) {
        const shopifyExtras: ShopifyConnectorExtras = { shopDomain: parsedCredentials.shopDomain };
        extras = { ...extras, ...shopifyExtras };
        delete parsedCredentials.shopDomain;
      }
    }

    const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(
      parsedCredentials as unknown as DecryptedCredentials,
    );

    const accountId = createConnectorAccountId();
    const repoPath = getDefaultRepoPath(workbook.organizationId, workbookId, accountId);

    const baseDisplayName = createDto.displayName ?? `${_.startCase(createDto.service.toLowerCase())}`;
    const displayName = await this.findUniqueDisplayName(workbookId, baseDisplayName);

    const connectorAccount = await this.db.client.connectorAccount.create({
      data: {
        id: accountId,
        userId: actor.userId,
        workbookId: workbookId,
        service: createDto.service,
        displayName,
        authType: createDto.authType || AuthType.USER_PROVIDED_PARAMS,
        repoPath,
        encryptedCredentials: encryptedCredentials as unknown as Prisma.InputJsonValue,
        modifier: createDto.modifier,
        extras: extras as Prisma.InputJsonValue,
        version: getConnectorCurrentVersion(createDto.service),
      },
    });

    const testResult = await this.testConnection(workbookId, connectorAccount.id, actor);

    let apiDomain: string | undefined;
    if (createDto.service === ServiceConst.GENERIC_API && isGenericApiConnectorExtras(createDto.extras)) {
      const firstEndpointUrl = createDto.extras.endpoints[0]?.url;
      if (firstEndpointUrl) apiDomain = extractApiDomain(firstEndpointUrl);
    }

    this.posthogService.trackCreateDataSource(actor, connectorAccount, {
      authType: createDto.authType ?? connectorAccount.authType,
      healthStatus: testResult.health,
      apiDomain,
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
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccount.id);
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
   *
   * **PERFORMS NO AUTHORIZATION — internal callers only.** The lookup is not scoped to a workbook
   * or an organization, and the returned object carries DECRYPTED credentials, so any caller that
   * takes its `id` from user input hands out cross-tenant access to another workbook's connection
   * (DEV-11167). Only use this where the id was derived from a resource the caller already owns
   * (e.g. a DataFolder that was itself authorized), or where the workbook is resolved *from* the
   * returned account and authorized afterwards.
   *
   * Anything reachable from an HTTP route with a caller-supplied id must use {@link findOne},
   * which scopes the query on `{ id, workbookId }`.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async findOneByIdUnscoped(id: string, _actor: Actor): Promise<ConnectorAccount & DecryptedCredentials> {
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

    await this.assertGenericConnectorEnabled(currentAccount.service, actor);

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

    // GENERIC_API: validate extras shape when supplied so we don't persist
    // garbage that would break listTables / pull at runtime. Mirrors the
    // pre-create probe's validation; the actual auth re-check happens lazily
    // when healthStatus is reset to null below.
    if (currentAccount.service === ServiceConst.GENERIC_API && updateDto.extras !== undefined) {
      if (!isGenericApiConnectorExtras(updateDto.extras)) {
        throw new BadRequestException('Generic API requires structured extras: { apiType, authHeader, endpoints[] }.');
      }
    }

    const encryptedCredentials = await this.credentialEncryptionService.encryptCredentials(decryptedCredentials);

    const account = await this.db.client.connectorAccount.update({
      where: { id, workbookId },
      data: {
        displayName: updateDto.displayName,
        encryptedCredentials: encryptedCredentials as unknown as Prisma.InputJsonValue,
        modifier: updateDto.modifier,
        extras: extras as Prisma.InputJsonValue | undefined,
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

  /**
   * Admin-only "break glass" reveal of a connection's decrypted credentials.
   *
   * Why: operators occasionally need to read a live customer's API key to debug
   * a broken connection. The endpoint is intentionally narrow (admin role required)
   * and every call writes an audit log entry so reveals are reviewable after the fact.
   */
  async revealCredentials(
    workbookId: WorkbookId,
    id: string,
    actor: Actor,
  ): Promise<{ credentials: DecryptedCredentials; extras: Record<string, unknown> | null }> {
    if (!actor.isAdmin) {
      throw new ForbiddenException('Only admins may reveal connection credentials');
    }

    const workbook = await this.loadWorkbook(workbookId);
    const account = await this.db.client.connectorAccount.findUnique({
      where: { id, workbookId },
    });
    if (!account) {
      throw new NotFoundException('ConnectorAccount not found');
    }

    const credentials = await this.credentialEncryptionService.decryptCredentials(
      account.encryptedCredentials as unknown as EncryptedData,
    );

    await this.auditLogService.logEvent({
      actor,
      eventType: 'reveal',
      message: `Revealed credentials for connection ${account.displayName}`,
      entityId: account.id as ConnectorAccountId,
      organizationId: workbook.organizationId,
      context: {
        service: account.service,
        authType: account.authType,
      },
    });

    return {
      credentials,
      extras: account.extras as Record<string, unknown> | null,
    };
  }

  async remove(workbookId: WorkbookId, id: string, actor: Actor): Promise<void> {
    const account = await this.findOne(workbookId, id, actor);
    if (!account) {
      throw new NotFoundException('ConnectorAccount not found');
    }

    await this.assertGenericConnectorEnabled(account.service, actor);

    const workbook = await this.loadWorkbook(workbookId);

    await this.removeConnectionData(account, actor);

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
    await this.removeConnectionData(account, SYSTEM_ACTOR);

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
  private async removeConnectionData(account: ConnectorAccount, actor: Actor): Promise<void> {
    const { id, workbookId } = account;

    // Fetch all DataFolders for this connection (needed for schedule cleanup)
    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId, connectorAccountId: id },
      select: { id: true, path: true },
    });

    const folderIds = dataFolders.map((f) => f.id);

    // Delete schedules for this connection (no FK cascade to DataFolder or ConnectorAccount):
    // per-table pull/publish schedules key off a folder id, while connection-wide pull
    // schedules (CONNECTION_FULL_PULL / CONNECTION_INCREMENTAL_PULL) key off the account id.
    await this.db.client.schedule.deleteMany({
      where: { entityId: { in: [...folderIds, id] } },
    });

    // Delete publish plans for this connection (no FK cascade to ConnectorAccount)
    await this.db.client.publishPlan.deleteMany({
      where: { workbookId, connectorAccountId: id },
    });

    // Per-(workbook, account) auxiliary tables with no FK cascade — must be
    // cleaned up here so a workbook that outlives the deleted account
    // doesn't carry orphan rows that could surface in a later publish.
    //   - UploadPatchMeta: tracks `revert: true` flags from upload-patch
    //     between upload and plan-build for this account's paths.
    //   - RecreatedIdMap: (priorRemoteId → newRemoteId) mappings written
    //     by past recreate publishes against this account's connector.
    await this.db.client.uploadPatchMeta.deleteMany({
      where: { workbookId, connectorAccountId: id },
    });
    await this.db.client.recreatedIdMap.deleteMany({
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

    // Orphan cleanup (DEV-10885): FileIndex/FileReference have no FK to DataFolder,
    // so the DataFolder bulk-delete above leaves their rows behind. Run it in a
    // durable background job so the user's delete doesn't block on an unbounded
    // deleteMany (one connection had ~42k index rows). Safe to defer here (unlike
    // resetConnection, which cleans inline): the FileIndex delete is scoped by the
    // now-dead connectorAccountId, which a reconnect never reuses, so it can't touch
    // a future connection's rows. The FileReference delete IS keyed by folder path
    // (no connectorAccountId column) and folder paths carry no connection prefix, so
    // the job guards it at run time — skipping any path a live DataFolder has since
    // reclaimed (a reconnect + re-pull of the same service) — rather than trusting
    // the enqueue-time assumption. Best-effort: the connection is already deleted, so
    // a failed enqueue must not surface as an error (a re-pull rebuilds these caches,
    // and Phase B's GC backstops anything missed).
    try {
      await this.bullEnqueuerService.enqueueCleanupConnectionIndexRowsJob(
        {
          workbookId: workbookId as WorkbookId,
          connectorAccountId: id,
          connectionFolderPaths: dataFolders.map((folder) => folder.path).filter((path): path is string => !!path),
        },
        actor,
      );
    } catch (err) {
      WSLogger.error({
        source: 'ConnectorAccountService.removeConnectionData',
        message: 'Failed to enqueue FileIndex/FileReference cleanup job after connection removal',
        error: err,
        workbookId,
        connectorAccountId: id,
      });
    }
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

    await this.assertGenericConnectorEnabled(account.service, actor);

    // Capture the connection's folder paths BEFORE deleting the DataFolders — the
    // FileReference cleanup below is keyed by source-file path, which can't be
    // recovered once the DataFolders are gone.
    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId, connectorAccountId: id },
      select: { path: true },
    });

    // Delete all data folders for this connection
    await this.db.client.dataFolder.deleteMany({
      where: { workbookId, connectorAccountId: id },
    });

    // Delete all publish plans for this connection
    await this.db.client.publishPlan.deleteMany({
      where: { workbookId, connectorAccountId: id },
    });

    // Clean up index rows that have no FK to DataFolder and so don't cascade
    // (DEV-10885). Done INLINE here (not via the async delete-time job) because
    // reset keeps the same connectorAccountId: a background sweep could race — and
    // delete — the rows a re-pull writes right after. FileIndex is scoped by
    // connectorAccountId, which covers nested sub-paths for free (mirror of
    // FileIndexService.deleteForConnection); FileReference has no such column, so we
    // prefix-delete under each folder path. No live-children guard is needed here (the
    // async delete job has one) because reset runs inline within the same request, so
    // no reconnect can have recreated a folder at these paths yet.
    await this.db.client.fileIndex.deleteMany({ where: { workbookId, connectorAccountId: id } });
    for (const { path } of dataFolders) {
      if (!path) continue;
      const folderPathNoSlash = path.replace(/^\//, '');
      if (!folderPathNoSlash) continue;
      await this.db.client.fileReference.deleteMany({
        where: { workbookId, sourceFilePath: { startsWith: `${folderPathNoSlash}/` } },
      });
    }

    // Delete and re-init the connection's dedicated git repo
    try {
      const repoId = await this.scratchGitService.resolveConnectionRepoPath(id);
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

  async listTables(workbookId: WorkbookId, connectorAccountId: string, actor: Actor): Promise<TableList> {
    const account = await this.findOne(workbookId, connectorAccountId, actor);

    await this.assertGenericConnectorEnabled(account.service, actor);

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
      const serviceMetadata = getServiceMetadata(account.service);
      return {
        tables,
        discoveryMode: connector.tableDiscoveryMode,
        supportsFilters: connector.supportsFilters(),
        supportsFieldSelection: connector.supportsFieldSelection(),
        advancedSettings: getServiceAdvancedSettings(account.service),
        ...(serviceMetadata.tableSearchPlaceholder !== undefined
          ? { tableSearchPlaceholder: serviceMetadata.tableSearchPlaceholder }
          : {}),
        ...(serviceMetadata.tableSearchInstructions !== undefined
          ? { tableSearchInstructions: serviceMetadata.tableSearchInstructions }
          : {}),
      };
    } catch (error) {
      throw exceptionForConnectorError(error, connector);
    }
  }

  /**
   * List the places a new table can be created for a connection (e.g. Airtable
   * bases, Postgres schemas, Notion pages). Returns the destinations sorted
   * alphabetically by name. Throws a 400 when the connector does not support
   * creating tables.
   */
  async listCreateDestinations(
    workbookId: WorkbookId,
    connectorAccountId: string,
    actor: Actor,
  ): Promise<CreateDestinationList> {
    const account = await this.findOne(workbookId, connectorAccountId, actor);

    await this.assertGenericConnectorEnabled(account.service, actor);

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

    if (!connector.listCreateDestinations) {
      throw new BadRequestException(
        `${getServiceDisplayName(account.service)} does not support listing table create destinations`,
      );
    }

    try {
      const destinations = await connector
        .listCreateDestinations()
        .then((destinations) => destinations.sort((a, b) => a.name.localeCompare(b.name)));
      return { destinations };
    } catch (error) {
      throw exceptionForConnectorError(error, connector);
    }
  }

  /**
   * Search the places a new table can be created for a connection. Prefers the
   * connector's own server-side search (Notion, whose shared-page list can far
   * exceed the base-list cap); otherwise filters the full `listCreateDestinations`
   * list in-process (fine for connectors with small lists). Results are sorted by
   * name and `hasMore` is set when matches were cut off at the cap. Empty/whitespace
   * `searchTerm` behaves like the list endpoint. Throws a 400 when the connector
   * supports neither listing nor searching create destinations.
   */
  async searchCreateDestinations(
    workbookId: WorkbookId,
    connectorAccountId: string,
    searchTerm: string,
    actor: Actor,
  ): Promise<CreateDestinationSearchResult> {
    const { account, connector } = await this.buildConnectorForAccount(workbookId, connectorAccountId, actor);

    if (!connector.searchCreateDestinations && !connector.listCreateDestinations) {
      throw new BadRequestException(
        `${getServiceDisplayName(account.service)} does not support listing table create destinations`,
      );
    }

    const normalizedSearchTerm = searchTerm ?? '';

    try {
      const result = connector.searchCreateDestinations
        ? await connector.searchCreateDestinations(normalizedSearchTerm)
        : await this.filterCreateDestinationsInProcess(connector, normalizedSearchTerm);
      const sortedDestinations = result.destinations.sort((a, b) => a.name.localeCompare(b.name));
      return { destinations: sortedDestinations, hasMore: result.hasMore };
    } catch (error) {
      throw exceptionForConnectorError(error, connector);
    }
  }

  /**
   * Resolve one create-destination by remote id. Prefers the connector's own
   * by-id lookup (Notion's `GET /v1/pages/:id`); otherwise finds the id within
   * the full `listCreateDestinations` list. Returns `{ destination: null }` (200)
   * when the connection cannot access the id — a definitive "the saved selection
   * is stale". Transport/server failures propagate as normal errors so a temporary
   * outage is never mistaken for a stale id. Throws a 400 when the connector
   * supports neither lookup nor listing.
   */
  async lookupCreateDestination(
    workbookId: WorkbookId,
    connectorAccountId: string,
    destinationId: string,
    actor: Actor,
  ): Promise<CreateDestinationLookup> {
    const { account, connector } = await this.buildConnectorForAccount(workbookId, connectorAccountId, actor);

    if (!connector.lookupCreateDestination && !connector.listCreateDestinations) {
      throw new BadRequestException(
        `${getServiceDisplayName(account.service)} does not support listing table create destinations`,
      );
    }

    try {
      if (connector.lookupCreateDestination) {
        const destination = await connector.lookupCreateDestination(destinationId);
        return { destination };
      }
      // Fallback for connectors with a small, complete list: an id absent from the
      // list is inaccessible (null), matching the lookup contract.
      const allDestinations = connector.listCreateDestinations ? await connector.listCreateDestinations() : [];
      const destination = allDestinations.find((candidate) => candidate.id === destinationId) ?? null;
      return { destination };
    } catch (error) {
      throw exceptionForConnectorError(error, connector);
    }
  }

  /**
   * In-process create-destination search for connectors that only implement
   * `listCreateDestinations` (their lists are small). Case-insensitive substring
   * match on the name, capped at {@link CREATE_DESTINATION_SEARCH_RESULT_CAP};
   * an empty term returns the first capped page.
   */
  private async filterCreateDestinationsInProcess(
    connector: Connector,
    searchTerm: string,
  ): Promise<{ destinations: CreateDestination[]; hasMore: boolean }> {
    if (!connector.listCreateDestinations) {
      return { destinations: [], hasMore: false };
    }
    const allDestinations = await connector.listCreateDestinations();
    const normalizedSearchTerm = searchTerm.trim().toLowerCase();
    const matchingDestinations = normalizedSearchTerm
      ? allDestinations.filter((destination) => destination.name.toLowerCase().includes(normalizedSearchTerm))
      : allDestinations;
    const cappedDestinations = matchingDestinations.slice(0, CREATE_DESTINATION_SEARCH_RESULT_CAP);
    return {
      destinations: cappedDestinations,
      hasMore: matchingDestinations.length > cappedDestinations.length,
    };
  }

  /**
   * Load a connection and build its connector, applying the generic-connector
   * gate. Shared by the create-destination search/lookup endpoints; mirrors the
   * inline setup the older table endpoints use.
   */
  private async buildConnectorForAccount(
    workbookId: WorkbookId,
    connectorAccountId: string,
    actor: Actor,
  ): Promise<{ account: ConnectorAccount & DecryptedCredentials; connector: Connector }> {
    const account = await this.findOne(workbookId, connectorAccountId, actor);

    await this.assertGenericConnectorEnabled(account.service, actor);

    try {
      const connector = await this.connectorsService.getConnector({
        service: account.service,
        connectorAccount: account,
        decryptedCredentials: account,
        userId: actor.userId,
      });
      return { account, connector };
    } catch (error) {
      throw new InternalServerErrorException(error instanceof Error ? error.message : String(error), {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async searchTables(
    workbookId: WorkbookId,
    connectorAccountId: string,
    searchTerm: string,
    actor: Actor,
  ): Promise<TableSearchResult> {
    const account = await this.findOne(workbookId, connectorAccountId, actor);

    await this.assertGenericConnectorEnabled(account.service, actor);

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

    await this.assertGenericConnectorEnabled(account.service, actor);

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
    await this.assertGenericConnectorEnabled(account.service, actor);
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

  /**
   * Fetch the current API quota / rate-limit state for a connection. Returns
   * `{ supported: false }` when the underlying connector does not expose a
   * quota endpoint. Errors from the connector bubble up so the controller
   * surfaces them to the client (the dialog renders an error state).
   */
  async getApiQuota(workbookId: WorkbookId, id: string, actor: Actor): Promise<ApiQuotaResponse> {
    const account = await this.findOne(workbookId, id, actor);
    await this.assertGenericConnectorEnabled(account.service, actor);
    const connector = await this.connectorsService.getConnector({
      service: account.service,
      connectorAccount: account,
      decryptedCredentials: account,
    });

    const result = await connector.getApiQuota();
    if (result === null) {
      return { supported: false };
    }
    if ('dashboardUrl' in result) {
      return { supported: false, dashboardUrl: result.dashboardUrl };
    }
    return { supported: true, quota: result.quota };
  }
}

/**
 * Flatten an error chain into a single string for log output. Walks `.cause`
 * (undici / native fetch attach the real network error there) and appends
 * common Node error codes. Without this, undici failures only ever log
 * "fetch failed" and the actual ENOTFOUND / ECONNREFUSED / TLS error is lost.
 */
function describeErrorChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < 5) {
    if (cur instanceof Error) {
      const code = (cur as Error & { code?: string }).code;
      parts.push(code ? `${cur.message} [${code}]` : cur.message);
      cur = (cur as Error & { cause?: unknown }).cause;
    } else {
      // Avoid `String(<plain object>)` returning '[object Object]'.
      parts.push(typeof cur === 'string' ? cur : JSON.stringify(cur));
      cur = undefined;
    }
    depth++;
  }
  return parts.join(' ← ');
}
