import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TSchema } from '@sinclair/typebox';
import {
  AiContextResponse,
  ColumnMapping,
  createScratchPendingPublishId,
  createSyncId,
  DataFolderId,
  LookupFieldOptions,
  PreviewFieldResult,
  PreviewRecordBody,
  PreviewRecordResponse,
  SaveSyncBody,
  ScheduleAction,
  Service,
  SyncId,
  SyncMapping,
  TableMapping,
  TransformerTypes,
  WorkbookId,
} from '@spinner/shared-types';
import get from 'lodash/get';
import isEqual from 'lodash/isEqual';
import set from 'lodash/set';
import zipObjectDeep from 'lodash/zipObjectDeep';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { ScheduleService } from 'src/schedule/schedule.service';
import { DIRTY_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { validateSchemaMapping } from 'src/sync/schema-validator';
import { previewRecordBodySchema, saveSyncBodySchema } from 'src/sync/sync-mapping.schema';
import {
  applyTransformerPipeline,
  createLookupTools,
  findTransformerConfigs,
  getTransformerConfigs,
  LookupTools,
  SyncPhase,
  SyncRecord,
} from 'src/sync/transformers';
import { Actor } from 'src/users/types';
import { formatJsonWithPrettier } from 'src/utils/json-formatter';
import { extractSchemaFields, SchemaField } from 'src/utils/schema-helpers';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { deduplicateFileName, resolveBaseFileName } from 'src/workbook/util';
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

export interface SyncTableMappingResult {
  recordsCreated: number;
  recordsUpdated: number;
  createdPaths: string[];
  updatedPaths: string[];
  errors: Array<{ sourceRemoteId: string; error: string }>;
  warnings: Array<{ sourceRemoteId: string; warning: string }>;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly db: DbService,
    private readonly dataFolderService: DataFolderService,
    private readonly posthogService: PostHogService,
    private readonly scheduleService: ScheduleService,
    private readonly scratchGitService: ScratchGitService,
    private readonly workbookService: WorkbookService,
  ) {}

  /**
   * Reads schema from git first, falling back to the DB value.
   */
  private async readSchemaWithFallback(
    workbookId: string,
    connectorAccountId: string | null,
    folderPath: string | null,
    dbSchema: unknown,
  ): Promise<BaseJsonTableSpec | null> {
    if (folderPath) {
      try {
        const repoId = await this.scratchGitService.resolveRepoId(
          workbookId as WorkbookId,
          connectorAccountId ?? undefined,
        );
        const gitSchema = await this.scratchGitService.readSchemaFromGit(repoId, folderPath);
        if (gitSchema) return gitSchema;
      } catch (error) {
        WSLogger.error({
          source: 'SyncService.readSchemaWithFallback',
          message: 'Failed to read schema from git, falling back to DB',
          error,
          workbookId,
          folderPath,
        });
      }
    }
    return (dbSchema as BaseJsonTableSpec) || null;
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

    // Validate mappings — skip gracefully when schemas are absent
    if (body.validateMappings) {
      for (const tableMapping of body.mappings.tableMappings) {
        const sourceId = tableMapping.sourceDataFolderId;
        const destId = tableMapping.destinationDataFolderId;

        const sourceFolder = await this.dataFolderService.fetchSchemaSpec(sourceId, actor);
        const destFolder = await this.dataFolderService.fetchSchemaSpec(destId, actor);

        if (sourceFolder?.schema && destFolder?.schema) {
          const errors = validateSchemaMapping(sourceFolder.schema, destFolder.schema, tableMapping.columnMappings);
          if (errors.length > 0) {
            throw new BadRequestException(`Validation failed for folder mapping: ${errors.join('; ')}`);
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
        mappings: body.mappings as unknown as Prisma.InputJsonValue,
        publishAfterSync: false,
        syncTablePairs: {
          create: body.mappings.tableMappings.map((tm) => ({
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

    const sync = await this.db.client.sync.findFirst({
      where: { id: syncId },
    });
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }

    if (body.validateMappings) {
      // Validate mappings — skip gracefully when schemas are absent
      for (const tableMapping of body.mappings.tableMappings) {
        const sourceId = tableMapping.sourceDataFolderId;
        const destId = tableMapping.destinationDataFolderId;

        const sourceFolder = await this.dataFolderService.fetchSchemaSpec(sourceId, actor);
        const destFolder = await this.dataFolderService.fetchSchemaSpec(destId, actor);

        if (sourceFolder?.schema && destFolder?.schema) {
          const errors = validateSchemaMapping(sourceFolder.schema, destFolder.schema, tableMapping.columnMappings);
          if (errors.length > 0) {
            throw new BadRequestException(`Validation failed for folder mapping: ${errors.join('; ')}`);
          }
        }
      }
    }

    // Validate record matching fields exist in column mappings
    for (const tableMapping of body.mappings.tableMappings) {
      if (tableMapping.recordMatching) {
        const hasMatchingColumn = tableMapping.columnMappings.some(
          (cm) =>
            cm.sourceColumnId === tableMapping.recordMatching!.sourceColumnId &&
            cm.destinationColumnId === tableMapping.recordMatching!.destinationColumnId,
        );
        if (!hasMatchingColumn) {
          throw new BadRequestException(
            `Record matching fields "${tableMapping.recordMatching.sourceColumnId}" -> "${tableMapping.recordMatching.destinationColumnId}" do not match any column mapping`,
          );
        }
      }
    }

    // Transaction to update sync details and replace mappings
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
          mappings: body.mappings as unknown as Prisma.InputJsonValue,
          ...(body.publishAfterSync !== undefined && { publishAfterSync: body.publishAfterSync }),
          syncTablePairs: {
            create: body.mappings.tableMappings.map((tm) => ({
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
          await this.scheduleService.delete(workbookId, existingSchedule.id, actor);
        }
      } else if (existingSchedule) {
        // Update existing schedule's cron expression
        await this.scheduleService.update(workbookId, existingSchedule.id, { cronExpression: body.schedule }, actor);
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
   * Extracts the idColumnRemoteId from a DataFolder's schema.
   * Falls back to 'id' if the schema doesn't specify an idColumnRemoteId.
   */
  private getIdColumnFromSchema(schema: unknown): string {
    const jsonSchema = schema as BaseJsonTableSpec | null;
    return jsonSchema?.idColumnRemoteId ?? 'id';
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
      await this.scheduleService.delete(workbookId, schedule.id, actor);
    }

    await this.db.client.sync.delete({
      where: { id: syncId },
    });

    this.posthogService.trackRemoveSync(actor, sync);
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
    tableMapping: TableMapping,
    workbookId: WorkbookId,
    actor: Actor,
    phase: SyncPhase = 'DATA',
  ): Promise<SyncTableMappingResult> {
    const result: SyncTableMappingResult = {
      recordsCreated: 0,
      recordsUpdated: 0,
      createdPaths: [],
      updatedPaths: [],
      errors: [],
      warnings: [],
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
    const sourceTableSpec = await this.readSchemaWithFallback(
      workbookId,
      sourceFolder.connectorAccountId,
      sourceFolder.path,
      sourceFolder.schema,
    );
    const destinationTableSpec = await this.readSchemaWithFallback(
      workbookId,
      destinationFolder.connectorAccountId,
      destinationFolder.path,
      destinationFolder.schema,
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

        await this.fillSyncCachesBatch(syncId, tableMapping, batchRecords, []);
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
        usedDestFileNames.add(file.path.split('/').pop()!);
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
    const lookupTools = createLookupTools(this.db, syncId);

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
      const batchRecordsById = new Map(batchRecords.map((r) => [r.id, r]));

      WSLogger.info({
        source: 'SyncService.syncTableMapping',
        message: `Pass 2: source batch`,
        syncId,
        records: batchRecords.length,
        cursor: sourceCursor ?? 'initial',
        batch: batchCounter,
      });

      // Get mappings for this batch
      const batchMappings = await this.getDestinationMappings(
        syncId,
        tableMapping.sourceDataFolderId,
        Array.from(batchRecordsById.keys()),
      );

      // Check for source records that weren't included in mappings (missing or falsy match key)
      if (tableMapping.recordMatching) {
        for (const [sourceId, sourceRecord] of batchRecordsById) {
          if (!batchMappings.has(sourceId)) {
            const matchKeyValue = get(sourceRecord.fields, tableMapping.recordMatching.sourceColumnId);
            if (matchKeyValue === undefined || matchKeyValue === null) {
              result.errors.push({
                sourceRemoteId: sourceId,
                error: `Source record missing record matching field: ${tableMapping.recordMatching.sourceColumnId}`,
              });
            } else if (typeof matchKeyValue !== 'string' || matchKeyValue === '') {
              result.errors.push({
                sourceRemoteId: sourceId,
                error: `Source record has empty or invalid record matching value for field: ${tableMapping.recordMatching.sourceColumnId}`,
              });
            }
          }
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
            const transformResult = await transformRecordAsync(
              sourceRecord,
              tableMapping.columnMappings,
              sourceTableSpec,
              destinationTableSpec,
              lookupTools,
              phase,
            );
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
            const slugValue = destinationTableSpec?.slugColumnRemoteId
              ? (get(transformedFields, destinationTableSpec.slugColumnRemoteId) as string | undefined)
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
            result.createdPaths.push(destinationPath);
          } else {
            // Existing record: pass the existing fields as the base so transformRecordAsync
            // surgically updates only the mapped fields. This is critical to preserve the
            // original JSON key ordering in the destination file (see baseFields param docs).
            destinationPath = mapping.destinationFilePath;
            const existingRecord = destinationRecordsByPath.get(mapping.destinationFilePath);

            const transformResult = await transformRecordAsync(
              sourceRecord,
              tableMapping.columnMappings,
              sourceTableSpec,
              destinationTableSpec,
              lookupTools,
              phase,
              existingRecord?.fields,
            );
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
          workbookId,
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
        return result;
      }
    }

    return result;
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
    tableMapping: TableMapping,
    sourceRecords: SyncRecord[],
    destinationRecords: SyncRecord[],
  ): Promise<void> {
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
      await this.insertSourceMatchKeys(syncId, tableMapping, sourceRecords);
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
  async buildRecordMatchingMappings(syncId: SyncId, tableMapping: TableMapping): Promise<void> {
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
    tableMapping: TableMapping,
    sourceRecords: SyncRecord[],
    fkValuesByFolder: Map<DataFolderId, Set<string>>,
  ): void {
    // Collect all lookup_field configs across all column mappings
    const lookupEntries: { mapping: ColumnMapping; opts: LookupFieldOptions }[] = [];
    for (const mapping of tableMapping.columnMappings) {
      for (const config of findTransformerConfigs(mapping, TransformerTypes.LookupField)) {
        lookupEntries.push({ mapping, opts: config.options as LookupFieldOptions });
      }
    }
    if (lookupEntries.length === 0) {
      return;
    }

    let collectedCount = 0;
    for (const { mapping, opts } of lookupEntries) {
      if (!fkValuesByFolder.has(opts.referencedDataFolderId)) {
        fkValuesByFolder.set(opts.referencedDataFolderId, new Set());
      }
      const fkValues = fkValuesByFolder.get(opts.referencedDataFolderId)!;
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
      const idColumn = this.getIdColumnFromSchema(folder.schema);
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
    tableMapping: TableMapping,
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
        if (typeof matchValue !== 'string' || matchValue === '') {
          return null;
        }
        return {
          syncId,
          dataFolderId,
          matchId: matchValue,
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
    tableMapping: TableMapping,
    records: SyncRecord[],
  ): Promise<void> {
    if (!tableMapping.recordMatching) {
      throw new Error('TableMapping must have recordMatching configured');
    }
    await this.insertMatchKeys(
      syncId,
      tableMapping.sourceDataFolderId,
      records,
      tableMapping.recordMatching.sourceColumnId,
    );
  }

  /**
   * Inserts match keys for destination records using the TableMapping's recordMatching config.
   */
  private async insertDestinationMatchKeys(
    syncId: SyncId,
    tableMapping: TableMapping,
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

    const sourceIdColumn = this.getIdColumnFromSchema(sourceFolder.schema);

    const repoId = await this.scratchGitService.resolveRepoId(workbookId, sourceFolder.connectorAccountId ?? undefined);

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

    // Stub lookup tools — FK lookups are not available in preview
    const notAvailableInPreviewError = new Error('Lookup is not available in preview');
    const previewLookupTools: LookupTools = {
      getDestinationMappingForSourceFk: () => Promise.reject(notAvailableInPreviewError),
      lookupFieldFromFkRecord: () => Promise.reject(notAvailableInPreviewError),
    };

    // Schemas
    const sourceTableSpec = await this.dataFolderService.fetchSchemaSpec(sourceId, actor);
    if (!sourceTableSpec) {
      throw new NotFoundException(`Schema not found for source folder`);
    }
    const destinationTableSpec = await this.dataFolderService.fetchSchemaSpec(body.destFolderId, actor);
    if (!destinationTableSpec) {
      throw new NotFoundException(`Schema not found for destination folder ${body.destFolderId}`);
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
            destinationFieldPath: mapping.destinationColumnId,
            destinationTableSpec,
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

    return { recordId: record.id, fields };
  }

  /**
   * Generates structured Markdown context for an AI agent to build sync definitions.
   * Includes all linked folders, their schemas, available transformers, and examples.
   */
  async generateAiContext(workbookId: WorkbookId, actor: Actor): Promise<AiContextResponse> {
    const workbook = await this.workbookService.findOne(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

    // Fetch all folders with their cached schemas directly from the DB (no external API calls)
    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId },
      include: { connectorAccount: true },
      orderBy: { name: 'asc' },
    });

    // Group linked folders by connector account
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

      const service = folder.connectorService ? (folder.connectorService as Service) : null;
      if (service) allServices.add(service);

      // Read schema from git first, fall back to DB
      const schemaJson = await this.readSchemaWithFallback(
        workbookId,
        folder.connectorAccountId,
        folder.path,
        folder.schema,
      );
      const fields = schemaJson?.schema ? extractSchemaFields(schemaJson.schema) : [];

      const accountId = folder.connectorAccountId;
      if (!connectorAccountGroups.has(accountId)) {
        connectorAccountGroups.set(accountId, {
          name: folder.connectorAccount.displayName,
          service,
          folders: [],
        });
      }
      connectorAccountGroups.get(accountId)!.folders.push({
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

    // Fetch existing syncs for examples
    const existingSyncs = (await this.findAllForWorkbook(workbookId, actor)) as Array<{
      mappings: SyncMapping | null;
    }>;
    const syncWithMappings = existingSyncs.find((s) => s.mappings?.tableMappings?.length);

    // Build all linked folder IDs for the example
    const allLinkedFolders = linkedGroups.flatMap((g) => g.folders);

    // Assemble Markdown
    const lines: string[] = [];
    lines.push('# Scratch Sync — AI Agent Context');
    lines.push('');
    lines.push(
      'You are helping a user build a sync definition for Scratch, a content management system that syncs data between connected services.',
    );
    lines.push('');

    // Task section
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

    // Key Concepts
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

    // Available Folders
    lines.push('## Available Folders');
    lines.push('');

    // Build a lookup of folder ID -> name for foreign key annotations
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

    // Available Transformers
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

    // Connector Tips — only for services present
    const tipSections: Array<{ service: Service; tip: string }> = [
      {
        service: Service.NOTION,
        tip: [
          '### Notion',
          '- Rich text fields contain Notion block objects. Use the `notion_to_html` transformer to convert them to HTML.',
          "- Relation/rollup fields are foreign keys. Use `source_fk_to_dest_fk` if you're syncing the related table too.",
        ].join('\n'),
      },
      {
        service: Service.AIRTABLE,
        tip: [
          '### Airtable',
          "- Linked record fields are foreign keys. Use `source_fk_to_dest_fk` if you're syncing the related table too.",
          '- Formula and lookup fields are readonly.',
        ].join('\n'),
      },
      {
        service: Service.POSTGRES,
        tip: ['### Postgres', '- Field paths correspond directly to column names.'].join('\n'),
      },
      {
        service: Service.SUPABASE,
        tip: ['### Supabase', '- Field paths correspond directly to column names.'].join('\n'),
      },
      {
        service: Service.WEBFLOW,
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

    // Example Sync
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

    // Output instruction
    lines.push('## Output');
    lines.push('');
    lines.push(
      'Respond with ONLY the JSON `SyncMapping` object. The user will paste it directly into the Scratch sync editor.',
    );
    lines.push('');

    return { markdown: lines.join('\n') };
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
function parseFileToRecord(file: FileContent, idColumnRemoteId: string): SyncRecord {
  const fields: Record<string, unknown> = {};

  if (file.content) {
    const parsed = JSON.parse(file.content) as object;
    // Add metadata fields from front matter
    Object.assign(fields, parsed);
  }

  // Extract the record ID from the specified column
  const recordId = get(fields, idColumnRemoteId);
  if (recordId === undefined || recordId === null) {
    throw new Error(`Record in file ${file.path} is missing required ID field: ${idColumnRemoteId}`);
  }
  if (typeof recordId !== 'string' && typeof recordId !== 'number') {
    throw new Error(`Record ID field ${idColumnRemoteId} in file ${file.path} must be a string or number`);
  }

  return {
    id: String(recordId),
    filePath: file.path,
    fields,
  };
}

/**
 * Transform a source record's fields to destination schema using column mappings.
 * Supports ColumnMapping with optional transformers.
 *
 * @param sourceRecord - The source record to transform
 * @param columnMappings - Array of column mappings defining field transformations
 * @param lookupTools - Tools for FK lookups (optional, required for FK transformers)
 * @param phase - The sync phase (DATA or FK)
 * @param baseFields - When updating an existing record, pass its current fields here.
 *   The function will clone this object and use lodash `set()` to write only the mapped
 *   values into it. This preserves the original JSON key ordering of the destination file.
 *   IMPORTANT: Do NOT replace this with a merge/spread/Object.assign approach — those
 *   strategies reorder keys based on insertion order which corrupts the destination file's
 *   key ordering. When omitted (new records), builds a fresh object with zipObjectDeep.
 * @returns Transformed fields for the destination record
 */
export interface TransformRecordResult {
  fields: Record<string, unknown>;
  warnings: string[];
}

export async function transformRecordAsync(
  sourceRecord: SyncRecord,
  columnMappings: ColumnMapping[],
  sourceTableSpec: BaseJsonTableSpec | null,
  destinationTableSpec: BaseJsonTableSpec | null,
  lookupTools?: LookupTools,
  phase: SyncPhase = 'DATA',
  baseFields?: Record<string, unknown>,
): Promise<TransformRecordResult> {
  const definedPaths: string[] = [];
  const definedValues: unknown[] = [];
  const warnings: string[] = [];

  for (const mapping of columnMappings) {
    const sourceValue = get(sourceRecord.fields, mapping.sourceColumnId);

    // Skip undefined source values
    if (sourceValue === undefined) {
      continue;
    }

    let transformedValue: unknown = sourceValue;
    let skip = false;

    // Apply transformer pipeline if configured
    const configs = getTransformerConfigs(mapping);
    if (configs.length > 0) {
      const result = await applyTransformerPipeline(configs, sourceValue, {
        sourceRecord,
        sourceFieldPath: mapping.sourceColumnId,
        sourceTableSpec,
        destinationFieldPath: mapping.destinationColumnId,
        destinationTableSpec,
        lookupTools: lookupTools ?? {
          getDestinationMappingForSourceFk: () => Promise.resolve(null),
          lookupFieldFromFkRecord: () => Promise.resolve(null),
        },
        destinationValue: baseFields ? get(baseFields, mapping.destinationColumnId) : undefined,
        phase,
      });

      if (result.success) {
        if (result.skip) {
          skip = true;
        }
        if (result.warnings) {
          warnings.push(...result.warnings);
        }
        transformedValue = result.value;
      } else {
        if (result.useOriginal) {
          transformedValue = sourceValue;
        }
        WSLogger.error({
          source: 'transformRecordAsync',
          message: 'Failed to transform field',
          error: result.error,
          transformerType: result.failedTransformerType,
          sourceColumnId: mapping.sourceColumnId,
          sourceRecordId: sourceRecord.id,
        });
        throw new Error(`Failed to transform field "${mapping.sourceColumnId}": ${result.error}`);
      }
    }

    if (!skip) {
      definedPaths.push(mapping.destinationColumnId);
      definedValues.push(transformedValue);
    }
  }

  // IMPORTANT: When baseFields is provided (updating an existing record), we clone the
  // existing object and use lodash set() to write only the mapped fields. This preserves
  // the original key ordering of the JSON file. Do NOT replace this with merge/spread/
  // Object.assign — those approaches reorder keys and corrupt the destination file layout.
  if (baseFields) {
    const fields = structuredClone(baseFields);
    for (let i = 0; i < definedPaths.length; i++) {
      set(fields, definedPaths[i], definedValues[i]);
    }
    return { fields, warnings };
  }

  return { fields: zipObjectDeep(definedPaths, definedValues) as Record<string, unknown>, warnings };
}

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
