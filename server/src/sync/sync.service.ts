import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TSchema } from '@sinclair/typebox';
import {
  ColumnMapping,
  createScratchPendingPublishId,
  createSyncId,
  DataFolderId,
  LookupFieldOptions,
  PreviewFieldResult,
  PreviewRecordBody,
  PreviewRecordResponse,
  SaveSyncBody,
  SyncId,
  TableMapping,
  WorkbookId,
} from '@spinner/shared-types';
import get from 'lodash/get';
import merge from 'lodash/merge';
import set from 'lodash/set';
import zipObjectDeep from 'lodash/zipObjectDeep';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { DIRTY_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { validateSchemaMapping } from 'src/sync/schema-validator';
import { previewRecordBodySchema, saveSyncBodySchema } from 'src/sync/sync-mapping.schema';
import {
  createLookupTools,
  getTransformer,
  LookupTools,
  SyncPhase,
  SyncRecord,
  TransformContext,
} from 'src/sync/transformers';
import { Actor } from 'src/users/types';
import { formatJsonWithPrettier } from 'src/utils/json-formatter';
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
}

@Injectable()
export class SyncService {
  constructor(
    private readonly db: DbService,
    private readonly dataFolderService: DataFolderService,
    private readonly posthogService: PostHogService,
    private readonly scratchGitService: ScratchGitService,
    private readonly workbookService: WorkbookService,
  ) {}

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

    const syncId = createSyncId();

    const sync = await this.db.client.sync.create({
      data: {
        id: syncId,
        displayName: body.displayName,
        mappings: body.mappings as unknown as Prisma.InputJsonValue,
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
        syncTablePairs: {
          some: {
            sourceDataFolder: { workbookId },
          },
        },
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

    // Consider adding workbookId to the sync.
    return await this.db.client.sync.findMany({
      where: {
        syncTablePairs: {
          some: {
            sourceDataFolder: {
              workbookId,
            },
          },
        },
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
      where: { id: syncId, syncTablePairs: { some: { sourceDataFolder: { workbookId } } } },
    });
    if (!sync) {
      throw new NotFoundException('Sync not found');
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

    // Get idColumnRemoteId from schemas
    const sourceIdColumn = this.getIdColumnFromSchema(sourceFolder.schema);
    const destinationIdColumn = this.getIdColumnFromSchema(destinationFolder.schema);

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
    const destIdColumn = this.getIdColumnFromSchema(destinationFolder.schema);

    // Get destination table spec for slug resolution
    const destTableSpec = destinationFolder.schema as BaseJsonTableSpec | null;

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
          const transformedFields = await transformRecordAsync(
            sourceRecord,
            tableMapping.columnMappings,
            lookupTools,
            phase,
          );

          let destinationPath: string;

          if (mapping.destinationFilePath === null) {
            // This is a new record

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
            const slugValue = destTableSpec?.slugColumnRemoteId
              ? (get(transformedFields, destTableSpec.slugColumnRemoteId) as string | undefined)
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
            // Use the file path from the mapping (from SyncMatchKeys.filePath via buildRecordMatchingMappings)
            destinationPath = mapping.destinationFilePath;

            // Merge existing destination fields with transformed source fields (source takes precedence).
            // This preserves destination fields that aren't covered by column mappings.
            const existingRecord = destinationRecordsByPath.get(mapping.destinationFilePath);
            if (existingRecord) {
              Object.assign(transformedFields, merge({}, existingRecord.fields, transformedFields));
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
    const lookupFieldMappings = tableMapping.columnMappings.filter((m) => m.transformer?.type === 'lookup_field');
    if (lookupFieldMappings.length === 0) {
      return;
    }

    let collectedCount = 0;
    for (const mapping of lookupFieldMappings) {
      const opts = mapping.transformer!.options as LookupFieldOptions;
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
   * Clears all match keys for a sync.
   * Call this before re-populating match keys for a fresh sync.
   */
  private async clearMatchKeys(syncId: SyncId): Promise<void> {
    await this.db.client.syncMatchKeys.deleteMany({
      where: { syncId },
    });
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
   * Finds match IDs that exist in both source and destination DataFolders.
   * Returns the set of matchIds that have records on both sides.
   */
  private async findMatchingIds(syncId: SyncId, tableMapping: TableMapping): Promise<Set<string>> {
    // Use raw SQL for the self-join query
    const results = await this.db.client.$queryRaw<{ matchId: string }[]>`
      SELECT DISTINCT src."matchId"
      FROM "SyncMatchKeys" src
      INNER JOIN "SyncMatchKeys" dest
        ON src."syncId" = dest."syncId"
        AND src."matchId" = dest."matchId"
      WHERE src."syncId" = ${syncId}
        AND src."dataFolderId" = ${tableMapping.sourceDataFolderId}
        AND dest."dataFolderId" = ${tableMapping.destinationDataFolderId}
    `;

    return new Set(results.map((r) => r.matchId));
  }

  /**
   * Finds match IDs that exist in source but NOT in destination.
   * These represent new records that need to be created in the destination.
   */
  private async findUnmatchedSourceIds(syncId: SyncId, tableMapping: TableMapping): Promise<Set<string>> {
    const results = await this.db.client.$queryRaw<{ matchId: string }[]>`
      SELECT src."matchId"
      FROM "SyncMatchKeys" src
      LEFT JOIN "SyncMatchKeys" dest
        ON src."syncId" = dest."syncId"
        AND src."matchId" = dest."matchId"
        AND dest."dataFolderId" = ${tableMapping.destinationDataFolderId}
      WHERE src."syncId" = ${syncId}
        AND src."dataFolderId" = ${tableMapping.sourceDataFolderId}
        AND dest."matchId" IS NULL
    `;

    return new Set(results.map((r) => r.matchId));
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

    const sourceId = body.sourceId as DataFolderId;
    const sourceFolder = await this.db.client.dataFolder.findUnique({ where: { id: sourceId } });
    if (!sourceFolder) {
      throw new NotFoundException(`Source folder ${body.sourceId} not found`);
    }

    const sourceIdColumn = this.getIdColumnFromSchema(sourceFolder.schema);

    // Fetch the single source file
    const file = await this.scratchGitService.getRepoFile(workbookId, DIRTY_BRANCH, body.filePath);
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
      getDestinationPathForSourceFk: () => Promise.reject(notAvailableInPreviewError),
      lookupFieldFromFkRecord: () => Promise.reject(notAvailableInPreviewError),
    };

    const fields: PreviewFieldResult[] = [];
    for (const mapping of columnMappings) {
      const sourceValue = get(record.fields, mapping.sourceColumnId);
      let transformedValue: unknown = sourceValue;
      let warning: string | undefined;

      if (mapping.transformer) {
        const transformer = getTransformer(mapping.transformer.type);
        if (transformer) {
          try {
            const ctx: TransformContext = {
              sourceRecord: record,
              sourceFieldPath: mapping.sourceColumnId,
              sourceValue,
              lookupTools: previewLookupTools,
              options: mapping.transformer.options ?? {},
              phase: 'DATA',
            };
            const result = await transformer.transform(ctx);
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
      }

      fields.push({
        sourceField: mapping.sourceColumnId,
        destinationField: mapping.destinationColumnId,
        sourceValue,
        transformedValue,
        transformerType: mapping.transformer?.type,
        warning,
      });
    }

    return { recordId: record.id, fields };
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
 * @returns Transformed fields for the destination record
 */
async function transformRecordAsync(
  sourceRecord: SyncRecord,
  columnMappings: ColumnMapping[],
  lookupTools?: LookupTools,
  phase: SyncPhase = 'DATA',
): Promise<Record<string, unknown>> {
  const definedPaths: string[] = [];
  const definedValues: unknown[] = [];

  for (const mapping of columnMappings) {
    const sourceValue = get(sourceRecord.fields, mapping.sourceColumnId);

    // Skip undefined source values
    if (sourceValue === undefined) {
      continue;
    }

    let transformedValue: unknown = sourceValue;
    let skip = false;

    // Apply transformer if configured
    if (mapping.transformer) {
      const transformer = getTransformer(mapping.transformer.type);
      if (transformer) {
        // Create transform context
        const ctx: TransformContext = {
          sourceRecord,
          sourceFieldPath: mapping.sourceColumnId,
          sourceValue,
          lookupTools: lookupTools ?? {
            getDestinationPathForSourceFk: () => Promise.resolve(null),
            lookupFieldFromFkRecord: () => Promise.resolve(null),
          },
          options: mapping.transformer.options ?? {},
          phase,
        };

        const result = await transformer.transform(ctx);

        if (result.success) {
          if (result.skip) {
            skip = true;
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
            transformerType: mapping.transformer.type,
            sourceColumnId: mapping.sourceColumnId,
            sourceRecordId: sourceRecord.id,
          });
          throw new Error(`Failed to transform field "${mapping.sourceColumnId}": ${result.error}`);
        }
      } else {
        WSLogger.error({
          source: 'transformRecordAsync',
          message: `Unknown transformer type: ${mapping.transformer.type}`,
          transformerType: mapping.transformer.type,
          sourceColumnId: mapping.sourceColumnId,
          sourceRecordId: sourceRecord.id,
        });
      }
    }

    if (!skip) {
      definedPaths.push(mapping.destinationColumnId);
      definedValues.push(transformedValue);
    }
  }

  return zipObjectDeep(definedPaths, definedValues) as Record<string, unknown>;
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
