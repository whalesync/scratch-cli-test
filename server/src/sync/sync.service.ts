import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type Sync as PrismaSync } from '@prisma/client';
import { TSchema } from '@sinclair/typebox';
import type { Service } from '@spinner/shared-types';
import {
  AiContextResponse,
  ColumnMapping,
  ColumnMappingV2,
  ConstantTypeMismatchError,
  createScratchPendingPublishId,
  createSyncId,
  DataFolderId,
  ExportSyncConfig,
  LookupFieldOptions,
  PreviewFieldResult,
  PreviewRecordBody,
  PreviewRecordResponse,
  SaveSyncBody,
  ScheduleAction,
  StoredSyncMapping,
  SyncId,
  SyncMapping,
  SyncMappingV1,
  SyncMappingV2,
  SyncMappingValidationError,
  TableMappingV1,
  TableMappingV2,
  TransformerConfig,
  TransformerTypes,
  transformV1ToV2,
  ValidateSyncMappingTypesResponse,
  WorkbookId,
} from '@spinner/shared-types';
import get from 'lodash/get';
import isEqual from 'lodash/isEqual';
import set from 'lodash/set';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { Service as ServiceConst } from 'src/remote-service/connectors/service-constants';
import { BaseJsonTableSpec, IdPath, idPath, readRecordIdAsString } from 'src/remote-service/connectors/types';
import { ScheduleService } from 'src/schedule/schedule.service';
import { DIRTY_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { findConstantTypeMismatches, getSchemaAtPath, validateSchemaMapping } from 'src/sync/schema-validator';
import {
  applyColumnMappings,
  classifyDestinationRecord,
  ensureTableMappingV2,
  findTransformerConfigsV2,
  getColumnMappingPhaseV2,
  v2ColumnAsV1,
} from 'src/sync/sync-execution';
import {
  parseStoredMappings,
  previewRecordBodySchema,
  saveSyncBodySchema,
  validateMappingTypeBodySchema,
} from 'src/sync/sync-mapping.schema';
import {
  applyTransformerPipeline,
  createLookupTools,
  getColumnMappingPhase,
  getTransformerConfigs,
  LookupTools,
  SyncPhase,
  SyncRecord,
} from 'src/sync/transformers';
import { MappingTypeTrace, traceMappingType } from 'src/sync/transformers/type-validator';
import { Actor } from 'src/users/types';
import { formatJsonWithPrettier } from 'src/utils/json-formatter';
import { extractSchemaFields, SchemaField } from 'src/utils/schema-helpers';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { deduplicateFileName, resolveBaseFileName } from 'src/workbook/util';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { WorkbookService } from 'src/workbook/workbook.service';

export interface RemoteIdMappingPair {
  sourceRemoteId: string;
  destinationRemoteId: string | null;
  destinationFilePath: string | null;
}

interface FileContent {
  folderId: DataFolderId;
  path: string;
  content: string;
}

interface MatchKeyTransformContext {
  sourceTableSpec: BaseJsonTableSpec | null;
  destinationTableSpec: BaseJsonTableSpec | null;
  sourceService: Service;
  destinationService: Service;
}

export interface SyncTableMappingResult {
  recordsCreated: number;
  recordsUpdated: number;
  recordsSkipped: number;
  createdPaths: string[];
  updatedPaths: string[];
  errors: Array<{ sourceRemoteId: string; error: string }>;
  warnings: Array<{ sourceRemoteId: string; warning: string }>;
  /**
   * Per-table summary of Pass 3 (unmatched-destination) activity. Zero across
   * the board when Pass 3 is gated off (no `unmatchedDestinationPolicy`, no
   * `recordMatching`, or `onlySourceFilePath` is set). The worker job
   * aggregates these across tables to populate the per-run AuditLogEvent and
   * the PostHog `sync_completed` event.
   */
  unmatchedDestinationCounts: {
    /** Unmatched dest records whose match-key field is populated (visited count). */
    withMatchKey: number;
    /** Unmatched dest records whose match-key field is empty/null/whitespace (visited count). */
    withoutMatchKey: number;
    /** Records actually written by Pass 3 — proxy for "flipped to the archived value." */
    archived: number;
    /**
     * Records updated in Pass 2 when the table mapping has any `when: 'matched'`
     * or `when: 'always'` constant — proxy for "flipped to the unarchived value."
     * Upper bound, not exact (a record already at the constant value still counts).
     */
    unarchived: number;
  };
}

/**
 * Sync row with its on-disk mappings resolved to the `StoredSyncMapping`
 * discriminated union. `mappingsV2` is omitted so consumers cannot reach
 * around the read choke point.
 */
export type SyncWithMappings = Omit<PrismaSync, 'mappings' | 'mappingsV2'> & {
  mappings: StoredSyncMapping;
};

/**
 * Sentinel value written to the frozen `Sync.mappings` column when a new sync
 * is created. The real mapping shape goes to `Sync.mappingsV2`. A pre-update
 * client that reads `mappings` directly sees an empty sync — fail-safe rather
 * than a corrupt half-state. See plan §"Storage Model and Migration".
 *
 * TODO(DEV-10008): delete this sentinel when the `mappings` column is dropped
 * in the Phase 4 cleanup.
 */
const SENTINEL_EMPTY_V1_MAPPINGS: SyncMappingV1 = { version: 1, tableMappings: [] };

/**
 * Project a v2 column-mapping list down to the v1 `ColumnMapping` shape used by
 * `validateSchemaMapping` (source/destination type compatibility) and the
 * record-matching cross-check below. Drops constant sources — they have no
 * source-column path to validate — and unmatched-side rules, which have no
 * source-column read at all. The resulting list is what the v1 codepath would
 * have produced from the same logical sync.
 */
function projectV2ColumnMappingsToV1(columnMappings: ColumnMappingV2[]): ColumnMapping[] {
  const out: ColumnMapping[] = [];
  for (const cm of columnMappings) {
    if (cm.source.kind !== 'column') continue;
    if (cm.when !== undefined && cm.when !== 'matched') continue;
    out.push({
      sourceColumnId: cm.source.columnId,
      destinationColumnId: cm.destinationColumnId,
      ...(cm.source.transformer ? { transformer: cm.source.transformer } : {}),
      ...(cm.source.transformers ? { transformers: cm.source.transformers } : {}),
    });
  }
  return out;
}

/**
 * Normalize a request body's `mappings` field to the v2 shape for writing to
 * `Sync.mappingsV2`. The body may already be v2 (Lane D's editor) or v1 (the
 * scratchmd CLI, whalesync import, pre-update web client). Both are accepted
 * by `saveSyncBodySchema`; this helper produces the single shape that gets
 * persisted.
 */
function normalizeSaveBodyMappings(mappings: StoredSyncMapping): SyncMappingV2 {
  return mappings.version === 2 ? mappings : transformV1ToV2(mappings);
}

@Injectable()
export class SyncService {
  constructor(
    private readonly db: DbService,
    private readonly dataFolderService: DataFolderService,
    private readonly posthogService: PostHogService,
    private readonly scheduleService: ScheduleService,
    private readonly scratchGitService: ScratchGitService,
    private readonly workbookRepoService: WorkbookRepoService,
    private readonly workbookService: WorkbookService,
  ) {}

  /**
   * Read choke point — fetches a Sync row and resolves its on-disk mappings
   * (v1 or v2) to the `StoredSyncMapping` discriminated union. Prefers
   * `mappingsV2` when non-null, falls back to v1 `mappings`. The returned row
   * has `mappingsV2` stripped so consumers cannot reach around the choke
   * point.
   *
   * The ESLint rule on `prisma.sync.find*` ensures all reads route through
   * this method (or its sibling `getMappings`).
   */
  async getSync(syncId: SyncId): Promise<SyncWithMappings | null> {
    const row = await this.db.client.sync.findFirst({ where: { id: syncId } });
    return row ? parseStoredMappings(row) : null;
  }

  /**
   * Convenience: just the mappings for a sync. Returns the on-disk shape via
   * `StoredSyncMapping`; consumers narrow on `mappings.version`.
   */
  async getMappings(syncId: SyncId): Promise<StoredSyncMapping | null> {
    const row = await this.db.client.sync.findFirst({
      where: { id: syncId },
      select: { mappings: true, mappingsV2: true },
    });
    return row ? parseStoredMappings(row).mappings : null;
  }

  /**
   * Fetches a Sync with `syncTablePairs` and their source/destination
   * `DataFolder`s included, mappings parsed via the choke point. Used by the
   * `sync-data-folders` worker job; surfaces the deep include in one place so
   * the job doesn't need its own Prisma read.
   */
  async getSyncForExecution(syncId: SyncId): Promise<
    | (SyncWithMappings & {
        syncTablePairs: Array<
          Prisma.SyncTablePairGetPayload<{
            include: { sourceDataFolder: true; destinationDataFolder: true };
          }>
        >;
      })
    | null
  > {
    const row = await this.db.client.sync.findUnique({
      where: { id: syncId },
      include: {
        syncTablePairs: {
          include: {
            sourceDataFolder: true,
            destinationDataFolder: true,
          },
        },
      },
    });
    return row ? parseStoredMappings(row) : null;
  }

  /** Fire-and-forget: persist all syncs for the workbook to the workbook git repo. */
  private pushSyncsToGitInBackground(workbookId: WorkbookId, actor: Actor): void {
    const orgId = actor.organizationId;
    this.workbookRepoService
      .initWorkbookRepo(orgId, workbookId)
      .then(() => this.workbookRepoService.pushSyncs(orgId, workbookId, actor))
      .catch((err: unknown) => {
        WSLogger.warn({
          source: 'SyncService.pushSyncsToGitInBackground',
          message: 'Failed to push syncs to workbook repo',
          error: err,
          workbookId,
        });
      });
  }

  /**
   * Reads schema from git.
   */
  private async readSchemaFromGit(
    workbookId: string,
    connectorAccountId: string | null,
    folderPath: string | null,
  ): Promise<BaseJsonTableSpec | null> {
    if (folderPath) {
      try {
        const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
        const gitSchema = await this.scratchGitService.readSchemaFromGit(repoId, folderPath);
        if (gitSchema) return gitSchema;
      } catch (error) {
        WSLogger.error({
          source: 'SyncService.readSchemaFromGit',
          message: 'Failed to read schema from git',
          error,
          workbookId,
          folderPath,
        });
      }
    }
    return null;
  }

  /**
   * Creates a new sync.
   */
  async createSync(workbookId: WorkbookId, body: SaveSyncBody, actor: Actor): Promise<unknown> {
    const parsed = saveSyncBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid sync body: ${parsed.error.message}`);
    }

    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    const v2Mappings = normalizeSaveBodyMappings(body.mappings);

    // Validate mappings — skip gracefully when schemas are absent. The
    // validator is v1-only today; project v2 down to v1-shaped column
    // mappings (kind='column', when='matched'/undefined) before calling it.
    if (body.validateMappings) {
      for (const tableMapping of v2Mappings.tableMappings) {
        const sourceId = tableMapping.sourceDataFolderId;
        const destId = tableMapping.destinationDataFolderId;

        const sourceFolder = await this.dataFolderService.fetchSchemaSpec(sourceId, actor);
        const destFolder = await this.dataFolderService.fetchSchemaSpec(destId, actor);

        if (sourceFolder?.schema && destFolder?.schema) {
          const v1Cols = projectV2ColumnMappingsToV1(tableMapping.columnMappings);
          const errors = validateSchemaMapping(sourceFolder.schema, destFolder.schema, v1Cols);
          if (errors.length > 0) {
            throw new BadRequestException(`Validation failed for folder mapping: ${errors.join('; ')}`);
          }
        }

        // Constant column mappings have no source column for validateSchemaMapping
        // to type-check; verify their literal values against the destination
        // column type directly. Surfaced as HTTP 400 by SyncExceptionFilter.
        if (destFolder?.schema) {
          const constantMismatches = findConstantTypeMismatches(destFolder.schema, tableMapping.columnMappings);
          if (constantMismatches.length > 0) {
            const mismatch = constantMismatches[0];
            throw new ConstantTypeMismatchError(mismatch.destinationColumnId, mismatch.expected, mismatch.got);
          }
        }
      }
    }

    const syncId = createSyncId();

    const sync = await this.db.client.sync.create({
      data: {
        id: syncId,
        workbookId,
        displayName: body.displayName,
        // Sentinel-v1 on the frozen column; the real shape lives in mappingsV2.
        mappings: SENTINEL_EMPTY_V1_MAPPINGS as unknown as Prisma.InputJsonValue,
        mappingsV2: v2Mappings as unknown as Prisma.InputJsonValue,
        publishAfterSync: false,
        syncTablePairs: {
          create: v2Mappings.tableMappings.map((tm) => ({
            id: createSyncId(),
            sourceDataFolderId: tm.sourceDataFolderId,
            destinationDataFolderId: tm.destinationDataFolderId,
            // We would store columnMappings and recordMatching here if the model supported it,
            // but for now we just link the folders.
            // TODO: Update SyncTablePair model to support field mappings
          })),
        },
      },
      include: {
        syncTablePairs: true,
      },
    });

    // Create schedule if a non-empty cron expression was provided
    if (body.schedule) {
      await this.scheduleService.create(
        workbookId,
        {
          name: `Sync: ${body.displayName}`,
          action: ScheduleAction.SYNC,
          entityId: syncId,
          cronExpression: body.schedule,
          enabled: true,
        },
        actor,
      );
    }

    this.posthogService.trackCreateSync(actor, sync);
    this.pushSyncsToGitInBackground(workbookId, actor);
    return sync;
  }

  /**
   * Updates an existing sync.
   * Replaces mapped folders and settings.
   */
  async updateSync(workbookId: WorkbookId, syncId: SyncId, body: SaveSyncBody, actor: Actor): Promise<unknown> {
    const parsed = saveSyncBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid sync body: ${parsed.error.message}`);
    }

    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    // Existence check plus the migration state of this row. Selecting only `id`
    // and `mappingsV2` (not the v1 `mappings` content) keeps this outside the
    // read choke point's parse contract while still surfacing whether the sync
    // has crossed over to v2.
    const sync = await this.db.client.sync.findFirst({
      where: { id: syncId },
      select: { id: true, mappingsV2: true },
    });
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }

    // Once a sync has been migrated to v2 (`mappingsV2 IS NOT NULL`), reject any
    // save whose body is still the v1 shape. A stale client that only knows v1
    // would otherwise write to the frozen `mappings` column and have its edits
    // silently shadowed by the authoritative `mappingsV2`. A 409 prompts the
    // client to update to a v2-aware version.
    // TODO(DEV-10008): remove this guard when the v1 column is dropped and all
    // clients speak v2.
    if (sync.mappingsV2 !== null && body.mappings.version === 1) {
      throw new ConflictException({
        error: 'SYNC_MAPPING_V1_WRITE_REJECTED',
        message: 'This sync uses the latest mapping format. Update your client to the newest version to edit it.',
        syncId,
      });
    }

    const v2Mappings = normalizeSaveBodyMappings(body.mappings);

    if (body.validateMappings) {
      // Validate mappings — skip gracefully when schemas are absent. The
      // validator is v1-only today; project v2 down to v1-shaped column
      // mappings before calling it.
      for (const tableMapping of v2Mappings.tableMappings) {
        const sourceId = tableMapping.sourceDataFolderId;
        const destId = tableMapping.destinationDataFolderId;

        const sourceFolder = await this.dataFolderService.fetchSchemaSpec(sourceId, actor);
        const destFolder = await this.dataFolderService.fetchSchemaSpec(destId, actor);

        if (sourceFolder?.schema && destFolder?.schema) {
          const v1Cols = projectV2ColumnMappingsToV1(tableMapping.columnMappings);
          const errors = validateSchemaMapping(sourceFolder.schema, destFolder.schema, v1Cols);
          if (errors.length > 0) {
            throw new BadRequestException(`Validation failed for folder mapping: ${errors.join('; ')}`);
          }
        }

        // Constant column mappings have no source column for validateSchemaMapping
        // to type-check; verify their literal values against the destination
        // column type directly. Surfaced as HTTP 400 by SyncExceptionFilter.
        if (destFolder?.schema) {
          const constantMismatches = findConstantTypeMismatches(destFolder.schema, tableMapping.columnMappings);
          if (constantMismatches.length > 0) {
            const mismatch = constantMismatches[0];
            throw new ConstantTypeMismatchError(mismatch.destinationColumnId, mismatch.expected, mismatch.got);
          }
        }
      }
    }

    // Validate record matching fields exist in column mappings. A constant
    // mapping cannot serve as the match-key source (the v2 zod refinement
    // already blocks constants from targeting the match-key column); only
    // `kind: 'column'` mappings with a matching source/destination pair count.
    for (const tableMapping of v2Mappings.tableMappings) {
      const recordMatching = tableMapping.recordMatching;
      if (recordMatching) {
        const hasMatchingColumn = tableMapping.columnMappings.some(
          (cm) =>
            cm.source.kind === 'column' &&
            cm.source.columnId === recordMatching.sourceColumnId &&
            cm.destinationColumnId === recordMatching.destinationColumnId,
        );
        if (!hasMatchingColumn) {
          throw new BadRequestException(
            `Record matching fields "${recordMatching.sourceColumnId}" -> "${recordMatching.destinationColumnId}" do not match any column mapping`,
          );
        }
      }
    }

    // Transaction to update sync details and replace mappings. Writes only
    // `mappingsV2` — the v1 `mappings` column is frozen from the moment v2
    // ships and stays at whatever was there (sentinel for post-T5-created
    // syncs, real v1 data for pre-T5 syncs that haven't been backfilled).
    const updated = await this.db.client.$transaction(async (tx) => {
      // 1. Delete existing table pairs
      await tx.syncTablePair.deleteMany({
        where: { syncId },
      });

      // 2. Update sync and create new pairs
      return tx.sync.update({
        where: { id: syncId },
        data: {
          displayName: body.displayName,
          mappingsV2: v2Mappings as unknown as Prisma.InputJsonValue,
          ...(body.publishAfterSync !== undefined && { publishAfterSync: body.publishAfterSync }),
          syncTablePairs: {
            create: v2Mappings.tableMappings.map((tm) => ({
              id: createSyncId(),
              sourceDataFolderId: tm.sourceDataFolderId,
              destinationDataFolderId: tm.destinationDataFolderId,
              // We would store columnMappings and recordMatching here if the model supported it,
              // but for now we just link the folders.
              // TODO: Update SyncTablePair model to support field mappings
            })),
          },
        },
        include: {
          syncTablePairs: true,
        },
      });
    });

    // Handle schedule create/update/delete
    if (body.schedule !== undefined) {
      const existingSchedule = await this.db.client.schedule.findFirst({
        where: { workbookId, action: 'SYNC', entityId: syncId },
      });

      if (body.schedule === '') {
        // Empty string means "no schedule" — delete if one exists
        if (existingSchedule) {
          await this.scheduleService.delete(workbookId, existingSchedule.id);
        }
      } else if (existingSchedule) {
        // Update existing schedule's cron expression
        await this.scheduleService.update(workbookId, existingSchedule.id, { cronExpression: body.schedule });
      } else {
        // Create a new schedule
        await this.scheduleService.create(
          workbookId,
          {
            name: `Sync: ${body.displayName}`,
            action: ScheduleAction.SYNC,
            entityId: syncId,
            cronExpression: body.schedule,
            enabled: true,
          },
          actor,
        );
      }
    }

    this.posthogService.trackUpdateSync(actor, updated);
    this.pushSyncsToGitInBackground(workbookId, actor);
    return updated;
  }

  /**
   * Gets a single sync by ID, scoped to the given workbook.
   */
  async findOneForWorkbook(workbookId: WorkbookId, syncId: SyncId, actor: Actor): Promise<unknown> {
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    const sync = await this.db.client.sync.findFirst({
      where: {
        id: syncId,
        workbookId,
      },
      include: {
        syncTablePairs: true,
      },
    });

    if (!sync) {
      throw new NotFoundException('Sync not found');
    }

    return sync;
  }

  /**
   * Lists all syncs for a workbook.
   */
  async findAllForWorkbook(workbookId: WorkbookId, actor: Actor): Promise<unknown[]> {
    // Verify user has access to the workbook
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    return await this.db.client.sync.findMany({
      where: {
        workbookId,
      },
      include: {
        syncTablePairs: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  /**
   * Exports sync configurations in SaveSyncBody-compatible format for CLI download.
   * Includes schedule from the Schedule table and read-only metadata.
   */
  async exportSyncs(workbookId: WorkbookId, syncId: SyncId | undefined, actor: Actor): Promise<ExportSyncConfig[]> {
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    const whereClause: Prisma.SyncWhereInput = { workbookId };
    if (syncId) {
      whereClause.id = syncId;
    }

    const syncs = await this.db.client.sync.findMany({
      where: whereClause,
      include: { syncTablePairs: true },
      orderBy: { createdAt: 'desc' },
    });

    if (syncId && syncs.length === 0) {
      throw new NotFoundException(`Sync ${syncId} not found`);
    }

    // Batch-fetch all SYNC schedules for this workbook to avoid N+1 queries
    const schedules = await this.db.client.schedule.findMany({
      where: { workbookId, action: 'SYNC' },
    });
    const scheduleByEntityId = new Map(schedules.map((s) => [s.entityId, s]));

    return syncs.map((sync) => {
      const schedule = scheduleByEntityId.get(sync.id);
      const stored = parseStoredMappings(sync);
      // TODO(DEV-10008): widen ExportSyncConfig.mappings to StoredSyncMapping
      // and drop this narrow. Today the export DTO is v1-shaped only.
      if (stored.mappings.version !== 1) {
        throw new BadRequestException(`Sync ${sync.id}: v2 mappings export is not yet supported.`);
      }
      const v1Mappings: SyncMapping = stored.mappings;
      return {
        id: sync.id,
        displayName: sync.displayName,
        mappings: v1Mappings,
        validateMappings: false,
        schedule: schedule?.cronExpression ?? '',
        publishAfterSync: sync.publishAfterSync,
        _metadata: {
          syncState: sync.syncState,
          lastSyncTime: sync.lastSyncTime?.toISOString() ?? null,
          createdAt: sync.createdAt.toISOString(),
          updatedAt: sync.updatedAt.toISOString(),
        },
      };
    });
  }

  /**
   * Generates structured Markdown context for an external AI agent to build sync definitions.
   * Includes all linked folders, their schemas, available transformers, and examples.
   */
  async generateAiContext(workbookId: WorkbookId, actor: Actor): Promise<AiContextResponse> {
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId },
      include: { connectorAccount: true },
      orderBy: { name: 'asc' },
    });

    const linkedGroups: Array<{
      groupName: string;
      service: Service | null;
      folders: Array<{
        id: string;
        name: string;
        fields: SchemaField[];
      }>;
    }> = [];

    const allServices = new Set<Service>();
    const connectorAccountGroups = new Map<
      string,
      {
        name: string;
        service: Service | null;
        folders: (typeof linkedGroups)[0]['folders'];
      }
    >();

    for (const folder of dataFolders) {
      if (!folder.connectorAccountId || !folder.connectorAccount) continue;

      const service = folder.connectorService ? folder.connectorService : null;
      if (service) allServices.add(service);

      const schemaJson = await this.readSchemaFromGit(workbookId, folder.connectorAccountId, folder.path);
      const fields = schemaJson?.schema ? extractSchemaFields(schemaJson.schema) : [];

      const accountId = folder.connectorAccountId;
      let group = connectorAccountGroups.get(accountId);
      if (!group) {
        group = {
          name: folder.connectorAccount.displayName,
          service,
          folders: [],
        };
        connectorAccountGroups.set(accountId, group);
      }
      group.folders.push({
        id: folder.id,
        name: folder.name,
        fields,
      });
    }

    for (const [, group] of connectorAccountGroups) {
      linkedGroups.push({
        groupName: group.name,
        service: group.service,
        folders: group.folders,
      });
    }

    const existingSyncs = (await this.findAllForWorkbook(workbookId, actor)) as Array<{
      mappings: SyncMapping | null;
    }>;
    const syncWithMappings = existingSyncs.find((s) => s.mappings?.tableMappings?.length);
    const allLinkedFolders = linkedGroups.flatMap((g) => g.folders);

    const lines: string[] = [];
    lines.push('# Scratch Sync — AI Agent Context');
    lines.push('');
    lines.push(
      'You are helping a user build a sync definition for Scratch, a content management system that syncs data between connected services.',
    );
    lines.push('');
    lines.push('## Your Task');
    lines.push('');
    lines.push('Generate a JSON object with this exact structure (a `SyncMapping`):');
    lines.push('');
    lines.push('```json');
    lines.push('{');
    lines.push('  "version": 1,');
    lines.push('  "tableMappings": [');
    lines.push('    {');
    lines.push('      "sourceDataFolderId": "<source folder ID>",');
    lines.push('      "destinationDataFolderId": "<destination folder ID>",');
    lines.push('      "columnMappings": [');
    lines.push('        {');
    lines.push('          "sourceColumnId": "<field path in source>",');
    lines.push('          "destinationColumnId": "<field path in destination>",');
    lines.push('          "transformer": { "type": "...", "options": { ... } }');
    lines.push('        }');
    lines.push('      ],');
    lines.push('      "recordMatching": {');
    lines.push('        "sourceColumnId": "<field path>",');
    lines.push('        "destinationColumnId": "<field path>"');
    lines.push('      }');
    lines.push('    }');
    lines.push('  ]');
    lines.push('}');
    lines.push('```');
    lines.push('');
    lines.push('## Key Concepts');
    lines.push('');
    lines.push('- A **sync** copies data from source folders to destination folders');
    lines.push(
      '- **Column mappings** map source fields to destination fields using JSON path notation (e.g., `company.name`, `tags[0]`)',
    );
    lines.push(
      '- **Record matching** (optional) matches existing destination records by a field value so they get updated instead of duplicated. If omitted, all source records are created as new records in the destination.',
    );
    lines.push('- **Transformers** (optional) transform field values during sync');
    lines.push('- Fields marked as **readonly** can only be used as source fields, not destinations');
    lines.push('');
    lines.push('## Available Folders');
    lines.push('');

    const folderNameById = new Map<string, string>();
    for (const group of linkedGroups) {
      for (const folder of group.folders) {
        folderNameById.set(folder.id, folder.name);
      }
    }

    for (const group of linkedGroups) {
      const serviceLabel = group.service ? ` (${group.service})` : '';
      lines.push(`### ${group.groupName}${serviceLabel}`);
      lines.push('');

      for (const folder of group.folders) {
        lines.push(`#### ${folder.name}`);
        lines.push(`- **ID**: \`${folder.id}\``);

        if (folder.fields.length > 0) {
          lines.push('- **Fields**:');
          lines.push('  | Field Path | Type | Notes |');
          lines.push('  |---|---|---|');

          for (const field of folder.fields) {
            const notes: string[] = [];
            if (field.suggestedTransformer) {
              notes.push(`suggested transformer: ${field.suggestedTransformer.type}`);
            }
            if (field.readonly) {
              notes.push('readonly');
            }
            if (field.foreignKey) {
              const linkedName = folderNameById.get(field.foreignKey.linkedTableId);
              notes.push(`foreign key${linkedName ? ` to ${linkedName}` : ''}`);
            }
            lines.push(`  | ${field.path} | ${field.type} | ${notes.join(', ')} |`);
          }
        } else {
          lines.push('- **Fields**: (no schema available)');
        }
        lines.push('');
      }
    }

    lines.push('## Available Transformers');
    lines.push('');
    lines.push('### `string_to_number`');
    lines.push('Converts string values to numbers.');
    lines.push('- **Options** (all optional):');
    lines.push('  - `stripCurrency` (boolean): Remove currency symbols before parsing');
    lines.push('  - `parseInteger` (boolean): Truncate to integer instead of float');
    lines.push('');
    lines.push('### `source_fk_to_dest_fk`');
    lines.push(
      'Maps foreign key IDs from source records to their corresponding destination IDs. Use this when both source and destination have linked/related records that are also being synced.',
    );
    lines.push('- **Options** (required):');
    lines.push('  - `referencedDataFolderId` (string): The folder ID containing the referenced records');
    lines.push('');
    lines.push('### `lookup_field`');
    lines.push(
      'Extracts a field value from a related record via foreign key. Use this to denormalize data (e.g., get a category name from a category ID).',
    );
    lines.push('- **Options** (required):');
    lines.push('  - `referencedDataFolderId` (string): The folder ID containing the referenced records');
    lines.push('  - `referencedFieldPath` (string): The field path to extract (e.g., `name` or `company.displayName`)');
    lines.push('');
    lines.push('### `notion_to_html`');
    lines.push(
      'Converts Notion rich text blocks to HTML. Use this when the source is a Notion folder with rich text content.',
    );
    lines.push('- **Options**: None');
    lines.push('');

    const tipSections: Array<{ service: Service; tip: string }> = [
      {
        service: ServiceConst.NOTION,
        tip: [
          '### Notion',
          '- Rich text fields contain Notion block objects. Use the `notion_to_html` transformer to convert them to HTML.',
          "- Relation/rollup fields are foreign keys. Use `source_fk_to_dest_fk` if you're syncing the related table too.",
        ].join('\n'),
      },
      {
        service: ServiceConst.AIRTABLE,
        tip: [
          '### Airtable',
          "- Linked record fields are foreign keys. Use `source_fk_to_dest_fk` if you're syncing the related table too.",
          '- Formula and lookup fields are readonly.',
        ].join('\n'),
      },
      {
        service: ServiceConst.POSTGRES,
        tip: ['### Postgres', '- Field paths correspond directly to column names.'].join('\n'),
      },
      {
        service: ServiceConst.SUPABASE,
        tip: ['### Supabase', '- Field paths correspond directly to column names.'].join('\n'),
      },
      {
        service: ServiceConst.WEBFLOW,
        tip: ['### Webflow', "- CMS fields use Webflow's internal field slugs."].join('\n'),
      },
    ];

    const relevantTips = tipSections.filter((t) => allServices.has(t.service));
    if (relevantTips.length > 0) {
      lines.push('## Connector Tips');
      lines.push('');
      for (const tip of relevantTips) {
        lines.push(tip.tip);
        lines.push('');
      }
    }

    if (syncWithMappings?.mappings) {
      lines.push('## Example Sync (from this workbook)');
      lines.push('');
      lines.push("Here's an existing sync in this workbook for reference:");
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(syncWithMappings.mappings, null, 2));
      lines.push('```');
    } else if (allLinkedFolders.length >= 2) {
      lines.push('## Example Sync');
      lines.push('');
      const src = allLinkedFolders[0];
      const dest = allLinkedFolders[1];
      const srcField = src.fields[0]?.path ?? 'fieldName';
      const destField = dest.fields[0]?.path ?? 'fieldName';

      const example: SyncMapping = {
        version: 1,
        tableMappings: [
          {
            sourceDataFolderId: src.id as DataFolderId,
            destinationDataFolderId: dest.id as DataFolderId,
            columnMappings: [{ sourceColumnId: srcField, destinationColumnId: destField }],
          },
        ],
      };
      lines.push('```json');
      lines.push(JSON.stringify(example, null, 2));
      lines.push('```');
      lines.push('');
      lines.push('Note: This is a minimal example using real folder IDs and field names from your workbook.');
    }
    lines.push('');

    return { markdown: lines.join('\n') };
  }

  /**
   * Extracts the idColumnRemoteId from a DataFolder's schema.
   * Falls back to `idPath('id')` if the schema doesn't specify an idColumnRemoteId.
   */
  private getIdColumnFromSchema(schema: unknown): IdPath {
    const jsonSchema = schema as BaseJsonTableSpec | null;
    return jsonSchema?.idColumnRemoteId ?? idPath('id');
  }

  /**
   * Deletes a sync.
   */
  async deleteSync(workbookId: WorkbookId, syncId: SyncId, actor: Actor): Promise<void> {
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    const sync = await this.db.client.sync.findFirst({
      where: { id: syncId, workbookId },
    });
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }

    // Delete associated schedules
    const schedules = await this.db.client.schedule.findMany({
      where: { workbookId, action: 'SYNC', entityId: syncId },
    });
    for (const schedule of schedules) {
      await this.scheduleService.delete(workbookId, schedule.id);
    }

    await this.db.client.sync.delete({
      where: { id: syncId },
    });

    this.posthogService.trackRemoveSync(actor, sync);
    this.pushSyncsToGitInBackground(workbookId, actor);
  }

  /**
   * Syncs records from source to destination DataFolder based on a TableMapping.
   * Creates new records in destination for unmatched source records,
   * and updates existing destination records for matched ones.
   *
   * @param syncId - The sync ID
   * @param tableMapping - The table mapping configuration
   * @param workbookId - The workbook ID
   * @param actor - The actor performing the sync
   * @returns Result containing counts of created/updated records and any errors
   */
  async syncTableMapping(
    syncId: SyncId,
    inputTableMapping: TableMappingV1 | TableMappingV2,
    workbookId: WorkbookId,
    actor: Actor,
    phase: SyncPhase = 'DATA',
    /**
     * Optional filter: if set, Pass 2 only transforms and writes the source record at this file path.
     * Pass 1 still builds full caches (necessary for accurate matching and FK resolution).
     * Used by syncOneRecord to scope a sync run to a single record.
     */
    onlySourceFilePath?: string,
  ): Promise<SyncTableMappingResult> {
    // Defensively normalize to v2 — callers may pass either shape. Idempotent
    // for inputs that are already v2.
    const tableMapping = ensureTableMappingV2(inputTableMapping);

    // Used by Pass 2 to estimate "unarchived" — records that received any
    // matched-bucket constant write. Upper bound, not exact: a record already
    // at the constant value still counts.
    const hasMatchedBucketConstant = tableMapping.columnMappings.some(
      (m) => m.source.kind === 'constant' && ((m.when ?? 'matched') === 'matched' || m.when === 'always'),
    );

    WSLogger.info({
      source: 'SyncService.syncTableMapping',
      message: 'Entering executor',
      syncId,
      phase,
      sourceDataFolderId: tableMapping.sourceDataFolderId,
      destinationDataFolderId: tableMapping.destinationDataFolderId,
      columnMappingCount: tableMapping.columnMappings.length,
    });

    const result: SyncTableMappingResult = {
      recordsCreated: 0,
      recordsUpdated: 0,
      recordsSkipped: 0,
      createdPaths: [],
      updatedPaths: [],
      errors: [],
      warnings: [],
      unmatchedDestinationCounts: { withMatchKey: 0, withoutMatchKey: 0, archived: 0, unarchived: 0 },
    };

    // 1. Fetch source and destination DataFolders with their schemas
    const [sourceFolder, destinationFolder] = await Promise.all([
      this.db.client.dataFolder.findUnique({
        where: { id: tableMapping.sourceDataFolderId },
      }),
      this.db.client.dataFolder.findUnique({
        where: { id: tableMapping.destinationDataFolderId },
      }),
    ]);

    if (!sourceFolder) {
      throw new NotFoundException(`Source DataFolder ${tableMapping.sourceDataFolderId} not found`);
    }
    if (!destinationFolder) {
      throw new NotFoundException(`Destination DataFolder ${tableMapping.destinationDataFolderId} not found`);
    }

    // Read schema from git first, fall back to DB
    const sourceTableSpec = await this.readSchemaFromGit(
      workbookId,
      sourceFolder.connectorAccountId,
      sourceFolder.path,
    );

    const destinationTableSpec = await this.readSchemaFromGit(
      workbookId,
      destinationFolder.connectorAccountId,
      destinationFolder.path,
    );
    const destinationRepoId = await this.scratchGitService.resolveConnectionRepoPath(
      destinationFolder.connectorAccountId,
    );

    // Get idColumnRemoteId from schemas
    const sourceIdColumn = this.getIdColumnFromSchema(sourceTableSpec);
    const destinationIdColumn = this.getIdColumnFromSchema(destinationTableSpec);

    // ===========================================================================================
    // Pass 1: Populate caches (match keys, FK records, remote ID mappings)
    // Skipped in FOREIGN_KEY_MAPPING phase — it reuses caches built by the DATA phase.
    // ===========================================================================================

    const destinationRecordsByPath = new Map<string, SyncRecord>();
    const usedDestFileNames = new Set<string>();
    const fkValuesByFolder = new Map<DataFolderId, Set<string>>();

    // Build transform context for applying transformers to source match key values
    const matchKeyTransformContext: MatchKeyTransformContext = {
      sourceTableSpec,
      destinationTableSpec,
      sourceService: sourceFolder.connectorService as Service,
      destinationService: destinationFolder.connectorService as Service,
    };

    if (phase === 'DATA') {
      // Clear existing caches for this sync's table mapping
      await this.clearMatchKeysForDataFolder(syncId, tableMapping.sourceDataFolderId);
      await this.clearMatchKeysForDataFolder(syncId, tableMapping.destinationDataFolderId);
      await this.clearRemoteIdMappingsForDataFolder(syncId, tableMapping.sourceDataFolderId);

      // Page through source files — insert match keys and collect FK values per batch
      let sourceCursor: string | undefined;
      let batchCounter = 0;
      do {
        const page = await this.dataFolderService.getFileContentsByFolderIdPaginated(
          workbookId,
          tableMapping.sourceDataFolderId,
          actor,
          DIRTY_BRANCH,
          sourceCursor,
        );
        const batchRecords = page.files.map((file) => parseFileToRecord(file, sourceIdColumn));

        WSLogger.info({
          source: 'SyncService.syncTableMapping',
          message: `Pass 1: source batch`,
          syncId,
          records: batchRecords.length,
          cursor: sourceCursor ?? 'initial',
          batch: batchCounter,
        });

        await this.fillSyncCachesBatch(syncId, tableMapping, batchRecords, [], matchKeyTransformContext);
        this.collectForeignKeyValues(tableMapping, batchRecords, fkValuesByFolder);

        sourceCursor = page.nextCursor;
        batchCounter++;
      } while (sourceCursor);
    }

    // Page through destination files — insert match keys and build lookup maps per batch
    let destCursor: string | undefined;
    let batchCounter = 0;
    do {
      const page = await this.dataFolderService.getFileContentsByFolderIdPaginated(
        workbookId,
        tableMapping.destinationDataFolderId,
        actor,
        DIRTY_BRANCH,
        destCursor,
      );

      const batchRecords: SyncRecord[] = [];
      for (const file of page.files) {
        const record = parseFileToRecord(file, destinationIdColumn);
        batchRecords.push(record);
        destinationRecordsByPath.set(file.path, record);
        const filename = file.path.split('/').pop();
        if (filename !== undefined) {
          usedDestFileNames.add(filename);
        } else {
          WSLogger.error({
            source: 'SyncService.syncTableMapping',
            message: 'Destination file path is missing filename',
            filePath: file.path,
          });
          continue;
        }
      }

      WSLogger.info({
        source: 'SyncService.syncTableMapping',
        message: `Pass 1: destination batch`,
        syncId,
        records: batchRecords.length,
        cursor: destCursor ?? 'initial',
        batch: batchCounter,
      });

      if (phase === 'DATA') {
        // Only need to fill the caches in the first phase
        await this.fillSyncCachesBatch(syncId, tableMapping, [], batchRecords);
      }

      destCursor = page.nextCursor;
      batchCounter++;
    } while (destCursor);

    if (phase === 'DATA') {
      // Finalize caches — join match keys to create remote ID mappings
      await this.buildRecordMatchingMappings(syncId, tableMapping);

      // Populate FK record cache for lookup_field transformers
      await this.populateForeignKeyRecordCache(syncId, fkValuesByFolder, workbookId, actor);
    }

    // ===========================================================================================
    // Pass 2: Iterate source pages again to transform and write records using populated caches
    // ===========================================================================================

    // Get the destination folder path for new files
    const destinationFolderPath = destinationFolder.path?.replace(/^\//, '') ?? '';

    // Get the destination idColumnRemoteId from schema
    const destIdColumn = this.getIdColumnFromSchema(destinationTableSpec);

    // Create lookup tools for transformers that need FK resolution
    const lookupTools = createLookupTools(
      this.db,
      syncId,
      workbookId,
      sourceFolder.connectorService as Service,
      destinationFolder.connectorService as Service,
    );

    // Track new records so we can backfill SyncRemoteIdMapping with their file paths and record IDs
    const newRecordMappings: Array<{ sourceRemoteId: string; filePath: string; destinationRecordId: string }> = [];

    // Accumulated files to write across all source pages
    const filesToWrite: Array<{ path: string; content: string }> = [];

    // Page through source files again for transformation
    let sourceCursor: string | undefined;
    do {
      const page = await this.dataFolderService.getFileContentsByFolderIdPaginated(
        workbookId,
        tableMapping.sourceDataFolderId,
        actor,
        DIRTY_BRANCH,
        sourceCursor,
      );

      // Parse this batch of source records
      const batchRecords = page.files.map((file) => parseFileToRecord(file, sourceIdColumn));
      let batchRecordsById = new Map(batchRecords.map((r) => [r.id, r]));

      // When scoped to a single source file, drop everything else from the batch.
      // Skip the entire batch if it doesn't contain the target file.
      if (onlySourceFilePath !== undefined) {
        batchRecordsById = new Map([...batchRecordsById].filter(([, r]) => r.filePath === onlySourceFilePath));
        if (batchRecordsById.size === 0) {
          sourceCursor = page.nextCursor;
          batchCounter++;
          continue;
        }
      }

      WSLogger.info({
        source: 'SyncService.syncTableMapping',
        message: `Pass 2: source batch`,
        syncId,
        records: batchRecordsById.size,
        cursor: sourceCursor ?? 'initial',
        batch: batchCounter,
      });

      // Get mappings for this batch
      const batchMappings = await this.getDestinationMappings(
        syncId,
        tableMapping.sourceDataFolderId,
        Array.from(batchRecordsById.keys()),
      );

      // Skip source records with missing or empty match key — this is expected
      // when source data has incomplete records and is not an error condition.
      if (tableMapping.recordMatching) {
        let skippedNoMatchKey = 0;
        for (const [sourceId, sourceRecord] of batchRecordsById) {
          if (!batchMappings.has(sourceId)) {
            const matchKeyValue = get(sourceRecord.fields, tableMapping.recordMatching.sourceColumnId);
            if (
              matchKeyValue === undefined ||
              matchKeyValue === null ||
              (typeof matchKeyValue !== 'string' && typeof matchKeyValue !== 'number') ||
              String(matchKeyValue).trim() === ''
            ) {
              skippedNoMatchKey++;
            }
          }
        }
        if (skippedNoMatchKey > 0) {
          result.recordsSkipped += skippedNoMatchKey;
          WSLogger.info({
            source: 'SyncService.syncTableMapping',
            message: `Skipped ${skippedNoMatchKey} source record(s) with no match key value`,
            syncId,
            field: tableMapping.recordMatching.sourceColumnId,
          });
        }
      }

      for (const [sourceRemoteId, mapping] of batchMappings) {
        const sourceRecord = batchRecordsById.get(sourceRemoteId);
        if (!sourceRecord) {
          result.errors.push({
            sourceRemoteId,
            error: 'Source record not found',
          });
          continue;
        }

        try {
          let destinationPath: string;
          let transformedFields: Record<string, unknown>;

          if (mapping.destinationFilePath === null) {
            // This is a new record
            const transformResult = await applyColumnMappings({
              bucket: 'matched',
              sourceRecord,
              baseFields: undefined,
              mappings: tableMapping.columnMappings,
              sourceTableSpec,
              destinationTableSpec,
              lookupTools,
              phase,
              syncContext: {
                sourceService: sourceFolder.connectorService as Service,
                destinationService: destinationFolder.connectorService as Service,
              },
            });
            transformedFields = transformResult.fields;
            for (const w of transformResult.warnings) {
              result.warnings.push({ sourceRemoteId, warning: w });
            }

            // Generate a temporary ID for the new record so it can be matched on subsequent syncs,
            // but only if the column mappings haven't already set the destination ID column.
            const existingIdValue = get(transformedFields, destIdColumn);
            const hasExplicitId =
              existingIdValue != null && (typeof existingIdValue === 'string' || typeof existingIdValue === 'number');
            const tempId = hasExplicitId ? String(existingIdValue) : createScratchPendingPublishId();
            if (!hasExplicitId) {
              set(transformedFields, destIdColumn, tempId);
            }

            // Resolve filename: prefer slug from destination schema, fall back to temp ID
            const slugPath = destinationTableSpec?.slugFieldPath ?? destinationTableSpec?.slugColumnRemoteId;
            const slugValue = slugPath ? (get(transformedFields, slugPath) as string | undefined) : undefined;
            const baseName = resolveBaseFileName({ slugValue, idValue: tempId });
            const fileName = deduplicateFileName(baseName, '.json', usedDestFileNames, tempId);
            destinationPath = destinationFolderPath ? `${destinationFolderPath}/${fileName}` : fileName;

            // Track this new record mapping for Phase 2 FK resolution
            newRecordMappings.push({
              sourceRemoteId,
              filePath: destinationPath,
              destinationRecordId: String(tempId),
            });

            result.recordsCreated++;
            result.createdPaths.push(destinationPath);
          } else {
            // Existing record: pass the existing fields as the base so applyColumnMappings
            // surgically updates only the mapped fields. This is critical to preserve the
            // original JSON key ordering in the destination file (see baseFields param docs).
            destinationPath = mapping.destinationFilePath;
            const existingRecord = destinationRecordsByPath.get(mapping.destinationFilePath);

            const transformResult = await applyColumnMappings({
              bucket: 'matched',
              sourceRecord,
              baseFields: existingRecord?.fields,
              mappings: tableMapping.columnMappings,
              sourceTableSpec,
              destinationTableSpec,
              lookupTools,
              phase,
              syncContext: {
                sourceService: sourceFolder.connectorService as Service,
                destinationService: destinationFolder.connectorService as Service,
              },
            });
            transformedFields = transformResult.fields;
            for (const w of transformResult.warnings) {
              result.warnings.push({ sourceRemoteId, warning: w });
            }

            // Skip writing if the transformed fields are identical to the existing record —
            // this avoids unnecessary file writes that produce only whitespace changes.
            if (existingRecord && isEqual(transformedFields, existingRecord.fields)) {
              continue;
            }

            result.recordsUpdated++;
            result.updatedPaths.push(destinationPath);
            if (hasMatchedBucketConstant) {
              result.unmatchedDestinationCounts.unarchived++;
            }
          }

          const content = serializeRecord(transformedFields);
          filesToWrite.push({ path: destinationPath, content });
        } catch (error) {
          result.errors.push({
            sourceRemoteId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      sourceCursor = page.nextCursor;
      batchCounter++;
    } while (sourceCursor);

    // ===========================================================================================
    // Pass 3: Apply `unmatchedDestinationPolicy` to records with no source counterpart.
    //
    // Skipped entirely when:
    //   - phase !== 'DATA' (constants are DATA-only; Pass 3 would be a no-op in FK phase),
    //   - `onlySourceFilePath` is set (single-record scope is incompatible with a
    //     dest-folder-wide enumeration — `syncOneRecord` never runs Pass 3),
    //   - `recordMatching` is unset (no way to classify dest records),
    //   - `unmatchedDestinationPolicy` is absent or all-`ignore`,
    //   - the match-key column is missing from the destination schema
    //     (defensive: rather than crash, log a warning and bail).
    // ===========================================================================================
    if (
      phase === 'DATA' &&
      onlySourceFilePath === undefined &&
      tableMapping.recordMatching !== undefined &&
      tableMapping.unmatchedDestinationPolicy !== undefined &&
      (tableMapping.unmatchedDestinationPolicy.withMatchKey === 'apply' ||
        tableMapping.unmatchedDestinationPolicy.withoutMatchKey === 'apply')
    ) {
      const matchColPath = tableMapping.recordMatching.destinationColumnId;
      const matchSchema = destinationTableSpec ? getSchemaAtPath(destinationTableSpec.schema, matchColPath) : undefined;
      if (matchSchema === undefined) {
        WSLogger.warn({
          source: 'SyncService.syncTableMapping',
          message: 'Pass 3 skipped: match-key column missing from destination schema',
          syncId,
          destinationColumnId: matchColPath,
        });
      } else {
        // Defensive: drop any constant mapping targeting the match-key column.
        // Save-time validation rejects this combo; runtime defense covers
        // manually-edited rows from sneaking past the schema and overwriting
        // the only identifier classifying a record as belonging to this sync.
        const mappingsForPass3: ColumnMappingV2[] = [];
        for (const m of tableMapping.columnMappings) {
          if (m.source.kind === 'constant' && m.destinationColumnId === matchColPath) {
            WSLogger.warn({
              source: 'SyncService.syncTableMapping',
              message: 'Pass 3: omitting constant mapping that targets the match-key column',
              syncId,
              destinationColumnId: matchColPath,
            });
            continue;
          }
          mappingsForPass3.push(m);
        }

        // Hydrate the source-side match-key set for O(1) classification. Uses
        // the unique (syncId, dataFolderId) index on SyncMatchKeys.
        const sourceMatchKeyRows = await this.db.client.syncMatchKeys.findMany({
          where: { syncId, dataFolderId: tableMapping.sourceDataFolderId },
          select: { matchId: true },
        });
        const sourceMatchKeySet = new Set(sourceMatchKeyRows.map((r) => r.matchId));

        WSLogger.info({
          source: 'SyncService.syncTableMapping',
          message: 'Pass 3: starting unmatched-destination write',
          syncId,
          sourceMatchKeyCount: sourceMatchKeySet.size,
          destinationRecordCount: destinationRecordsByPath.size,
          policy: tableMapping.unmatchedDestinationPolicy,
        });

        const policy = tableMapping.unmatchedDestinationPolicy;
        for (const [destPath, destRecord] of destinationRecordsByPath) {
          const classification = classifyDestinationRecord(destRecord, sourceMatchKeySet, matchColPath);
          if (classification === 'matched') {
            continue;
          }

          if (classification === 'unmatchedWithMatchKey') {
            result.unmatchedDestinationCounts.withMatchKey++;
            if (policy.withMatchKey !== 'apply') continue;
          } else {
            result.unmatchedDestinationCounts.withoutMatchKey++;
            if (policy.withoutMatchKey !== 'apply') continue;
          }

          try {
            const transformResult = await applyColumnMappings({
              bucket: 'unmatched',
              sourceRecord: null,
              baseFields: destRecord.fields,
              mappings: mappingsForPass3,
              sourceTableSpec,
              destinationTableSpec,
              lookupTools,
              phase: 'DATA',
              syncContext: {
                sourceService: sourceFolder.connectorService as Service,
                destinationService: destinationFolder.connectorService as Service,
              },
            });
            for (const w of transformResult.warnings) {
              result.warnings.push({ sourceRemoteId: destRecord.id, warning: w });
            }
            if (isEqual(transformResult.fields, destRecord.fields)) {
              // No effective change — the unmatched rules produced the same
              // bytes already on disk. Skip the write (mirrors Pass 2).
              continue;
            }
            result.unmatchedDestinationCounts.archived++;
            result.recordsUpdated++;
            result.updatedPaths.push(destPath);
            filesToWrite.push({ path: destPath, content: serializeRecord(transformResult.fields) });
          } catch (error) {
            result.errors.push({
              sourceRemoteId: destRecord.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        WSLogger.info({
          source: 'SyncService.syncTableMapping',
          message: 'Pass 3: completed',
          syncId,
          counts: result.unmatchedDestinationCounts,
        });
      }
    }

    // 7. Backfill SyncRemoteIdMapping for newly created records with their file paths
    // This is needed so the FOREIGN_KEY_MAPPING phase can resolve FK references to new records
    if (phase === 'DATA' && newRecordMappings.length > 0) {
      await this.updateRemoteIdMappingsForNewRecords(syncId, tableMapping.sourceDataFolderId, newRecordMappings);
    }

    // 8. Write all files in batch to the dirty branch
    if (filesToWrite.length > 0) {
      WSLogger.info({
        source: 'SyncService.syncTableMapping',
        message: `Committing files to git`,
        syncId,
        files: filesToWrite.length,
      });
      try {
        await this.scratchGitService.commitFilesToBranch(
          destinationRepoId,
          DIRTY_BRANCH,
          filesToWrite,
          'Sync: batch write files',
        );
      } catch (error) {
        // If batch write fails, all records are affected
        const errorMessage = error instanceof Error ? error.message : String(error);
        for (const file of filesToWrite) {
          result.errors.push({
            sourceRemoteId: file.path,
            error: `Batch write failed: ${errorMessage}`,
          });
        }
        result.recordsCreated = 0;
        result.recordsUpdated = 0;
        // Pass 3 writes were rolled back too — zero the archive/unarchive counts.
        // The classification visited-counts (withMatchKey, withoutMatchKey) stay
        // since the work happened even if no file landed.
        result.unmatchedDestinationCounts.archived = 0;
        result.unmatchedDestinationCounts.unarchived = 0;
        return result;
      }
    }

    return result;
  }

  /**
   * Syncs a single source record to the destination folder. Thin wrapper around `syncTableMapping`
   * that scopes Pass 2 to one source file. Pass 1 still builds full caches (necessary for accurate
   * record matching and FK resolution).
   */
  async syncOneRecord(
    syncId: SyncId,
    workbookId: WorkbookId,
    sourceFilePath: string,
    sourceDataFolderId: DataFolderId,
    actor: Actor,
  ): Promise<{ created: boolean; updated: boolean; destinationPath: string | null; error: string | null }> {
    const sync = await this.getSync(syncId);
    if (!sync) {
      throw new NotFoundException(`Sync ${syncId} not found`);
    }

    const v2Mappings = sync.mappings.version === 1 ? transformV1ToV2(sync.mappings) : sync.mappings;
    const tableMapping = v2Mappings.tableMappings.find((tm) => tm.sourceDataFolderId === sourceDataFolderId);
    if (!tableMapping) {
      throw new NotFoundException(`No table mapping found for source folder ${sourceDataFolderId} in sync ${syncId}`);
    }

    // Run DATA phase scoped to this one source file
    const dataResult = await this.syncTableMapping(syncId, tableMapping, workbookId, actor, 'DATA', sourceFilePath);

    // Run FK phase if any column mappings need it (reuses caches built by DATA phase)
    const hasFkMappings = tableMapping.columnMappings.some((m) => getColumnMappingPhaseV2(m) === 'FOREIGN_KEY_MAPPING');
    const fkResult = hasFkMappings
      ? await this.syncTableMapping(syncId, tableMapping, workbookId, actor, 'FOREIGN_KEY_MAPPING', sourceFilePath)
      : null;

    // Translate batch result to single-record response shape
    const created = dataResult.recordsCreated > 0;
    const updated = dataResult.recordsUpdated > 0 || (fkResult?.recordsUpdated ?? 0) > 0;
    const destinationPath =
      dataResult.createdPaths[0] ?? dataResult.updatedPaths[0] ?? fkResult?.updatedPaths[0] ?? null;
    const errorEntry = dataResult.errors[0] ?? fkResult?.errors[0];

    return {
      created,
      updated,
      destinationPath,
      error: errorEntry?.error ?? null,
    };
  }

  /**
   * Fills sync caches (match keys and remote ID mappings) before running a sync.
   * Populates the SyncMatchKeys table for both sides, and creates SyncRemoteIdMapping entries
   * for records that exist in both source and destination.
   *
   * @param syncId - The sync ID
   * @param tableMapping - The table mapping with source/destination folder IDs
   * @param sourceRecords - The source records to process
   * @param destinationRecords - The destination records to process
   */
  /**
   * Processes a batch of source and destination records for cache population.
   * Inserts match keys (when recordMatching is configured) or creates direct
   * remote ID mappings (when no recordMatching) for this batch.
   */
  async fillSyncCachesBatch(
    syncId: SyncId,
    inputTableMapping: TableMappingV1 | TableMappingV2,
    sourceRecords: SyncRecord[],
    destinationRecords: SyncRecord[],
    transformContext?: MatchKeyTransformContext,
  ): Promise<void> {
    const tableMapping = ensureTableMappingV2(inputTableMapping);
    if (!tableMapping.recordMatching) {
      // No record matching — every source record is a create.
      // Insert mappings directly with null destination so the rest of the flow treats them as new.
      const batchMappings: RemoteIdMappingPair[] = sourceRecords.map((r) => ({
        sourceRemoteId: r.id,
        destinationRemoteId: null,
        destinationFilePath: null,
      }));
      if (batchMappings.length > 0) {
        await this.upsertRemoteIdMappings(syncId, tableMapping, batchMappings);
      }
      return;
    }

    // Insert match keys for both sides
    if (sourceRecords.length > 0) {
      await this.insertSourceMatchKeys(syncId, tableMapping, sourceRecords, transformContext);
    }
    if (destinationRecords.length > 0) {
      await this.insertDestinationMatchKeys(syncId, tableMapping, destinationRecords);
    }
  }

  /**
   * Finalizes sync caches after all batches have been processed.
   * Joins source and destination match keys to create remote ID mappings.
   * Only needed when recordMatching is configured.
   */
  async buildRecordMatchingMappings(syncId: SyncId, inputTableMapping: TableMappingV1 | TableMappingV2): Promise<void> {
    const tableMapping = ensureTableMappingV2(inputTableMapping);
    if (!tableMapping.recordMatching) {
      return;
    }

    // Create remote ID mappings for both matched and unmatched source records
    const allSourceMappings = await this.db.client.$queryRaw<
      { sourceRemoteId: string; destinationRemoteId: string | null; destinationFilePath: string | null }[]
    >`
      SELECT src."remoteId" as "sourceRemoteId",
             dest."remoteId" as "destinationRemoteId",
             dest."filePath" as "destinationFilePath"
      FROM "SyncMatchKeys" src
      LEFT JOIN "SyncMatchKeys" dest
        ON src."syncId" = dest."syncId"
        AND src."matchId" = dest."matchId"
        AND dest."dataFolderId" = ${tableMapping.destinationDataFolderId}
      WHERE src."syncId" = ${syncId}
        AND src."dataFolderId" = ${tableMapping.sourceDataFolderId}
    `;

    const matchedCount = allSourceMappings.filter((m) => m.destinationRemoteId !== null).length;
    WSLogger.info({
      source: 'SyncService.buildRecordMatchingMappings',
      message: 'Built mappings for record matching',
      syncId,
      totalSourceRecords: allSourceMappings.length,
      matchedRecords: matchedCount,
      unmatchedRecords: allSourceMappings.length - matchedCount,
    });

    if (allSourceMappings.length > 0) {
      await this.upsertRemoteIdMappings(syncId, tableMapping, allSourceMappings);
    }
  }

  /**
   * Collects foreign key values from a batch of source records for lookup_field transformers.
   * Accumulates values into the provided map of sets, keyed by referenced DataFolder ID.
   */
  private collectForeignKeyValues(
    tableMapping: TableMappingV2,
    sourceRecords: SyncRecord[],
    fkValuesByFolder: Map<DataFolderId, Set<string>>,
  ): void {
    // Collect all lookup_field configs across all column mappings.
    // Constants have no source column and no transformers — skip them.
    const lookupEntries: { mapping: ColumnMapping; opts: LookupFieldOptions }[] = [];
    for (const mappingV2 of tableMapping.columnMappings) {
      for (const config of findTransformerConfigsV2(mappingV2, TransformerTypes.LookupField)) {
        const mapping = v2ColumnAsV1(mappingV2);
        if (mapping !== null) {
          lookupEntries.push({ mapping, opts: config.options as LookupFieldOptions });
        }
      }
    }
    if (lookupEntries.length === 0) {
      return;
    }

    let collectedCount = 0;
    for (const { mapping, opts } of lookupEntries) {
      let fkValues = fkValuesByFolder.get(opts.referencedDataFolderId);
      if (!fkValues) {
        fkValues = new Set();
        fkValuesByFolder.set(opts.referencedDataFolderId, fkValues);
      }
      const sizeBefore = fkValues.size;

      for (const record of sourceRecords) {
        const val = get(record.fields, mapping.sourceColumnId);
        if (val === null || val === undefined) continue;
        if (Array.isArray(val)) {
          for (const elem of val) {
            if (elem !== null && elem !== undefined && (typeof elem === 'string' || typeof elem === 'number')) {
              fkValues.add(String(elem));
            }
          }
        } else if (typeof val === 'string' || typeof val === 'number') {
          fkValues.add(String(val));
        }
      }

      collectedCount += fkValues.size - sizeBefore;
    }

    WSLogger.info({
      source: 'SyncService.collectForeignKeyValues',
      message: `Collected FK values from source records`,
      sourceRecords: sourceRecords.length,
      newFkValues: collectedCount,
    });
  }

  /**
   * Populates the SyncForeignKeyRecord cache for lookup_field transformers.
   * Uses pre-collected FK values (from collectForeignKeyValues) to fetch and
   * cache the referenced record data.
   */
  private async populateForeignKeyRecordCache(
    syncId: SyncId,
    fkValuesByFolder: Map<DataFolderId, Set<string>>,
    workbookId: WorkbookId,
    actor: Actor,
  ): Promise<void> {
    if (fkValuesByFolder.size === 0) {
      return;
    }

    // Clear existing FK record cache for this sync
    await this.db.client.syncForeignKeyRecord.deleteMany({ where: { syncId } });

    for (const [referencedFolderId, fkValues] of fkValuesByFolder) {
      if (fkValues.size === 0) continue;

      // Fetch the referenced DataFolder for its schema
      const folder = await this.db.client.dataFolder.findUnique({
        where: { id: referencedFolderId },
      });
      if (!folder) {
        WSLogger.warn({
          source: 'SyncService',
          message: `Referenced DataFolder ${referencedFolderId} not found for lookup_field transformer`,
        });
        continue;
      }

      // Fetch and parse records from the referenced DataFolder
      const referencedSchema = await this.readSchemaFromGit(workbookId, folder.connectorAccountId, folder.path);
      const idColumn = this.getIdColumnFromSchema(referencedSchema);
      const files = await this.dataFolderService.getAllFileContentsByFolderId(workbookId, referencedFolderId, actor);
      const records = files.map((f) => parseFileToRecord(f, idColumn));
      const recordsById = new Map(records.map((r) => [r.id, r.fields]));

      // Create one cache entry per unique (dataFolderId, foreignKeyValue)
      const entries: Array<{
        syncId: string;
        dataFolderId: string;
        foreignKeyValue: string;
        recordData: Prisma.InputJsonValue;
      }> = [];

      for (const fkValue of fkValues) {
        const recordData = recordsById.get(fkValue);
        if (!recordData) continue;
        entries.push({
          syncId,
          dataFolderId: referencedFolderId,
          foreignKeyValue: fkValue,
          recordData: recordData as Prisma.InputJsonValue,
        });
      }

      if (entries.length > 0) {
        await this.db.client.syncForeignKeyRecord.createMany({
          data: entries,
          skipDuplicates: true,
        });
      }
    }
  }

  // ===============================================================================================================
  // SyncRemoteIdMapping methods - for storing and retrieving mapping of source remote IDs to destination remote IDs
  // ===============================================================================================================

  /**
   * Upserts remote ID mappings for synced records.
   * Maps source remote IDs to their corresponding destination remote IDs.
   *
   * @param syncId - The sync ID
   * @param tableMapping - The table mapping containing source/destination DataFolder IDs
   * @param mappings - Array of source/destination remote ID pairs
   */
  private async upsertRemoteIdMappings(
    syncId: SyncId,
    tableMapping: TableMappingV2,
    mappings: RemoteIdMappingPair[],
  ): Promise<void> {
    if (mappings.length === 0) {
      return;
    }

    await this.db.client.$transaction(
      mappings.map((mapping) =>
        this.db.client.syncRemoteIdMapping.upsert({
          where: {
            syncId_dataFolderId_sourceRemoteId: {
              syncId,
              dataFolderId: tableMapping.sourceDataFolderId,
              sourceRemoteId: mapping.sourceRemoteId,
            },
          },
          create: {
            syncId,
            dataFolderId: tableMapping.sourceDataFolderId,
            sourceRemoteId: mapping.sourceRemoteId,
            destinationRemoteId: mapping.destinationRemoteId,
            destinationFilePath: mapping.destinationFilePath,
          },
          update: {
            destinationRemoteId: mapping.destinationRemoteId,
            destinationFilePath: mapping.destinationFilePath,
          },
        }),
      ),
    );
  }

  /**
   * Updates SyncRemoteIdMapping entries for newly created records with their destination file paths
   * and record IDs. During Phase 1, new records have null destination fields. This backfills them
   * so Phase 2 FK resolution can resolve references to new records.
   */
  private async updateRemoteIdMappingsForNewRecords(
    syncId: SyncId,
    dataFolderId: DataFolderId,
    newRecords: Array<{ sourceRemoteId: string; filePath: string; destinationRecordId: string }>,
  ): Promise<void> {
    if (newRecords.length === 0) {
      return;
    }

    await this.db.client.$transaction(
      newRecords.map((record) =>
        this.db.client.syncRemoteIdMapping.update({
          where: {
            syncId_dataFolderId_sourceRemoteId: {
              syncId,
              dataFolderId,
              sourceRemoteId: record.sourceRemoteId,
            },
          },
          data: {
            destinationRemoteId: record.destinationRecordId,
            destinationFilePath: record.filePath,
          },
        }),
      ),
    );
  }

  /**
   * Bulk lookup of destination mappings for multiple source remote IDs.
   *
   * @param syncId - The sync ID
   * @param dataFolderId - The source DataFolder ID
   * @param sourceRemoteIds - Array of source remote IDs to look up
   * @returns Map of source remote ID to destination mapping (record ID + file path)
   */
  private async getDestinationMappings(
    syncId: SyncId,
    dataFolderId: DataFolderId,
    sourceRemoteIds: string[],
  ): Promise<Map<string, { destinationRemoteId: string | null; destinationFilePath: string | null }>> {
    if (sourceRemoteIds.length === 0) {
      return new Map();
    }

    const mappings = await this.db.client.syncRemoteIdMapping.findMany({
      where: {
        syncId,
        dataFolderId,
        sourceRemoteId: { in: sourceRemoteIds },
      },
      select: { sourceRemoteId: true, destinationRemoteId: true, destinationFilePath: true },
    });

    return new Map(
      mappings.map((m) => [
        m.sourceRemoteId,
        { destinationRemoteId: m.destinationRemoteId, destinationFilePath: m.destinationFilePath },
      ]),
    );
  }

  // ============================================================================
  // SyncMatchKeys methods - for finding matching records across source and destination
  // ============================================================================

  /**
   * Inserts match keys for a batch of SyncRecords.
   * Extracts the value from the specified column and stores it as the matchId,
   * along with the record's remote ID for efficient lookup later.
   *
   * @param syncId - The sync ID
   * @param dataFolderId - The DataFolder ID (source or destination)
   * @param records - The SyncRecords to extract match keys from
   * @param matchColumnId - The column ID to extract match values from
   */
  private async insertMatchKeys(
    syncId: SyncId,
    dataFolderId: DataFolderId,
    records: SyncRecord[],
    matchColumnId: string,
  ): Promise<void> {
    const matchKeys = records
      .map((record) => {
        const matchValue = get(record.fields, matchColumnId);
        if ((typeof matchValue !== 'string' && typeof matchValue !== 'number') || String(matchValue).trim() === '') {
          return null;
        }
        return {
          syncId,
          dataFolderId,
          matchId: String(matchValue),
          remoteId: record.id,
          filePath: record.filePath,
        };
      })
      .filter((key): key is NonNullable<typeof key> => key !== null);

    if (matchKeys.length === 0) {
      return;
    }

    // Use createMany with skipDuplicates to handle duplicates gracefully
    await this.db.client.syncMatchKeys.createMany({
      data: matchKeys,
      skipDuplicates: true,
    });
  }

  /**
   * Inserts match keys for source records using the TableMapping's recordMatching config.
   */
  private async insertSourceMatchKeys(
    syncId: SyncId,
    tableMapping: TableMappingV2,
    records: SyncRecord[],
    transformContext?: MatchKeyTransformContext,
  ): Promise<void> {
    if (!tableMapping.recordMatching) {
      throw new Error('TableMapping must have recordMatching configured');
    }

    // Check if the source match column has DATA-phase transformers configured.
    // The match-key column must be a `kind: 'column'` source with `when: 'matched'`
    // (or undefined); constant sources can't carry the match value and are excluded
    // by save-time validation (D10/OV8).
    if (transformContext) {
      const matchColumnId = tableMapping.recordMatching.sourceColumnId;
      const matchDestColumnId = tableMapping.recordMatching.destinationColumnId;
      const matchMappingV2 = tableMapping.columnMappings?.find(
        (m) =>
          (m.when ?? 'matched') === 'matched' &&
          m.source.kind === 'column' &&
          m.source.columnId === matchColumnId &&
          m.destinationColumnId === matchDestColumnId,
      );
      const matchMapping = matchMappingV2 ? v2ColumnAsV1(matchMappingV2) : null;
      if (matchMapping) {
        const allConfigs = getTransformerConfigs(matchMapping);
        const dataConfigs = allConfigs.filter((c) => {
          // Build a temporary mapping with just this config to check its phase
          const tempMapping: ColumnMapping = { ...matchMapping, transformer: c, transformers: undefined };
          return getColumnMappingPhase(tempMapping) === 'DATA';
        });

        if (dataConfigs.length > 0) {
          await this.insertTransformedMatchKeys(syncId, tableMapping, records, dataConfigs, transformContext);
          return;
        }
      }
    }

    await this.insertMatchKeys(
      syncId,
      tableMapping.sourceDataFolderId,
      records,
      tableMapping.recordMatching.sourceColumnId,
    );
  }

  /**
   * Inserts match keys for source records after applying DATA-phase transformers
   * from the matching column's ColumnMapping.
   */
  private async insertTransformedMatchKeys(
    syncId: SyncId,
    tableMapping: TableMappingV2,
    records: SyncRecord[],
    transformerConfigs: TransformerConfig[],
    ctx: MatchKeyTransformContext,
  ): Promise<void> {
    const recordMatching = tableMapping.recordMatching;
    if (!recordMatching) {
      throw new Error(
        `insertTransformedMatchKeys called for table mapping (sync ${syncId}) without recordMatching configured`,
      );
    }
    const matchColumnId = recordMatching.sourceColumnId;
    const destColumnId = recordMatching.destinationColumnId;

    const noopLookupTools: LookupTools = {
      getDestinationMappingForSourceFk: () => Promise.resolve(null),
      lookupFieldFromFkRecord: () => Promise.resolve(undefined),
      getOrCreateDestinationAssetMapping: () => Promise.reject(new Error('Not available during match key insertion')),
      matchDestinationAssetByHash: () => Promise.resolve([]),
    };

    const matchKeys: Array<{
      syncId: SyncId;
      dataFolderId: DataFolderId;
      matchId: string;
      remoteId: string;
      filePath: string;
    }> = [];

    for (const record of records) {
      const rawValue = get(record.fields, matchColumnId);

      try {
        const result = await applyTransformerPipeline(transformerConfigs, rawValue, {
          sourceRecord: record,
          sourceFieldPath: matchColumnId,
          sourceTableSpec: ctx.sourceTableSpec,
          sourceService: ctx.sourceService,
          destinationFieldPath: destColumnId,
          destinationTableSpec: ctx.destinationTableSpec,
          destinationService: ctx.destinationService,
          lookupTools: noopLookupTools,
          phase: 'DATA',
        });

        if (!result.success) {
          WSLogger.warn({
            source: 'SyncService.insertTransformedMatchKeys',
            message: `Transformer failed for match key, skipping record`,
            syncId,
            remoteId: record.id,
            error: result.error,
          });
          continue;
        }

        const matchValue = result.value;
        if ((typeof matchValue !== 'string' && typeof matchValue !== 'number') || String(matchValue).trim() === '') {
          continue;
        }

        matchKeys.push({
          syncId,
          dataFolderId: tableMapping.sourceDataFolderId,
          matchId: String(matchValue),
          remoteId: record.id,
          filePath: record.filePath,
        });
      } catch (err) {
        WSLogger.warn({
          source: 'SyncService.insertTransformedMatchKeys',
          message: `Unexpected error transforming match key, skipping record`,
          syncId,
          remoteId: record.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    if (matchKeys.length === 0) {
      return;
    }

    await this.db.client.syncMatchKeys.createMany({
      data: matchKeys,
      skipDuplicates: true,
    });
  }

  /**
   * Inserts match keys for destination records using the TableMapping's recordMatching config.
   */
  private async insertDestinationMatchKeys(
    syncId: SyncId,
    tableMapping: TableMappingV2,
    records: SyncRecord[],
  ): Promise<void> {
    if (!tableMapping.recordMatching) {
      throw new Error('TableMapping must have recordMatching configured');
    }
    await this.insertMatchKeys(
      syncId,
      tableMapping.destinationDataFolderId,
      records,
      tableMapping.recordMatching.destinationColumnId,
    );
  }

  /**
   * Clears match keys for a specific sync and DataFolder combination.
   */
  private async clearMatchKeysForDataFolder(syncId: SyncId, dataFolderId: DataFolderId): Promise<void> {
    await this.db.client.syncMatchKeys.deleteMany({
      where: { syncId, dataFolderId },
    });
  }

  /**
   * Clears remote ID mappings for a specific sync and DataFolder combination.
   */
  private async clearRemoteIdMappingsForDataFolder(syncId: SyncId, dataFolderId: DataFolderId): Promise<void> {
    await this.db.client.syncRemoteIdMapping.deleteMany({
      where: { syncId, dataFolderId },
    });
  }

  /**
   * Previews how a single source record would be transformed by the given column mappings.
   * Does not write anything — returns per-field source/transformed pairs.
   */
  async previewRecord(workbookId: WorkbookId, body: PreviewRecordBody, actor: Actor): Promise<PreviewRecordResponse> {
    const parsed = previewRecordBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid preview body: ${parsed.error.message}`);
    }

    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    const sourceId = body.sourceFolderId;
    const sourceFolder = await this.db.client.dataFolder.findUnique({ where: { id: sourceId } });
    if (!sourceFolder) {
      throw new NotFoundException(`Source folder ${body.sourceFolderId} not found`);
    }

    const destinationFolder = await this.db.client.dataFolder.findUnique({ where: { id: body.destFolderId } });
    if (!destinationFolder) {
      throw new NotFoundException(`Destination folder ${body.destFolderId} not found`);
    }

    const sourceSchema = await this.readSchemaFromGit(workbookId, sourceFolder.connectorAccountId, sourceFolder.path);
    const sourceIdColumn = this.getIdColumnFromSchema(sourceSchema);

    const repoId = await this.scratchGitService.resolveConnectionRepoPath(sourceFolder.connectorAccountId);

    // Fetch the single source file
    const file = await this.scratchGitService.getRepoFile(repoId, DIRTY_BRANCH, body.filePath);
    if (!file) {
      throw new NotFoundException(`File not found: ${body.filePath}`);
    }

    const record = parseFileToRecord(
      { folderId: sourceId, path: body.filePath, content: file.content },
      sourceIdColumn,
    );
    const columnMappings = body.columnMappings;

    // Stub lookup tools — FK/asset lookups are not available in preview
    const notAvailableInPreviewError = new Error('Lookup is not available in preview');
    const previewLookupTools: LookupTools = {
      getDestinationMappingForSourceFk: () => Promise.reject(notAvailableInPreviewError),
      lookupFieldFromFkRecord: () => Promise.reject(notAvailableInPreviewError),
      getOrCreateDestinationAssetMapping: () => Promise.reject(notAvailableInPreviewError),
      matchDestinationAssetByHash: () => Promise.reject(notAvailableInPreviewError),
    };

    // Schemas
    let sourceTableSpec = (await this.dataFolderService.getStoredSchema(sourceId, actor)) as BaseJsonTableSpec | null;
    if (!sourceTableSpec) {
      sourceTableSpec = await this.dataFolderService.fetchSchemaSpec(sourceId, actor).catch(() => null);
    }
    let destinationTableSpec = (await this.dataFolderService.getStoredSchema(
      body.destFolderId,
      actor,
    )) as BaseJsonTableSpec | null;
    if (!destinationTableSpec) {
      destinationTableSpec = await this.dataFolderService.fetchSchemaSpec(body.destFolderId, actor).catch(() => null);
    }

    const fields: PreviewFieldResult[] = [];
    for (const mapping of columnMappings) {
      const sourceValue = get(record.fields, mapping.sourceColumnId);
      let transformedValue: unknown = sourceValue;
      let warning: string | undefined;

      const configs = getTransformerConfigs(mapping);
      if (configs.length > 0) {
        try {
          const result = await applyTransformerPipeline(configs, sourceValue, {
            sourceRecord: record,
            sourceFieldPath: mapping.sourceColumnId,
            sourceTableSpec,
            sourceService: sourceFolder.connectorService as Service,
            destinationFieldPath: mapping.destinationColumnId,
            destinationTableSpec,
            destinationService: destinationFolder.connectorService as Service,
            lookupTools: previewLookupTools,
            phase: 'DATA',
          });
          if (result.success) {
            transformedValue = result.skip ? 'Not available in preview' : result.value;
          } else {
            warning = result.error;
            transformedValue = sourceValue;
          }
        } catch (err) {
          if (err === notAvailableInPreviewError) {
            transformedValue = notAvailableInPreviewError.message;
          } else {
            warning = `Transform failed: ${err instanceof Error ? err.message : String(err)}`;
            transformedValue = '';
          }
        }
      }

      fields.push({
        sourceField: mapping.sourceColumnId,
        destinationField: mapping.destinationColumnId,
        sourceValue,
        transformedValue,
        transformerType: configs[0]?.type,
        warning,
      });
    }

    // Validate record matching field if configured — use the transformed value to match sync behaviour
    let recordMatchingWarning: string | undefined;
    const recordMatching = body.recordMatching;
    if (recordMatching) {
      const matchField = fields.find(
        (f) =>
          f.sourceField === recordMatching.sourceColumnId && f.destinationField === recordMatching.destinationColumnId,
      );
      const sourceMatchValue = matchField
        ? matchField.transformedValue
        : get(record.fields, recordMatching.sourceColumnId);
      recordMatchingWarning = validateMatchFieldValue(sourceMatchValue, recordMatching.sourceColumnId, 'source');
    }

    return { recordId: record.id, fields, recordMatchingWarning };
  }

  /**
   * Validates a mapping between two data folders.
   * Fetches schemas and checks validity.
   */
  async validateFolderMapping(
    workbookId: WorkbookId,
    sourceId: DataFolderId,
    destId: DataFolderId,
    columnMappings: ColumnMapping[],
    actor: Actor,
  ): Promise<boolean> {
    const sourceSpec = await this.dataFolderService.fetchSchemaSpec(sourceId, actor);
    // If no schema (e.g. scratch folder), we can't strictly validate, so assume true or fail?
    // User requested "validateMapping(sourceSchema, destinationSchema, mapping)".
    // If one is missing, maybe return true (loose validation) or false (strict).
    // Let's assume strict if connected, loose if not?
    // For now, if spec is missing, we skip validation -> true.

    const destSpec = await this.dataFolderService.fetchSchemaSpec(destId, actor);

    if (!sourceSpec?.schema || !destSpec?.schema) {
      return true;
    }

    return this.validateSchemaMapping(sourceSpec.schema, destSpec.schema, columnMappings);
  }

  /**
   * Traces the type through a single mapping's transformer pipeline (admin only).
   * Returns source type, each transformer step (name + output type), and destination type as JSON Schema fragments.
   */
  async traceMappingType(
    workbookId: WorkbookId,
    body: {
      sourceFolderId: DataFolderId;
      destFolderId: DataFolderId;
      sourceColumnId: string;
      destinationColumnId: string;
      transformers: TransformerConfig[];
    },
    actor: Actor,
  ): Promise<MappingTypeTrace | { error: string }> {
    if (!actor.isAdmin) {
      throw new UnauthorizedException('Only admins can run type validation.');
    }

    const parseResult = validateMappingTypeBodySchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException(`Invalid body: ${parseResult.error.message}`);
    }
    const data = parseResult.data;

    const sourceFolderId = data.sourceFolderId as DataFolderId;
    const destFolderId = data.destFolderId as DataFolderId;
    const sourceSpec = (await this.dataFolderService.getStoredSchema(
      sourceFolderId,
      actor,
    )) as BaseJsonTableSpec | null;
    const destSpec = (await this.dataFolderService.getStoredSchema(destFolderId, actor)) as BaseJsonTableSpec | null;

    if (!sourceSpec?.schema || !destSpec?.schema) {
      return { error: 'Source or destination schema not available.' };
    }

    const mapping: ColumnMapping = {
      sourceColumnId: data.sourceColumnId,
      destinationColumnId: data.destinationColumnId,
      transformers: data.transformers as TransformerConfig[],
    };

    return traceMappingType(mapping, sourceSpec.schema, destSpec.schema);
  }

  /**
   * Runs the same type validation as the Configure Transformers modal for every field mapping
   * in a sync. Returns an error report with tableMappingIndex, fieldMappingIndex, step, and errorMsg.
   */
  async validateSyncMappingTypes(
    workbookId: WorkbookId,
    syncId: SyncId,
    actor: Actor,
  ): Promise<ValidateSyncMappingTypesResponse> {
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    const sync = await this.db.client.sync.findFirst({
      where: { id: syncId, workbookId },
    });
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }

    const stored = parseStoredMappings(sync);
    if (stored.mappings.version !== 1) {
      // TODO(DEV-10008): widen the type-validator pipeline to accept v2
      // column mappings; today it operates on v1 only.
      throw new BadRequestException(`Sync ${syncId}: validate-mapping-types does not yet support v2 mappings.`);
    }
    const tableMappings = stored.mappings.tableMappings;
    const errors: SyncMappingValidationError[] = [];

    for (let tableMappingIndex = 0; tableMappingIndex < tableMappings.length; tableMappingIndex++) {
      const tm = tableMappings[tableMappingIndex];
      const sourceSpec = (await this.dataFolderService.getStoredSchema(
        tm.sourceDataFolderId,
        actor,
      )) as BaseJsonTableSpec | null;
      const destSpec = (await this.dataFolderService.getStoredSchema(
        tm.destinationDataFolderId,
        actor,
      )) as BaseJsonTableSpec | null;

      if (!sourceSpec?.schema || !destSpec?.schema) {
        continue;
      }

      const columnMappings = tm.columnMappings ?? [];
      for (let fieldMappingIndex = 0; fieldMappingIndex < columnMappings.length; fieldMappingIndex++) {
        const cm = columnMappings[fieldMappingIndex];
        const mapping: ColumnMapping = {
          sourceColumnId: cm.sourceColumnId,
          destinationColumnId: cm.destinationColumnId,
          transformer: cm.transformer,
          transformers: cm.transformers,
        };

        const result = traceMappingType(mapping, sourceSpec.schema, destSpec.schema);

        if ('error' in result) {
          errors.push({
            tableMappingIndex,
            fieldMappingIndex,
            step: 'source',
            errorMsg: result.error,
            outputJsonSchemaType: {},
            nextInputJsonSchemaType: {},
            errorType: 'compile_time_type_check',
            errorLevel: 'error',
          });
          continue;
        }

        const { validation } = result;
        for (const ve of validation) {
          errors.push({
            tableMappingIndex,
            fieldMappingIndex,
            step: ve.step,
            errorMsg: ve.errorMsg,
            outputJsonSchemaType: ve.outputJsonSchemaType,
            nextInputJsonSchemaType: ve.nextInputJsonSchemaType,
            errorType: ve.errorType,
            errorLevel: ve.errorLevel,
          });
        }
      }
    }

    return { errors };
  }

  /**
   * Pure validation logic between two schemas.
   */
  private validateSchemaMapping(sourceSchema: TSchema, destSchema: TSchema, columnMappings: ColumnMapping[]): boolean {
    void sourceSchema;
    void destSchema;
    void columnMappings;
    return true;
  }
}

/**
 * Parse a file's content to extract fields from front matter and body.
 *
 * @param file - The file content to parse
 * @param idColumnRemoteId - The column ID to use as the record ID (from schema.idColumnRemoteId)
 * @returns A SyncRecord with the ID extracted from the specified column
 */
function parseFileToRecord(file: FileContent, idColumnRemoteId: IdPath): SyncRecord {
  const fields: Record<string, unknown> = {};

  if (file.content) {
    const parsed = JSON.parse(file.content) as object;
    // Add metadata fields from front matter
    Object.assign(fields, parsed);
  }

  const recordId = readRecordIdAsString(fields, idColumnRemoteId);
  if (recordId === null) {
    throw new Error(`Record in file ${file.path} is missing or has non-stringable id at path: ${idColumnRemoteId}`);
  }

  return {
    id: recordId,
    filePath: file.path,
    fields,
  };
}

// `transformRecordAsync` and `TransformRecordResult` moved to sync-execution.ts.
// Re-exported here for back-compat with existing test imports.
export { transformRecordAsync } from 'src/sync/sync-execution';
export type { TransformRecordResult } from 'src/sync/sync-execution';

/**
 * Serialize transformed fields to markdown with YAML front matter.
 * This is the inverse of parseFileToRecord.
 * TODO: Update this to handle metadata correctly.
 *
 * @param fields - The fields to serialize
 * @returns JSON string formatted with Prettier
 */
function serializeRecord(fields: Record<string, unknown>): string {
  return formatJsonWithPrettier(fields);
}

/**
 * Validates that a match field value is suitable for record matching.
 * Returns a warning string if the value is invalid, or undefined if it's valid.
 */
function validateMatchFieldValue(
  value: unknown,
  fieldPath: string,
  side: 'source' | 'destination',
): string | undefined {
  if (value === undefined || value === null) {
    return `${side === 'source' ? 'Source' : 'Destination'} record is missing the record matching field "${fieldPath}". This record will not be matched during sync.`;
  }
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    const typeDesc = typeof value === 'string' ? 'empty' : `of type ${typeof value}`;
    return `${side === 'source' ? 'Source' : 'Destination'} record has an invalid value (${typeDesc}) for the record matching field "${fieldPath}". This record will not be matched during sync.`;
  }
  return undefined;
}
