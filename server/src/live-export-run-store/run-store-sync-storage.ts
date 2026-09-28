import { createPlainId, DataFolderId, SyncId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
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
} from 'src/sync/storage/sync-storage-ports';
import type { AssetMappingResult } from 'src/sync/transformers/transformer.types';
import {
  readAllRunStoreEntries,
  RUN_STORE_BULK_PAGE_SIZE,
  type RunStoreClient,
  type RunStoreEntryToPut,
  type RunStoreKey,
} from './run-store-client';
import {
  runStoreRecordsCollection,
  runStoreSyncOutputCollection,
  runStoreSyncOutputStagingCollection,
} from './run-store-collections';
import { RunStoreTableSpecStore } from './run-store-table-spec-store';

/**
 * The Live Export run-store implementation of the sync storage ports (see
 * `src/sync/storage/sync-storage-ports.ts`). ONE bundle serves a whole sync job — every table pair,
 * both the DATA and FOREIGN_KEY_MAPPING phases — because the match index and the lookup data live in
 * this process's memory instead of Postgres:
 *
 * - records are read from the run's `records:<folderId>` collections (written by the pulls), in bulk
 *   pages, with one table pair's pages kept in memory so the sync's second pass over a table costs no
 *   round-trips (bounded by `cacheBudgetBytes`; above it, the pass re-reads);
 * - the sync's output goes to `sync-output:<destinationFolderId>` (staged per table run and merged in
 *   one transaction on commit, so a failed table leaves nothing behind), and destination reads see it
 *   through an overlay — the same view the classic engine's `dirty` branch gives the FK phase;
 * - match keys, remote-id mappings and the `lookup_field` cache are in-memory maps.
 */
export function createRunStoreSyncStoragePorts(dependencies: {
  runStoreClient: RunStoreClient;
  runStoreKey: RunStoreKey;
  db: DbService;
  syncId: SyncId;
  cacheBudgetBytes?: number;
}): SyncStoragePorts {
  const { runStoreClient, runStoreKey, db, syncId } = dependencies;
  const syncOutputOverlay = new SyncOutputOverlay();
  const matchIndex = new InMemorySyncMatchIndex();
  return {
    recordSource: new RunStoreSyncRecordSource(
      runStoreClient,
      runStoreKey,
      syncOutputOverlay,
      dependencies.cacheBudgetBytes ?? defaultSyncRecordCacheBudgetBytes(),
    ),
    tableSpecStore: new RunStoreTableSpecStore(runStoreClient, runStoreKey),
    matchIndex,
    lookupDataProvider: new InMemorySyncLookupDataProvider(db, syncId, matchIndex),
    openDestinationOutputSink: (destinationFolder) =>
      Promise.resolve(
        new RunStoreSyncOutputSink(runStoreClient, runStoreKey, syncId, destinationFolder, syncOutputOverlay),
      ),
  };
}

/**
 * Empties the sync output of these destination folders (and any staging left by an attempt that died), so a
 * sync job always starts from the pulled records alone. A redelivered sync job (worker crash, redeploy)
 * recomputes everything; without this, the new attempt's in-memory overlay wouldn't know about the records
 * the dead attempt already created in `sync-output`, and would create them again under new paths.
 */
export async function resetRunStoreSyncOutputForDestinationFolders(
  runStoreClient: RunStoreClient,
  runStoreKey: RunStoreKey,
  destinationDataFolderIds: string[],
): Promise<void> {
  const summary = await runStoreClient.getRunStoreSummary(runStoreKey);
  if (!summary) {
    throw new Error(
      `Live Export run store ${runStoreKey} does not exist — the run's first step should have created it`,
    );
  }
  const destinationFolderIds = new Set(destinationDataFolderIds);
  for (const { collection } of summary.collections) {
    const syncOutputFolderId = /^sync-output:(.+)$/.exec(collection)?.[1];
    const stagingFolderId = /^sync-output-staging:([^:]+):/.exec(collection)?.[1];
    const folderId = syncOutputFolderId ?? stagingFolderId;
    if (folderId !== undefined && destinationFolderIds.has(folderId)) {
      await runStoreClient.deleteCollection(runStoreKey, collection);
    }
  }
}

/** 256 MB unless `LIVE_EXPORT_RUN_STORE_SYNC_CACHE_MB` says otherwise. */
function defaultSyncRecordCacheBudgetBytes(): number {
  const configuredMegabytes = Number(process.env.LIVE_EXPORT_RUN_STORE_SYNC_CACHE_MB);
  const megabytes = Number.isFinite(configuredMegabytes) && configuredMegabytes >= 0 ? configuredMegabytes : 256;
  return megabytes * 1024 * 1024;
}

// =====================================================================================================
// What this sync run has committed to each destination folder
// =====================================================================================================

/** Per destination folder: the record paths this run wrote (content in `sync-output`) and deleted. */
export class SyncOutputOverlay {
  private readonly stateByDestinationFolderId = new Map<
    string,
    { writtenPaths: Set<string>; deletedPaths: Set<string> }
  >();

  stateFor(destinationDataFolderId: string): { writtenPaths: Set<string>; deletedPaths: Set<string> } | undefined {
    return this.stateByDestinationFolderId.get(destinationDataFolderId);
  }

  recordWrittenPaths(destinationDataFolderId: string, paths: Iterable<string>): void {
    const state = this.ensureState(destinationDataFolderId);
    for (const path of paths) {
      state.writtenPaths.add(path);
      state.deletedPaths.delete(path);
    }
  }

  recordDeletedPaths(destinationDataFolderId: string, paths: Iterable<string>): void {
    const state = this.ensureState(destinationDataFolderId);
    for (const path of paths) {
      state.deletedPaths.add(path);
      state.writtenPaths.delete(path);
    }
  }

  private ensureState(destinationDataFolderId: string): { writtenPaths: Set<string>; deletedPaths: Set<string> } {
    let state = this.stateByDestinationFolderId.get(destinationDataFolderId);
    if (!state) {
      state = { writtenPaths: new Set(), deletedPaths: new Set() };
      this.stateByDestinationFolderId.set(destinationDataFolderId, state);
    }
    return state;
  }
}

// =====================================================================================================
// Record source
// =====================================================================================================

interface CachedFolderRecords {
  pages: SyncRecordFile[][];
  contentByPath: Map<string, string>;
  bytes: number;
}

export class RunStoreSyncRecordSource implements SyncRecordSource {
  /** Complete folders only, least recently used first (Map insertion order). */
  private readonly cachedRecordsByFolderId = new Map<string, CachedFolderRecords>();
  private cachedBytes = 0;

  constructor(
    private readonly runStoreClient: RunStoreClient,
    private readonly runStoreKey: RunStoreKey,
    private readonly syncOutputOverlay: SyncOutputOverlay,
    private readonly cacheBudgetBytes: number,
  ) {}

  /** The sync never writes to source folders, so a source folder is exactly what the pull stored. */
  async *pageThroughSourceFolderRecordFiles(sourceDataFolderId: DataFolderId): AsyncGenerator<SyncRecordFile[]> {
    yield* this.pageThroughPulledFolderRecordFiles(sourceDataFolderId);
  }

  async *pageThroughDestinationFolderRecordFiles(
    destinationDataFolderId: DataFolderId,
    logContext: DestinationFolderPageReadLogContext,
  ): AsyncGenerator<SyncRecordFile[]> {
    const overlay = this.syncOutputOverlay.stateFor(destinationDataFolderId);
    const writtenPathsSeenInPulledRecords = new Set<string>();
    let destinationPageCounter = 0;

    for await (const pulledPage of this.pageThroughPulledFolderRecordFiles(destinationDataFolderId)) {
      let page = pulledPage;
      if (overlay && (overlay.writtenPaths.size > 0 || overlay.deletedPaths.size > 0)) {
        const pathsWrittenByThisRunInPage = pulledPage
          .map((file) => file.path)
          .filter((path) => overlay.writtenPaths.has(path));
        for (const path of pathsWrittenByThisRunInPage) writtenPathsSeenInPulledRecords.add(path);
        const writtenContentByPath = await this.readSyncOutputContents(
          destinationDataFolderId,
          pathsWrittenByThisRunInPage,
        );
        page = [];
        for (const file of pulledPage) {
          if (overlay.deletedPaths.has(file.path)) continue;
          const writtenContent = writtenContentByPath.get(file.path);
          page.push(writtenContent !== undefined ? { ...file, content: writtenContent } : file);
        }
      }
      this.logDestinationPage(logContext, destinationDataFolderId, page.length, destinationPageCounter++);
      yield page;
    }

    // Records this run created (they exist only in the sync output).
    if (overlay) {
      const createdPaths = [...overlay.writtenPaths].filter((path) => !writtenPathsSeenInPulledRecords.has(path));
      for (let index = 0; index < createdPaths.length; index += RUN_STORE_BULK_PAGE_SIZE) {
        const pathsInPage = createdPaths.slice(index, index + RUN_STORE_BULK_PAGE_SIZE);
        const contentByPath = await this.readSyncOutputContents(destinationDataFolderId, pathsInPage);
        const page: SyncRecordFile[] = [];
        for (const path of pathsInPage) {
          const content = contentByPath.get(path);
          if (content !== undefined) page.push({ folderId: destinationDataFolderId, path, content });
        }
        this.logDestinationPage(logContext, destinationDataFolderId, page.length, destinationPageCounter++);
        yield page;
      }
    }
  }

  async readDestinationRecordFilesByPath(
    destinationFolder: SyncDestinationFolderLocation,
    destinationRecordFilePaths: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    const destinationDataFolderId = destinationFolder.dataFolderId;
    const overlay = this.syncOutputOverlay.stateFor(destinationDataFolderId);
    const contentByPath = new Map<string, string | null>();

    const pathsWrittenByThisRun: string[] = [];
    const pathsToReadFromPulledRecords: string[] = [];
    for (const path of destinationRecordFilePaths) {
      if (overlay?.deletedPaths.has(path)) {
        contentByPath.set(path, null);
      } else if (overlay?.writtenPaths.has(path)) {
        pathsWrittenByThisRun.push(path);
      } else {
        pathsToReadFromPulledRecords.push(path);
      }
    }

    for (const [path, content] of await this.readSyncOutputContents(destinationDataFolderId, pathsWrittenByThisRun)) {
      contentByPath.set(path, content);
    }

    const cachedFolder = this.cachedRecordsByFolderId.get(destinationDataFolderId);
    if (cachedFolder) {
      this.markRecentlyUsed(destinationDataFolderId, cachedFolder);
      for (const path of pathsToReadFromPulledRecords) {
        contentByPath.set(path, cachedFolder.contentByPath.get(path) ?? null);
      }
    } else {
      for (let index = 0; index < pathsToReadFromPulledRecords.length; index += RUN_STORE_BULK_PAGE_SIZE) {
        const { entries } = await this.runStoreClient.readEntriesByKeys(
          this.runStoreKey,
          runStoreRecordsCollection(destinationDataFolderId),
          pathsToReadFromPulledRecords.slice(index, index + RUN_STORE_BULK_PAGE_SIZE),
          { includeBodies: true },
        );
        for (const entry of entries) contentByPath.set(entry.key, entry.body ?? null);
      }
    }

    return destinationRecordFilePaths.map((path) => ({ path, content: contentByPath.get(path) ?? null }));
  }

  private async *pageThroughPulledFolderRecordFiles(dataFolderId: DataFolderId): AsyncGenerator<SyncRecordFile[]> {
    const cachedFolder = this.cachedRecordsByFolderId.get(dataFolderId);
    if (cachedFolder) {
      this.markRecentlyUsed(dataFolderId, cachedFolder);
      yield* cachedFolder.pages;
      return;
    }

    // Read from the store, caching the folder as it streams while it fits in the budget.
    let folderBeingCached: CachedFolderRecords | null = { pages: [], contentByPath: new Map(), bytes: 0 };
    for await (const entries of readAllRunStoreEntries(
      this.runStoreClient,
      this.runStoreKey,
      runStoreRecordsCollection(dataFolderId),
      { includeBodies: true },
    )) {
      const page: SyncRecordFile[] = entries.map((entry) => ({
        folderId: dataFolderId,
        path: entry.key,
        content: entry.body ?? '',
      }));
      if (folderBeingCached) {
        folderBeingCached.pages.push(page);
        for (const file of page) {
          folderBeingCached.contentByPath.set(file.path, file.content);
          folderBeingCached.bytes += file.content.length + file.path.length;
        }
        if (!this.makeRoomFor(folderBeingCached.bytes, dataFolderId)) {
          folderBeingCached = null; // too big to cache; this folder is re-read each pass
        }
      }
      yield page;
    }
    if (folderBeingCached) {
      this.cachedRecordsByFolderId.set(dataFolderId, folderBeingCached);
      this.cachedBytes += folderBeingCached.bytes;
    }
  }

  /** Evicts least-recently-used folders until `bytes` more fit; false when they can't fit at all. */
  private makeRoomFor(bytes: number, dataFolderIdBeingCached: string): boolean {
    if (bytes > this.cacheBudgetBytes) return false;
    for (const [dataFolderId, cachedFolder] of this.cachedRecordsByFolderId) {
      if (this.cachedBytes + bytes <= this.cacheBudgetBytes) break;
      if (dataFolderId === dataFolderIdBeingCached) continue;
      this.cachedRecordsByFolderId.delete(dataFolderId);
      this.cachedBytes -= cachedFolder.bytes;
    }
    return this.cachedBytes + bytes <= this.cacheBudgetBytes;
  }

  private markRecentlyUsed(dataFolderId: string, cachedFolder: CachedFolderRecords): void {
    this.cachedRecordsByFolderId.delete(dataFolderId);
    this.cachedRecordsByFolderId.set(dataFolderId, cachedFolder);
  }

  private async readSyncOutputContents(destinationDataFolderId: string, paths: string[]): Promise<Map<string, string>> {
    const contentByPath = new Map<string, string>();
    for (let index = 0; index < paths.length; index += RUN_STORE_BULK_PAGE_SIZE) {
      const { entries } = await this.runStoreClient.readEntriesByKeys(
        this.runStoreKey,
        runStoreSyncOutputCollection(destinationDataFolderId),
        paths.slice(index, index + RUN_STORE_BULK_PAGE_SIZE),
        { includeBodies: true },
      );
      for (const entry of entries) {
        if (typeof entry.body === 'string') contentByPath.set(entry.key, entry.body);
      }
    }
    return contentByPath;
  }

  private logDestinationPage(
    logContext: DestinationFolderPageReadLogContext,
    destinationDataFolderId: string,
    records: number,
    batch: number,
  ): void {
    WSLogger.info({
      source: 'SyncService.syncTableMapping',
      message: `${logContext.passLabel}: destination batch`,
      syncId: logContext.syncId,
      destinationDataFolderId,
      records,
      batch,
    });
  }
}

// =====================================================================================================
// Match index (in memory, for the whole sync run)
// =====================================================================================================

/**
 * The same semantics as `ClassicPostgresSyncMatchIndex` (SyncMatchKeys + SyncRemoteIdMapping), in
 * memory: a folder keeps the FIRST entry for a duplicated match id (createMany skipDuplicates), the
 * join prefers a matched destination for a source record that reduced to several match ids, and
 * newly-created destinations only update mappings that exist.
 */
export class InMemorySyncMatchIndex implements SyncMatchIndex {
  private readonly matchKeyEntryByMatchIdByFolderId = new Map<string, Map<string, SyncMatchKeyEntry>>();
  private readonly mappingBySourceRemoteIdByFolderId = new Map<
    string,
    Map<string, DestinationMappingForSourceRecord>
  >();

  clearMatchKeysForDataFolder(dataFolderId: DataFolderId): Promise<void> {
    this.matchKeyEntryByMatchIdByFolderId.delete(dataFolderId);
    return Promise.resolve();
  }

  clearRemoteIdMappingsForSourceDataFolder(sourceDataFolderId: DataFolderId): Promise<void> {
    this.mappingBySourceRemoteIdByFolderId.delete(sourceDataFolderId);
    return Promise.resolve();
  }

  addMatchKeysForDataFolder(dataFolderId: DataFolderId, matchKeyEntries: SyncMatchKeyEntry[]): Promise<void> {
    let entryByMatchId = this.matchKeyEntryByMatchIdByFolderId.get(dataFolderId);
    if (!entryByMatchId) {
      entryByMatchId = new Map();
      this.matchKeyEntryByMatchIdByFolderId.set(dataFolderId, entryByMatchId);
    }
    for (const entry of matchKeyEntries) {
      if (!entryByMatchId.has(entry.matchId)) entryByMatchId.set(entry.matchId, entry);
    }
    return Promise.resolve();
  }

  upsertRemoteIdMappingsForSourceDataFolder(
    sourceDataFolderId: DataFolderId,
    remoteIdMappingPairs: RemoteIdMappingPair[],
  ): Promise<void> {
    const mappings = this.mappingsFor(sourceDataFolderId);
    for (const pair of remoteIdMappingPairs) {
      mappings.set(pair.sourceRemoteId, {
        destinationRemoteId: pair.destinationRemoteId,
        destinationFilePath: pair.destinationFilePath,
      });
    }
    return Promise.resolve();
  }

  joinMatchKeysIntoRemoteIdMappings(folders: {
    sourceDataFolderId: DataFolderId;
    destinationDataFolderId: DataFolderId;
  }): Promise<{ totalSourceRecords: number; matchedRecords: number }> {
    const sourceEntries =
      this.matchKeyEntryByMatchIdByFolderId.get(folders.sourceDataFolderId) ?? new Map<string, SyncMatchKeyEntry>();
    const destinationEntryByMatchId =
      this.matchKeyEntryByMatchIdByFolderId.get(folders.destinationDataFolderId) ??
      new Map<string, SyncMatchKeyEntry>();
    const joinedBySourceRemoteId = new Map<string, DestinationMappingForSourceRecord>();
    let matchedRecords = 0;
    for (const [matchId, sourceEntry] of sourceEntries) {
      const destinationEntry = destinationEntryByMatchId.get(matchId);
      if (destinationEntry) matchedRecords++;
      const candidate: DestinationMappingForSourceRecord = {
        destinationRemoteId: destinationEntry?.remoteId ?? null,
        destinationFilePath: destinationEntry?.filePath ?? null,
      };
      const existing = joinedBySourceRemoteId.get(sourceEntry.remoteId);
      // DISTINCT ON ("sourceRemoteId") ORDER BY "destinationRemoteId" NULLS LAST, "destinationFilePath" NULLS LAST
      if (!existing || compareMappingsForDistinctOn(candidate, existing) < 0) {
        joinedBySourceRemoteId.set(sourceEntry.remoteId, candidate);
      }
    }
    const mappings = this.mappingsFor(folders.sourceDataFolderId);
    for (const [sourceRemoteId, mapping] of joinedBySourceRemoteId) {
      mappings.set(sourceRemoteId, mapping);
    }
    return Promise.resolve({ totalSourceRecords: sourceEntries.size, matchedRecords });
  }

  getDestinationMappingsForSourceRemoteIds(
    sourceDataFolderId: DataFolderId,
    sourceRemoteIds: string[],
  ): Promise<Map<string, DestinationMappingForSourceRecord>> {
    const mappings = this.mappingBySourceRemoteIdByFolderId.get(sourceDataFolderId);
    const found = new Map<string, DestinationMappingForSourceRecord>();
    if (!mappings) return Promise.resolve(found);
    for (const sourceRemoteId of sourceRemoteIds) {
      const mapping = mappings.get(sourceRemoteId);
      if (mapping) found.set(sourceRemoteId, { ...mapping });
    }
    return Promise.resolve(found);
  }

  recordDestinationsOfNewlyCreatedRecords(
    sourceDataFolderId: DataFolderId,
    newlyCreatedDestinationRecords: NewlyCreatedDestinationRecord[],
  ): Promise<void> {
    const mappings = this.mappingBySourceRemoteIdByFolderId.get(sourceDataFolderId);
    if (!mappings) return Promise.resolve();
    for (const created of newlyCreatedDestinationRecords) {
      if (mappings.has(created.sourceRemoteId)) {
        mappings.set(created.sourceRemoteId, {
          destinationRemoteId: created.destinationRecordId,
          destinationFilePath: created.filePath,
        });
      }
    }
    return Promise.resolve();
  }

  loadMatchIdsForDataFolder(dataFolderId: DataFolderId): Promise<Set<string>> {
    return Promise.resolve(new Set(this.matchKeyEntryByMatchIdByFolderId.get(dataFolderId)?.keys() ?? []));
  }

  /** Every mapping of a source folder, as `SyncRemoteIdMapping` rows (for FK lookups). */
  remoteIdMappingRowsForSourceFolder(
    sourceDataFolderId: string,
  ): Array<{ sourceRemoteId: string; destinationFilePath: string | null; destinationRemoteId: string | null }> {
    const mappings = this.mappingBySourceRemoteIdByFolderId.get(sourceDataFolderId);
    if (!mappings) return [];
    return [...mappings].map(([sourceRemoteId, mapping]) => ({
      sourceRemoteId,
      destinationFilePath: mapping.destinationFilePath,
      destinationRemoteId: mapping.destinationRemoteId,
    }));
  }

  private mappingsFor(sourceDataFolderId: string): Map<string, DestinationMappingForSourceRecord> {
    let mappings = this.mappingBySourceRemoteIdByFolderId.get(sourceDataFolderId);
    if (!mappings) {
      mappings = new Map();
      this.mappingBySourceRemoteIdByFolderId.set(sourceDataFolderId, mappings);
    }
    return mappings;
  }
}

/** Negative when `left` sorts first under `ORDER BY destinationRemoteId NULLS LAST, destinationFilePath NULLS LAST`. */
function compareMappingsForDistinctOn(
  left: DestinationMappingForSourceRecord,
  right: DestinationMappingForSourceRecord,
): number {
  return (
    compareNullableStringsNullsLast(left.destinationRemoteId, right.destinationRemoteId) ||
    compareNullableStringsNullsLast(left.destinationFilePath, right.destinationFilePath)
  );
}

function compareNullableStringsNullsLast(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

// =====================================================================================================
// Lookup data (in memory, over the run's match index)
// =====================================================================================================

export class InMemorySyncLookupDataProvider implements SyncLookupDataProvider {
  private readonly cachedRecordFieldsByForeignKeyValueByFolderId = new Map<string, Map<string, unknown>>();

  constructor(
    private readonly db: DbService,
    private readonly syncId: SyncId,
    private readonly matchIndex: InMemorySyncMatchIndex,
  ) {}

  /** The table pair is configuration (Postgres); the mappings are this run's, from memory. */
  async loadReferencedFolderRemoteIdMappingRows(
    referencedDataFolderId: DataFolderId,
  ): Promise<ReferencedFolderRemoteIdMappingRows> {
    const referencedTablePair = await this.db.client.syncTablePair.findFirst({
      where: { syncId: this.syncId, sourceDataFolderId: referencedDataFolderId },
      select: {
        destinationDataFolderId: true,
        sourceDataFolder: { select: { name: true, connectorService: true } },
        destinationDataFolder: { select: { name: true, connectorAccount: { select: { displayName: true } } } },
      },
    });
    return {
      referencedTablePair,
      remoteIdMappingRows: this.matchIndex.remoteIdMappingRowsForSourceFolder(referencedDataFolderId),
    };
  }

  clearForeignKeyRecordCache(): Promise<void> {
    this.cachedRecordFieldsByForeignKeyValueByFolderId.clear();
    return Promise.resolve();
  }

  addForeignKeyRecordsToCache(foreignKeyRecordCacheEntries: ForeignKeyRecordCacheEntry[]): Promise<void> {
    for (const entry of foreignKeyRecordCacheEntries) {
      let recordFieldsByForeignKeyValue = this.cachedRecordFieldsByForeignKeyValueByFolderId.get(entry.dataFolderId);
      if (!recordFieldsByForeignKeyValue) {
        recordFieldsByForeignKeyValue = new Map();
        this.cachedRecordFieldsByForeignKeyValueByFolderId.set(entry.dataFolderId, recordFieldsByForeignKeyValue);
      }
      if (!recordFieldsByForeignKeyValue.has(entry.foreignKeyValue)) {
        recordFieldsByForeignKeyValue.set(entry.foreignKeyValue, entry.recordFields);
      }
    }
    return Promise.resolve();
  }

  findCachedForeignKeyRecordFields(referencedDataFolderId: DataFolderId, foreignKeyValue: string): Promise<unknown> {
    return Promise.resolve(
      this.cachedRecordFieldsByForeignKeyValueByFolderId.get(referencedDataFolderId)?.get(foreignKeyValue) ?? null,
    );
  }

  /** Mappings with asset transformers run on the classic engine (see `live-export-engine.ts`). */
  getOrCreateDestinationAssetMapping(): Promise<AssetMappingResult> {
    return Promise.reject(new Error(ASSET_TRANSFORMERS_UNSUPPORTED_MESSAGE));
  }

  loadAssetContentHashIndexForFolderPair(): Promise<AssetContentHashIndexForFolderPair> {
    return Promise.reject(new Error(ASSET_TRANSFORMERS_UNSUPPORTED_MESSAGE));
  }
}

const ASSET_TRANSFORMERS_UNSUPPORTED_MESSAGE =
  'Asset transformers are not supported by the Live Export run-store engine (the run should have used the classic engine)';

// =====================================================================================================
// Output sink (per table run)
// =====================================================================================================

/** Queued writes spill to the run store once this many are buffered (one bulk request). */
const SYNC_OUTPUT_FLUSH_THRESHOLD = RUN_STORE_BULK_PAGE_SIZE;

export class RunStoreSyncOutputSink implements SyncDestinationOutputSink {
  private readonly stagingCollection: string;
  private readonly finalCollection: string;
  private bufferedEntries: RunStoreEntryToPut[] = [];
  private readonly queuedPaths = new Set<string>();
  private queuedWriteCount = 0;

  constructor(
    private readonly runStoreClient: RunStoreClient,
    private readonly runStoreKey: RunStoreKey,
    private readonly syncId: string,
    private readonly destinationFolder: SyncDestinationFolderLocation,
    private readonly syncOutputOverlay: SyncOutputOverlay,
  ) {
    this.stagingCollection = runStoreSyncOutputStagingCollection(destinationFolder.dataFolderId, createPlainId());
    this.finalCollection = runStoreSyncOutputCollection(destinationFolder.dataFolderId);
  }

  get queuedRecordFileWriteCount(): number {
    return this.queuedWriteCount;
  }

  queueRecordFileWrite(recordFile: { path: string; content: string }): void {
    this.bufferedEntries.push({ key: recordFile.path, meta: { deleted: false }, body: recordFile.content });
    this.queuedPaths.add(recordFile.path);
    this.queuedWriteCount++;
  }

  async flushQueuedRecordFileWritesAtPageBoundary(): Promise<void> {
    if (this.bufferedEntries.length >= SYNC_OUTPUT_FLUSH_THRESHOLD) {
      await this.spillBufferedEntriesToStaging();
    }
  }

  /** Lands the table's writes in `sync-output` in one transaction (merge of the staged entries). */
  async commitQueuedRecordFileWrites(): Promise<void> {
    WSLogger.info({
      source: 'SyncService.syncTableMapping',
      message: 'Committing files to the Live Export run store',
      syncId: this.syncId,
      files: this.queuedWriteCount,
      destinationDataFolderId: this.destinationFolder.dataFolderId,
    });
    try {
      await this.spillBufferedEntriesToStaging();
      const moved = await this.runStoreClient.mergeCollectionInto(
        this.runStoreKey,
        this.stagingCollection,
        this.finalCollection,
      );
      if (moved === 0 && this.queuedWriteCount > 0) {
        throw new Error(`Run store commit moved 0 of ${this.queuedWriteCount} staged file(s) — staging state was lost`);
      }
      this.syncOutputOverlay.recordWrittenPaths(this.destinationFolder.dataFolderId, this.queuedPaths);
    } catch (error) {
      await this.runStoreClient.deleteCollection(this.runStoreKey, this.stagingCollection).catch(() => {});
      throw error;
    }
  }

  /** Staged and merged like the writes, so a failed deletion leaves no tombstone behind. */
  async deleteRecordFiles(recordFilePaths: string[]): Promise<void> {
    const deletionStagingCollection = `${this.stagingCollection}-deletions`;
    try {
      for (let index = 0; index < recordFilePaths.length; index += RUN_STORE_BULK_PAGE_SIZE) {
        await this.runStoreClient.putEntries(
          this.runStoreKey,
          deletionStagingCollection,
          recordFilePaths
            .slice(index, index + RUN_STORE_BULK_PAGE_SIZE)
            .map((path) => ({ key: path, meta: { deleted: true }, body: null })),
        );
      }
      await this.runStoreClient.mergeCollectionInto(this.runStoreKey, deletionStagingCollection, this.finalCollection);
    } catch (error) {
      await this.runStoreClient.deleteCollection(this.runStoreKey, deletionStagingCollection).catch(() => {});
      throw error;
    }
    this.syncOutputOverlay.recordDeletedPaths(this.destinationFolder.dataFolderId, recordFilePaths);
  }

  private async spillBufferedEntriesToStaging(): Promise<void> {
    while (this.bufferedEntries.length > 0) {
      const batch = this.bufferedEntries.slice(0, RUN_STORE_BULK_PAGE_SIZE);
      await this.runStoreClient.putEntries(this.runStoreKey, this.stagingCollection, batch);
      this.bufferedEntries = this.bufferedEntries.slice(batch.length);
    }
  }
}
