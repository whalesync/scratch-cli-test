import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Client } from '@notionhq/client';
import { AuthType } from '@prisma/client';
import type {
  AvailableMigrationsResponse,
  MigrationDescriptor,
  MigrationResult,
  RunMigrationDto,
  ValidatedRunMigrationDto,
  WorkbookId,
} from '@spinner/shared-types';
import { type DataFolderId } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { hasAdminToolsPermission } from 'src/auth/permissions';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { OAuthService } from 'src/oauth/oauth.service';
import { Service } from 'src/remote-service/connectors/service-constants';
import { SYSTEM_ACTOR } from 'src/users/types';
import { EncryptedData } from 'src/utils/encryption';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { DbService } from '../db/db.service';
import {
  accumulate,
  AuditLogEntry,
  BackfillDeps,
  backfillNotionFolder,
  emptySummary,
  FolderToBackfill,
  NotionFetchOutcome,
} from './notion-data-source-backfill';

const AVAILABLE_MIGRATIONS: MigrationDescriptor[] = [
  {
    name: 'init-workbook-repos',
    description:
      'Initializes the Git config repo for workbooks created before auto-init was added (April 2026). ' +
      'Safe to run multiple times — workbooks that already have a repo are skipped by scratch-git.',
  },
  {
    name: 'notion-data-source-backfill',
    description:
      "Backfills Notion data source IDs into existing folders so the connector can talk to Notion's " +
      '2025-09-03 API. For single-source databases (the common case), the folder is rewritten in place ' +
      'and the change is transparent to the user. For databases with multiple data sources, the existing ' +
      'folder is pinned to the first source and one new folder is created per additional source. ' +
      'Idempotent — re-runs skip folders that already have a 2-element tableId.',
  },
];

/**
 * Notion API version that exposes `data_sources` on the `databases.retrieve`
 * response. See the 2025-09-03 upgrade guide. The production NotionConnector
 * still uses the SDK default — Phase 3 of the upgrade will bump it in lockstep
 * with the `fetchJsonTableSpec` migration to `dataSources.retrieve`.
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

    switch (dto.migration) {
      case 'init-workbook-repos':
        return this.initWorkbookRepos(dto);
      case 'notion-data-source-backfill':
        return this.runNotionDataSourceBackfill(dto);
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
    const clientByAccount = new Map<string, Client | 'no_token'>();

    const getClient = async (connectorAccountId: string): Promise<Client | 'no_token'> => {
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
      const client = new Client({ auth: token, notionVersion: NOTION_API_VERSION_FOR_BACKFILL });
      clientByAccount.set(connectorAccountId, client);
      return client;
    };

    return {
      dryRun: false,
      fetchDataSources: async (databaseId, connectorAccountId): Promise<NotionFetchOutcome> => {
        const client = await getClient(connectorAccountId);
        if (client === 'no_token') return { kind: 'unauthorized' };
        try {
          // The 2025-09-03 response carries `data_sources: Array<{ id, name }>`
          // which is not in the v3 SDK's typed `DatabaseObjectResponse`.
          const response = (await client.databases.retrieve({ database_id: databaseId })) as unknown as {
            data_sources?: Array<{ id: string; name: string }>;
          };
          return { kind: 'ok', dataSources: response.data_sources ?? [] };
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
}
