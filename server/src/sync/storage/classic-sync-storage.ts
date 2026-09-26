import { Prisma } from '@prisma/client';
import {
  createAssetId,
  createPlainId,
  createScratchPendingPublishId,
  DataFolderId,
  Service,
  SyncId,
  WorkbookId,
} from '@spinner/shared-types';
import chunk from 'lodash/chunk';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { DIRTY_BRANCH, type RepoId, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { AssetMappingResult } from 'src/sync/transformers/transformer.types';
import type { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { GitTableSpecStore } from 'src/workbook/table-spec-store/git-table-spec-store';
import type {
  AssetContentHashIndexForFolderPair,
  DestinationFolderPageReadLogContext,
  DestinationMappingForSourceRecord,
  ForeignKeyRecordCacheEntry,
  NewlyCreatedDestinationRecord,
  ReferencedFolderRemoteIdMappingRows,
  RemoteIdMappingPair,
  SyncDestinationFolderLocation,
  SyncDestinationOutputSink,
  SyncLookupDataProvider,
  SyncMatchIndex,
  SyncMatchKeyEntry,
  SyncRecordFile,
  SyncRecordSource,
  SyncStoragePorts,
} from './sync-storage-ports';

/**
 * The classic sync storage: record files on the scratch-git `dirty` branch, the match index in
 * `SyncMatchKeys` / `SyncRemoteIdMapping`, lookups in `SyncForeignKeyRecord` / `Asset`, and each
 * table's output landed on `dirty` as one commit. Every method is code moved verbatim out of
 * `SyncService` / `createLookupTools`; see `sync-storage-ports.ts` for why the ports exist.
 */

/**
 * Rows per statement when writing `SyncRemoteIdMapping`. One source page, so a
 * table's mapping writes cost the same whether it holds a thousand records or a
 * hundred thousand. Well under the 32,767 bind-parameter ceiling at three
 * parameters per row.
 */
const REMOTE_ID_MAPPING_WRITE_CHUNK_SIZE = 1000;

/**
 * How many queued output files trigger a spill to scratch-git staging: one source page
 * (PAGINATED_FILE_BATCH_SIZE).
 */
const STAGED_WRITE_FLUSH_THRESHOLD = 1000;

/**
 * Resolves each connection's repo once per sync run, so the output sink (which resolves it up
 * front, failing the table early when the connection has no repo) and the destination reads
 * share one lookup.
 */
function createMemoizedConnectionRepoPathResolver(
  scratchGitService: ScratchGitService,
): (connectorAccountId: string | null) => Promise<RepoId> {
  const repoPathPromiseByConnectorAccountId = new Map<string | null, Promise<RepoId>>();
  return (connectorAccountId) => {
    let repoPathPromise = repoPathPromiseByConnectorAccountId.get(connectorAccountId);
    if (!repoPathPromise) {
      repoPathPromise = scratchGitService.resolveConnectionRepoPath(connectorAccountId);
      repoPathPromiseByConnectorAccountId.set(connectorAccountId, repoPathPromise);
      // A failed resolution is not cached: the next caller gets its own attempt and error.
      repoPathPromise.catch(() => repoPathPromiseByConnectorAccountId.delete(connectorAccountId));
    }
    return repoPathPromise;
  };
}

export function createClassicSyncStoragePorts(dependencies: {
  db: DbService;
  dataFolderService: DataFolderService;
  scratchGitService: ScratchGitService;
  syncId: SyncId;
  workbookId: WorkbookId;
  actor: Actor;
}): SyncStoragePorts {
  const { db, dataFolderService, scratchGitService, syncId, workbookId, actor } = dependencies;
  const resolveConnectionRepoPath = createMemoizedConnectionRepoPathResolver(scratchGitService);
  return {
    recordSource: new ClassicGitDirtyBranchRecordSource(
      dataFolderService,
      scratchGitService,
      workbookId,
      actor,
      resolveConnectionRepoPath,
    ),
    tableSpecStore: new GitTableSpecStore(scratchGitService),
    matchIndex: new ClassicPostgresSyncMatchIndex(db, syncId),
    lookupDataProvider: new ClassicPostgresSyncLookupDataProvider(db, syncId, workbookId),
    openDestinationOutputSink: async (destinationFolder) => {
      const destinationRepoId = await resolveConnectionRepoPath(destinationFolder.connectorAccountId);
      return new ClassicStagedGitCommitOutputSink(scratchGitService, syncId, destinationFolder, destinationRepoId);
    },
  };
}

// =====================================================================================================
// Record source: the scratch-git dirty branch
// =====================================================================================================

export class ClassicGitDirtyBranchRecordSource implements SyncRecordSource {
  constructor(
    private readonly dataFolderService: DataFolderService,
    private readonly scratchGitService: ScratchGitService,
    private readonly workbookId: WorkbookId,
    private readonly actor: Actor,
    private readonly resolveConnectionRepoPath: (connectorAccountId: string | null) => Promise<RepoId>,
  ) {}

  async *pageThroughSourceFolderRecordFiles(sourceDataFolderId: DataFolderId): AsyncGenerator<SyncRecordFile[]> {
    let sourcePageCursor: string | undefined;
    do {
      const page = await this.dataFolderService.getFileContentsByFolderIdPaginated(
        this.workbookId,
        sourceDataFolderId,
        this.actor,
        DIRTY_BRANCH,
        sourcePageCursor,
      );
      yield page.files;
      sourcePageCursor = page.nextCursor;
    } while (sourcePageCursor);
  }

  /**
   * Pages through every file in a destination folder on the dirty branch, yielding
   * one page at a time so no caller has to hold the whole folder in memory.
   *
   * Both Pass 1 (match keys + filename dedupe set) and Pass 3 (unmatched-destination
   * classification) stream the folder independently through this generator rather
   * than sharing one whole-folder map of parsed records — that map was ~700 MB on a
   * 42k-record destination and OOM-killed the sync worker (DEV-11194).
   *
   * Re-reading is safe because nothing a sync run writes reaches the dirty branch
   * until the single atomic commit in step 8: Pass 2's output buffers to the git
   * service's staging area and Pass 3's deletions are applied afterwards. Every
   * pass therefore sees the same pre-sync destination bytes.
   */
  async *pageThroughDestinationFolderRecordFiles(
    destinationDataFolderId: DataFolderId,
    logContext: DestinationFolderPageReadLogContext,
  ): AsyncGenerator<SyncRecordFile[]> {
    let destinationPageCursor: string | undefined;
    let destinationPageCounter = 0;

    do {
      let page: { files: SyncRecordFile[]; nextCursor?: string };
      try {
        page = await this.dataFolderService.getFileContentsByFolderIdPaginated(
          this.workbookId,
          destinationDataFolderId,
          this.actor,
          DIRTY_BRANCH,
          destinationPageCursor,
        );
      } catch (error) {
        // An empty (or not-yet-populated) destination folder has zero files, so git
        // tracks no directory for it and a path-scoped read returns 404. Treat that as
        // "no existing destination records" rather than failing the whole sync — e.g.
        // syncing into a brand-new or empty Webflow collection. Every source record
        // then falls into the unmatched-source (create) path, and Pass 3 sees no
        // unmatched-destination records. A 404 after pagination has already advanced
        // (cursor set) is a genuine anomaly and is rethrown.
        if (error instanceof ScratchGitNotFoundError && destinationPageCursor === undefined) {
          WSLogger.info({
            source: 'SyncService.syncTableMapping',
            message: 'Destination folder not found in git; treating as empty (0 existing records)',
            syncId: logContext.syncId,
            destinationDataFolderId,
            destinationFolderPath: logContext.destinationFolderPath,
            pass: logContext.passLabel,
          });
          return;
        }
        throw error;
      }

      WSLogger.info({
        source: 'SyncService.syncTableMapping',
        message: `${logContext.passLabel}: destination batch`,
        syncId: logContext.syncId,
        records: page.files.length,
        cursor: destinationPageCursor ?? 'initial',
        batch: destinationPageCounter,
      });

      yield page.files;

      destinationPageCursor = page.nextCursor;
      destinationPageCounter++;
    } while (destinationPageCursor);
  }

  /**
   * `readRepoFilesByFolder` groups the paths by folder, so a page of paths costs one
   * optimized tree walk.
   */
  async readDestinationRecordFilesByPath(
    destinationFolder: SyncDestinationFolderLocation,
    destinationRecordFilePaths: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    const destinationRepoId = await this.resolveConnectionRepoPath(destinationFolder.connectorAccountId);
    return this.scratchGitService.readRepoFilesByFolder(destinationRepoId, DIRTY_BRANCH, destinationRecordFilePaths);
  }
}

// =====================================================================================================
// Match index: SyncMatchKeys + SyncRemoteIdMapping
// =====================================================================================================

export class ClassicPostgresSyncMatchIndex implements SyncMatchIndex {
  constructor(
    private readonly db: DbService,
    private readonly syncId: SyncId,
  ) {}

  /**
   * Clears match keys for a specific sync and DataFolder combination.
   */
  async clearMatchKeysForDataFolder(dataFolderId: DataFolderId): Promise<void> {
    await this.db.client.syncMatchKeys.deleteMany({
      where: { syncId: this.syncId, dataFolderId },
    });
  }

  /**
   * Clears remote ID mappings for a specific sync and DataFolder combination.
   */
  async clearRemoteIdMappingsForSourceDataFolder(sourceDataFolderId: DataFolderId): Promise<void> {
    await this.db.client.syncRemoteIdMapping.deleteMany({
      where: { syncId: this.syncId, dataFolderId: sourceDataFolderId },
    });
  }

  async addMatchKeysForDataFolder(dataFolderId: DataFolderId, matchKeyEntries: SyncMatchKeyEntry[]): Promise<void> {
    if (matchKeyEntries.length === 0) {
      return;
    }

    // Use createMany with skipDuplicates to handle duplicates gracefully
    await this.db.client.syncMatchKeys.createMany({
      data: matchKeyEntries.map((entry) => ({
        syncId: this.syncId,
        dataFolderId,
        matchId: entry.matchId,
        remoteId: entry.remoteId,
        filePath: entry.filePath,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * Upserts remote ID mappings for synced records.
   * Maps source remote IDs to their corresponding destination remote IDs.
   */
  async upsertRemoteIdMappingsForSourceDataFolder(
    sourceDataFolderId: DataFolderId,
    remoteIdMappingPairs: RemoteIdMappingPair[],
  ): Promise<void> {
    if (remoteIdMappingPairs.length === 0) {
      return;
    }

    // Chunked so the operation list stays bounded no matter how many mappings a
    // caller passes — matching how the asset and file indexes write their upserts.
    for (const chunkOfMappings of chunk(remoteIdMappingPairs, REMOTE_ID_MAPPING_WRITE_CHUNK_SIZE)) {
      await this.db.client.$transaction(
        chunkOfMappings.map((mapping) =>
          this.db.client.syncRemoteIdMapping.upsert({
            where: {
              syncId_dataFolderId_sourceRemoteId: {
                syncId: this.syncId,
                dataFolderId: sourceDataFolderId,
                sourceRemoteId: mapping.sourceRemoteId,
              },
            },
            create: {
              syncId: this.syncId,
              dataFolderId: sourceDataFolderId,
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
  }

  /**
   * Both sides of this already live in Postgres, so the join result never travels
   * through the worker: one statement reads `SyncMatchKeys` and writes
   * `SyncRemoteIdMapping`, and only the summary counts come back. Selecting every
   * row and replaying it as one Prisma operation per record is what OOM-killed the
   * sync worker on large tables — a 42k-record table built 42k upsert operations in
   * a single `$transaction` and died before sending any of them (DEV-11192).
   *
   * `id` and `updatedAt` are set explicitly because raw SQL bypasses Prisma's
   * client-side `cuid()` / `@updatedAt` defaults (the same reason `run-count`'s raw
   * upsert sets them); `createdAt` has a database default and is left alone.
   *
   * The left join can't fan a source row out: `SyncMatchKeys` is unique on
   * `(syncId, dataFolderId, matchId)`, so it adds at most one destination row to each.
   *
   * The driving side is a different story. That uniqueness covers `matchId`, not
   * `remoteId`, and `insertMatchKeys` writes one row per record with `skipDuplicates`
   * — so two source records sharing a `remoteId` but reducing to different match keys
   * (a record file duplicated on disk with the match-key field edited and the id left
   * alone) both survive, and produce two `joined` rows with the same `sourceRemoteId`.
   * That is the `ON CONFLICT` target, and Postgres aborts the whole statement with
   * "ON CONFLICT DO UPDATE command cannot affect row a second time" rather than
   * writing anything. `DISTINCT ON` collapses them to one, which is what the previous
   * per-record upsert loop did by overwriting; the `ORDER BY` makes the survivor
   * deterministic and prefers a row that actually matched a destination, where the
   * loop kept whichever happened to be written last. Reported counts are unaffected
   * — they come from `joined`, not from the rows inserted.
   */
  async joinMatchKeysIntoRemoteIdMappings(folders: {
    sourceDataFolderId: DataFolderId;
    destinationDataFolderId: DataFolderId;
  }): Promise<{ totalSourceRecords: number; matchedRecords: number }> {
    const syncId = this.syncId;
    // Create remote ID mappings for both matched and unmatched source records
    const [counts] = await this.db.client.$queryRaw<{ total: bigint; matched: bigint }[]>`
      WITH joined AS (
        SELECT src."remoteId" as "sourceRemoteId",
               dest."remoteId" as "destinationRemoteId",
               dest."filePath" as "destinationFilePath"
        FROM "SyncMatchKeys" src
        LEFT JOIN "SyncMatchKeys" dest
          ON src."syncId" = dest."syncId"
          AND src."matchId" = dest."matchId"
          AND dest."dataFolderId" = ${folders.destinationDataFolderId}
        WHERE src."syncId" = ${syncId}
          AND src."dataFolderId" = ${folders.sourceDataFolderId}
      ), upserted AS (
        INSERT INTO "SyncRemoteIdMapping" (
          "id", "updatedAt", "syncId", "dataFolderId",
          "sourceRemoteId", "destinationRemoteId", "destinationFilePath"
        )
        SELECT DISTINCT ON ("sourceRemoteId")
               gen_random_uuid()::text, NOW(), ${syncId}, ${folders.sourceDataFolderId},
               "sourceRemoteId", "destinationRemoteId", "destinationFilePath"
        FROM joined
        ORDER BY "sourceRemoteId", "destinationRemoteId" NULLS LAST, "destinationFilePath" NULLS LAST
        ON CONFLICT ("syncId", "dataFolderId", "sourceRemoteId")
        DO UPDATE SET "destinationRemoteId" = EXCLUDED."destinationRemoteId",
                      "destinationFilePath" = EXCLUDED."destinationFilePath",
                      "updatedAt" = NOW()
        RETURNING 1
      )
      SELECT (SELECT COUNT(*) FROM joined) AS "total",
             (SELECT COUNT(*) FROM joined WHERE "destinationRemoteId" IS NOT NULL) AS "matched"
    `;

    return { totalSourceRecords: Number(counts?.total ?? 0), matchedRecords: Number(counts?.matched ?? 0) };
  }

  /**
   * Bulk lookup of destination mappings for multiple source remote IDs.
   */
  async getDestinationMappingsForSourceRemoteIds(
    sourceDataFolderId: DataFolderId,
    sourceRemoteIds: string[],
  ): Promise<Map<string, DestinationMappingForSourceRecord>> {
    if (sourceRemoteIds.length === 0) {
      return new Map();
    }

    // Custom plan: a cached generic plan walks every mapping row of the sync through the
    // single-column syncId/dataFolderId indexes instead of probing the unique key — ~12 s per
    // 1000-id page on a 110k-row folder versus ~20 ms (see DbService helper).
    const mappings = await this.db.runQueryWithCustomPlanForBoundParameterValues(
      this.db.client.syncRemoteIdMapping.findMany({
        where: {
          syncId: this.syncId,
          dataFolderId: sourceDataFolderId,
          sourceRemoteId: { in: sourceRemoteIds },
        },
        select: { sourceRemoteId: true, destinationRemoteId: true, destinationFilePath: true },
      }),
    );

    return new Map(
      mappings.map((m) => [
        m.sourceRemoteId,
        { destinationRemoteId: m.destinationRemoteId, destinationFilePath: m.destinationFilePath },
      ]),
    );
  }

  /**
   * Updates SyncRemoteIdMapping entries for newly created records with their destination file paths
   * and record IDs. During Phase 1, new records have null destination fields. This backfills them
   * so Phase 2 FK resolution can resolve references to new records.
   *
   * Written as one `UPDATE ... FROM (VALUES ...)` per chunk rather than one statement
   * per record: a sync where every source record is a create (an empty destination,
   * the common first run) queued one operation per record here, the same shape that
   * OOM-killed the worker in `buildRecordMatchingMappings` (DEV-11192).
   */
  async recordDestinationsOfNewlyCreatedRecords(
    sourceDataFolderId: DataFolderId,
    newlyCreatedDestinationRecords: NewlyCreatedDestinationRecord[],
  ): Promise<void> {
    if (newlyCreatedDestinationRecords.length === 0) {
      return;
    }

    for (const chunkOfRecords of chunk(newlyCreatedDestinationRecords, REMOTE_ID_MAPPING_WRITE_CHUNK_SIZE)) {
      const values = Prisma.join(
        chunkOfRecords.map(
          (record) => Prisma.sql`(${record.sourceRemoteId}, ${record.destinationRecordId}, ${record.filePath})`,
        ),
      );
      await this.db.client.$executeRaw`
        UPDATE "SyncRemoteIdMapping" AS m
        SET "destinationRemoteId" = v."destinationRecordId",
            "destinationFilePath" = v."filePath",
            "updatedAt" = NOW()
        FROM (VALUES ${values}) AS v("sourceRemoteId", "destinationRecordId", "filePath")
        WHERE m."syncId" = ${this.syncId}
          AND m."dataFolderId" = ${sourceDataFolderId}
          AND m."sourceRemoteId" = v."sourceRemoteId"
      `;
    }
  }

  /** Uses the unique (syncId, dataFolderId) index on SyncMatchKeys. */
  async loadMatchIdsForDataFolder(dataFolderId: DataFolderId): Promise<Set<string>> {
    const matchKeyRows = await this.db.client.syncMatchKeys.findMany({
      where: { syncId: this.syncId, dataFolderId },
      select: { matchId: true },
    });
    return new Set(matchKeyRows.map((r) => r.matchId));
  }
}

// =====================================================================================================
// Lookup data: SyncRemoteIdMapping, SyncForeignKeyRecord, Asset
// =====================================================================================================

export class ClassicPostgresSyncLookupDataProvider implements SyncLookupDataProvider {
  constructor(
    private readonly db: DbService,
    private readonly syncId: SyncId,
    private readonly workbookId: WorkbookId,
  ) {}

  async loadReferencedFolderRemoteIdMappingRows(
    referencedDataFolderId: DataFolderId,
  ): Promise<ReferencedFolderRemoteIdMappingRows> {
    const referencedTablePair = await this.db.client.syncTablePair.findFirst({
      where: { syncId: this.syncId, sourceDataFolderId: referencedDataFolderId },
      select: {
        destinationDataFolderId: true,
        // The SOURCE folder's name is the referenced TABLE's name — what an unresolved FK calls
        // the table it could not find its target in — and its `connectorService` is the service a
        // missing target would have been deleted FROM, which is not necessarily the service of the
        // pair currently being synced.
        sourceDataFolder: { select: { name: true, connectorService: true } },
        destinationDataFolder: { select: { name: true, connectorAccount: { select: { displayName: true } } } },
      },
    });

    const remoteIdMappingRows = await this.db.client.syncRemoteIdMapping.findMany({
      where: {
        syncId: this.syncId,
        dataFolderId: referencedDataFolderId,
      },
      select: { sourceRemoteId: true, destinationFilePath: true, destinationRemoteId: true },
    });

    return { referencedTablePair, remoteIdMappingRows };
  }

  async clearForeignKeyRecordCache(): Promise<void> {
    await this.db.client.syncForeignKeyRecord.deleteMany({ where: { syncId: this.syncId } });
  }

  async addForeignKeyRecordsToCache(foreignKeyRecordCacheEntries: ForeignKeyRecordCacheEntry[]): Promise<void> {
    await this.db.client.syncForeignKeyRecord.createMany({
      data: foreignKeyRecordCacheEntries.map((entry) => ({
        syncId: this.syncId,
        dataFolderId: entry.dataFolderId,
        foreignKeyValue: entry.foreignKeyValue,
        recordData: entry.recordFields as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  }

  async findCachedForeignKeyRecordFields(
    referencedDataFolderId: DataFolderId,
    foreignKeyValue: string,
  ): Promise<unknown> {
    const cachedRecord = await this.db.client.syncForeignKeyRecord.findFirst({
      where: {
        syncId: this.syncId,
        dataFolderId: referencedDataFolderId,
        foreignKeyValue,
      },
      select: { recordData: true },
    });
    return cachedRecord?.recordData ?? null;
  }

  async getOrCreateDestinationAssetMapping(args: {
    sourceAssetRemoteId: string;
    sourceDataFolderId: DataFolderId;
    sourceService: Service;
    destinationDataFolderId: DataFolderId;
    destinationService: Service;
  }): Promise<AssetMappingResult> {
    const { sourceAssetRemoteId, sourceDataFolderId, sourceService, destinationDataFolderId, destinationService } =
      args;
    const { db, workbookId } = this;

    // 1. Look up the source asset by (workbookId, sourceDataFolderId, sourceService, remoteAssetId).
    //    Scoped by dataFolderId (not just service) to correctly handle multiple connections
    //    of the same service type. sourceService is kept as a secondary safety filter.
    const sourceAsset = await db.client.asset.findFirst({
      where: {
        workbookId,
        dataFolderId: sourceDataFolderId,
        service: sourceService,
        remoteAssetId: sourceAssetRemoteId,
      },
    });

    if (!sourceAsset) {
      throw new Error('ASSET_NOT_FOUND');
    }

    if (!sourceAsset.rehostedUrl) {
      throw new Error('ASSET_NOT_REHOSTED');
    }

    // 2. Upsert destination asset — atomic to avoid race conditions when
    //    concurrent calls process the same source asset.
    //    Uses the @@unique([sourceAssetId, dataFolderId]) constraint on Asset.
    const tempId = createScratchPendingPublishId();

    const destAsset = await db.client.asset.upsert({
      where: {
        sourceAssetId_dataFolderId: {
          sourceAssetId: sourceAsset.id,
          dataFolderId: destinationDataFolderId,
        },
      },
      update: {}, // no-op if already exists
      create: {
        id: createAssetId(),
        workbookId,
        service: destinationService,
        dataFolderId: destinationDataFolderId,
        remoteAssetId: tempId,
        sourceAssetId: sourceAsset.id,
        filename: sourceAsset.filename,
        mimeType: sourceAsset.mimeType,
        size: sourceAsset.size,
        width: sourceAsset.width,
        height: sourceAsset.height,
        altText: sourceAsset.altText,
        mediaType: sourceAsset.mediaType,
        rehostedUrl: sourceAsset.rehostedUrl,
        rehostedAt: sourceAsset.rehostedAt,
      },
      select: { id: true, remoteAssetId: true },
    });

    // If the returned remoteAssetId matches our tempId, the create path was taken;
    // otherwise the existing record was returned (update no-op path).
    const isNew = destAsset.remoteAssetId === tempId;
    return { destinationAssetId: destAsset.id, destinationAssetRemoteId: destAsset.remoteAssetId, isNew };
  }

  async loadAssetContentHashIndexForFolderPair(args: {
    sourceDataFolderId: DataFolderId;
    sourceService: Service;
    destinationDataFolderId: DataFolderId;
    destinationService: Service;
  }): Promise<AssetContentHashIndexForFolderPair> {
    const { sourceDataFolderId, sourceService, destinationDataFolderId, destinationService } = args;
    const { db, workbookId } = this;

    // Load all source assets with hashes in one query
    const sourceAssets = await db.client.asset.findMany({
      where: { workbookId, dataFolderId: sourceDataFolderId, service: sourceService, contentHash: { not: null } },
      select: { remoteAssetId: true, contentHash: true },
    });
    const sourceHashByRemoteId = new Map<string, string>();
    for (const a of sourceAssets) {
      if (a.contentHash) sourceHashByRemoteId.set(a.remoteAssetId, a.contentHash);
    }

    // Load all destination assets with hashes in one query
    const destAssets = await db.client.asset.findMany({
      where: {
        workbookId,
        dataFolderId: destinationDataFolderId,
        service: destinationService,
        contentHash: { not: null },
      },
      select: { remoteAssetId: true, contentHash: true },
    });
    const destRemoteIdsByHash = new Map<string, string[]>();
    for (const a of destAssets) {
      if (a.contentHash) {
        const existing = destRemoteIdsByHash.get(a.contentHash) ?? [];
        existing.push(a.remoteAssetId);
        destRemoteIdsByHash.set(a.contentHash, existing);
      }
    }

    return { sourceHashByRemoteId, destRemoteIdsByHash };
  }
}

// =====================================================================================================
// Output sink: scratch-git staging + one commit on the dirty branch
// =====================================================================================================

/**
 * Output-file writer: bounded memory, one commit.
 *
 * Transformed destination files are NOT accumulated for the whole table —
 * holding every serialized record in memory is what OOM-killed the sync
 * worker on large tables (DEV-11193). Instead, files buffer up to one source
 * page and then spill to the scratch-git staging area (disk on the git
 * service, tracked in its SQLite index); the commit lands everything as exactly
 * ONE commit via the atomic staged-commit endpoint, so the dirty branch
 * never shows a partially-synced table and a mid-run failure leaves nothing
 * behind — the same all-or-nothing contract the old single commitFilesToBranch
 * call provided. A table whose writes fit in one buffer never touches
 * staging and commits directly, keeping small syncs (and syncOneRecord) to a
 * single round-trip.
 *
 * Staged paths are relative to the destination folder (scratch-git prefixes
 * the staging folder name on commit). A destination folder at the repo root
 * (no path prefix) can't express that split, so it stays on the buffered
 * direct-commit path regardless of size — connector folders always have a
 * path, so this is a defensive fallback, not an expected case.
 *
 * The staging key carries a per-run random component ON PURPOSE: concurrent
 * runs of the same sync are not prevented anywhere (a manual trigger during
 * a scheduled run, a double-enqueue), and a key shared across runs would let
 * one run's cleanup delete another run's staged rows — or its atomic commit
 * absorb them — silently landing a partial table as "success". A unique key
 * also guarantees a crashed attempt's leftover rows can never be committed
 * by any later run (only this run ever names this key); the leftover
 * directory itself is disk garbage on the git service until swept, the same
 * trade the pull jobs make with their per-run staging keys.
 */
export class ClassicStagedGitCommitOutputSink implements SyncDestinationOutputSink {
  private readonly stagingJobKey: string;
  private readonly destinationFolderPath: string;
  private bufferedFilesToWrite: Array<{ path: string; content: string }> = [];
  private stagedFileCountBeforeBuffer = 0;
  private stagingActive = false;

  constructor(
    private readonly scratchGitService: ScratchGitService,
    private readonly syncId: string,
    destinationFolder: SyncDestinationFolderLocation,
    private readonly destinationRepoId: RepoId,
  ) {
    this.destinationFolderPath = destinationFolder.folderPathWithoutLeadingSlash;
    this.stagingJobKey = `sync-${syncId}-${destinationFolder.dataFolderId}-${createPlainId()}`;
  }

  get queuedRecordFileWriteCount(): number {
    return this.stagedFileCountBeforeBuffer + this.bufferedFilesToWrite.length;
  }

  queueRecordFileWrite(recordFile: { path: string; content: string }): void {
    this.bufferedFilesToWrite.push(recordFile);
  }

  private async spillBufferedFilesToStaging(): Promise<void> {
    if (this.bufferedFilesToWrite.length === 0) {
      return;
    }
    const destinationFolderPath = this.destinationFolderPath;
    this.stagingActive = true;
    const filesRelativeToDestinationFolder = this.bufferedFilesToWrite.map((file) => {
      if (!file.path.startsWith(`${destinationFolderPath}/`)) {
        throw new Error(`Sync write path "${file.path}" is not under destination folder "${destinationFolderPath}"`);
      }
      return { path: file.path.slice(destinationFolderPath.length + 1), content: file.content };
    });
    await this.scratchGitService.stageFiles(
      this.stagingJobKey,
      destinationFolderPath,
      filesRelativeToDestinationFolder,
    );
    this.stagedFileCountBeforeBuffer += this.bufferedFilesToWrite.length;
    this.bufferedFilesToWrite = [];
  }

  // Called at page boundaries (never inside a per-record try/catch, so a
  // staging failure fails the table sync instead of being misattributed to
  // one record while its file stays buffered).
  async flushQueuedRecordFileWritesAtPageBoundary(): Promise<void> {
    if (this.destinationFolderPath !== '' && this.bufferedFilesToWrite.length >= STAGED_WRITE_FLUSH_THRESHOLD) {
      await this.spillBufferedFilesToStaging();
    }
  }

  /**
   * Land all queued writes on the dirty branch as ONE commit. Small runs
   * (everything still in the buffer) commit directly; larger runs flush the
   * buffer tail to staging and use the atomic staged commit, which folds the
   * staged files into a single commit on the scratch-git side.
   */
  async commitQueuedRecordFileWrites(): Promise<void> {
    const totalFilesToWrite = this.queuedRecordFileWriteCount;
    WSLogger.info({
      source: 'SyncService.syncTableMapping',
      message: `Committing files to git`,
      syncId: this.syncId,
      files: totalFilesToWrite,
      viaStaging: this.stagingActive,
    });
    try {
      if (this.stagingActive) {
        await this.spillBufferedFilesToStaging();
        const atomicCommitResult = await this.scratchGitService.commitStagedFilesAtomic(
          this.stagingJobKey,
          this.destinationRepoId,
          DIRTY_BRANCH,
          this.destinationFolderPath,
          'Sync: batch write files',
        );
        // The endpoint reports empty success when the staging index is gone
        // (it can't tell "nothing staged" from "staging state destroyed", e.g.
        // the git service's local disk was replaced mid-run). We know we
        // staged files, so zero committed means the writes were lost — fail
        // loudly instead of reporting a successful sync that wrote nothing.
        // (No exact-count check: duplicate destination paths legitimately
        // collapse into one staged row.)
        if (atomicCommitResult.committed === 0) {
          throw new Error(
            `Atomic staged commit wrote 0 of ${totalFilesToWrite} staged file(s) — staging state was lost`,
          );
        }
      } else {
        await this.scratchGitService.commitFilesToBranch(
          this.destinationRepoId,
          DIRTY_BRANCH,
          this.bufferedFilesToWrite,
          'Sync: batch write files',
        );
      }
    } finally {
      if (this.stagingActive) {
        // Best-effort disk cleanup on the git service; a leftover directory is
        // harmless garbage (its per-run key is never named again).
        try {
          await this.scratchGitService.cleanupStaging(this.stagingJobKey);
        } catch (cleanupError) {
          WSLogger.warn({
            source: 'SyncService.syncTableMapping',
            message: 'Failed to clean up sync staging directory',
            syncId: this.syncId,
            stagingJobKey: this.stagingJobKey,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
    }
  }

  async deleteRecordFiles(recordFilePaths: string[]): Promise<void> {
    await this.scratchGitService.deleteFilesFromBranch(
      this.destinationRepoId,
      DIRTY_BRANCH,
      recordFilePaths,
      'Sync: delete orphaned destination records',
    );
  }
}
