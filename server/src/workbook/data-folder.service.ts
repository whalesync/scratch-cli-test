import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConnectorAccount, Prisma, WorkbookManager } from '@prisma/client';
import {
  AnyId,
  createDataFolderId,
  DataFolderGroup,
  DataFolderId,
  DataFolderOptions,
  formatRecordJson,
  IncrementalPullSupport,
  RefreshConnectionSchemasResponse,
  RefreshConnectionSchemasResult,
  SCRATCH_GROUP_NAME,
  Service,
  TableView,
  ValidatedCreateDataFolderDto,
  ValidatedUpdateDataFolderDto,
  WorkbookId,
  X_SCRATCH_ASSET_TABLE,
} from '@spinner/shared-types';
import { get } from 'lodash';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DataFolderCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { DecryptedCredentials } from 'src/remote-service/connector-account/types/encrypted-credentials.interface';
import { exceptionForConnectorError } from 'src/remote-service/connectors/error';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { Actor } from 'src/users/types';
import { extractSchemaFields, SchemaField } from 'src/utils/schema-helpers';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { RunContext } from 'src/worker/jobs/base-types';
import {
  connectorRegistry,
  resolveIncrementalPullSupportForService,
} from '../remote-service/connectors/connector-registry';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, dotPath } from '../remote-service/connectors/types';
import { DIRTY_BRANCH, MAIN_BRANCH, ScratchGitService } from '../scratch-git/scratch-git.service';
import { escapeConnectorFolderPathSegment } from './connector-folder-path.util';
import { DataFolderEntity, DataFolderGroupEntity } from './entities/data-folder.entity';
import { FilesService } from './files.service';
import { validateScratchRelativePath, validateScratchSegmentName } from './scratch-path-validation';
import { WorkbookEventService } from './workbook-event.service';
import { WorkbookService } from './workbook.service';

const PAGINATED_FILE_BATCH_SIZE = 1000;

@Injectable()
export class DataFolderService {
  constructor(
    private readonly workbookService: WorkbookService,
    private readonly db: DbService,
    private readonly connectorAccountService: ConnectorAccountService,
    private readonly connectorService: ConnectorsService,
    private readonly configService: ScratchConfigService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly auditLogService: AuditLogService,
    private readonly posthogService: PostHogService,
    private readonly scratchGitService: ScratchGitService,
    private readonly filesService: FilesService,
    private readonly workbookEventService: WorkbookEventService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
  ) {}

  /**
   * Total record count for a single workbook: the sum of its folders' denormalized
   * {@link DataFolder.recordCount}. A cheap DB aggregate over the maintained column, not a
   * live git walk. Returns 0 for a workbook with no folders.
   */
  async sumRecordCountForWorkbook(workbookId: WorkbookId): Promise<number> {
    const result = await this.db.client.dataFolder.aggregate({
      _sum: { recordCount: true },
      where: { workbookId },
    });
    return result._sum.recordCount ?? 0;
  }

  /**
   * Total record count across every workbook owned by an organization
   * (`Workbook.organizationId`), excluding workbooks pending deletion. Summed from the
   * denormalized per-folder counts. Workbooks are organization-owned, so this is the
   * count a member of that organization sees.
   */
  async sumRecordCountForOrganization(organizationId: string): Promise<number> {
    const result = await this.db.client.dataFolder.aggregate({
      _sum: { recordCount: true },
      where: { workbook: { organizationId, isPendingDelete: false } },
    });
    return result._sum.recordCount ?? 0;
  }

  /**
   * The record count Whalesync attributes to an organization's plan: summed across every CRM-mirror
   * workspace (`managedBy === ws_export`) it owns, taking the LARGER of each workspace's two connection
   * sides rather than the sum. A CRM mirror keeps the same records synced across both connections, so
   * each record exists as a file on both sides; the user thinks of it as one record, so we count it
   * once per workspace by taking the bigger side. Non-CRM-mirror workspaces are ignored entirely.
   *
   * Prisma can sum per (workbook, connector account) in one grouped query but can't express
   * "max-per-workbook then sum", so we reduce the grouped rows in memory (mirrors the per-folder max
   * in {@link largestConnectionSideRecordCount}). Org + `isPendingDelete` scoping matches
   * {@link sumRecordCountForOrganization}.
   */
  async sumWhalesyncEligibleRecordCountForOrganization(organizationId: string): Promise<number> {
    const recordCountByWorkbookAndConnectorAccount = await this.db.client.dataFolder.groupBy({
      by: ['workbookId', 'connectorAccountId'],
      where: {
        connectorAccountId: { not: null },
        workbook: { organizationId, isPendingDelete: false, managedBy: WorkbookManager.ws_export },
      },
      _sum: { recordCount: true },
    });

    const largestConnectionSideRecordCountByWorkbookId = new Map<string, number>();
    for (const row of recordCountByWorkbookAndConnectorAccount) {
      const connectionSideRecordCount = row._sum.recordCount ?? 0;
      const currentLargestForWorkbook = largestConnectionSideRecordCountByWorkbookId.get(row.workbookId) ?? 0;
      if (connectionSideRecordCount > currentLargestForWorkbook) {
        largestConnectionSideRecordCountByWorkbookId.set(row.workbookId, connectionSideRecordCount);
      }
    }

    let totalWhalesyncEligibleRecordCount = 0;
    for (const largestConnectionSide of largestConnectionSideRecordCountByWorkbookId.values()) {
      totalWhalesyncEligibleRecordCount += largestConnectionSide;
    }
    return totalWhalesyncEligibleRecordCount;
  }

  /**
   * Distinct connector services used by at least one data folder across every workbook owned by an
   * organization (excluding workbooks pending deletion), ordered alphabetically. Includes services
   * whose connection is broken or disconnected — membership is by data folder, not by a live
   * connection. Powers the connector icons in the billing page's organization usage summary.
   */
  async listConnectorServicesForOrganization(organizationId: string): Promise<Service[]> {
    const dataFoldersWithDistinctConnectorService = await this.db.client.dataFolder.findMany({
      where: {
        workbook: { organizationId, isPendingDelete: false },
        connectorService: { not: null },
      },
      distinct: ['connectorService'],
      select: { connectorService: true },
      orderBy: { connectorService: 'asc' },
    });
    return dataFoldersWithDistinctConnectorService.flatMap((dataFolder) =>
      dataFolder.connectorService ? [dataFolder.connectorService] : [],
    );
  }

  /**
   * Compute a folder's {@link IncrementalPullSupport} for the REST API, without
   * instantiating the connector or hitting any remote API. The connector
   * registry answers from the persisted `options` + `tableId` alone for most
   * connectors; only those that auto-detect their last-modified field from the
   * table schema (Airtable, WordPress) need the schema, which we read locally
   * from git — and only when the schemaless answer isn't already SUPPORTED, so a
   * folder with an explicit `modifiedAtField` (or a non-incremental connector)
   * never pays for a git read.
   */
  private async computeIncrementalPullSupport(folder: {
    connectorService: string | null;
    connectorAccountId: string | null;
    workbookId: string;
    path: string | null;
    tableId: string[];
    options: Prisma.JsonValue | null;
  }): Promise<IncrementalPullSupport> {
    const service = folder.connectorService;
    if (!service) return IncrementalPullSupport.NOT_SUPPORTED;

    const registration = connectorRegistry.get(service);
    if (!registration || !registration.metadata.incrementalPull) {
      return IncrementalPullSupport.NOT_SUPPORTED;
    }

    const options = (folder.options ?? {}) as unknown as DataFolderOptions;
    let support = resolveIncrementalPullSupportForService({
      service,
      options,
      tableSpec: null,
      tableId: folder.tableId,
    });

    if (support !== IncrementalPullSupport.SUPPORTED && registration.incrementalPullAutoDetectsFromSchema) {
      const tableSpec = await this.readSchema(folder.workbookId as WorkbookId, folder.connectorAccountId, folder.path);
      if (tableSpec) {
        support = resolveIncrementalPullSupportForService({ service, options, tableSpec, tableId: folder.tableId });
      }
    }

    return support;
  }

  /**
   * Computes {@link IncrementalPullSupport} for many folders at once, returning a
   * map keyed by data folder id. Used when embedding data folders in workbook
   * listings so the client can decide whether incremental pull is available for
   * each folder without a follow-up request. Each folder is resolved in parallel
   * via {@link computeIncrementalPullSupport}.
   */
  async computeIncrementalPullSupportByDataFolderId(
    folders: ReadonlyArray<{
      id: string;
      connectorService: string | null;
      connectorAccountId: string | null;
      workbookId: string;
      path: string | null;
      tableId: string[];
      options: Prisma.JsonValue | null;
    }>,
  ): Promise<Map<string, IncrementalPullSupport>> {
    return new Map(
      await Promise.all(
        folders.map(async (folder) => [folder.id, await this.computeIncrementalPullSupport(folder)] as const),
      ),
    );
  }

  /**
   * Lists all data folders in a workbook as a flat list.
   */
  async listAll(workbookId: WorkbookId, actor: Actor): Promise<DataFolderEntity[]> {
    await this.workbookService.assertReadableWorkbook(actor, workbookId);

    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId },
      include: DataFolderCluster._validator.include,
      orderBy: { name: 'asc' },
    });

    const schedulesByEntityId = await this.workbookService.fetchSchedulesByEntityId(workbookId);
    return Promise.all(
      dataFolders.map(
        async (f) =>
          new DataFolderEntity(f, schedulesByEntityId.get(f.id) ?? [], await this.computeIncrementalPullSupport(f)),
      ),
    );
  }

  async listGroupedByConnectorBases(workbookId: WorkbookId, actor: Actor): Promise<DataFolderGroup[]> {
    // Read access: pending workbooks are still listable.
    await this.workbookService.assertReadableWorkbook(actor, workbookId);

    // Fetch all data folders for the workbook with connector account info
    const dataFolders = await this.db.client.dataFolder.findMany({
      where: {
        workbookId,
      },
      include: DataFolderCluster._validator.include,
      orderBy: {
        name: 'asc',
      },
    });

    const schedulesByEntityId = await this.workbookService.fetchSchedulesByEntityId(workbookId);

    // Compute incremental-pull support up front (in parallel) so the synchronous
    // group-building below can look each folder's value up by id.
    const incrementalPullSupportByFolderId = new Map<string, IncrementalPullSupport>(
      await Promise.all(
        dataFolders.map(async (folder) => [folder.id, await this.computeIncrementalPullSupport(folder)] as const),
      ),
    );

    // Group data folders by connector account
    const connectorAccountGroups = new Map<
      string,
      {
        name: string;
        connectorAccount: DataFolderCluster.DataFolder['connectorAccount'];
        folders: DataFolderCluster.DataFolder[];
      }
    >();

    // Connector-less (scratch) folders are collected separately into the "Scratch" group (DEV-10424).
    const scratchFolders: DataFolderCluster.DataFolder[] = [];

    for (const folder of dataFolders) {
      if (folder.connectorAccountId && folder.connectorAccount) {
        const accountId = folder.connectorAccountId;
        let group = connectorAccountGroups.get(accountId);
        if (!group) {
          group = {
            name: folder.connectorAccount.displayName,
            connectorAccount: folder.connectorAccount,
            folders: [],
          };
          connectorAccountGroups.set(accountId, group);
        }
        group.folders.push(folder);
      } else if (!folder.connectorAccountId) {
        scratchFolders.push(folder);
      }
    }

    // Build the result array with the Scratch group first (the client also sorts it first). The
    // Scratch group is emitted unconditionally — even when empty — so the user always has a place to
    // create the first standalone folder (DEV-10424).
    const groups: DataFolderGroupEntity[] = [];

    groups.push(
      new DataFolderGroupEntity(
        SCRATCH_GROUP_NAME,
        null,
        scratchFolders.map(
          (f) =>
            new DataFolderEntity(
              f,
              schedulesByEntityId.get(f.id) ?? [],
              incrementalPullSupportByFolderId.get(f.id) ?? IncrementalPullSupport.NOT_SUPPORTED,
            ),
        ),
      ),
    );

    // Add connector account groups
    for (const [, group] of connectorAccountGroups) {
      groups.push(
        new DataFolderGroupEntity(
          group.name,
          group.connectorAccount,
          group.folders.map(
            (f) =>
              new DataFolderEntity(
                f,
                schedulesByEntityId.get(f.id) ?? [],
                incrementalPullSupportByFolderId.get(f.id) ?? IncrementalPullSupport.NOT_SUPPORTED,
              ),
          ),
        ),
      );
    }

    return groups;
  }

  async findOne(id: DataFolderId, actor: Actor): Promise<DataFolderEntity> {
    const dataFolder = await this.db.client.dataFolder.findUnique({
      where: { id },
      include: DataFolderCluster._validator.include,
    });

    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }

    // Read access: pending workbooks are still readable so the client can render the soft-delete state.
    await this.workbookService.assertReadableWorkbook(actor, dataFolder.workbookId as WorkbookId);

    const schedules = await this.db.client.schedule.findMany({ where: { entityId: id } });
    return new DataFolderEntity(dataFolder, schedules, await this.computeIncrementalPullSupport(dataFolder));
  }

  async createFolder(
    dto: ValidatedCreateDataFolderDto,
    actor: Actor,
    runContext: RunContext,
  ): Promise<DataFolderEntity> {
    const { name, workbookId, connectorAccountId, filter } = dto;
    const parentFolderId = (dto as { parentFolderId?: string }).parentFolderId;

    // Mutation: 404 if workbook is missing or pending deletion.
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);

    // Load parent folder if specified to build the path
    let parentFolder: DataFolderCluster.DataFolder | null = null;
    if (parentFolderId) {
      parentFolder = await this.db.client.dataFolder.findUnique({
        where: { id: parentFolderId },
        include: DataFolderCluster._validator.include,
      });
      if (!parentFolder) {
        throw new NotFoundException('Parent folder not found');
      }
      // Verify parent folder belongs to the same workbook
      if (parentFolder.workbookId !== workbookId) {
        throw new NotFoundException('Parent folder does not belong this workbook');
      }
    }

    if (!connectorAccountId) {
      // Connector-less "scratch" folder (DEV-10424): a standalone folder of raw user files with no
      // connector, schema, or pull. Top-level only; nested subfolders are git subdirectories.
      return this.createScratchFolder({
        name,
        workbookId,
        organizationId: workbook.organizationId,
        parentFolderId,
        actor,
      });
    }

    if (!dto.tableId || dto.tableId.length === 0) {
      throw new BadRequestException('A remote table ID is required to create a data folder');
    }

    const dataFolderId = createDataFolderId();

    // Case 1: Connected folder with connector account and table IDs
    const connectorAccount = await this.connectorAccountService.findOneById(connectorAccountId, actor);
    if (!connectorAccount) {
      throw new NotFoundException('Connector account not found');
    }

    const service = connectorAccount.service;

    // Get connector and fetch table spec
    const connector = await this.connectorService.getConnector({
      service,
      connectorAccount: connectorAccount as ConnectorAccount,
      decryptedCredentials: connectorAccount as unknown as DecryptedCredentials,
    });

    // Validate filter support
    if (filter && !connector.supportsFilters()) {
      throw new BadRequestException('This connector does not support filters');
    }

    // Fetch table spec for the first tableId
    let tableSpec: BaseJsonTableSpec;
    try {
      tableSpec = await connector.fetchJsonTableSpec(
        { wsId: dto.tableId[0], remoteId: dto.tableId },
        dto.options as DataFolderOptions | undefined,
      );
    } catch (error) {
      throw exceptionForConnectorError(error, connector);
    }

    // Apply user field overrides to the schema
    const { idFieldOverride, nameFieldOverride } = dto;
    if (idFieldOverride || nameFieldOverride) {
      const schema = tableSpec.schema as Record<string, unknown> | undefined;
      if (idFieldOverride) {
        if (!schema?.properties || !(schema.properties as Record<string, unknown>)[idFieldOverride]) {
          throw new BadRequestException(`ID field "${idFieldOverride}" does not exist in the table schema`);
        }
        tableSpec.idPath = dotPath(idFieldOverride);
      }
      if (nameFieldOverride && nameFieldOverride.length > 0) {
        // Validate that the field path exists in the schema. lodash.get takes a path array
        // (NOT a JSON Pointer string), so we interleave "properties" between each segment:
        // ["fields", "Name"] -> ["properties", "fields", "properties", "Name"].
        const lookupPath = nameFieldOverride.flatMap((segment) => ['properties', segment]);
        const fieldExists = get(schema, lookupPath) !== undefined;
        if (!fieldExists) {
          throw new BadRequestException(
            `Name field path "${nameFieldOverride.join('.')}" does not exist in the table schema`,
          );
        }
        tableSpec.titlePath = dotPath(nameFieldOverride.join('.'));
      }
    }

    // Build path from connector display name, base path, and table name
    let folderPath = this.buildConnectorFolderPath(
      connectorAccount.displayName,
      tableSpec,
      parentFolder?.path ?? undefined,
    );

    // Ensure path is unique within this connector account in the workbook
    folderPath = await this.ensureUniquePath(workbookId, connectorAccountId, folderPath, dataFolderId);

    // Create the DataFolder
    const isAssetTable = Boolean(tableSpec.schema[X_SCRATCH_ASSET_TABLE]);
    const createdDataFolder = await this.db.client.dataFolder.create({
      data: {
        id: dataFolderId,
        name,
        workbookId,
        connectorAccountId,
        connectorService: service,
        path: folderPath,
        // Connector-built deep link to the table in the service's own web UI
        // (null for services with no constructible link). Refreshed on every pull.
        remoteWebUrl: tableSpec.remoteWebUrl ?? null,
        lock: 'pull',
        // Connector-declared folder-structure version (DEV-9698). Defaults to 1;
        // a connector that evolves its on-disk layout (e.g. Webflow nested
        // collections) stamps the new version here so a migration can find and
        // convert folders still on the old layout. Keep DataFolderService
        // connector-agnostic — no `if (service === WEBFLOW)` here.
        version: tableSpec.structureVersion ?? 1,
        tableId: dto.tableId,
        isAssetTable,
        options: {
          ...(dto.options ?? {}),
          ...(filter ? { filter } : {}),
          ...(idFieldOverride ? { idFieldOverride } : {}),
          ...(nameFieldOverride ? { nameFieldOverride } : {}),
        } as Prisma.InputJsonValue,
      },
      include: { connectorAccount: true },
    });

    // Write schema and default view to git repo
    try {
      const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
      await this.scratchGitService.writeSchemaToGit(repoId, folderPath, tableSpec);
      const defaultView = connector.buildDefaultView(tableSpec);
      if (defaultView) {
        await this.scratchGitService.writeViewToGit(repoId, folderPath, 'default', defaultView);
      }
    } catch (error) {
      WSLogger.error({
        source: 'DataFolderService.createFolder',
        message: 'Failed to write schema to git',
        error,
        workbookId,
        dataFolderId,
      });
    }

    this.workbookEventService.sendWorkbookEvent(workbookId, {
      type: 'folder-created',
      data: { source: 'user', entityId: dataFolderId, message: 'Folder created' },
    });

    // Trigger pull job (defaults to true if not specified)
    if (dto.triggerPull !== false) {
      try {
        await this.bullEnqueuerService.enqueuePullLinkedFolderFilesJob(
          workbookId,
          actor,
          [dataFolderId],
          {
            totalFiles: 0,
            folderCount: 1,
            connectionName: createdDataFolder.connectorAccount?.displayName ?? 'Unknown connection',
            folderId: dataFolderId,
            folderName: createdDataFolder.name,
            connector: createdDataFolder.connectorService ?? 'unknown',
            filter: (createdDataFolder.options as unknown as DataFolderOptions)?.filter ?? null,
            status: 'pending',
            createdPaths: [],
            updatedPaths: [],
            deletedPaths: [],
            createdCount: 0,
            updatedCount: 0,
            deletedCount: 0,
            folders: [],
          },
          runContext,
        );
        WSLogger.info({
          source: 'DataFolderService.createFolder',
          message: 'Started pulling files for newly created data folder',
          workbookId,
          dataFolderId,
        });
      } catch (error) {
        WSLogger.error({
          source: 'DataFolderService.createFolder',
          message: 'Failed to start pull job for newly created data folder',
          error,
          workbookId,
          dataFolderId,
        });
      }
    } else {
      WSLogger.info({
        source: 'DataFolderService.createFolder',
        message: 'Skipped pull job for newly created data folder (triggerPull=false)',
        workbookId,
        dataFolderId,
      });
    }

    // Log audit event
    await this.auditLogService.logEvent({
      actor,
      eventType: 'create',
      message: `Created linked data folder ${name} in workbook ${workbook.name}`,
      entityId: dataFolderId,
      organizationId: workbook.organizationId,
      context: {
        workbookId,
        connectorAccountId,
        service,
        tableSpec: tableSpec?.name,
        ...(idFieldOverride ? { idFieldOverride } : {}),
        ...(nameFieldOverride ? { nameFieldOverride } : {}),
      },
    });

    this.posthogService.trackAddDataFolder(actor, createdDataFolder);
    return new DataFolderEntity(createdDataFolder, [], await this.computeIncrementalPullSupport(createdDataFolder));
  }

  /**
   * Create a standalone "scratch" folder (DEV-10424): a top-level DataFolder with no connector,
   * schema, or pull. Files inside are raw bytes committed straight to `main`; nested subfolders are
   * git subdirectories (not their own DataFolder rows). An empty `.gitkeep` keeps the folder in git
   * so it round-trips to the desktop clone.
   */
  private async createScratchFolder(params: {
    name: string;
    workbookId: WorkbookId;
    organizationId: string;
    parentFolderId: string | undefined;
    actor: Actor;
  }): Promise<DataFolderEntity> {
    const { name, workbookId, organizationId, parentFolderId, actor } = params;

    if (parentFolderId) {
      // Nested folders inside a scratch folder are git subdirectories, not DataFolder rows.
      throw new BadRequestException('Nested scratch folders are created as subdirectories, not data folders');
    }

    validateScratchSegmentName(name);
    const folderPath = `/${name}`; // DataFolder.path keeps a leading slash

    // Reject a collision with any existing folder path in this workbook (connector or scratch).
    const existing = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: folderPath },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(`A folder named "${name}" already exists`);
    }

    // Ensure the scratch repo exists BEFORE creating the row (idempotent). This self-heals workbooks
    // that predate the eager init / the init-scratch-repos backfill: surfacing an init failure here is
    // better than creating a DB row whose repo is missing and then throwing an opaque NotFound on the
    // first file write.
    const repoId = await this.scratchGitService.ensureScratchRepo(workbookId);

    const dataFolderId = createDataFolderId();
    const createdDataFolder = await this.db.client.dataFolder.create({
      data: {
        id: dataFolderId,
        name,
        workbookId,
        connectorAccountId: null,
        connectorService: null,
        path: folderPath,
        tableId: [],
      },
      include: { connectorAccount: true },
    });

    // Persist the (empty) folder in git with a hidden placeholder so it survives commit/clone and
    // appears on the desktop after a pull. The repo is ensured above, so this normally succeeds; the
    // row is the source of truth on web regardless, so a placeholder failure stays non-fatal.
    try {
      await this.scratchGitService.commitFile(
        repoId,
        `${name}/.gitkeep`,
        '',
        `Create scratch folder ${name}`,
        MAIN_BRANCH,
      );
    } catch (error) {
      WSLogger.error({
        source: 'DataFolderService.createScratchFolder',
        message: 'Failed to write .gitkeep for scratch folder',
        error,
        workbookId,
        dataFolderId,
      });
    }

    this.workbookEventService.sendWorkbookEvent(workbookId, {
      type: 'folder-created',
      data: { source: 'user', entityId: dataFolderId, message: 'Folder created' },
    });

    this.posthogService.trackAddDataFolder(actor, createdDataFolder);
    await this.auditLogService.logEvent({
      actor,
      eventType: 'create',
      message: `Created folder ${name}`,
      entityId: dataFolderId,
      organizationId,
      context: { workbookId, folderName: name },
    });

    return new DataFolderEntity(createdDataFolder, [], IncrementalPullSupport.NOT_SUPPORTED);
  }

  /**
   * Create an (empty) nested subdirectory inside a scratch folder (DEV-10424). `subPath` is relative
   * to the scratch folder root (e.g. "drafts" or "drafts/2026"). Persisted with a hidden `.gitkeep`
   * so the empty directory survives git. Scratch-only — connector folders reject this.
   */
  async createScratchSubfolder(workbookId: WorkbookId, folderId: DataFolderId, subPath: string): Promise<void> {
    const folder = await this.db.client.dataFolder.findUnique({
      where: { id: folderId },
      select: { workbookId: true, path: true, connectorAccountId: true },
    });
    if (!folder || folder.workbookId !== workbookId) {
      throw new NotFoundException('Data folder not found');
    }
    if (folder.connectorAccountId) {
      throw new BadRequestException('Subfolders are only supported in scratch folders');
    }
    if (!folder.path) {
      throw new InternalServerErrorException(`Path missing from DataFolder ${folderId}`);
    }

    const segments = validateScratchRelativePath(subPath);
    const folderGitPath = folder.path.replace(/^\//, '');
    const gitkeepPath = `${folderGitPath}/${segments.join('/')}/.gitkeep`;
    // Init-if-absent so the write self-heals even if the scratch repo was never created (idempotent).
    const repoId = await this.scratchGitService.ensureScratchRepo(workbookId);
    await this.scratchGitService.commitFile(repoId, gitkeepPath, '', `Create scratch folder ${subPath}`, MAIN_BRANCH);

    this.workbookEventService.sendWorkbookEvent(workbookId, {
      type: 'folder-contents-changed',
      data: { source: 'user', entityId: folderId, message: 'Subfolder created', path: gitkeepPath },
    });
  }

  async deleteFolder(id: DataFolderId, actor: Actor): Promise<void> {
    // Fetch the data folder
    const dataFolder = await this.db.client.dataFolder.findUnique({
      where: { id },
      include: DataFolderCluster._validator.include,
    });

    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }

    // Mutation: 404 if workbook is missing or pending deletion.
    const workbook = await this.workbookService.assertWritableWorkbook(actor, dataFolder.workbookId as WorkbookId);

    // Delete folder in git from both branches to avoid orphaned files in git status
    // Note: dataFolder.path includes leading slash, which is handled by service
    if (dataFolder.path) {
      try {
        // Folder-aware: connector folders resolve to the connector repo; a connector-less scratch
        // folder resolves to the per-workbook scratch repo. (Previously this fell back to the bare
        // `workbookId`, which is not a valid repo path and pointed deletes at the wrong repo.)
        const repoId = await this.scratchGitService.resolveRepoPathForFolder(
          dataFolder.connectorAccountId,
          dataFolder.workbookId as WorkbookId,
        );
        await this.scratchGitService.removeDataFolder(repoId, dataFolder.path);
      } catch (err) {
        // Git repo/folder may not exist yet (e.g., table linked but never pulled) — safe to ignore
        if (!(err instanceof ScratchGitNotFoundError)) {
          throw err;
        }
      }
    }

    // Delete associated pull/publish schedules (no FK cascade exists for Schedule.entityId)
    await this.db.client.schedule.deleteMany({
      where: { entityId: id, action: { in: ['PULL', 'PUBLISH'] } },
    });

    // Clean up rows that aren't FK-linked to DataFolder and so don't cascade.
    // Without this, re-creating a folder at the same path resurrects stale state.
    // FileIndex.folderPath and FileReference.sourceFilePath are stored without
    // a leading slash (see pull-linked-folder-files.job.ts), so we strip it here
    // to match — otherwise the queries match zero rows.
    //
    // Owner-aware (DEV-10885): a plain exact-path delete both (a) missed rows stored
    // under a folderPath deeper than the DataFolder path (e.g. Shopify variants whose
    // slash-bearing GID id leaks into folderPath) and (b) could delete a live child
    // DataFolder's rows when one nests inside this one (e.g. a Webflow secondary-locale
    // folder). We load the workbook's other live folder paths so the cleanup deletes
    // only rows this folder is the longest-prefix owner of.
    if (dataFolder.path) {
      const folderPathNoSlash = dataFolder.path.replace(/^\//, '');
      const otherLiveDataFolders = await this.db.client.dataFolder.findMany({
        where: { workbookId: dataFolder.workbookId, id: { not: id }, path: { not: null } },
        select: { path: true },
      });
      const otherLiveFolderPathsNoSlash = otherLiveDataFolders
        .map((folder) => folder.path?.replace(/^\//, ''))
        .filter((path): path is string => !!path);
      const liveChildFolderPathsNoSlash = otherLiveFolderPathsNoSlash.filter((path) =>
        path.startsWith(`${folderPathNoSlash}/`),
      );

      await this.fileIndexService.deleteRowsOwnedByDeletedFolder(
        dataFolder.workbookId,
        dataFolder.connectorAccountId,
        folderPathNoSlash,
        otherLiveFolderPathsNoSlash,
      );
      await this.fileReferenceService.deleteForFolderExcludingLiveChildren(
        dataFolder.workbookId,
        folderPathNoSlash,
        liveChildFolderPathsNoSlash,
      );
    }
    await this.db.client.syncMatchKeys.deleteMany({ where: { dataFolderId: id } });

    // Delete the data folder (cascades to children due to schema relation)
    await this.db.client.dataFolder.delete({
      where: { id },
    });

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'folder-deleted',
      data: { source: 'user', entityId: id, message: 'Folder deleted' },
    });

    this.posthogService.trackRemoveDataFolder(actor, dataFolder);
    // Log audit event
    await this.auditLogService.logEvent({
      actor,
      eventType: 'delete',
      message: `Deleted data folder ${dataFolder.name} from workbook ${workbook.name}`,
      entityId: id,
      organizationId: workbook.organizationId,
      context: {
        workbookId: dataFolder.workbookId,
        folderName: dataFolder.name,
      },
    });
  }

  async updateFolder(id: DataFolderId, dto: ValidatedUpdateDataFolderDto, actor: Actor): Promise<DataFolderEntity> {
    const dataFolder = await this.db.client.dataFolder.findUnique({
      where: { id },
      include: DataFolderCluster._validator.include,
    });

    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }

    // Mutation: 404 if workbook is missing or pending deletion.
    await this.workbookService.assertWritableWorkbook(actor, dataFolder.workbookId as WorkbookId);

    // When setting a filter, verify the connector supports filters
    if (dto.filter && dataFolder.connectorAccountId) {
      const connectorAccount = await this.connectorAccountService.findOneById(dataFolder.connectorAccountId, actor);
      if (!connectorAccount) {
        throw new NotFoundException('Connector account not found');
      }

      const connector = await this.connectorService.getConnector({
        service: dataFolder.connectorService as Service,
        connectorAccount: connectorAccount as ConnectorAccount,
        decryptedCredentials: connectorAccount as unknown as DecryptedCredentials,
      });

      if (!connector.supportsFilters()) {
        throw new BadRequestException('This connector does not support filters');
      }
    }

    const mergedOptions = {
      ...(dto.options ?? (dataFolder.options as Record<string, unknown>) ?? {}),
      ...(dto.filter !== undefined ? { filter: dto.filter?.trim() || undefined } : {}),
    };

    const updatedDataFolder = await this.db.client.dataFolder.update({
      where: { id },
      data: {
        options: mergedOptions as Prisma.InputJsonValue,
      },
      include: DataFolderCluster._validator.include,
    });

    return new DataFolderEntity(updatedDataFolder, [], await this.computeIncrementalPullSupport(updatedDataFolder));
  }

  /**
   * Checks whether `path` is already used by another DataFolder for the same connector account in the workbook.
   * If it is, appends `-{last 5 chars of dataFolderId}` to make the path unique.
   * Paths may repeat across different connector accounts; git content is scoped per connector repo.
   * @param workbookId - The ID of the workbook
   * @param connectorAccountId - The connector account this folder belongs to
   * @param path - The path to check
   * @param dataFolderId - The ID of the data folder
   * @returns The unique path to use for the new data folder
   */
  private async ensureUniquePath(
    workbookId: WorkbookId,
    connectorAccountId: string,
    path: string,
    dataFolderId: DataFolderId,
  ): Promise<string> {
    const existing = await this.db.client.dataFolder.findFirst({
      where: { workbookId, connectorAccountId, path },
      select: { id: true },
    });

    if (existing) {
      return `${path}-${dataFolderId.slice(-5)}`;
    }

    return path;
  }

  async getNewFileTemplate(id: DataFolderId, actor: Actor): Promise<Record<string, unknown>> {
    const dataFolder = await this.db.client.dataFolder.findUnique({
      where: { id },
      include: DataFolderCluster._validator.include,
    });

    if (!dataFolder) {
      throw new NotFoundException('Data folder not found');
    }

    // Read access: building a new-file template is read-only.
    await this.workbookService.assertReadableWorkbook(actor, dataFolder.workbookId as WorkbookId);

    if (dataFolder.connectorAccountId && dataFolder.connectorService) {
      const connectorAccount = await this.connectorAccountService.findOneById(dataFolder.connectorAccountId, actor);
      if (!connectorAccount) {
        throw new NotFoundException('Connector account not found');
      }

      const connector = await this.connectorService.getConnector({
        service: dataFolder.connectorService,
        connectorAccount: connectorAccount as ConnectorAccount,
        decryptedCredentials: connectorAccount as unknown as DecryptedCredentials,
      });

      const schema = await this.readSchema(
        dataFolder.workbookId as WorkbookId,
        dataFolder.connectorAccountId,
        dataFolder.path,
      );

      if (!schema) {
        // Fallback if no schema is present (shouldn't happen for valid connected folders but safe to handle)
        return {};
      }

      return await connector.getNewFile(schema);
    }

    // Default for scratch folders or if no connector logic applies
    return {};
  }

  async createFile(
    workbookId: WorkbookId,
    id: DataFolderId,
    dto: { name: string; useTemplate?: boolean },
    actor: Actor,
  ) {
    const folder = await this.db.client.dataFolder.findUnique({
      where: { id },
      select: { connectorAccountId: true },
    });
    const isScratch = !folder?.connectorAccountId;

    let content: string;
    if (isScratch) {
      // Scratch files are byte-passthrough: a new file starts empty and is never JSON-wrapped.
      content = '';
    } else {
      content = formatRecordJson({});
      if (dto.useTemplate) {
        try {
          const template = await this.getNewFileTemplate(id, actor);
          content = formatRecordJson(template);
        } catch (e) {
          WSLogger.warn({
            source: 'DataFolderService.createFile',
            message: 'Failed to fetch template for new file',
            error: e,
          });
        }
      }
    }

    const file = await this.filesService.createFile(
      workbookId,
      {
        name: dto.name,
        parentFolderId: id,
        content,
      },
      actor,
    );

    this.workbookEventService.sendWorkbookEvent(workbookId, {
      type: 'folder-contents-changed',
      data: { source: 'user', entityId: id, message: 'File created', path: file.path },
    });

    return file;
  }

  /**
   * Get all file contents for a data folder using paginated reads.
   * Returns an array of objects containing the folder ID, file path, and content.
   */
  async getAllFileContentsByFolderId(
    workbookId: WorkbookId,
    folderId: DataFolderId,
    actor: Actor,
    branch: string = DIRTY_BRANCH,
  ): Promise<{ folderId: DataFolderId; path: string; content: string }[]> {
    const folder = await this.findOne(folderId, actor);

    if (!folder.path) {
      throw new InternalServerErrorException(`Path missing from DataFolder ${folderId}`);
    }

    const folderPath = folder.path.replace(/^\//, ''); // remove preceding / for git paths
    const allFiles: { folderId: DataFolderId; path: string; content: string }[] = [];
    let cursor: string | undefined;

    const repoId = await this.scratchGitService.resolveRepoPathForFolder(folder.connectorAccountId, workbookId);
    // Scratch folders are main-only; ignore a caller-requested dirty branch for them.
    const effectiveBranch = folder.connectorAccountId ? branch : MAIN_BRANCH;

    do {
      const page = await this.scratchGitService.getRepoFilesPaginated(
        repoId,
        effectiveBranch,
        folderPath,
        PAGINATED_FILE_BATCH_SIZE,
        cursor,
      );

      for (const file of page.files) {
        // Skip dotfiles (e.g. .schema.json) — they are metadata, not data records
        if (file.name.startsWith('.')) continue;
        allFiles.push({
          folderId,
          path: `${folderPath}/${file.name}`,
          content: file.content,
        });
      }

      cursor = page.nextCursor;
    } while (cursor);

    return allFiles;
  }

  /**
   * Get a single page of file contents for a data folder.
   * Returns the files in this page and a nextCursor for fetching the next page.
   */
  async getFileContentsByFolderIdPaginated(
    workbookId: WorkbookId,
    folderId: DataFolderId,
    actor: Actor,
    branch: string = DIRTY_BRANCH,
    cursor?: string,
  ): Promise<{ files: { folderId: DataFolderId; path: string; content: string }[]; nextCursor?: string }> {
    const folder = await this.findOne(folderId, actor);

    if (!folder.path) {
      throw new InternalServerErrorException(`Path missing from DataFolder ${folderId}`);
    }

    const folderPath = folder.path.replace(/^\//, ''); // remove preceding / for git paths

    const repoId = await this.scratchGitService.resolveRepoPathForFolder(folder.connectorAccountId, workbookId);
    // Scratch folders are main-only; ignore a caller-requested dirty branch for them.
    const effectiveBranch = folder.connectorAccountId ? branch : MAIN_BRANCH;
    const page = await this.scratchGitService.getRepoFilesPaginated(
      repoId,
      effectiveBranch,
      folderPath,
      PAGINATED_FILE_BATCH_SIZE,
      cursor,
    );

    const files = page.files
      .filter((file) => !file.name.startsWith('.')) // Skip dotfiles (e.g. .schema.json)
      .map((file) => ({
        folderId,
        path: `${folderPath}/${file.name}`,
        content: file.content,
      }));

    return { files, nextCursor: page.nextCursor };
  }

  /**
   * Builds the folder path for a DataFolder linked to a connector account.
   * Path parts: [parentFolderPath] / basePath[0..n] / tableName (no connection name prefix).
   */
  buildConnectorFolderPath(
    _connectorDisplayName: string,
    tableSpec: BaseJsonTableSpec,
    parentFolderPath?: string,
  ): string {
    // Single source of truth shared with the Webflow folder-restructure
    // migration so a migrated folder's path matches a fresh pull's (finding C1).
    const escape = escapeConnectorFolderPathSegment;
    const parts: string[] = [];

    if (parentFolderPath) {
      // parentFolderPath already includes leading slash, strip it for joining
      parts.push(parentFolderPath.replace(/^\//, ''));
    }

    if (tableSpec.basePath && tableSpec.basePath.length > 0) {
      parts.push(...tableSpec.basePath.filter(Boolean).map(escape));
    }

    parts.push(escape(tableSpec.name));

    return '/' + parts.join('/');
  }

  /**
   * Reads schema from git.
   */
  async readSchema(
    workbookId: WorkbookId,
    connectorAccountId: string | null | undefined,
    folderPath: string | null,
  ): Promise<BaseJsonTableSpec | null> {
    if (!folderPath) return null;
    // Scratch (connector-less) folders have no schema by design.
    if (!connectorAccountId) return null;
    try {
      const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
      const gitSchema = await this.scratchGitService.readSchemaFromGit(repoId, folderPath);
      if (gitSchema) return gitSchema;
    } catch (error) {
      WSLogger.error({
        source: 'DataFolderService.readSchema',
        message: 'Failed to read schema from git',
        error,
        workbookId,
        folderPath,
      });
    }
    return null;
  }

  /**
   * Returns the schema already stored in the DB for a data folder, without calling the connector.
   */
  async getStoredSchema(id: DataFolderId, actor: Actor): Promise<Record<string, unknown> | null> {
    const folder = await this.findOne(id, actor);
    return await this.readSchema(folder.workbookId, folder.connectorAccountId, folder.path);
  }

  /**
   * Reads a stored TableView from git for a data folder. The connector's curated
   * default view is persisted separately from `schema.json` (see
   * `ScratchGitService.writeViewToGit`), so this is the read complement of
   * `readSchema`. Returns null if the view is missing or unreadable.
   */
  async readView(
    connectorAccountId: string | null | undefined,
    folderPath: string | null,
    viewName: string,
  ): Promise<TableView | null> {
    if (!folderPath) return null;
    // Scratch (connector-less) folders have no stored view by design.
    if (!connectorAccountId) return null;
    try {
      const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
      return await this.scratchGitService.readViewFromGit(repoId, folderPath, viewName);
    } catch (error) {
      WSLogger.error({
        source: 'DataFolderService.readView',
        message: 'Failed to read view from git',
        error,
        folderPath,
        viewName,
      });
      return null;
    }
  }

  /**
   * Returns the connector's stored default TableView for a data folder, without
   * calling the connector. Parallels `getStoredSchema`. Used by create-schema
   * plan generation to pick meaningful, de-duplicated columns instead of walking
   * the raw nested JSON schema.
   */
  async getStoredView(id: DataFolderId, actor: Actor): Promise<TableView | null> {
    const folder = await this.findOne(id, actor);
    return await this.readView(folder.connectorAccountId, folder.path, 'default');
  }

  /**
   * Fetches the full JSON Table Spec from the connector for a data folder.
   */
  async fetchSchemaSpec(id: DataFolderId, actor: Actor): Promise<BaseJsonTableSpec | null> {
    const folder = await this.findOne(id, actor);

    if (!folder.connectorAccountId || !folder.tableId || folder.tableId.length === 0 || !folder.connectorService) {
      return null;
    }

    const connectorAccount = await this.connectorAccountService.findOneById(folder.connectorAccountId, actor);
    if (!connectorAccount) {
      return null;
    }

    const connector = await this.connectorService.getConnector({
      service: folder.connectorService,
      connectorAccount: connectorAccount as ConnectorAccount,
      decryptedCredentials: connectorAccount as unknown as DecryptedCredentials,
    });

    try {
      const tableSpec = await connector.fetchJsonTableSpec({
        wsId: folder.tableId[0],
        remoteId: folder.tableId,
      });

      // Re-apply user field overrides from options
      const options =
        folder.options && typeof folder.options === 'object' && !Array.isArray(folder.options) ? folder.options : {};
      const idOverride = 'idFieldOverride' in options ? options.idFieldOverride : undefined;
      const nameOverride = 'nameFieldOverride' in options ? options.nameFieldOverride : undefined;
      if (typeof idOverride === 'string') {
        tableSpec.idPath = dotPath(idOverride);
      }
      if (Array.isArray(nameOverride) && nameOverride.length > 0) {
        tableSpec.titlePath = dotPath(nameOverride.join('.'));
      }

      // Write schema and default view to git repo
      try {
        const repoId = await this.scratchGitService.resolveConnectionRepoPath(folder.connectorAccountId);
        if (folder.path) {
          await this.scratchGitService.writeSchemaToGit(repoId, folder.path, tableSpec);
          const defaultView = connector.buildDefaultView(tableSpec);
          if (defaultView) {
            await this.scratchGitService.writeViewToGit(repoId, folder.path, 'default', defaultView);
          }
        } else {
          WSLogger.error({
            source: 'DataFolderService.fetchSchemaSpec',
            message: 'Folder path is missing — unable to write schema to git',
            dataFolderId: id,
          });
        }
      } catch (error) {
        WSLogger.error({
          source: 'DataFolderService.fetchSchemaSpec',
          message: 'Failed to write schema to git',
          error,
          dataFolderId: id,
        });
      }

      return tableSpec;
    } catch (error) {
      WSLogger.error({
        source: 'DataFolderService.fetchSchemaSpec',
        message: 'Failed to fetch schema from connector',
        error,
        dataFolderId: id,
      });
      return null;
    }
  }

  /**
   * Re-derives the schema (and default view) for every data folder belonging to a single
   * connection (connector account), in one pass. Reuses the per-folder {@link fetchSchemaSpec},
   * which fetches the spec from the connector and writes `schema.json` + `views/default.json`
   * back to the connection's git repo.
   *
   * Folders are processed sequentially to stay gentle on the connector's metadata API. A folder
   * whose refresh fails (connector error, missing path, no linked table, etc.) is recorded as
   * `failed` and does NOT stop the others — the caller gets a per-folder outcome list plus
   * aggregate counts rather than an all-or-nothing failure.
   */
  async refreshSchemasForConnection(
    connectorAccountId: string,
    actor: Actor,
  ): Promise<RefreshConnectionSchemasResponse> {
    const connectorAccount = await this.connectorAccountService.findOneById(connectorAccountId, actor);
    // Fail fast at the boundary; each per-folder fetchSchemaSpec also re-checks folder access.
    const workbook = await this.workbookService.assertWritableWorkbook(
      actor,
      connectorAccount.workbookId as WorkbookId,
    );

    const foldersInConnection = await this.db.client.dataFolder.findMany({
      where: { connectorAccountId },
      orderBy: { path: 'asc' },
    });

    const perFolderResults: RefreshConnectionSchemasResult[] = [];
    for (const folder of foldersInConnection) {
      const dataFolderId = folder.id as DataFolderId;
      try {
        const tableSpec = await this.fetchSchemaSpec(dataFolderId, actor);
        if (tableSpec) {
          perFolderResults.push({ dataFolderId, folderName: folder.name, status: 'refreshed' });
        } else {
          perFolderResults.push({
            dataFolderId,
            folderName: folder.name,
            status: 'failed',
            error: 'No schema available for this data folder',
          });
        }
      } catch (error) {
        perFolderResults.push({
          dataFolderId,
          folderName: folder.name,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const refreshedCount = perFolderResults.filter((result) => result.status === 'refreshed').length;
    const failedCount = perFolderResults.length - refreshedCount;

    this.posthogService.trackRefreshConnectionSchemas(actor, connectorAccount, { refreshedCount, failedCount });
    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Refreshed schemas for connection ${connectorAccount.displayName} (${refreshedCount} of ${perFolderResults.length} folders)`,
      entityId: connectorAccount.id as AnyId,
      organizationId: workbook.organizationId,
      context: {
        workbookId: connectorAccount.workbookId,
        connectorAccountId: connectorAccount.id,
        connectorService: connectorAccount.service,
        refreshedCount,
        failedCount,
      },
    });

    return { refreshedCount, failedCount, results: perFolderResults };
  }

  /**
   * Returns schema paths (dot notation) for a data folder.
   * Tries to read the schema from the git repo first, falling back to the connector.
   */
  async getSchemaPaths(id: DataFolderId, actor: Actor): Promise<SchemaField[]> {
    let spec = (await this.getStoredSchema(id, actor)) as BaseJsonTableSpec | null;
    if (!spec || !spec.schema) {
      WSLogger.warn({
        source: 'DataFolderService.getSchemaPaths',
        message: 'Schema missing from git, fetching from connector',
        dataFolderId: id,
      });
      spec = await this.fetchSchemaSpec(id, actor);
    }
    if (!spec || !spec.schema) {
      return [];
    }
    return extractSchemaFields(spec.schema);
  }
}
