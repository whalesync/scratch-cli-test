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
  formatRecordJson,
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
  UnmatchedDestinationAction,
  ValidateSyncMappingTypesResponse,
  WorkbookId,
} from '@spinner/shared-types';
import isEqual from 'lodash/isEqual';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { resolveMatchedRecordArchiveRepairFieldsForService } from 'src/remote-service/connectors/connector-registry';
import { resolveFieldValueCanonicalizersForTable } from 'src/remote-service/connectors/field-value-canonicalization';
import { Service as ServiceConst } from 'src/remote-service/connectors/service-constants';
import { BaseJsonTableSpec, DotPath, dotPath, readRecordIdAsString } from 'src/remote-service/connectors/types';
import { ScheduleService } from 'src/schedule/schedule.service';
import { DIRTY_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { deriveCanonicalMatchKey, getFieldUnpackTransformer } from 'src/sync/record-matching';
import { findConstantTypeMismatches, getSchemaAtPath, validateSchemaMapping } from 'src/sync/schema-validator';
import { ClassicPostgresSyncMatchIndex, createClassicSyncStoragePorts } from 'src/sync/storage/classic-sync-storage';
import type {
  ForeignKeyRecordCacheEntry,
  RemoteIdMappingPair,
  SyncDestinationFolderLocation,
  SyncMatchIndex,
  SyncMatchKeyEntry,
  SyncRecordFile,
  SyncStoragePorts,
} from 'src/sync/storage/sync-storage-ports';
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
  getTransformerConfigs,
  LookupTools,
  SyncPhase,
  SyncRecord,
} from 'src/sync/transformers';
import { MappingTypeTrace, traceMappingType } from 'src/sync/transformers/type-validator';
import { Actor } from 'src/users/types';
import { readFieldValueAtPath, setFieldValueAtPath } from 'src/utils/field-path';
import { safeJsonParse } from 'src/utils/helpers';
import { extractSchemaFields, SchemaField } from 'src/utils/schema-helpers';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { GitTableSpecStore } from 'src/workbook/table-spec-store/git-table-spec-store';
import { readTableSpecOrNullLoggingFailure, type TableSpecStore } from 'src/workbook/table-spec-store/table-spec-store';
import { deduplicateFileName, resolveBaseFileName } from 'src/workbook/util';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { WorkbookService } from 'src/workbook/workbook.service';

export type { RemoteIdMappingPair } from 'src/sync/storage/sync-storage-ports';

/**
 * Server-internal options for {@link SyncService.createSync} / {@link SyncService.updateSync}
 * (never part of the REST body). `validateAgainstStoredSchemas` makes mapping validation
 * read each folder's stored git schema instead of fetching it live from the connector —
 * see {@link SyncService.loadSchemaForMappingValidation}.
 */
export interface SaveSyncOptions {
  validateAgainstStoredSchemas?: boolean;
}

interface MatchKeyTransformContext {
  sourceTableSpec: BaseJsonTableSpec | null;
  destinationTableSpec: BaseJsonTableSpec | null;
  sourceService: Service;
  destinationService: Service;
}

/**
 * How many sample paths / errors / warnings a table result keeps. These lists are
 * for display only — every count a caller reports comes from the numeric fields
 * beside them — so they are capped at the point of collection rather than grown to
 * one entry per record and trimmed by the reader. A table with 42k records used to
 * build 42k-entry arrays here on its way to showing the first hundred.
 */
const MAX_REPORTED_SAMPLES = 100;

/** Appends to a display list until it reaches `MAX_REPORTED_SAMPLES`, then drops silently. */
function pushSample<T>(samples: T[], value: T): void {
  if (samples.length < MAX_REPORTED_SAMPLES) {
    samples.push(value);
  }
}

export interface SyncTableMappingResult {
  recordsCreated: number;
  recordsUpdated: number;
  recordsSkipped: number;
  /** Destination record files deleted by Pass 3's `'delete'` policy. */
  recordsDeleted: number;
  /** Sample of created paths, capped at `MAX_REPORTED_SAMPLES`. Count: `recordsCreated`. */
  createdPaths: string[];
  /** Sample of updated paths, capped at `MAX_REPORTED_SAMPLES`. Count: `recordsUpdated`. */
  updatedPaths: string[];
  /**
   * Sample of paths deleted by Pass 3's `'delete'` policy, capped at
   * `MAX_REPORTED_SAMPLES`. Count: `recordsDeleted`.
   */
  deletedPaths: string[];
  /** Sample of errors, capped at `MAX_REPORTED_SAMPLES`. Count: `errorCount`. */
  errors: Array<{ sourceRemoteId: string; error: string }>;
  /** Sample of warnings, capped at `MAX_REPORTED_SAMPLES`. Count: `warningCount`. */
  warnings: Array<{ sourceRemoteId: string; warning: string }>;
  /** Every error raised, including those past the `errors` sample cap. */
  errorCount: number;
  /** Every warning raised, including those past the `warnings` sample cap. */
  warningCount: number;
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
    /**
     * Destination record files deleted by Pass 3 — the count of unmatched
     * records whose bucket policy resolved to `'delete'`. The source record is
     * gone, so its destination counterpart was removed from the dirty branch.
     */
    deleted: number;
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
  ) {
    this.gitTableSpecStore = new GitTableSpecStore(scratchGitService);
  }

  /** Where table specs are read from outside a sync run (AI context, preview): the git copy. */
  private readonly gitTableSpecStore: TableSpecStore;

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
   * Reads a folder's table spec from `tableSpecStore` (the git copy unless the caller supplies its own
   * store); null when there is none or it can't be read.
   */
  private readTableSpecOrNull(
    workbookId: string,
    connectorAccountId: string | null,
    folderPath: string | null,
    tableSpecStore: TableSpecStore = this.gitTableSpecStore,
  ): Promise<BaseJsonTableSpec | null> {
    return readTableSpecOrNullLoggingFailure(
      tableSpecStore,
      { connectorAccountId, folderPath },
      { source: 'SyncService.readTableSpecOrNull', workbookId },
    );
  }

  /**
   * The schema a save's mapping validation checks a folder's column mappings against.
   * Default reads it LIVE from the connector (also rewriting the stored git copy) — the
   * freshest check for an interactively edited sync. With `validateAgainstStoredSchemas`
   * it reads the stored git copy instead: the sync-draft apply path passes that because
   * every folder it touches has a just-written or pull-maintained stored schema, and
   * re-fetching source+destination live per table pair made saving a many-table draft
   * minutes-slow (DEV-10875). Returns null when no schema is available, in which case
   * validation skips gracefully (matching the live path's behavior on fetch failure).
   */
  private async loadSchemaForMappingValidation(
    dataFolderId: DataFolderId,
    actor: Actor,
    options: SaveSyncOptions,
  ): Promise<TSchema | null> {
    if (options.validateAgainstStoredSchemas) {
      const storedSpec = await this.dataFolderService.getStoredSchema(dataFolderId, actor);
      const storedSchema = storedSpec?.schema;
      return storedSchema && typeof storedSchema === 'object' ? (storedSchema as TSchema) : null;
    }
    const spec = await this.dataFolderService.fetchSchemaSpec(dataFolderId, actor);
    return spec?.schema ?? null;
  }

  /**
   * Creates a new sync.
   */
  async createSync(
    workbookId: WorkbookId,
    body: SaveSyncBody,
    actor: Actor,
    options: SaveSyncOptions = {},
  ): Promise<unknown> {
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

        const sourceSchema = await this.loadSchemaForMappingValidation(sourceId, actor, options);
        const destSchema = await this.loadSchemaForMappingValidation(destId, actor, options);

        if (sourceSchema && destSchema) {
          const v1Cols = projectV2ColumnMappingsToV1(tableMapping.columnMappings);
          const errors = validateSchemaMapping(sourceSchema, destSchema, v1Cols);
          if (errors.length > 0) {
            throw new BadRequestException(`Validation failed for folder mapping: ${errors.join('; ')}`);
          }
        }

        // Constant column mappings have no source column for validateSchemaMapping
        // to type-check; verify their literal values against the destination
        // column type directly. Surfaced as HTTP 400 by SyncExceptionFilter.
        if (destSchema) {
          const constantMismatches = findConstantTypeMismatches(destSchema, tableMapping.columnMappings);
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
        publishAfterSync: body.publishAfterSync ?? false,
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
          timezone: body.scheduleTimezone ?? null,
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
  async updateSync(
    workbookId: WorkbookId,
    syncId: SyncId,
    body: SaveSyncBody,
    actor: Actor,
    options: SaveSyncOptions = {},
  ): Promise<unknown> {
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

        const sourceSchema = await this.loadSchemaForMappingValidation(sourceId, actor, options);
        const destSchema = await this.loadSchemaForMappingValidation(destId, actor, options);

        if (sourceSchema && destSchema) {
          const v1Cols = projectV2ColumnMappingsToV1(tableMapping.columnMappings);
          const errors = validateSchemaMapping(sourceSchema, destSchema, v1Cols);
          if (errors.length > 0) {
            throw new BadRequestException(`Validation failed for folder mapping: ${errors.join('; ')}`);
          }
        }

        // Constant column mappings have no source column for validateSchemaMapping
        // to type-check; verify their literal values against the destination
        // column type directly. Surfaced as HTTP 400 by SyncExceptionFilter.
        if (destSchema) {
          const constantMismatches = findConstantTypeMismatches(destSchema, tableMapping.columnMappings);
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
        // Update existing schedule's cron expression. Only forward the timezone when the
        // caller actually sent one (`!== undefined`) so a client that omits it — e.g. an
        // older scratchmd CLI re-importing a sync — preserves the stored timezone.
        await this.scheduleService.update(workbookId, existingSchedule.id, {
          cronExpression: body.schedule,
          ...(body.scheduleTimezone !== undefined && { timezone: body.scheduleTimezone }),
        });
      } else {
        // Create a new schedule
        await this.scheduleService.create(
          workbookId,
          {
            name: `Sync: ${body.displayName}`,
            action: ScheduleAction.SYNC,
            entityId: syncId,
            cronExpression: body.schedule,
            timezone: body.scheduleTimezone ?? null,
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
        scheduleTimezone: schedule?.timezone ?? null,
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

      const schemaJson = await this.readTableSpecOrNull(workbookId, folder.connectorAccountId, folder.path);
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
   * Extracts the idPath from a DataFolder's schema.
   * Falls back to `dotPath('id')` if the schema doesn't specify an idPath.
   */
  private getIdColumnFromSchema(schema: unknown): DotPath {
    const jsonSchema = schema as BaseJsonTableSpec | null;
    return jsonSchema?.idPath ?? dotPath('id');
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
   * The classic storage a sync run reads and writes when the caller supplies none: record files
   * on the scratch-git dirty branch, the match index and lookup caches in Postgres.
   */
  private buildDefaultClassicSyncStoragePorts(syncId: SyncId, workbookId: WorkbookId, actor: Actor): SyncStoragePorts {
    return createClassicSyncStoragePorts({
      db: this.db,
      dataFolderService: this.dataFolderService,
      scratchGitService: this.scratchGitService,
      syncId,
      workbookId,
      actor,
    });
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
   * @param storagePorts - Where the run reads and writes records, match keys and lookups;
   *   defaults to the classic git + Postgres storage. A caller supplying its own must pass the same
   *   bundle to every call of the run (see {@link SyncStoragePorts})
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
    storagePorts: SyncStoragePorts = this.buildDefaultClassicSyncStoragePorts(syncId, workbookId, actor),
  ): Promise<SyncTableMappingResult> {
    const { recordSource, matchIndex, tableSpecStore } = storagePorts;

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
      recordsDeleted: 0,
      createdPaths: [],
      updatedPaths: [],
      deletedPaths: [],
      errors: [],
      warnings: [],
      errorCount: 0,
      warningCount: 0,
      unmatchedDestinationCounts: { withMatchKey: 0, withoutMatchKey: 0, archived: 0, unarchived: 0, deleted: 0 },
    };

    /** Records an error: always counted, sampled up to the display cap. */
    const recordError = (sourceRemoteId: string, error: string): void => {
      result.errorCount++;
      pushSample(result.errors, { sourceRemoteId, error });
    };

    /** Records a warning: always counted, sampled up to the display cap. */
    const recordWarning = (sourceRemoteId: string, warning: string): void => {
      result.warningCount++;
      pushSample(result.warnings, { sourceRemoteId, warning });
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
    const sourceTableSpec = await this.readTableSpecOrNull(
      workbookId,
      sourceFolder.connectorAccountId,
      sourceFolder.path,
      tableSpecStore,
    );

    const destinationTableSpec = await this.readTableSpecOrNull(
      workbookId,
      destinationFolder.connectorAccountId,
      destinationFolder.path,
      tableSpecStore,
    );
    // Get the destination folder path for new files
    const destinationFolderPath = destinationFolder.path?.replace(/^\//, '') ?? '';
    const destinationFolderLocation: SyncDestinationFolderLocation = {
      dataFolderId: tableMapping.destinationDataFolderId,
      folderPathWithoutLeadingSlash: destinationFolderPath,
      connectorAccountId: destinationFolder.connectorAccountId,
    };
    const destinationOutputSink = await storagePorts.openDestinationOutputSink(destinationFolderLocation);

    // Get idPath from schemas
    const sourceIdColumn = this.getIdColumnFromSchema(sourceTableSpec);
    const destinationIdColumn = this.getIdColumnFromSchema(destinationTableSpec);

    // The destination connector's declared field-value canonicalizers (DEV-10556):
    // a mapped value canonically equal to what the matched record already holds is
    // NOT overlaid in Pass 2 / Pass 3, so a no-op sync leaves the record untouched
    // instead of rewriting every field in the minimal write shape and re-publishing.
    // Connectors that declare no canonicalizer keep the purely structural compare.
    const destinationFieldCanonicalizers = resolveFieldValueCanonicalizersForTable(
      destinationFolder.connectorService ?? '',
      destinationTableSpec,
    );
    if (destinationFieldCanonicalizers.size > 0) {
      WSLogger.debug({
        source: 'SyncService.syncTableMapping',
        message: `Destination ${destinationFolder.connectorService} declares field-value canonicalizers for ${destinationFieldCanonicalizers.size} field(s) of ${destinationFolder.path}`,
      });
    }

    // ===========================================================================================
    // Pass 1: Populate caches (match keys, FK records, remote ID mappings)
    // Skipped in FOREIGN_KEY_MAPPING phase — it reuses caches built by the DATA phase.
    // ===========================================================================================

    // Filename strings only — the parsed destination records themselves are never
    // retained across pages (DEV-11194). Pass 2 re-reads the handful it needs per
    // source page; Pass 3 streams the folder again.
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
      await matchIndex.clearMatchKeysForDataFolder(tableMapping.sourceDataFolderId);
      await matchIndex.clearMatchKeysForDataFolder(tableMapping.destinationDataFolderId);
      await matchIndex.clearRemoteIdMappingsForSourceDataFolder(tableMapping.sourceDataFolderId);

      // Page through source files — insert match keys and collect FK values per batch
      let batchCounter = 0;
      for await (const sourceFilePage of recordSource.pageThroughSourceFolderRecordFiles(
        tableMapping.sourceDataFolderId,
      )) {
        const batchRecords = sourceFilePage.map((file) => parseFileToRecord(file, sourceIdColumn));

        WSLogger.info({
          source: 'SyncService.syncTableMapping',
          message: `Pass 1: source batch`,
          syncId,
          records: batchRecords.length,
          batch: batchCounter,
        });

        await this.fillSyncCachesBatch(syncId, tableMapping, batchRecords, [], matchKeyTransformContext, matchIndex);
        this.collectForeignKeyValues(tableMapping, batchRecords, fkValuesByFolder);

        batchCounter++;
      }
    }

    // Page through destination files — insert match keys and collect used filenames
    // per batch. Each page's parsed records are discarded once the page is handled.
    for await (const destinationFilePage of recordSource.pageThroughDestinationFolderRecordFiles(
      tableMapping.destinationDataFolderId,
      { syncId, passLabel: 'Pass 1', destinationFolderPath: destinationFolder.path },
    )) {
      const batchRecords: SyncRecord[] = [];
      for (const file of destinationFilePage) {
        const record = parseFileToRecord(file, destinationIdColumn);
        batchRecords.push(record);
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

      if (phase === 'DATA') {
        // Only need to fill the caches in the first phase
        await this.fillSyncCachesBatch(syncId, tableMapping, [], batchRecords, matchKeyTransformContext, matchIndex);
      }
    }

    if (phase === 'DATA') {
      // Finalize caches — join match keys to create remote ID mappings
      await this.buildRecordMatchingMappings(syncId, tableMapping, matchIndex);

      // Populate FK record cache for lookup_field transformers
      await this.populateForeignKeyRecordCache(syncId, fkValuesByFolder, workbookId, storagePorts);
    }

    // ===========================================================================================
    // Pass 2: Iterate source pages again to transform and write records using populated caches
    // ===========================================================================================

    // Get the destination idPath from schema
    const destIdColumn = this.getIdColumnFromSchema(destinationTableSpec);

    // Create lookup tools for transformers that need FK resolution
    const lookupTools = createLookupTools(
      storagePorts.lookupDataProvider,
      sourceFolder.connectorService as Service,
      destinationFolder.connectorService as Service,
      (referencedDataFolderId, onRecordPage) =>
        this.readSourceRecordsForReferencedFolderInPages(
          workbookId,
          referencedDataFolderId,
          storagePorts,
          onRecordPage,
        ),
    );

    // Track new records so we can backfill SyncRemoteIdMapping with their file paths and record IDs.
    // Flushed at page boundaries (and again after the last page) so a table whose
    // records are all creates — any sync into an empty destination — never holds
    // more than one page of them.
    let newRecordMappings: Array<{ sourceRemoteId: string; filePath: string; destinationRecordId: string }> = [];
    const flushNewRecordMappings = async (): Promise<void> => {
      if (phase !== 'DATA' || newRecordMappings.length === 0) {
        return;
      }
      const pending = newRecordMappings;
      newRecordMappings = [];
      await matchIndex.recordDestinationsOfNewlyCreatedRecords(tableMapping.sourceDataFolderId, pending);
    };

    // Transformed destination files queue on `destinationOutputSink` (bounded memory —
    // see ClassicStagedGitCommitOutputSink, DEV-11193) and land as one unit in step 8.
    //
    // Queued files, for the step-8 failure report. A batch write fails as a unit,
    // so every queued file is affected and the count is what callers act on; only
    // a sample of the paths is kept, since holding one path string per record put
    // a second whole-table array next to the one DEV-11193 removed.
    const queuedFilePathSamples: string[] = [];
    const queueFileWrite = (file: { path: string; content: string }): void => {
      destinationOutputSink.queueRecordFileWrite(file);
      pushSample(queuedFilePathSamples, file.path);
    };

    // Pass 3 'delete' policy collects orphaned destination record paths here;
    // committed as a batch deletion after the writes land (see step 8).
    const filesToDelete: string[] = [];

    // Page through source files again for transformation
    let sourcePageCounter = 0;
    for await (const sourceFilePage of recordSource.pageThroughSourceFolderRecordFiles(
      tableMapping.sourceDataFolderId,
    )) {
      // Parse this batch of source records
      const batchRecords = sourceFilePage.map((file) => parseFileToRecord(file, sourceIdColumn));
      let batchRecordsById = new Map(batchRecords.map((r) => [r.id, r]));

      // When scoped to a single source file, drop everything else from the batch.
      // Skip the entire batch if it doesn't contain the target file.
      if (onlySourceFilePath !== undefined) {
        batchRecordsById = new Map([...batchRecordsById].filter(([, r]) => r.filePath === onlySourceFilePath));
        if (batchRecordsById.size === 0) {
          sourcePageCounter++;
          continue;
        }
      }

      WSLogger.info({
        source: 'SyncService.syncTableMapping',
        message: `Pass 2: source batch`,
        syncId,
        records: batchRecordsById.size,
        batch: sourcePageCounter,
      });

      // Get mappings for this batch
      const batchMappings = await matchIndex.getDestinationMappingsForSourceRemoteIds(
        tableMapping.sourceDataFolderId,
        Array.from(batchRecordsById.keys()),
      );

      // Read the existing destination records this page's matched mappings point at,
      // and hold them only for the page (DEV-11194 — the whole-folder map this
      // replaces was the sync worker's largest allocation).
      // Nothing this run has written has landed yet (Pass 2 queues on the output
      // sink, which lands in step 8), so these are the same bytes Pass 1 read.
      const matchedDestinationPathsInPage = Array.from(
        new Set(
          Array.from(batchMappings.values())
            .map((mapping) => mapping.destinationFilePath)
            .filter((destinationFilePath): destinationFilePath is string => destinationFilePath !== null),
        ),
      );
      const existingDestinationRecordsByPathInPage = new Map<string, SyncRecord>();
      if (matchedDestinationPathsInPage.length > 0) {
        const existingDestinationFilesInPage = await recordSource.readDestinationRecordFilesByPath(
          destinationFolderLocation,
          matchedDestinationPathsInPage,
        );
        for (const file of existingDestinationFilesInPage) {
          // A null content means the mapping points at a file that is no longer in
          // git. Leaving it out of the map reproduces the old behaviour exactly: the
          // record gets no `baseFields` and is rewritten from the mappings alone.
          if (file.content === null) {
            continue;
          }
          existingDestinationRecordsByPathInPage.set(
            file.path,
            parseFileToRecord(
              { folderId: tableMapping.destinationDataFolderId, path: file.path, content: file.content },
              destinationIdColumn,
            ),
          );
        }
      }

      // Skip source records with missing or empty match key — this is expected
      // when source data has incomplete records and is not an error condition.
      if (tableMapping.recordMatching) {
        let skippedNoMatchKey = 0;
        for (const [sourceId, sourceRecord] of batchRecordsById) {
          if (!batchMappings.has(sourceId)) {
            const matchKeyValue = readFieldValueAtPath(sourceRecord.fields, tableMapping.recordMatching.sourceColumnId);
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
          recordError(sourceRemoteId, 'Source record not found');
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
              recordWarning(sourceRemoteId, w);
            }

            // Generate a temporary ID for the new record so it can be matched on subsequent syncs,
            // but only if the column mappings haven't already set the destination ID column.
            const existingIdValue = readFieldValueAtPath(transformedFields, destIdColumn);
            const hasExplicitId =
              existingIdValue != null && (typeof existingIdValue === 'string' || typeof existingIdValue === 'number');
            const tempId = hasExplicitId ? String(existingIdValue) : createScratchPendingPublishId();
            if (!hasExplicitId) {
              setFieldValueAtPath(transformedFields, destIdColumn, tempId, destinationTableSpec?.schema);
            }

            // Resolve filename: prefer slug from destination schema, fall back to temp ID
            const slugPath = destinationTableSpec?.slugPath ?? destinationTableSpec?.slugColumnRemoteId;
            const slugValue = slugPath
              ? (readFieldValueAtPath(transformedFields, slugPath) as string | undefined)
              : undefined;
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
            pushSample(result.createdPaths, destinationPath);
          } else {
            // Existing record: pass the existing fields as the base so applyColumnMappings
            // surgically updates only the mapped fields. This is critical to preserve the
            // original JSON key ordering in the destination file (see baseFields param docs).
            destinationPath = mapping.destinationFilePath;
            const existingRecord = existingDestinationRecordsByPathInPage.get(mapping.destinationFilePath);

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
              destinationFieldCanonicalizers,
            });
            transformedFields = transformResult.fields;
            for (const w of transformResult.warnings) {
              recordWarning(sourceRemoteId, w);
            }

            // DEV-11013: repair an archived / soft-deleted destination record whose
            // source row still exists. The destination connector reports the field
            // overlay that would unarchive it (e.g. Notion's is_archived → false);
            // overlaying it makes the record differ from disk so it is written and
            // published even when NO mapped field drifted — otherwise the no-op skip
            // below would leave the mirror silently archived. Gated to the DATA phase
            // (like constants); the FK phase re-reads the record after the clear and
            // finds nothing to repair.
            let appliedArchiveRepair = false;
            if (phase === 'DATA' && existingRecord) {
              const archiveRepairFields = resolveMatchedRecordArchiveRepairFieldsForService(
                destinationFolder.connectorService as Service,
                existingRecord.fields,
              );
              if (archiveRepairFields) {
                for (const [repairFieldPath, repairValue] of Object.entries(archiveRepairFields)) {
                  setFieldValueAtPath(transformedFields, repairFieldPath, repairValue, destinationTableSpec?.schema);
                }
                appliedArchiveRepair = true;
              }
            }

            // Skip writing if the transformed fields are identical to the existing record —
            // this avoids unnecessary file writes that produce only whitespace changes.
            if (existingRecord && isEqual(transformedFields, existingRecord.fields)) {
              continue;
            }

            result.recordsUpdated++;
            pushSample(result.updatedPaths, destinationPath);
            if (hasMatchedBucketConstant || appliedArchiveRepair) {
              result.unmatchedDestinationCounts.unarchived++;
            }
          }

          const content = serializeRecord(transformedFields);
          queueFileWrite({ path: destinationPath, content });
        } catch (error) {
          recordError(sourceRemoteId, error instanceof Error ? error.message : String(error));
        }
      }

      await destinationOutputSink.flushQueuedRecordFileWritesAtPageBoundary();
      await flushNewRecordMappings();

      sourcePageCounter++;
    }

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
      (tableMapping.unmatchedDestinationPolicy.withMatchKey !== 'ignore' ||
        tableMapping.unmatchedDestinationPolicy.withoutMatchKey !== 'ignore')
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

        // Hydrate the source-side match-key set for O(1) classification.
        const sourceMatchKeySet = await matchIndex.loadMatchIdsForDataFolder(tableMapping.sourceDataFolderId);

        WSLogger.info({
          source: 'SyncService.syncTableMapping',
          message: 'Pass 3: starting unmatched-destination write',
          syncId,
          sourceMatchKeyCount: sourceMatchKeySet.size,
          policy: tableMapping.unmatchedDestinationPolicy,
        });

        // Resolve the destination field's extraction transformer once; reused to
        // canonicalize every destination record's match key the same way Pass 1
        // built the stored keys (so classification stays consistent with the join).
        const destinationMatchKeyUnpackTransformer = getFieldUnpackTransformer(destinationTableSpec, matchColPath);

        const policy = tableMapping.unmatchedDestinationPolicy;

        // Stream the destination folder a second time rather than iterating a
        // whole-folder map (DEV-11194). Pass 2's writes are still queued on the
        // output sink at this point, so this sees the same pre-sync records Pass 1 classified
        // against — records created by this run cannot leak into the classification.
        let destinationRecordsVisitedInPass3 = 0;
        for await (const destinationFilePage of recordSource.pageThroughDestinationFolderRecordFiles(
          tableMapping.destinationDataFolderId,
          { syncId, passLabel: 'Pass 3', destinationFolderPath: destinationFolder.path },
        )) {
          for (const destinationFile of destinationFilePage) {
            const destRecord = parseFileToRecord(destinationFile, destinationIdColumn);
            const destPath = destinationFile.path;
            destinationRecordsVisitedInPass3++;

            const destinationMatchKey = await deriveCanonicalMatchKey(
              {
                record: destRecord,
                fieldPath: matchColPath,
                tableSpec: destinationTableSpec,
                service: destinationFolder.connectorService as Service,
              },
              destinationMatchKeyUnpackTransformer,
            );
            const classification = classifyDestinationRecord(destinationMatchKey, sourceMatchKeySet);
            if (classification === 'matched') {
              continue;
            }

            // Resolve the per-bucket action for this unmatched record.
            let action: UnmatchedDestinationAction;
            if (classification === 'unmatchedWithMatchKey') {
              result.unmatchedDestinationCounts.withMatchKey++;
              action = policy.withMatchKey;
            } else {
              result.unmatchedDestinationCounts.withoutMatchKey++;
              action = policy.withoutMatchKey;
            }

            if (action === 'ignore') continue;

            if (action === 'delete') {
              // The source record is gone — remove its destination counterpart.
              // No column mappings are applied; the file is deleted outright.
              // Committed as a batch in step 9 (after the Pass 2/3 writes land).
              result.unmatchedDestinationCounts.deleted++;
              result.recordsDeleted++;
              pushSample(result.deletedPaths, destPath);
              filesToDelete.push(destPath);
              continue;
            }

            // action === 'apply' — apply the unmatched-bucket constant mappings.
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
                destinationFieldCanonicalizers,
              });
              for (const w of transformResult.warnings) {
                recordWarning(destRecord.id, w);
              }
              if (isEqual(transformResult.fields, destRecord.fields)) {
                // No effective change — the unmatched rules produced the same
                // bytes already on disk. Skip the write (mirrors Pass 2).
                continue;
              }
              result.unmatchedDestinationCounts.archived++;
              result.recordsUpdated++;
              pushSample(result.updatedPaths, destPath);
              queueFileWrite({ path: destPath, content: serializeRecord(transformResult.fields) });
            } catch (error) {
              recordError(destRecord.id, error instanceof Error ? error.message : String(error));
            }

            await destinationOutputSink.flushQueuedRecordFileWritesAtPageBoundary();
          }
        }

        WSLogger.info({
          source: 'SyncService.syncTableMapping',
          message: 'Pass 3: completed',
          syncId,
          destinationRecordsVisited: destinationRecordsVisitedInPass3,
          counts: result.unmatchedDestinationCounts,
        });
      }
    }

    // 7. Backfill SyncRemoteIdMapping for newly created records with their file paths
    // This is needed so the FOREIGN_KEY_MAPPING phase can resolve FK references to new records.
    // Earlier pages already flushed; this covers the tail.
    await flushNewRecordMappings();

    // 8. Land all queued writes as ONE unit (on the dirty branch as one commit, for
    // the classic sink).
    if (destinationOutputSink.queuedRecordFileWriteCount > 0) {
      try {
        await destinationOutputSink.commitQueuedRecordFileWrites();
      } catch (error) {
        // If the batch write fails, all records are affected. Nothing landed on
        // the branch — staged files only become visible at the atomic commit —
        // so the whole run's writes are reported failed, exactly as with the
        // old single commitFilesToBranch call.
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Every queued file failed, so the count is the queued count; the sampled
        // paths give the same first-N detail the old per-path loop surfaced.
        result.errorCount += destinationOutputSink.queuedRecordFileWriteCount;
        for (const path of queuedFilePathSamples) {
          pushSample(result.errors, { sourceRemoteId: path, error: `Batch write failed: ${errorMessage}` });
        }
        result.recordsCreated = 0;
        result.recordsUpdated = 0;
        // Pass 3 writes were rolled back too — zero the archive/unarchive counts.
        // The classification visited-counts (withMatchKey, withoutMatchKey) stay
        // since the work happened even if no file landed. The 'delete' batch has
        // not been committed yet (it runs below), so zero it: nothing was removed.
        result.unmatchedDestinationCounts.archived = 0;
        result.unmatchedDestinationCounts.unarchived = 0;
        result.unmatchedDestinationCounts.deleted = 0;
        result.recordsDeleted = 0;
        result.deletedPaths = [];
        return result;
      }
    }

    // 9. Delete orphaned destination records (Pass 3 'delete' policy) as a batch.
    // Runs after the writes land so a failed write never strands a deletion, and
    // deletions are skipped entirely if the writes failed (early return above).
    if (filesToDelete.length > 0) {
      WSLogger.info({
        source: 'SyncService.syncTableMapping',
        message: `Deleting orphaned destination records`,
        syncId,
        files: filesToDelete.length,
      });
      try {
        await destinationOutputSink.deleteRecordFiles(filesToDelete);
      } catch (error) {
        // Deletion failed — surface per path and zero the delete counters so the
        // run summary doesn't claim records were removed when none were.
        const errorMessage = error instanceof Error ? error.message : String(error);
        for (const path of filesToDelete) {
          recordError(path, `Batch delete failed: ${errorMessage}`);
        }
        result.unmatchedDestinationCounts.deleted = 0;
        result.recordsDeleted = 0;
        result.deletedPaths = [];
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
    matchIndex: SyncMatchIndex = new ClassicPostgresSyncMatchIndex(this.db, syncId),
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
        await matchIndex.upsertRemoteIdMappingsForSourceDataFolder(tableMapping.sourceDataFolderId, batchMappings);
      }
      return;
    }

    // Insert match keys for both sides
    if (sourceRecords.length > 0) {
      await this.insertSourceMatchKeys(matchIndex, tableMapping, sourceRecords, transformContext);
    }
    if (destinationRecords.length > 0) {
      await this.insertDestinationMatchKeys(matchIndex, tableMapping, destinationRecords, transformContext);
    }
  }

  /**
   * Finalizes sync caches after all batches have been processed.
   * Joins source and destination match keys to create remote ID mappings.
   * Only needed when recordMatching is configured. See
   * `ClassicPostgresSyncMatchIndex.joinMatchKeysIntoRemoteIdMappings` for how the classic
   * index does the join inside Postgres (DEV-11192).
   */
  async buildRecordMatchingMappings(
    syncId: SyncId,
    inputTableMapping: TableMappingV1 | TableMappingV2,
    matchIndex: SyncMatchIndex = new ClassicPostgresSyncMatchIndex(this.db, syncId),
  ): Promise<void> {
    const tableMapping = ensureTableMappingV2(inputTableMapping);
    if (!tableMapping.recordMatching) {
      return;
    }

    // Create remote ID mappings for both matched and unmatched source records
    const { totalSourceRecords, matchedRecords } = await matchIndex.joinMatchKeysIntoRemoteIdMappings({
      sourceDataFolderId: tableMapping.sourceDataFolderId,
      destinationDataFolderId: tableMapping.destinationDataFolderId,
    });

    WSLogger.info({
      source: 'SyncService.buildRecordMatchingMappings',
      message: 'Built mappings for record matching',
      syncId,
      totalSourceRecords,
      matchedRecords,
      unmatchedRecords: totalSourceRecords - matchedRecords,
    });
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
        const val = readFieldValueAtPath(record.fields, mapping.sourceColumnId);
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
   * Read and parse every source record of a REFERENCED folder — the folder on the far end of a
   * foreign key — delivering them to `onRecordPage` one page (PAGINATED_FILE_BATCH_SIZE files) at
   * a time. Paged rather than returned as one array so a large referenced folder (e.g. 40k Stripe
   * invoices) is never fully materialized in memory — doing so is what OOM-killed the sync worker
   * (DEV-11192). Shared by the `lookup_field` record cache (which indexes records by remote id)
   * and the FK phase's non-id target-key index (which indexes them by a declared field), so both
   * agree on how a referenced record is read and what its remote id is.
   *
   * The folder's own schema supplies the `idPath`, so each record's `id` is its source remote id.
   * Delivers no pages for a missing or empty folder; throws (via `parseFileToRecord`) if a record
   * has no id at that path, which is a genuinely broken record rather than an empty table.
   */
  private async readSourceRecordsForReferencedFolderInPages(
    workbookId: WorkbookId,
    referencedFolderId: DataFolderId,
    storagePorts: SyncStoragePorts,
    onRecordPage: (recordPage: SyncRecord[]) => void | Promise<void>,
  ): Promise<void> {
    const folder = await this.db.client.dataFolder.findUnique({ where: { id: referencedFolderId } });
    if (!folder) {
      WSLogger.warn({
        source: 'SyncService.readSourceRecordsForReferencedFolderInPages',
        message: `Referenced DataFolder ${referencedFolderId} not found`,
      });
      return;
    }
    const referencedSchema = await this.readTableSpecOrNull(
      workbookId,
      folder.connectorAccountId,
      folder.path,
      storagePorts.tableSpecStore,
    );
    const idColumn = this.getIdColumnFromSchema(referencedSchema);
    for await (const referencedFilePage of storagePorts.recordSource.pageThroughSourceFolderRecordFiles(
      referencedFolderId,
    )) {
      await onRecordPage(referencedFilePage.map((file) => parseFileToRecord(file, idColumn)));
    }
  }

  /**
   * Populates the `lookup_field` record cache (SyncForeignKeyRecord, classically) for lookup_field transformers.
   * Uses pre-collected FK values (from collectForeignKeyValues) to fetch and
   * cache the referenced record data.
   *
   * The cache itself lives in the lookup data store; memory is only a staging area, so each page of the
   * referenced folder is filtered and inserted as it streams. Peak memory is one page of
   * records, not the whole referenced folder — materializing the folder here is what
   * OOM-killed the sync worker on large tables (DEV-11192).
   */
  private async populateForeignKeyRecordCache(
    syncId: SyncId,
    fkValuesByFolder: Map<DataFolderId, Set<string>>,
    workbookId: WorkbookId,
    storagePorts: SyncStoragePorts,
  ): Promise<void> {
    if (fkValuesByFolder.size === 0) {
      return;
    }
    const { lookupDataProvider } = storagePorts;

    // Clear existing FK record cache for this sync
    await lookupDataProvider.clearForeignKeyRecordCache();

    for (const [referencedFolderId, fkValues] of fkValuesByFolder) {
      if (fkValues.size === 0) continue;

      let cachedRecordCount = 0;
      await this.readSourceRecordsForReferencedFolderInPages(
        workbookId,
        referencedFolderId,
        storagePorts,
        async (recordPage) => {
          // One cache entry per referenced record some collected FK value points at. Record ids are
          // unique within a folder, so filtering records against the FK-value set yields the same
          // entries as looking each FK value up in a full-folder index.
          const entries: ForeignKeyRecordCacheEntry[] = [];

          for (const record of recordPage) {
            if (!fkValues.has(record.id)) continue;
            entries.push({
              dataFolderId: referencedFolderId,
              foreignKeyValue: record.id,
              recordFields: record.fields,
            });
          }

          if (entries.length > 0) {
            await lookupDataProvider.addForeignKeyRecordsToCache(entries);
            cachedRecordCount += entries.length;
          }
        },
      );

      WSLogger.info({
        source: 'SyncService.populateForeignKeyRecordCache',
        message: 'Cached referenced records for lookup_field transformers',
        syncId,
        referencedFolderId,
        collectedFkValues: fkValues.size,
        cachedRecords: cachedRecordCount,
      });
    }
  }

  // ============================================================================
  // SyncMatchKeys methods - for finding matching records across source and destination
  // ============================================================================

  /**
   * Derives and stores canonical match keys for a batch of SyncRecords on one side.
   *
   * Each record's value at `matchColumnId` is reduced to a canonical primitive by
   * `deriveCanonicalMatchKey` — using the field's OWN connector-declared extraction
   * transformer (never the sync's copy transformers), so the same logical value
   * reduces to the same `matchId` regardless of which side it came from. Records
   * whose value can't be reduced (non-primitive with no extraction transformer,
   * empty, or missing) are skipped.
   *
   * @param matchIndex - Where the sync's match keys are stored
   * @param dataFolderId - The DataFolder ID (source or destination)
   * @param records - The SyncRecords to extract match keys from
   * @param matchColumnId - The column ID to extract match values from
   * @param fieldReduction - The schema + service for this side, used to resolve and
   *   apply the field's extraction transformer. Omitted (or specless) → primitive-only.
   */
  private async insertMatchKeys(
    matchIndex: SyncMatchIndex,
    dataFolderId: DataFolderId,
    records: SyncRecord[],
    matchColumnId: string,
    fieldReduction?: { tableSpec: BaseJsonTableSpec | null; service: Service },
  ): Promise<void> {
    const suggestedUnpackTransformer = fieldReduction
      ? getFieldUnpackTransformer(fieldReduction.tableSpec, matchColumnId)
      : undefined;

    const matchKeys: SyncMatchKeyEntry[] = [];

    for (const record of records) {
      const matchId = await deriveCanonicalMatchKey(
        {
          record,
          fieldPath: matchColumnId,
          tableSpec: fieldReduction?.tableSpec ?? null,
          service: fieldReduction?.service,
        },
        suggestedUnpackTransformer,
      );
      if (matchId === null) {
        continue;
      }
      matchKeys.push({ matchId, remoteId: record.id, filePath: record.filePath });
    }

    await matchIndex.addMatchKeysForDataFolder(dataFolderId, matchKeys);
  }

  /**
   * Inserts match keys for source records using the TableMapping's recordMatching config.
   */
  private async insertSourceMatchKeys(
    matchIndex: SyncMatchIndex,
    tableMapping: TableMappingV2,
    records: SyncRecord[],
    transformContext?: MatchKeyTransformContext,
  ): Promise<void> {
    if (!tableMapping.recordMatching) {
      throw new Error('TableMapping must have recordMatching configured');
    }
    await this.insertMatchKeys(
      matchIndex,
      tableMapping.sourceDataFolderId,
      records,
      tableMapping.recordMatching.sourceColumnId,
      transformContext
        ? { tableSpec: transformContext.sourceTableSpec, service: transformContext.sourceService }
        : undefined,
    );
  }

  /**
   * Inserts match keys for destination records using the TableMapping's recordMatching config.
   */
  private async insertDestinationMatchKeys(
    matchIndex: SyncMatchIndex,
    tableMapping: TableMappingV2,
    records: SyncRecord[],
    transformContext?: MatchKeyTransformContext,
  ): Promise<void> {
    if (!tableMapping.recordMatching) {
      throw new Error('TableMapping must have recordMatching configured');
    }
    await this.insertMatchKeys(
      matchIndex,
      tableMapping.destinationDataFolderId,
      records,
      tableMapping.recordMatching.destinationColumnId,
      transformContext
        ? { tableSpec: transformContext.destinationTableSpec, service: transformContext.destinationService }
        : undefined,
    );
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

    const sourceSchema = await this.readTableSpecOrNull(workbookId, sourceFolder.connectorAccountId, sourceFolder.path);
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
      resolveForeignKeyValueToTargetRemoteId: () => Promise.reject(notAvailableInPreviewError),
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
      const sourceValue = readFieldValueAtPath(record.fields, mapping.sourceColumnId);
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

    // Validate the record matching field if configured. Matching reduces the
    // source value to a canonical primitive via the source field's OWN extraction
    // transformer (not the copy transformers applied above), so mirror that here
    // rather than validating the copy-transformed value.
    let recordMatchingWarning: string | undefined;
    const recordMatching = body.recordMatching;
    if (recordMatching) {
      const sourceMatchKey = await deriveCanonicalMatchKey(
        {
          record,
          fieldPath: recordMatching.sourceColumnId,
          tableSpec: sourceTableSpec,
          service: sourceFolder.connectorService as Service,
        },
        getFieldUnpackTransformer(sourceTableSpec, recordMatching.sourceColumnId),
      );
      if (sourceMatchKey === null) {
        recordMatchingWarning = describeUnusableMatchValue(
          readFieldValueAtPath(record.fields, recordMatching.sourceColumnId),
          recordMatching.sourceColumnId,
        );
      }
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
 * @param idPath - The column ID to use as the record ID (from schema.idPath)
 * @returns A SyncRecord with the ID extracted from the specified column
 */
function parseFileToRecord(file: SyncRecordFile, idPath: DotPath): SyncRecord {
  const fields: Record<string, unknown> = {};

  if (file.content) {
    // A record file that isn't valid JSON is corrupt or truncated — e.g. an
    // interrupted pull (ECONNRESET) left partial content (DEV-9981). Surface a
    // clear, path-annotated error instead of an opaque `Unexpected end of JSON
    // input`, consistent with the missing-id throw below; the sync's top-level
    // handler reports the failure and a re-pull restores the file.
    const parsed = safeJsonParse<object>(file.content);
    if (!parsed.ok) {
      throw new Error(`Record in file ${file.path} is not valid JSON: ${parsed.error.message}`);
    }
    // Add metadata fields from front matter
    Object.assign(fields, parsed.value);
  }

  const recordId = readRecordIdAsString(fields, idPath);
  if (recordId === null) {
    throw new Error(`Record in file ${file.path} is missing or has non-stringable id at path: ${idPath}`);
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
  return formatRecordJson(fields);
}

/**
 * Explains why a source match-field value can't be used for record matching —
 * called only when `deriveCanonicalMatchKey` has already returned null for it.
 * Mirrors the reducer's rejection cases: missing, empty, or a non-primitive shape
 * with no extraction transformer to pull a plain value out of.
 */
function describeUnusableMatchValue(rawValue: unknown, fieldPath: string): string {
  const suffix = 'This record will not be matched during sync.';
  if (rawValue === undefined || rawValue === null) {
    return `Source record is missing the record matching field "${fieldPath}". ${suffix}`;
  }
  if (typeof rawValue === 'string' && rawValue.trim() === '') {
    return `Source record has an empty value for the record matching field "${fieldPath}". ${suffix}`;
  }
  return `Source record's value for the record matching field "${fieldPath}" can't be reduced to a plain text or number for matching. ${suffix}`;
}
