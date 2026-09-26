import type { DataFolderId, Service } from '@spinner/shared-types';
import type { AssetMappingResult } from 'src/sync/transformers/transformer.types';
import type { TableSpecStore } from 'src/workbook/table-spec-store/table-spec-store';

/**
 * Storage ports for a sync run.
 *
 * `SyncService.syncTableMapping` is orchestration plus per-record logic (matching, transforming,
 * diffing, the unmatched-destination policy). Everything it reads or writes goes through the four
 * ports below (plus the shared `TableSpecStore` for table specs), so the same logic can run against
 * different storage:
 *
 * - the classic implementation (`classic-sync-storage.ts`) — record files on the scratch-git
 *   `dirty` branch, match keys in `SyncMatchKeys` / `SyncRemoteIdMapping`, lookups in
 *   `SyncForeignKeyRecord` / `Asset`, output committed to `dirty`. This is today's code, moved.
 * - a Live Export run store (not built yet) — see
 *   `docs/plans/2026-09-25-live-export-git-free-run-store/2026-09-25-live-export-git-free-run-store.md`.
 *
 * The interfaces deliberately carry no Prisma rows and no git concepts (branches, repo ids,
 * commits): an implementation is free to keep its state in memory, on disk, or in a database.
 */

/** One record file as the sync reads it: the folder it belongs to, its path, its raw JSON text. */
export interface SyncRecordFile {
  folderId: DataFolderId;
  path: string;
  content: string;
}

/** Where the destination folder of a table mapping lives, as the storage needs to know it. */
export interface SyncDestinationFolderLocation {
  dataFolderId: DataFolderId;
  /** The folder's path with no leading slash; `''` for a folder at the storage root. */
  folderPathWithoutLeadingSlash: string;
  connectorAccountId: string | null;
}

/** Log fields a destination page read reports, so page logs stay attributable to a pass. */
export interface DestinationFolderPageReadLogContext {
  syncId: string;
  passLabel: string;
  destinationFolderPath: string | null;
}

/**
 * Reads the record files a sync consumes. Every read returns the same bytes for the whole run:
 * nothing a sync run writes is visible to these reads until the run's output is committed.
 */
export interface SyncRecordSource {
  /**
   * Pages through every record file of a source folder (the table being synced, or a folder a
   * foreign key references), one page at a time so no caller holds a whole folder in memory.
   */
  pageThroughSourceFolderRecordFiles(sourceDataFolderId: DataFolderId): AsyncGenerator<SyncRecordFile[]>;

  /**
   * Pages through every record file of a destination folder. A folder that does not exist yet
   * (a brand-new or empty destination) yields no pages rather than failing.
   */
  pageThroughDestinationFolderRecordFiles(
    destinationDataFolderId: DataFolderId,
    logContext: DestinationFolderPageReadLogContext,
  ): AsyncGenerator<SyncRecordFile[]>;

  /**
   * Reads specific destination record files by path. A path with no file comes back with
   * `content: null`.
   */
  readDestinationRecordFilesByPath(
    destinationFolder: SyncDestinationFolderLocation,
    destinationRecordFilePaths: string[],
  ): Promise<Array<{ path: string; content: string | null }>>;
}

/** One record's canonical match key, as derived by `deriveCanonicalMatchKey`. */
export interface SyncMatchKeyEntry {
  matchId: string;
  remoteId: string;
  filePath: string;
}

export interface RemoteIdMappingPair {
  sourceRemoteId: string;
  destinationRemoteId: string | null;
  destinationFilePath: string | null;
}

/** Where a source record landed in the destination; both null when it has no counterpart yet. */
export interface DestinationMappingForSourceRecord {
  destinationRemoteId: string | null;
  destinationFilePath: string | null;
}

export interface NewlyCreatedDestinationRecord {
  sourceRemoteId: string;
  filePath: string;
  destinationRecordId: string;
}

/**
 * The source ↔ destination record correspondence of one sync: match keys per folder, and the
 * per-source-record mapping produced by joining them. Scoped to a single sync; lives for the
 * whole sync run, because the FOREIGN_KEY_MAPPING phase reads the mappings the DATA phase built
 * (including other table pairs' mappings, via {@link SyncLookupDataProvider}).
 */
export interface SyncMatchIndex {
  clearMatchKeysForDataFolder(dataFolderId: DataFolderId): Promise<void>;
  clearRemoteIdMappingsForSourceDataFolder(sourceDataFolderId: DataFolderId): Promise<void>;
  /** Adds match keys for one folder. A duplicate `matchId` within a folder keeps the first entry. */
  addMatchKeysForDataFolder(dataFolderId: DataFolderId, matchKeyEntries: SyncMatchKeyEntry[]): Promise<void>;
  /** Inserts or overwrites the mapping of each source record. */
  upsertRemoteIdMappingsForSourceDataFolder(
    sourceDataFolderId: DataFolderId,
    remoteIdMappingPairs: RemoteIdMappingPair[],
  ): Promise<void>;
  /**
   * Joins the source folder's match keys to the destination folder's on `matchId`, writing one
   * mapping per source record (destination null when unmatched). Returns the join's counts.
   */
  joinMatchKeysIntoRemoteIdMappings(folders: {
    sourceDataFolderId: DataFolderId;
    destinationDataFolderId: DataFolderId;
  }): Promise<{ totalSourceRecords: number; matchedRecords: number }>;
  getDestinationMappingsForSourceRemoteIds(
    sourceDataFolderId: DataFolderId,
    sourceRemoteIds: string[],
  ): Promise<Map<string, DestinationMappingForSourceRecord>>;
  /** Fills in the destination of source records the sync just created a destination record for. */
  recordDestinationsOfNewlyCreatedRecords(
    sourceDataFolderId: DataFolderId,
    newlyCreatedDestinationRecords: NewlyCreatedDestinationRecord[],
  ): Promise<void>;
  loadMatchIdsForDataFolder(dataFolderId: DataFolderId): Promise<Set<string>>;
}

/**
 * The output of syncing one table mapping. Writes are queued and land all at once in
 * {@link commitQueuedRecordFileWrites}: a failed run leaves nothing half-written behind.
 */
export interface SyncDestinationOutputSink {
  queueRecordFileWrite(recordFile: { path: string; content: string }): void;
  /** Called at source/destination page boundaries so queued writes never grow past one page. */
  flushQueuedRecordFileWritesAtPageBoundary(): Promise<void>;
  /** Every write queued so far, whether still in memory or already flushed. */
  readonly queuedRecordFileWriteCount: number;
  /** Lands every queued write as one unit. Throws if any of it failed; nothing lands then. */
  commitQueuedRecordFileWrites(): Promise<void>;
  /** Removes destination record files. Called only after the queued writes have landed. */
  deleteRecordFiles(recordFilePaths: string[]): Promise<void>;
}

/** The table pair whose SOURCE folder a foreign key references, as FK resolution needs it. */
export interface ReferencedTablePairForForeignKeys {
  destinationDataFolderId: string;
  sourceDataFolder: { name: string; connectorService: Service | null };
  destinationDataFolder: { name: string; connectorAccount: { displayName: string } | null };
}

export interface ReferencedFolderRemoteIdMappingRows {
  /** Null when this sync has no table pair whose source folder is the referenced folder. */
  referencedTablePair: ReferencedTablePairForForeignKeys | null;
  remoteIdMappingRows: Array<{
    sourceRemoteId: string;
    destinationFilePath: string | null;
    destinationRemoteId: string | null;
  }>;
}

export interface ForeignKeyRecordCacheEntry {
  dataFolderId: DataFolderId;
  foreignKeyValue: string;
  recordFields: Record<string, unknown>;
}

export interface AssetContentHashIndexForFolderPair {
  sourceHashByRemoteId: Map<string, string>;
  destRemoteIdsByHash: Map<string, string[]>;
}

/**
 * The data `LookupTools` reads to resolve foreign keys, `lookup_field` values and assets —
 * plus the `lookup_field` record cache writes that feed it. Scoped to a single sync.
 */
export interface SyncLookupDataProvider {
  /** Every mapping this sync holds for a referenced (source) folder, plus that folder's table pair. */
  loadReferencedFolderRemoteIdMappingRows(
    referencedDataFolderId: DataFolderId,
  ): Promise<ReferencedFolderRemoteIdMappingRows>;

  clearForeignKeyRecordCache(): Promise<void>;
  /** Adds referenced records to the `lookup_field` cache. A duplicate (folder, value) keeps the first. */
  addForeignKeyRecordsToCache(foreignKeyRecordCacheEntries: ForeignKeyRecordCacheEntry[]): Promise<void>;
  /** The cached referenced record's fields, or null when the cache has no such record. */
  findCachedForeignKeyRecordFields(referencedDataFolderId: DataFolderId, foreignKeyValue: string): Promise<unknown>;

  getOrCreateDestinationAssetMapping(args: {
    sourceAssetRemoteId: string;
    sourceDataFolderId: DataFolderId;
    sourceService: Service;
    destinationDataFolderId: DataFolderId;
    destinationService: Service;
  }): Promise<AssetMappingResult>;
  loadAssetContentHashIndexForFolderPair(args: {
    sourceDataFolderId: DataFolderId;
    sourceService: Service;
    destinationDataFolderId: DataFolderId;
    destinationService: Service;
  }): Promise<AssetContentHashIndexForFolderPair>;
}

/**
 * Everything one sync run reads and writes, bundled. Scoped to a single sync: pass the SAME bundle to
 * every `syncTableMapping` call of a run (every table pair, DATA and FOREIGN_KEY_MAPPING phases) —
 * the FK phase reads the match index the DATA phase built. The classic bundle keeps that state in
 * Postgres, so a fresh classic bundle per call is equivalent; an in-memory bundle is not.
 */
export interface SyncStoragePorts {
  recordSource: SyncRecordSource;
  /** Where the synced folders' table specs are read from (source, destination, referenced folders). */
  tableSpecStore: TableSpecStore;
  matchIndex: SyncMatchIndex;
  lookupDataProvider: SyncLookupDataProvider;
  /**
   * Opens the output of one table mapping. Called once per `syncTableMapping` run, before any
   * record is read, so an unreachable destination fails the table up front.
   */
  openDestinationOutputSink(destinationFolder: SyncDestinationFolderLocation): Promise<SyncDestinationOutputSink>;
}
