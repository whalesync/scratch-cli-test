import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthType, Prisma } from '@prisma/client';
import type {
  AvailableMigrationsResponse,
  MigrationDescriptor,
  MigrationResult,
  MigrationResultSummaryRow,
  SyncId,
  ValidatedRunMigrationDto,
  WorkbookId,
} from '@spinner/shared-types';
import { type DataFolderId } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { hasAdminToolsPermission } from 'src/auth/permissions';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { OAuthService } from 'src/oauth/oauth.service';
import { NotionApiClient } from 'src/remote-service/connectors/library/notion/notion-api-client';
import { isFullDatabase } from 'src/remote-service/connectors/library/notion/notion-data-source-types';
import {
  WEBFLOW_FLAT_STRUCTURE_VERSION,
  WEBFLOW_NESTED_STRUCTURE_VERSION,
} from 'src/remote-service/connectors/library/webflow/webflow-folder-paths';
import { Service } from 'src/remote-service/connectors/service-constants';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { SYSTEM_ACTOR } from 'src/users/types';
import { EncryptedData } from 'src/utils/encryption';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { DbService } from '../db/db.service';
import { ConnectionDrainTimeoutError, ConnectionQuiesceService } from './connection-quiesce.service';
import { RunMigrationDto } from './dto/code-migrations.dto';
import { resolveFolderPathsToConnectorAccountIds } from './fileindex-connector-account-backfill';
import {
  accumulate,
  AuditLogEntry,
  BackfillDeps,
  backfillNotionFolder,
  emptySummary,
  FolderToBackfill,
  NotionFetchOutcome,
} from './notion-data-source-backfill';
import {
  accumulateSyncMappingV2Backfill,
  backfillSyncMappingRow,
  emptySyncMappingV2BackfillSummary,
  SyncMappingV2BackfillDeps,
  SyncMappingV2BackfillResult,
} from './sync-mapping-v2-backfill';
import {
  accumulateWebflowFolderRestructure,
  classifyWebflowTableByTableId,
  emptyWebflowFolderRestructureSummary,
  GitFolderMoveOutcome,
  migrateWebflowCollectionFolder,
  sortWebflowCollectionFoldersForSafeMoveOrder,
  WebflowCollectionFolderMigrationResult,
  WebflowCollectionFolderToMigrate,
  AuditLogEntry as WebflowFolderRestructureAuditLogEntry,
  WebflowFolderRestructureDeps,
  WebflowFolderRestructureSummary,
} from './webflow-folder-restructure-backfill';
import {
  accumulateWebflowFolderRestructureInverse,
  emptyWebflowFolderRestructureInverseSummary,
  invertWebflowCollectionFolder,
  sortWebflowCollectionFoldersForSafeInverseMoveOrder,
  WebflowCollectionFolderInversionResult,
  WebflowFolderRestructureInverseSummary,
} from './webflow-folder-restructure-inverse-backfill';
import { applyWebflowFolderMovePathRewrite } from './webflow-folder-restructure-path-rewrite';

const AVAILABLE_MIGRATIONS: MigrationDescriptor[] = [
  {
    name: 'init-workbook-repos',
    supportsDryRun: false,
    description:
      'Initializes the Git config repo for workbooks created before auto-init was added (April 2026). ' +
      'Safe to run multiple times — workbooks that already have a repo are skipped by scratch-git.',
  },
  {
    name: 'init-scratch-repos',
    supportsDryRun: false,
    description:
      'Initializes the per-workbook scratch repo for standalone connector-less files (DEV-10424) for ' +
      'workbooks created before scratch-repo auto-init was added. Safe to run multiple times — ' +
      'workbooks that already have a scratch repo are skipped by scratch-git.',
  },
  {
    name: 'notion-data-source-backfill',
    supportsDryRun: false,
    description:
      "Backfills Notion data source IDs into existing folders so the connector can talk to Notion's " +
      '2025-09-03 API. For single-source databases (the common case), the folder is rewritten in place ' +
      'and the change is transparent to the user. For databases with multiple data sources, the existing ' +
      'folder is pinned to the first source and one new folder is created per additional source. ' +
      'Idempotent — re-runs skip folders that already have a 2-element tableId.',
  },
  {
    name: 'sync-mapping-v2-backfill',
    supportsDryRun: false,
    description:
      'Backfills the v2 mapping shape into Sync.mappingsV2 for syncs created before the dual-column ' +
      'migration (rows where mappingsV2 IS NULL). Reads the frozen v1 mappings column, transforms it ' +
      'in memory, and writes mappingsV2 via a compare-and-set guarded on updatedAt — a concurrent edit ' +
      'or a parallel batch is a safe no-op. The frozen v1 column is never modified, so the migration is ' +
      'non-destructive and reversible by clearing mappingsV2 back to NULL. Idempotent — re-runs and ' +
      'parallel batches skip rows already at v2.',
  },
  {
    name: 'webflow-folder-restructure',
    supportsDryRun: true,
    description:
      'Re-parents existing Webflow CMS collection folders from the flat v1 layout /<Site>/<Collection> ' +
      'to the nested v2 layout /<Site>/Collections/<Collection> (DEV-9698). Moves the folder in git on ' +
      'both branches and rewrites DataFolder.path + version and every dependent path column (FileIndex, ' +
      'FileReference, SyncMatchKeys, SyncRemoteIdMapping destination side, RecreatedIdMap, ' +
      'UploadPatchMeta) in one atomic transaction per folder. Assets and Pages folders are left ' +
      'untouched. Flips ConnectorAccount.version to 2 once an account has no flat collection folders ' +
      'left. Supports dryRun. Idempotent — re-runs skip folders already at version 2. ' +
      'Each connection is quiesced for the duration of its migration (T4): schedules disabled, ' +
      'non-terminal publish plans cancelled, in-flight jobs drained, and live edits + new job ' +
      'enqueues blocked with a 409; a connection too busy to drain in time is skipped and retried ' +
      'on a later run.',
  },
  {
    name: 'fileindex-connector-account-backfill',
    supportsDryRun: true,
    description:
      'Backfills FileIndex.connectorAccountId for rows written before the column existed (DEV-10880), by ' +
      'mapping each connection-relative folderPath back to its owning connection via the workbook’s ' +
      'DataFolders. A folderPath owned by exactly one connection is scoped to it; a folderPath shared by ' +
      'two connections in the same workbook (e.g. two HubSpot connections both with Contacts) is left NULL ' +
      'and corrected by the next pull of each connection. Non-destructive (only NULL rows are written) and ' +
      'idempotent — re-runs skip already-scoped rows. Supports dryRun. `ids` targets workbooks; `qty` takes ' +
      'that many workbooks that still have unscoped rows.',
  },
  {
    name: 'webflow-folder-restructure-inverse',
    supportsDryRun: true,
    description:
      'ROLLBACK of webflow-folder-restructure (DEV-9698 T6). Re-parents nested v2 Webflow CMS ' +
      'collection folders from /<Site>/Collections/<Collection> back to the flat v1 layout ' +
      '/<Site>/<Collection>, rewriting the same path columns in one atomic transaction per folder ' +
      'and flipping DataFolder.version (and, once an account has no nested collections left, ' +
      'ConnectorAccount.version) from 2 back to 1. A collection literally named "Collections" ' +
      'reverts last in its site (the mirror of the forward ordering). Assets and Pages are ' +
      'untouched. Uses the same per-connection quiesce (T4) and dryRun support. Idempotent — ' +
      're-runs skip folders already at version 1.',
  },
];

/**
 * Notion API version that exposes `data_sources` on the `databases.retrieve`
 * response. Matches the v5 SDK's default; pinned here so the backfill stays
 * usable even if a future SDK bump moves the default forward.
 */
const NOTION_API_VERSION_FOR_BACKFILL = '2025-09-03';

@Controller('code-migrations')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class CodeMigrationsController {
  private readonly logger = new Logger(CodeMigrationsController.name);

  constructor(
    private readonly db: DbService,
    private readonly workbookRepoService: WorkbookRepoService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
    private readonly oauthService: OAuthService,
    private readonly auditLogService: AuditLogService,
    private readonly scratchGitService: ScratchGitService,
    private readonly connectionQuiesceService: ConnectionQuiesceService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
  ) {}

  @Get('available')
  getAvailableMigrations(@Req() req: RequestWithUser): AvailableMigrationsResponse {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can access migrations');
    }

    return { migrations: AVAILABLE_MIGRATIONS };
  }

  @Post('run')
  async runMigration(@Req() req: RequestWithUser, @Body() dtoParam: RunMigrationDto): Promise<MigrationResult> {
    const dto = dtoParam as ValidatedRunMigrationDto;
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can run migrations');
    }

    // Validate that either qty or ids is provided, but not both
    if (dto.qty && dto.ids && dto.ids.length > 0) {
      throw new BadRequestException('Cannot provide both qty and ids. Choose one.');
    }

    if (!dto.qty && (!dto.ids || dto.ids.length === 0)) {
      throw new BadRequestException('Must provide either qty or ids.');
    }

    // Reject a dry-run for a migration that doesn't support it, so a user can
    // never believe they dry-ran a migration that actually performed writes.
    // (Unknown migration names fall through to the switch's default below.)
    if (dto.dryRun) {
      const descriptor = AVAILABLE_MIGRATIONS.find((m) => m.name === dto.migration);
      if (descriptor && !descriptor.supportsDryRun) {
        throw new BadRequestException(`Migration "${dto.migration}" does not support dry-run.`);
      }
    }

    switch (dto.migration) {
      case 'init-workbook-repos':
        return this.initWorkbookRepos(dto);
      case 'init-scratch-repos':
        return this.initScratchRepos(dto);
      case 'notion-data-source-backfill':
        return this.runNotionDataSourceBackfill(dto);
      case 'sync-mapping-v2-backfill':
        return this.runSyncMappingV2Backfill(dto);
      case 'fileindex-connector-account-backfill':
        return this.runFileIndexConnectorAccountBackfill(dto);
      case 'webflow-folder-restructure':
        return this.runWebflowFolderRestructure(dto);
      case 'webflow-folder-restructure-inverse':
        return this.runWebflowFolderRestructureInverse(dto);
      default:
        throw new BadRequestException(`Unknown migration: ${dto.migration}`);
    }
  }

  /**
   * Initialize workbook config repos for workbooks created before auto-init was added (2026-04-01).
   * Idempotent — safe to run multiple times; existing repos are skipped by scratch-git.
   */
  private async initWorkbookRepos(dto: ValidatedRunMigrationDto): Promise<MigrationResult> {
    let workbooks;

    if (dto.ids && dto.ids.length > 0) {
      workbooks = await this.db.client.workbook.findMany({
        where: { id: { in: dto.ids } },
        select: { id: true, organizationId: true },
      });
    } else {
      workbooks = await this.db.client.workbook.findMany({
        select: { id: true, organizationId: true },
        take: dto.qty,
        orderBy: { createdAt: 'asc' },
      });
    }

    const migratedIds: string[] = [];
    for (const wb of workbooks) {
      try {
        await this.workbookRepoService.initWorkbookRepo(wb.organizationId, wb.id as WorkbookId);
        migratedIds.push(wb.id);
      } catch (error) {
        this.logger.error(`Failed to init workbook repo for ${wb.id}: ${String(error)}`);
      }
    }

    const totalCount = await this.db.client.workbook.count();

    return {
      migratedIds,
      remainingCount: totalCount - migratedIds.length,
      migrationName: 'init-workbook-repos',
      dryRun: false,
    };
  }

  /**
   * Initialize per-workbook scratch repos (standalone connector-less files, DEV-10424) for
   * workbooks created before scratch-repo auto-init was added. Batched via `qty` and resumable
   * (oldest-first); idempotent — scratch-git skips an already-initialized repo.
   */
  private async initScratchRepos(dto: ValidatedRunMigrationDto): Promise<MigrationResult> {
    let workbooks;

    if (dto.ids && dto.ids.length > 0) {
      workbooks = await this.db.client.workbook.findMany({
        where: { id: { in: dto.ids } },
        select: { id: true, organizationId: true },
      });
    } else {
      workbooks = await this.db.client.workbook.findMany({
        select: { id: true, organizationId: true },
        take: dto.qty,
        orderBy: { createdAt: 'asc' },
      });
    }

    const migratedIds: string[] = [];
    for (const wb of workbooks) {
      try {
        await this.workbookRepoService.initScratchRepo(wb.organizationId, wb.id as WorkbookId);
        migratedIds.push(wb.id);
      } catch (error) {
        this.logger.error(`Failed to init scratch repo for ${wb.id}: ${String(error)}`);
      }
    }

    const totalCount = await this.db.client.workbook.count();

    return {
      migratedIds,
      remainingCount: totalCount - migratedIds.length,
      migrationName: 'init-scratch-repos',
      dryRun: false,
    };
  }

  /**
   * Backfill `data_source_id` into the `tableId` column of every Notion
   * DataFolder. Phase 2 of the @notionhq/client 3.x → 5.x upgrade (DEV-8910).
   *
   * Per-folder decision logic lives in
   * [notion-data-source-backfill.ts](./notion-data-source-backfill.ts) and is
   * dependency-injected so the orchestration here can be thin and the core
   * can be unit-tested without a database. See `BACKFILL_AUDIT_MARKER` for
   * how the multi-source case is tagged for rollback.
   *
   * Idempotent: re-runs skip folders already at `tableId.length === 2`.
   * Returns successfully-processed folder ids in `migratedIds`; skipped /
   * errored folders are logged but not included.
   */
  private async runNotionDataSourceBackfill(dto: ValidatedRunMigrationDto): Promise<MigrationResult> {
    const folderRows =
      dto.ids && dto.ids.length > 0
        ? await this.db.client.dataFolder.findMany({
            where: { workbookId: { in: dto.ids }, connectorService: Service.NOTION },
            include: { workbook: { select: { organizationId: true } } },
          })
        : await this.db.client.dataFolder.findMany({
            where: { connectorService: Service.NOTION },
            take: dto.qty,
            orderBy: { createdAt: 'asc' },
            include: { workbook: { select: { organizationId: true } } },
          });

    const deps = this.buildBackfillDeps();
    const summary = emptySummary();
    const migratedIds: string[] = [];

    for (const row of folderRows) {
      if (!row.connectorAccountId) {
        // A Notion folder without a connector account shouldn't exist, but if
        // one does we can't talk to Notion for it. Log and skip.
        this.logger.warn(`Folder ${row.id} has no connectorAccountId — skipping`);
        summary.errored += 1;
        summary.total += 1;
        continue;
      }

      const folder: FolderToBackfill = {
        id: row.id as DataFolderId,
        workbookId: row.workbookId,
        organizationId: row.workbook.organizationId,
        connectorAccountId: row.connectorAccountId,
        tableId: row.tableId,
        name: row.name,
      };

      const result = await backfillNotionFolder(folder, deps);
      accumulate(summary, result);

      this.logger.log(`Folder ${folder.id} (${folder.name}) → ${result.kind}`);

      // Count both write outcomes as "migrated". Skipped (already done /
      // missing in Notion) and errored folders are left for the next run.
      if (result.kind === 'single_source_rewritten' || result.kind === 'multi_source_expanded') {
        migratedIds.push(folder.id);
      }
    }

    // `remainingCount` = Notion folders that still need backfill *after* this
    // run. The query happens against fresh DB state, so it's accurate even
    // when this run created new (already-backfilled) folders in the
    // multi-source case.
    const allNotionFolders = await this.db.client.dataFolder.findMany({
      where: { connectorService: Service.NOTION },
      select: { tableId: true },
    });
    const remainingCount = allNotionFolders.filter((f) => f.tableId.length < 2).length;

    this.logger.log(`notion-data-source-backfill complete: ${JSON.stringify(summary)}`);

    return {
      migratedIds,
      remainingCount,
      migrationName: 'notion-data-source-backfill',
      dryRun: false,
    };
  }

  /**
   * Wire the production services into `BackfillDeps`. Caches one Notion
   * `Client` per connector account so we don't decrypt credentials more than
   * once per account during the run. OAuth tokens are auto-refreshed via
   * `OAuthService.getValidAccessToken`; user-provided keys come from
   * `CredentialEncryptionService.decryptCredentials`.
   */
  private buildBackfillDeps(): BackfillDeps {
    const clientByAccount = new Map<string, NotionApiClient | 'no_token'>();

    const getClient = async (connectorAccountId: string): Promise<NotionApiClient | 'no_token'> => {
      const cached = clientByAccount.get(connectorAccountId);
      if (cached) return cached;

      const account = await this.db.client.connectorAccount.findUnique({ where: { id: connectorAccountId } });
      if (!account) {
        clientByAccount.set(connectorAccountId, 'no_token');
        return 'no_token';
      }

      let token: string | undefined;
      if (account.authType === AuthType.OAUTH) {
        try {
          token = await this.oauthService.getValidAccessToken(connectorAccountId);
        } catch (error) {
          this.logger.warn(`OAuth token fetch failed for ${connectorAccountId}: ${String(error)}`);
        }
      } else {
        const decrypted = await this.credentialEncryptionService.decryptCredentials(
          account.encryptedCredentials as unknown as EncryptedData,
        );
        token = decrypted.apiKey;
      }

      if (!token) {
        clientByAccount.set(connectorAccountId, 'no_token');
        return 'no_token';
      }
      const client = new NotionApiClient(token, { notionVersion: NOTION_API_VERSION_FOR_BACKFILL });
      clientByAccount.set(connectorAccountId, client);
      return client;
    };

    return {
      dryRun: false,
      fetchDataSources: async (databaseId, connectorAccountId): Promise<NotionFetchOutcome> => {
        const client = await getClient(connectorAccountId);
        if (client === 'no_token') return { kind: 'unauthorized' };
        try {
          const response = await client.retrieveDatabase({ database_id: databaseId });
          if (!isFullDatabase(response)) {
            return { kind: 'error', error: new Error(`partial database response for ${databaseId}`) };
          }
          return { kind: 'ok', dataSources: response.data_sources };
        } catch (error) {
          const e = error as { code?: string; status?: number };
          if (e.code === 'object_not_found' || e.status === 404) return { kind: 'not_found' };
          if (e.code === 'unauthorized' || e.status === 401) return { kind: 'unauthorized' };
          return { kind: 'error', error };
        }
      },
      updateFolderTableId: async (folderId, tableId) => {
        await this.db.client.dataFolder.update({ where: { id: folderId }, data: { tableId } });
      },
      createDataFolder: async (input) => {
        await this.db.client.dataFolder.create({
          data: {
            id: input.id,
            name: input.name,
            workbookId: input.workbookId,
            connectorAccountId: input.connectorAccountId,
            connectorService: Service.NOTION,
            tableId: input.tableId,
          },
        });
        return input.id;
      },
      logAudit: async (entry: AuditLogEntry) => {
        await this.auditLogService.logEvent({
          actor: SYSTEM_ACTOR,
          eventType: 'update',
          message: entry.message,
          entityId: entry.entityId,
          organizationId: entry.organizationId,
          context: entry.context,
        });
      },
    };
  }

  /**
   * Phase 3 of the sync-mapping v1 → v2 dual-column migration (DEV-10008):
   * populate `Sync.mappingsV2` for syncs created before the dual-column model
   * (rows where `mappingsV2 IS NULL`).
   *
   * Per-row decision logic lives in
   * [sync-mapping-v2-backfill.ts](./sync-mapping-v2-backfill.ts) and is
   * dependency-injected so the orchestration here stays thin and the core is
   * unit-testable without a database.
   *
   * Idempotent and parallel-safe: the candidate query filters `mappingsV2 IS
   * NULL`, and each write is a compare-and-set, so re-runs and concurrent
   * batches skip rows already migrated. The frozen v1 `mappings` column is
   * never touched — non-destructive and reversible by clearing `mappingsV2`.
   */
  private async runSyncMappingV2Backfill(dto: ValidatedRunMigrationDto): Promise<MigrationResult> {
    // Candidate rows: syncs still on the frozen v1 column (`mappingsV2 IS
    // NULL`), targeted by id when `ids` is given, else oldest-first up to
    // `qty`. The raw v1 `mappings` is read here pre-transform — the one read
    // that must bypass the `parseStoredMappings` choke point (which prefers,
    // then strips, `mappingsV2`). Hence the justified choke-point lint disable.
    //
    // Operational note: an errored row (malformed v1) stays `mappingsV2 IS
    // NULL` and remains a candidate, so a persistently-malformed *oldest*
    // prefix can stall qty-mode progress (and hold `remainingCount` above 0,
    // delaying the Phase 4 drop trigger). The summary's `errors` list names the
    // stuck ids; drain or repair them via an ids-mode run, or step past the bad
    // prefix with a larger `qty`.
    const targetingSpecificIds = dto.ids !== undefined && dto.ids.length > 0;
    const candidateWhere: Prisma.SyncWhereInput = targetingSpecificIds
      ? { id: { in: dto.ids }, mappingsV2: { equals: Prisma.DbNull } }
      : { mappingsV2: { equals: Prisma.DbNull } };
    // eslint-disable-next-line no-restricted-syntax -- backfill reads the raw pre-v2 `mappings` column; cannot route through parseStoredMappings
    const candidateRows = await this.db.client.sync.findMany({
      where: candidateWhere,
      // `take`/`orderBy` only bound the qty sweep; for an explicit id set the
      // `id: { in }` filter already bounds the result.
      take: targetingSpecificIds ? undefined : dto.qty,
      orderBy: { createdAt: 'asc' },
      select: { id: true, updatedAt: true, mappings: true, workbook: { select: { organizationId: true } } },
    });

    const deps = this.buildSyncMappingV2BackfillDeps();
    const summary = emptySyncMappingV2BackfillSummary();
    const migratedIds: string[] = [];

    for (const row of candidateRows) {
      let result: SyncMappingV2BackfillResult;
      try {
        result = await backfillSyncMappingRow(
          {
            id: row.id as SyncId,
            organizationId: row.workbook?.organizationId ?? null,
            updatedAt: row.updatedAt,
            rawV1Mappings: row.mappings,
          },
          deps,
        );
      } catch (error) {
        // A transient DB failure on the compare-and-set (deadlock, dropped
        // connection) must not abort the whole batch. The row stays
        // `mappingsV2 IS NULL`, so the next sweep retries it; the remaining
        // candidates in this batch are still processed.
        result = { kind: 'errored', error };
      }
      accumulateSyncMappingV2Backfill(summary, row.id, result);
      if (result.kind === 'transformed') {
        migratedIds.push(row.id);
      } else if (result.kind === 'errored') {
        this.logger.warn(`sync-mapping-v2-backfill: sync ${row.id} failed to migrate: ${String(result.error)}`);
      }
    }

    // `remainingCount` = syncs still on v1 (`mappingsV2 IS NULL`) *after* this
    // run, read against fresh DB state so it reflects rows this batch wrote.
    // This is the Phase 4 drop trigger: when it holds at 0 through the soak
    // window, the v1 column can be removed. (`count` is not a `find*`, so it is
    // outside the choke-point lint rule.)
    const remainingCount = await this.db.client.sync.count({
      where: { mappingsV2: { equals: Prisma.DbNull } },
    });

    this.metricsService.logValue(CustomMetric.BACKFILL_SYNC_MAPPING_V2_TRANSFORMED_TOTAL, summary.transformed);
    this.metricsService.logValue(CustomMetric.BACKFILL_SYNC_MAPPING_V1_REMAINING, remainingCount);

    this.logger.log(`sync-mapping-v2-backfill complete: ${JSON.stringify(summary)}; remaining=${remainingCount}`);

    return {
      migratedIds,
      remainingCount,
      migrationName: 'sync-mapping-v2-backfill',
      dryRun: false,
    };
  }

  /**
   * Wire the production Prisma + audit services into `SyncMappingV2BackfillDeps`.
   * The compare-and-set write is the key piece: `updateMany` filtered on
   * `(id, updatedAt unchanged, mappingsV2 IS NULL)` so a concurrent save or a
   * parallel backfill batch that already populated `mappingsV2` leaves this a
   * zero-row no-op rather than clobbering newer data.
   */
  private buildSyncMappingV2BackfillDeps(): SyncMappingV2BackfillDeps {
    return {
      dryRun: false,
      writeMappingsV2IfUnchanged: async (syncId, previouslyReadUpdatedAt, mappingsV2) => {
        const result = await this.db.client.sync.updateMany({
          where: {
            id: syncId,
            updatedAt: previouslyReadUpdatedAt,
            mappingsV2: { equals: Prisma.DbNull },
          },
          data: { mappingsV2: mappingsV2 as unknown as Prisma.InputJsonValue },
        });
        return result.count;
      },
      logAudit: async (entry) => {
        // Audit is a best-effort side log: by the time we get here the row is
        // already migrated, so an audit-write failure must not fail (or abort)
        // the migration. Matches the sync-run audit convention (caught + warned,
        // never blocks the write).
        try {
          await this.auditLogService.logEvent({
            actor: SYSTEM_ACTOR,
            eventType: 'update',
            message: entry.message,
            entityId: entry.entityId,
            organizationId: entry.organizationId,
            context: entry.context,
          });
        } catch (error) {
          this.logger.warn(`sync-mapping-v2-backfill: audit log failed for sync ${entry.entityId}: ${String(error)}`);
        }
      },
    };
  }

  /**
   * DEV-10880 — backfill `FileIndex.connectorAccountId` for rows written before
   * the discriminator column existed.
   *
   * Per-workbook: recover each connection-relative folderPath's owning connection
   * from the workbook's DataFolders (pure logic in
   * [fileindex-connector-account-backfill.ts](./fileindex-connector-account-backfill.ts)),
   * then `updateMany` the NULL rows of each unambiguously-owned folderPath. A
   * folderPath shared by two connections is left NULL and corrected by a re-pull.
   *
   * Non-destructive (writes only NULL rows) and idempotent (re-runs skip
   * already-scoped rows). Supports dryRun, which counts would-be updates without
   * writing. `ids` targets specific workbooks; `qty` takes that many workbooks
   * that still have unscoped rows.
   */
  private async runFileIndexConnectorAccountBackfill(dto: ValidatedRunMigrationDto): Promise<MigrationResult> {
    const migrationName = 'fileindex-connector-account-backfill';
    const dryRun = dto.dryRun ?? false;

    // Candidate workbooks: those with FileIndex rows still lacking a
    // connectorAccountId. `ids` targets them directly; `qty` takes that many
    // distinct workbooks with unscoped rows (deterministic order for resumability).
    let workbookIds: string[];
    if (dto.ids && dto.ids.length > 0) {
      workbookIds = dto.ids;
    } else {
      const unscopedWorkbookRows = await this.db.client.fileIndex.findMany({
        where: { connectorAccountId: null },
        select: { workbookId: true },
        distinct: ['workbookId'],
        orderBy: { workbookId: 'asc' },
        take: dto.qty,
      });
      workbookIds = unscopedWorkbookRows.map((row) => row.workbookId);
    }

    const migratedIds: string[] = [];
    let totalRowsScoped = 0;
    let totalAmbiguousFolderPaths = 0;

    for (const workbookId of workbookIds) {
      const dataFolders = await this.db.client.dataFolder.findMany({
        where: { workbookId },
        select: { path: true, connectorAccountId: true },
      });
      const { unambiguousFolderPathToConnectorAccountId, ambiguousFolderPaths } =
        resolveFolderPathsToConnectorAccountIds(dataFolders);
      totalAmbiguousFolderPaths += ambiguousFolderPaths.size;

      let workbookRowsScoped = 0;
      for (const [folderPath, connectorAccountId] of unambiguousFolderPathToConnectorAccountId) {
        if (dryRun) {
          workbookRowsScoped += await this.db.client.fileIndex.count({
            where: { workbookId, folderPath, connectorAccountId: null },
          });
          continue;
        }
        const { count } = await this.db.client.fileIndex.updateMany({
          where: { workbookId, folderPath, connectorAccountId: null },
          data: { connectorAccountId },
        });
        workbookRowsScoped += count;
      }

      totalRowsScoped += workbookRowsScoped;
      if (workbookRowsScoped > 0) migratedIds.push(workbookId);
      this.logger.log(
        `${migrationName}: workbook ${workbookId} → ${workbookRowsScoped} rows scoped${dryRun ? ' (dry-run)' : ''}; ` +
          `${ambiguousFolderPaths.size} ambiguous folderPath(s) left NULL`,
      );
    }

    // Read against fresh DB state so it reflects rows this run wrote. Ambiguous
    // folderPaths keep this above 0 until their connections are re-pulled.
    const remainingCount = await this.db.client.fileIndex.count({ where: { connectorAccountId: null } });

    this.logger.log(
      `${migrationName} complete${dryRun ? ' (dry-run)' : ''}: scoped=${totalRowsScoped}; ` +
        `ambiguousFolderPaths=${totalAmbiguousFolderPaths}; workbooks=${workbookIds.length}; remaining=${remainingCount}`,
    );

    return {
      migratedIds,
      remainingCount,
      migrationName,
      dryRun,
      summary: [
        {
          label: dryRun ? 'FileIndex rows that would be scoped' : 'FileIndex rows scoped to a connection',
          count: totalRowsScoped,
        },
        {
          label: 'Ambiguous folderPaths left NULL (shared across connections; fixed by re-pull)',
          count: totalAmbiguousFolderPaths,
        },
        { label: 'Workbooks processed', count: workbookIds.length },
      ],
    };
  }

  /**
   * DEV-9698 (T2) — re-parent existing Webflow CMS collection folders from the
   * flat v1 layout `/<Site>/<Collection>` to the nested v2 layout
   * `/<Site>/Collections/<Collection>`.
   *
   * Per-folder decision logic lives in
   * [webflow-folder-restructure-backfill.ts](./webflow-folder-restructure-backfill.ts)
   * and is dependency-injected so the orchestration here stays thin and the core
   * is unit-testable without a database. Each folder's git move + atomic
   * path-column rewrite happen via `migrateWebflowCollectionFolder`; this method
   * orders the batch safely, then flips `ConnectorAccount.version` to 2 for every
   * account whose flat collection folders are all migrated.
   *
   * Idempotent: re-runs skip folders already at `DataFolder.version === 2`.
   * NOTE: this build does not yet quiesce the connection (drain jobs / block live
   * edits / cancel publish plans) — that is T4. Run against an idle connection.
   */
  private async runWebflowFolderRestructure(dto: ValidatedRunMigrationDto): Promise<MigrationResult> {
    const migrationName = 'webflow-folder-restructure';
    const dryRun = dto.dryRun ?? false;
    const targetingSpecificWorkbooks = dto.ids !== undefined && dto.ids.length > 0;

    // Candidate folders: Webflow folders still on the flat layout (version < 2).
    // `isAssetTable: false` drops the synthetic Assets table from the candidate
    // set up front (a real CMS collection is never an asset table, even one a
    // user named "Assets"), so a qty-bounded sweep isn't churned by it. The
    // synthetic Pages table carries no such flag — it falls through to the
    // in-function tableId discriminator and is skipped (Assets/Pages stay
    // untouched at version 1).
    const candidateWhereBase: Prisma.DataFolderWhereInput = {
      connectorService: Service.WEBFLOW,
      isAssetTable: false,
      version: { lt: WEBFLOW_NESTED_STRUCTURE_VERSION },
    };

    // Every run is account-atomic: it migrates a connector account's flat
    // collections all in one pass. This is required for correct move ordering —
    // if an account were split across batches, a sibling migrating first in an
    // earlier batch (into `/<Site>/Collections/<Sibling>`) would make move_folder
    // refuse a later-batch `/<Site>/Collections` prefix-case collection forever,
    // a permanent wedge that never lets the account flip to v2. `ids` mode targets
    // whole workbooks (⊇ whole accounts); `qty` mode takes `qty` oldest candidates
    // as a SEED, then expands to the full candidate set of every account they touch
    // (so `qty` is a lower bound on rows processed, rounded up to whole accounts).
    let candidateRows;
    if (targetingSpecificWorkbooks) {
      candidateRows = await this.db.client.dataFolder.findMany({
        where: { ...candidateWhereBase, workbookId: { in: dto.ids } },
        include: { workbook: { select: { organizationId: true } } },
      });
    } else {
      const seedRows = await this.db.client.dataFolder.findMany({
        where: candidateWhereBase,
        take: dto.qty,
        orderBy: { createdAt: 'asc' },
        select: { connectorAccountId: true },
      });
      const seedAccountIds = [
        ...new Set(seedRows.map((row) => row.connectorAccountId).filter((id): id is string => id !== null)),
      ];
      candidateRows =
        seedAccountIds.length === 0
          ? []
          : await this.db.client.dataFolder.findMany({
              where: { ...candidateWhereBase, connectorAccountId: { in: seedAccountIds } },
              include: { workbook: { select: { organizationId: true } } },
            });
    }

    const deps = this.buildWebflowFolderRestructureDeps(dryRun, WEBFLOW_NESTED_STRUCTURE_VERSION, migrationName);
    const summary = emptyWebflowFolderRestructureSummary();
    const migratedIds: string[] = [];

    const foldersToMigrate: WebflowCollectionFolderToMigrate[] = [];
    for (const row of candidateRows) {
      if (!row.connectorAccountId || !row.path) {
        this.logger.warn(`webflow-folder-restructure: folder ${row.id} missing connectorAccountId/path — skipping`);
        summary.errored += 1;
        summary.total += 1;
        continue;
      }
      foldersToMigrate.push({
        id: row.id as DataFolderId,
        workbookId: row.workbookId,
        organizationId: row.workbook.organizationId,
        connectorAccountId: row.connectorAccountId,
        name: row.name,
        path: row.path,
        version: row.version,
        tableId: row.tableId,
      });
    }

    // Group candidate folders by connector account, keeping each account's
    // workbookId. The migration is processed ONE ACCOUNT AT A TIME, each wrapped
    // in a quiesce/release pair (T4), because the lock + schedule-disable +
    // publish-cancel + job-drain are all per-connection.
    const foldersByConnectorAccount = new Map<
      string,
      { workbookId: string; folders: WebflowCollectionFolderToMigrate[] }
    >();
    for (const folder of foldersToMigrate) {
      const entry = foldersByConnectorAccount.get(folder.connectorAccountId) ?? {
        workbookId: folder.workbookId,
        folders: [],
      };
      entry.folders.push(folder);
      foldersByConnectorAccount.set(folder.connectorAccountId, entry);
    }

    // In `ids` mode, also process in-scope Webflow accounts still at v1 that have
    // NO candidate folders — these were fully moved but never flipped (a crash
    // before the version flip). Including them (with an empty folder list) lets the
    // per-account block below quiesce + flip them, repairing the crash. `qty` mode
    // is left out (it would require an unbounded scan); such stragglers are repaired
    // by a later `ids`-targeted run.
    if (!dryRun && targetingSpecificWorkbooks) {
      const inScopeFlatAccounts = await this.db.client.connectorAccount.findMany({
        where: {
          service: Service.WEBFLOW,
          version: { lt: WEBFLOW_NESTED_STRUCTURE_VERSION },
          workbookId: { in: dto.ids },
        },
        select: { id: true, workbookId: true },
      });
      for (const account of inScopeFlatAccounts) {
        if (!foldersByConnectorAccount.has(account.id)) {
          foldersByConnectorAccount.set(account.id, { workbookId: account.workbookId, folders: [] });
        }
      }
    }

    const flippedAccountIds: string[] = [];
    const skippedBusyAccountIds: string[] = [];

    // Stable account order so a run is deterministic and re-runs converge.
    const connectorAccountEntries = [...foldersByConnectorAccount.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

    for (const [connectorAccountId, { workbookId, folders }] of connectorAccountEntries) {
      // Order so a collection literally named "Collections" migrates before its
      // siblings (otherwise move_folder refuses it once siblings have relocated).
      const orderedFolders = sortWebflowCollectionFoldersForSafeMoveOrder(folders);

      // Dry-run: no quiesce, no flip — just report each folder's would-be move.
      // A dry-run folder resolves to `would_migrate` (never `migrated`), so the
      // would-be ids are surfaced in `migratedIds` for the admin UI to list.
      if (dryRun) {
        for (const folder of orderedFolders) {
          const result = await this.migrateOneWebflowFolder(folder, deps);
          accumulateWebflowFolderRestructure(summary, result);
          if (result.kind === 'would_migrate') migratedIds.push(folder.id);
        }
        continue;
      }

      // Quiesce (acquire). A connection too busy to drain in time is released and
      // SKIPPED this run rather than migrated unsafely — a later run retries it.
      try {
        await this.connectionQuiesceService.quiesceConnection(workbookId, connectorAccountId);
      } catch (error) {
        await this.connectionQuiesceService
          .unquiesceConnection(workbookId, connectorAccountId)
          .catch((releaseError) => {
            this.logger.warn(
              `webflow-folder-restructure: failed to release connection ${connectorAccountId} after a quiesce error: ${String(releaseError)}`,
            );
          });
        if (error instanceof ConnectionDrainTimeoutError) {
          skippedBusyAccountIds.push(connectorAccountId);
          this.logger.warn(`webflow-folder-restructure: ${error.message}`);
          continue;
        }
        throw error;
      }

      try {
        for (const folder of orderedFolders) {
          const result = await this.migrateOneWebflowFolder(folder, deps);
          accumulateWebflowFolderRestructure(summary, result);
          this.logger.log(`webflow-folder-restructure: folder ${folder.id} (${folder.name}) → ${result.kind}`);
          if (result.kind === 'migrated') {
            migratedIds.push(folder.id);
          } else if (result.kind === 'errored') {
            this.logger.warn(`webflow-folder-restructure: folder ${folder.id} errored: ${String(result.error)}`);
          }
        }

        // Flip the account to v2 once all its flat collection folders are gone —
        // BEFORE the release restores schedules and unlocks, so a restored schedule
        // can't fire a v1-layout pull that re-creates the flat folders we just moved.
        const remainingFlatCollections = await this.countFlatWebflowCollectionFoldersForAccount(connectorAccountId);
        if (remainingFlatCollections === 0) {
          await this.db.client.connectorAccount.update({
            where: { id: connectorAccountId },
            data: { version: WEBFLOW_NESTED_STRUCTURE_VERSION },
          });
          flippedAccountIds.push(connectorAccountId);
          this.logger.log(
            `webflow-folder-restructure: flipped ConnectorAccount ${connectorAccountId} → v${WEBFLOW_NESTED_STRUCTURE_VERSION}`,
          );
        }
      } finally {
        // Release UNCONDITIONALLY, even on a partial-folder failure that left the
        // account at v1 (some folders moved, one errored, so no flip above). The
        // tree is then transiently MIXED (some v2-nested, some v1-flat) until a
        // re-run finishes it — but this is safe because a pull never rewrites
        // `DataFolder.path`: a connection-wide pull fans out to the account's
        // EXISTING folders by id and writes records at each folder's STORED path
        // (`pull-linked-folder-files.job.ts` updates only `lock`/watermark fields),
        // so a restored v1 schedule can't revert an already-moved folder. We do NOT
        // hold schedules disabled on a non-flip: a folder that can NEVER migrate
        // (a permanent bad-path shape, or a `repo_missing` folder picked but never
        // pulled) would otherwise wedge the connection's schedules off forever.
        // ⚠️ If pull is ever changed to recompute a folder's path from the account
        // version, revisit this — the mixed window would then become a real revert.
        await this.connectionQuiesceService.unquiesceConnection(workbookId, connectorAccountId);
      }
    }

    const remainingCount = await this.countRemainingFlatWebflowCollectionFolders();

    this.logger.log(
      `${migrationName} complete${dryRun ? ' (dry-run)' : ''}: ${JSON.stringify(summary)}; ` +
        `flippedAccounts=${flippedAccountIds.length}; skippedBusyAccounts=${skippedBusyAccountIds.length}; ` +
        `remaining=${remainingCount}`,
    );

    return {
      migratedIds,
      remainingCount,
      migrationName,
      dryRun,
      summary: this.buildWebflowForwardSummaryRows(
        summary,
        flippedAccountIds.length,
        skippedBusyAccountIds.length,
        dryRun,
      ),
    };
  }

  /**
   * Flatten the forward-migration outcome counters into UI-renderable rows. In a
   * dry-run the move count reads from `would_migrate` (nothing was written), and
   * the account-flip rows are omitted because a dry-run neither quiesces nor flips.
   */
  private buildWebflowForwardSummaryRows(
    summary: WebflowFolderRestructureSummary,
    flippedAccounts: number,
    skippedBusyAccounts: number,
    dryRun: boolean,
  ): MigrationResultSummaryRow[] {
    const rows: MigrationResultSummaryRow[] = [
      { label: 'Collection folders examined', count: summary.total },
      {
        label: dryRun ? 'Would migrate to nested layout' : 'Migrated to nested layout',
        count: dryRun ? summary.would_migrate : summary.migrated,
      },
      { label: 'Skipped — already nested', count: summary.skipped_already_migrated },
      { label: 'Skipped — Assets/Pages (not a collection)', count: summary.skipped_not_a_collection },
      { label: 'Skipped — unexpected path shape', count: summary.skipped_bad_path_shape },
      { label: 'Skipped — repo not pulled yet', count: summary.skipped_repo_missing },
      { label: 'Errored', count: summary.errored },
    ];
    if (!dryRun) {
      rows.push(
        { label: 'Accounts flipped to v2 (nested)', count: flippedAccounts },
        { label: 'Accounts skipped (too busy to drain)', count: skippedBusyAccounts },
      );
    }
    return rows;
  }

  /**
   * Run one folder's migration, converting a thrown error into an `errored`
   * result so a single folder failure (git move, DB txn) never aborts the batch —
   * the folder stays v1 and a re-run retries it (idempotency makes the retry safe).
   */
  private async migrateOneWebflowFolder(
    folder: WebflowCollectionFolderToMigrate,
    deps: WebflowFolderRestructureDeps,
  ): Promise<WebflowCollectionFolderMigrationResult> {
    try {
      return await migrateWebflowCollectionFolder(folder, deps);
    } catch (error) {
      return { kind: 'errored', error };
    }
  }

  /**
   * Wire the production Prisma / scratch-git / audit services into
   * `WebflowFolderRestructureDeps`. The atomic per-folder rewrite is delegated to
   * `applyWebflowFolderMovePathRewrite`; the git move resolves the connection's
   * repo and maps a missing-repo 404 to `repo_missing` (folder picked but never
   * pulled — left for a later run).
   *
   * `targetFolderVersion` is the `DataFolder.version` the atomic rewrite commits —
   * the only thing that differs functionally between the forward migration (2,
   * nesting) and the inverse/rollback (1, flattening); every other dep is
   * direction-agnostic, so both directions share this builder. `migrationName` is
   * a display-only label so the best-effort audit-failure warning is attributed to
   * the right run.
   */
  private buildWebflowFolderRestructureDeps(
    dryRun: boolean,
    targetFolderVersion: number,
    migrationName: string,
  ): WebflowFolderRestructureDeps {
    return {
      dryRun,
      ensureUniqueFolderPath: async (workbookId, connectorAccountId, candidateFolderPath, folderId) => {
        // Mirrors DataFolderService.ensureUniquePath: re-suffix with the last 5
        // of the folder id only on a genuine collision within the same account.
        const existing = await this.db.client.dataFolder.findFirst({
          where: { workbookId, connectorAccountId, path: candidateFolderPath },
          select: { id: true },
        });
        return existing ? `${candidateFolderPath}-${folderId.slice(-5)}` : candidateFolderPath;
      },
      moveFolderInGit: async (
        connectorAccountId,
        oldFolderPath,
        newFolderPath,
        commitMessage,
      ): Promise<GitFolderMoveOutcome> => {
        const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
        try {
          const { moved } = await this.scratchGitService.moveFolder(
            repoId,
            oldFolderPath,
            newFolderPath,
            commitMessage,
          );
          return moved ? { kind: 'moved' } : { kind: 'noop' };
        } catch (error) {
          if (error instanceof ScratchGitNotFoundError) return { kind: 'repo_missing' };
          throw error;
        }
      },
      applyFolderMovePathRewrite: (input) =>
        applyWebflowFolderMovePathRewrite(this.db.client, input, targetFolderVersion),
      logAudit: async (entry: WebflowFolderRestructureAuditLogEntry) => {
        // Audit is a best-effort side log written AFTER the folder is already
        // committed at its target version (the move + path rewrite have landed). An
        // audit-write failure must not propagate — if it did, the per-folder
        // function would reject, the orchestrator would mark an already-processed
        // folder as `errored` and drop it from its result ids, misreporting a
        // success. Catch + warn, never block (matches buildSyncMappingV2BackfillDeps).
        try {
          await this.auditLogService.logEvent({
            actor: SYSTEM_ACTOR,
            eventType: 'update',
            message: entry.message,
            entityId: entry.entityId,
            organizationId: entry.organizationId,
            context: entry.context,
          });
        } catch (error) {
          this.logger.warn(`${migrationName}: audit log failed for folder ${entry.entityId}: ${String(error)}`);
        }
      },
    };
  }

  /** Count flat (`version < 2`) Webflow CMS collection folders for one account. */
  private async countFlatWebflowCollectionFoldersForAccount(connectorAccountId: string): Promise<number> {
    const flatFolders = await this.db.client.dataFolder.findMany({
      where: {
        connectorAccountId,
        connectorService: Service.WEBFLOW,
        version: { lt: WEBFLOW_NESTED_STRUCTURE_VERSION },
      },
      select: { tableId: true },
    });
    return flatFolders.filter((folder) => classifyWebflowTableByTableId(folder.tableId) === 'collection').length;
  }

  /** Count every flat (`version < 2`) Webflow CMS collection folder still remaining. */
  private async countRemainingFlatWebflowCollectionFolders(): Promise<number> {
    const flatFolders = await this.db.client.dataFolder.findMany({
      where: { connectorService: Service.WEBFLOW, version: { lt: WEBFLOW_NESTED_STRUCTURE_VERSION } },
      select: { tableId: true },
    });
    return flatFolders.filter((folder) => classifyWebflowTableByTableId(folder.tableId) === 'collection').length;
  }

  /**
   * DEV-9698 (T6) — the ROLLBACK of {@link runWebflowFolderRestructure}: re-parent
   * nested v2 Webflow CMS collection folders from `/<Site>/Collections/<Collection>`
   * back to the flat v1 layout `/<Site>/<Collection>`, then flip
   * `ConnectorAccount.version` back to 1 for every account whose nested collections
   * are all reverted.
   *
   * This is a structural mirror of the forward orchestrator and shares its
   * primitives (account-atomic batching, per-connection quiesce, the atomic path
   * rewrite). The only deliberate differences: the candidate filter selects nested
   * folders (`version >= 2`), the ordering reverts a "Collections"-named collection
   * LAST in its site (vs. first), and the rewrite commits `version := 1` (vs. 2).
   *
   * Idempotent: re-runs skip folders already at `DataFolder.version === 1`.
   */
  private async runWebflowFolderRestructureInverse(dto: ValidatedRunMigrationDto): Promise<MigrationResult> {
    const migrationName = 'webflow-folder-restructure-inverse';
    const dryRun = dto.dryRun ?? false;
    const targetingSpecificWorkbooks = dto.ids !== undefined && dto.ids.length > 0;

    // Candidate folders: Webflow folders still on the NESTED layout (version >= 2).
    // `isAssetTable: false` is symmetric with the forward sweep (a real collection is
    // never an asset table); Assets/Pages stay at version 1 and are excluded by the
    // version filter regardless.
    const candidateWhereBase: Prisma.DataFolderWhereInput = {
      connectorService: Service.WEBFLOW,
      isAssetTable: false,
      version: { gte: WEBFLOW_NESTED_STRUCTURE_VERSION },
    };

    // Account-atomic, identical to the forward run: `ids` mode targets whole
    // workbooks; `qty` mode takes `qty` oldest nested candidates as a SEED and then
    // expands to the full nested candidate set of every account they touch (so the
    // "Collections"-named-last ordering can never be split across batches).
    let candidateRows;
    if (targetingSpecificWorkbooks) {
      candidateRows = await this.db.client.dataFolder.findMany({
        where: { ...candidateWhereBase, workbookId: { in: dto.ids } },
        include: { workbook: { select: { organizationId: true } } },
      });
    } else {
      const seedRows = await this.db.client.dataFolder.findMany({
        where: candidateWhereBase,
        take: dto.qty,
        orderBy: { createdAt: 'asc' },
        select: { connectorAccountId: true },
      });
      const seedAccountIds = [
        ...new Set(seedRows.map((row) => row.connectorAccountId).filter((id): id is string => id !== null)),
      ];
      candidateRows =
        seedAccountIds.length === 0
          ? []
          : await this.db.client.dataFolder.findMany({
              where: { ...candidateWhereBase, connectorAccountId: { in: seedAccountIds } },
              include: { workbook: { select: { organizationId: true } } },
            });
    }

    const deps = this.buildWebflowFolderRestructureDeps(dryRun, WEBFLOW_FLAT_STRUCTURE_VERSION, migrationName);
    const summary = emptyWebflowFolderRestructureInverseSummary();
    const revertedIds: string[] = [];

    const foldersToRevert: WebflowCollectionFolderToMigrate[] = [];
    for (const row of candidateRows) {
      if (!row.connectorAccountId || !row.path) {
        this.logger.warn(
          `webflow-folder-restructure-inverse: folder ${row.id} missing connectorAccountId/path — skipping`,
        );
        summary.errored += 1;
        summary.total += 1;
        continue;
      }
      foldersToRevert.push({
        id: row.id as DataFolderId,
        workbookId: row.workbookId,
        organizationId: row.workbook.organizationId,
        connectorAccountId: row.connectorAccountId,
        name: row.name,
        path: row.path,
        version: row.version,
        tableId: row.tableId,
      });
    }

    const foldersByConnectorAccount = new Map<
      string,
      { workbookId: string; folders: WebflowCollectionFolderToMigrate[] }
    >();
    for (const folder of foldersToRevert) {
      const entry = foldersByConnectorAccount.get(folder.connectorAccountId) ?? {
        workbookId: folder.workbookId,
        folders: [],
      };
      entry.folders.push(folder);
      foldersByConnectorAccount.set(folder.connectorAccountId, entry);
    }

    // In `ids` mode, also process in-scope Webflow accounts still at v2 that have NO
    // nested candidate folders — fully reverted but never flipped back to v1 (a crash
    // before the version flip). Including them (empty folder list) lets the per-account
    // block quiesce + flip them to v1, repairing the crash.
    if (!dryRun && targetingSpecificWorkbooks) {
      const inScopeNestedAccounts = await this.db.client.connectorAccount.findMany({
        where: {
          service: Service.WEBFLOW,
          version: { gte: WEBFLOW_NESTED_STRUCTURE_VERSION },
          workbookId: { in: dto.ids },
        },
        select: { id: true, workbookId: true },
      });
      for (const account of inScopeNestedAccounts) {
        if (!foldersByConnectorAccount.has(account.id)) {
          foldersByConnectorAccount.set(account.id, { workbookId: account.workbookId, folders: [] });
        }
      }
    }

    const flippedAccountIds: string[] = [];
    const skippedBusyAccountIds: string[] = [];

    const connectorAccountEntries = [...foldersByConnectorAccount.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

    for (const [connectorAccountId, { workbookId, folders }] of connectorAccountEntries) {
      // Order so a collection literally named "Collections" reverts AFTER its siblings
      // (otherwise its flat destination still holds the siblings and move_folder refuses it).
      const orderedFolders = sortWebflowCollectionFoldersForSafeInverseMoveOrder(folders);

      // Dry-run: a folder resolves to `would_revert` (never `reverted`), so the
      // would-be ids are surfaced in `revertedIds` for the admin UI to list.
      if (dryRun) {
        for (const folder of orderedFolders) {
          const result = await this.invertOneWebflowFolder(folder, deps);
          accumulateWebflowFolderRestructureInverse(summary, result);
          if (result.kind === 'would_revert') revertedIds.push(folder.id);
        }
        continue;
      }

      try {
        await this.connectionQuiesceService.quiesceConnection(workbookId, connectorAccountId);
      } catch (error) {
        await this.connectionQuiesceService
          .unquiesceConnection(workbookId, connectorAccountId)
          .catch((releaseError) => {
            this.logger.warn(
              `webflow-folder-restructure-inverse: failed to release connection ${connectorAccountId} after a quiesce error: ${String(releaseError)}`,
            );
          });
        if (error instanceof ConnectionDrainTimeoutError) {
          skippedBusyAccountIds.push(connectorAccountId);
          this.logger.warn(`webflow-folder-restructure-inverse: ${error.message}`);
          continue;
        }
        throw error;
      }

      try {
        for (const folder of orderedFolders) {
          const result = await this.invertOneWebflowFolder(folder, deps);
          accumulateWebflowFolderRestructureInverse(summary, result);
          this.logger.log(`webflow-folder-restructure-inverse: folder ${folder.id} (${folder.name}) → ${result.kind}`);
          if (result.kind === 'reverted') {
            revertedIds.push(folder.id);
          } else if (result.kind === 'errored') {
            this.logger.warn(
              `webflow-folder-restructure-inverse: folder ${folder.id} errored: ${String(result.error)}`,
            );
          }
        }

        // Flip the account back to v1 once all its nested collection folders are gone —
        // BEFORE the release restores schedules and unlocks (mirrors the forward flip).
        const remainingNestedCollections = await this.countNestedWebflowCollectionFoldersForAccount(connectorAccountId);
        if (remainingNestedCollections === 0) {
          await this.db.client.connectorAccount.update({
            where: { id: connectorAccountId },
            data: { version: WEBFLOW_FLAT_STRUCTURE_VERSION },
          });
          flippedAccountIds.push(connectorAccountId);
          this.logger.log(
            `webflow-folder-restructure-inverse: flipped ConnectorAccount ${connectorAccountId} → v${WEBFLOW_FLAT_STRUCTURE_VERSION}`,
          );
        }
      } finally {
        // Release UNCONDITIONALLY (same rationale as the forward run): a pull never
        // rewrites `DataFolder.path`, so a transiently-mixed tree after a partial revert
        // converges on a re-run, and a folder that can never revert (permanent bad shape /
        // repo_missing) must not wedge the connection's schedules off forever.
        await this.connectionQuiesceService.unquiesceConnection(workbookId, connectorAccountId);
      }
    }

    const remainingCount = await this.countRemainingNestedWebflowCollectionFolders();

    this.logger.log(
      `${migrationName} complete${dryRun ? ' (dry-run)' : ''}: ${JSON.stringify(summary)}; ` +
        `flippedAccounts=${flippedAccountIds.length}; skippedBusyAccounts=${skippedBusyAccountIds.length}; ` +
        `remaining=${remainingCount}`,
    );

    return {
      migratedIds: revertedIds,
      remainingCount,
      migrationName,
      dryRun,
      summary: this.buildWebflowInverseSummaryRows(
        summary,
        flippedAccountIds.length,
        skippedBusyAccountIds.length,
        dryRun,
      ),
    };
  }

  /**
   * Flatten the inverse-migration outcome counters into UI-renderable rows. In a
   * dry-run the revert count reads from `would_revert` (nothing was written), and
   * the account-flip rows are omitted because a dry-run neither quiesces nor flips.
   */
  private buildWebflowInverseSummaryRows(
    summary: WebflowFolderRestructureInverseSummary,
    flippedAccounts: number,
    skippedBusyAccounts: number,
    dryRun: boolean,
  ): MigrationResultSummaryRow[] {
    const rows: MigrationResultSummaryRow[] = [
      { label: 'Collection folders examined', count: summary.total },
      {
        label: dryRun ? 'Would revert to flat layout' : 'Reverted to flat layout',
        count: dryRun ? summary.would_revert : summary.reverted,
      },
      { label: 'Skipped — already flat', count: summary.skipped_already_flat },
      { label: 'Skipped — Assets/Pages (not a collection)', count: summary.skipped_not_a_collection },
      { label: 'Skipped — unexpected path shape', count: summary.skipped_bad_path_shape },
      { label: 'Skipped — repo not pulled yet', count: summary.skipped_repo_missing },
      { label: 'Errored', count: summary.errored },
    ];
    if (!dryRun) {
      rows.push(
        { label: 'Accounts flipped to v1 (flat)', count: flippedAccounts },
        { label: 'Accounts skipped (too busy to drain)', count: skippedBusyAccounts },
      );
    }
    return rows;
  }

  /**
   * Run one folder's inversion, converting a thrown error into an `errored` result
   * so a single folder failure never aborts the batch (the folder stays v2 and a
   * re-run retries it; idempotency makes the retry safe).
   */
  private async invertOneWebflowFolder(
    folder: WebflowCollectionFolderToMigrate,
    deps: WebflowFolderRestructureDeps,
  ): Promise<WebflowCollectionFolderInversionResult> {
    try {
      return await invertWebflowCollectionFolder(folder, deps);
    } catch (error) {
      return { kind: 'errored', error };
    }
  }

  /** Count nested (`version >= 2`) Webflow CMS collection folders for one account. */
  private async countNestedWebflowCollectionFoldersForAccount(connectorAccountId: string): Promise<number> {
    const nestedFolders = await this.db.client.dataFolder.findMany({
      where: {
        connectorAccountId,
        connectorService: Service.WEBFLOW,
        version: { gte: WEBFLOW_NESTED_STRUCTURE_VERSION },
      },
      select: { tableId: true },
    });
    return nestedFolders.filter((folder) => classifyWebflowTableByTableId(folder.tableId) === 'collection').length;
  }

  /** Count every nested (`version >= 2`) Webflow CMS collection folder still remaining. */
  private async countRemainingNestedWebflowCollectionFolders(): Promise<number> {
    const nestedFolders = await this.db.client.dataFolder.findMany({
      where: { connectorService: Service.WEBFLOW, version: { gte: WEBFLOW_NESTED_STRUCTURE_VERSION } },
      select: { tableId: true },
    });
    return nestedFolders.filter((folder) => classifyWebflowTableByTableId(folder.tableId) === 'collection').length;
  }
}
