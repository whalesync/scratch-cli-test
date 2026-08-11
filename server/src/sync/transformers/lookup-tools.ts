import {
  createAssetId,
  createScratchPendingPublishId,
  DataFolderId,
  Service,
  SyncId,
  WorkbookId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { readFieldValueAtPath } from 'src/utils/field-path';
import { sanitizeConnectionFolderName } from 'src/workbook/connector-folder-path.util';
import {
  addTargetRecordsToForeignKeyTargetKeyIndex,
  createEmptyForeignKeyTargetKeyIndex,
  resolveForeignKeyValueAgainstTargetKeyIndex,
  type ForeignKeyTargetKeyIndex,
  type TargetRecordForKeyIndex,
} from './foreign-key-target-key-index';
import {
  AssetMappingResult,
  DestinationMappingResolution,
  FkMappingResult,
  ForeignKeyTargetResolution,
  LookupTools,
} from './transformer.types';

/**
 * Everything one referenced folder contributes to FK resolution, loaded once and cached.
 *
 * Split into two shapes because the destination CONNECTION is a property of the folder, not
 * of an individual mapping: either we know it (and every mapping carries the canonical
 * workspace-absolute prefix), or we don't — and then no mapping can be handed out at all,
 * because there is no reference this producer is allowed to build without one. The unresolved
 * shape still remembers WHICH source ids had a destination record, so "this FK maps nowhere"
 * (a skip the user may have opted into via `onUnresolved: 'ignore'`) stays distinguishable
 * from "this FK maps somewhere we can't name" (a hard failure).
 */
type ReferencedFolderDestinationMappings = {
  /**
   * The source remote ids `SyncRemoteIdMapping` holds a row for that carries NO destination path —
   * the rows both shapes below drop, and the reason an FK that mapped nowhere could not say whether
   * its target was never synced or is merely waiting for its counterpart (DEV-11223).
   *
   * Deliberately only the destination-LESS ids, not every row's id: this is read only after the id
   * has already missed the destination-bearing lookup, so the ids in that lookup could never be
   * consulted here. Holding them too would duplicate the whole key set of a healthy folder's map —
   * a second ~35-40k-entry hash table per cached folder, in the path DEV-11192 OOM-killed the
   * worker in — to answer questions about a handful of ids.
   */
  sourceRemoteIdsSyncedWithoutDestination: Set<string>;
  /** How many rows the folder has in total, so "synced nothing at all" stays distinguishable. */
  syncedSourceRecordRowCount: number;
  /** The referenced (source) folder's display name, for messages; null when this sync has no pair for it. */
  referencedFolderName: string | null;
  /**
   * The service the referenced folder is connected to; null when unknown. Why this is the
   * REFERENCED folder's service and not the synced pair's:
   * {@link DestinationMappingResolution}'s `referencedFolderService`.
   */
  referencedFolderService: Service | null;
} & (
  | { kind: 'resolved'; mappingBySourceRemoteId: Map<string, FkMappingResult> }
  | { kind: 'connection_unresolved'; reason: string; sourceRemoteIdsWithDestination: Set<string> }
);

/**
 * Stream every source record of a referenced folder, one page at a time, so a foreign key whose
 * value names its target by a non-id field can be resolved. Paged (rather than returning the whole
 * folder) so a large referenced folder never has to be materialized in memory at once — the OOM
 * that motivated this shape held ~40k full Stripe records live. Resolves after the last page has
 * been delivered. Injected rather than imported so this module keeps no dependency on the
 * folder/git services and stays unit-testable.
 */
export type ReadReferencedFolderRecordPages = (
  referencedDataFolderId: DataFolderId,
  onRecordPage: (recordPage: TargetRecordForKeyIndex[]) => void,
) => Promise<void>;

/**
 * Creates a no-op LookupTools where every method returns null / rejects.
 * Useful in tests for transformers that don't need FK or asset lookups.
 */
export function createNullLookupTools(): LookupTools {
  return {
    // No folder reader, so only the identity (remote-id) resolution is meaningful here.
    resolveForeignKeyValueToTargetRemoteId: (foreignKeyValue, _folderId, targetKeyPath) =>
      Promise.resolve(
        targetKeyPath === undefined
          ? ({ kind: 'resolved', targetSourceRemoteId: foreignKeyValue } as const)
          : ({ kind: 'no_match' } as const),
      ),
    // No sync behind these tools, so no referenced folder has synced anything.
    getDestinationMappingForSourceFk: () =>
      Promise.resolve({
        kind: 'no_destination_record',
        cause: 'referenced_folder_synced_nothing',
        referencedFolderName: null,
        referencedFolderService: null,
      } as const),
    lookupFieldFromFkRecord: () => Promise.resolve(undefined),
    getOrCreateDestinationAssetMapping: () => Promise.reject(new Error('Asset lookup not available')),
    matchDestinationAssetByHash: () => Promise.resolve([]),
  };
}

/**
 * Factory function to create LookupTools for a specific sync context.
 *
 * @param db - Database service
 * @param syncId - The sync ID for looking up mappings
 * @param workbookId - The workbook ID for asset lookups
 * @param sourceService - The Service of the source connector
 * @param destinationService - The Service of the destination connector
 * @param readReferencedFolderRecordPages - Streams a referenced folder's source records page by
 *   page, for resolving a foreign key whose value names its target by a field other than the
 *   target's remote id
 */
export function createLookupTools(
  db: DbService,
  syncId: SyncId,
  workbookId: WorkbookId,
  sourceService: Service,
  destinationService: Service,
  readReferencedFolderRecordPages: ReadReferencedFolderRecordPages,
): LookupTools {
  // ── FK mapping cache ──────────────────────────────────────────────────────
  //
  // During the FOREIGN_KEY_MAPPING phase, the source_fk_to_dest_fk transformer
  // calls getDestinationMappingForSourceFk() once per FK array element. For
  // example, a table with 12K records and ~117 FK references per record, that
  // would be ~1.4 million individual DB queries if done one-by-one.
  //
  // Instead, we lazy-load ALL mappings for a given (syncId, referencedDataFolderId)
  // pair into an in-memory Map on first access. The SyncRemoteIdMapping table
  // typically has at most tens of thousands of rows per folder (bounded by the
  // number of records in the referenced table), so memory usage is modest — the
  // largest folder in a profiled 35K-record sync was ~2.5MB of string data.
  //
  // This turns ~1.6M sequential DB queries into ~13 bulk queries (one per
  // referenced folder), reducing FK resolution from potentially 30+ minutes
  // to under a second.
  //
  // Keyed by referencedDataFolderId → that folder's loaded destination mappings.
  // ───────────────────────────────────────────────────────────────────────────
  const fkMappingCache = new Map<DataFolderId, ReferencedFolderDestinationMappings>();

  // Cache for hash matching: loaded once per (sourceFolder, destFolder) pair, then in-memory lookups
  const hashMatchCache = new Map<
    string,
    { sourceHashByRemoteId: Map<string, string>; destRemoteIdsByHash: Map<string, string[]> }
  >();

  // ── Non-id foreign-key target index ───────────────────────────────────────
  //
  // Only built when a connector declares `targetKeyPath` on a foreign key, so every connector
  // whose references carry ids pays nothing. Keyed by folder AND key path — two fields could
  // name the same target table by different keys, and serving an id-keyed index to a
  // slug-keyed lookup would silently resolve nothing.
  //
  // One paged folder read per (folder, key path). The index folds each page in as it streams,
  // so only the compact key→remote-id maps are retained — never the folder's full records.
  // ──────────────────────────────────────────────────────────────────────────
  const targetKeyIndexCache = new Map<string, Promise<ForeignKeyTargetKeyIndex>>();

  function getTargetKeyIndex(
    referencedDataFolderId: DataFolderId,
    targetKeyPath: string,
  ): Promise<ForeignKeyTargetKeyIndex> {
    // A NUL byte can't appear in a folder id or a dot path, so it's an unambiguous separator.
    const cacheKey = `${referencedDataFolderId}\0${targetKeyPath}`;
    let index = targetKeyIndexCache.get(cacheKey);
    if (!index) {
      // Cache the PROMISE, not the result, so concurrent FK elements share one folder read.
      const indexUnderConstruction = createEmptyForeignKeyTargetKeyIndex();
      index = readReferencedFolderRecordPages(referencedDataFolderId, (recordPage) =>
        addTargetRecordsToForeignKeyTargetKeyIndex(indexUnderConstruction, recordPage, targetKeyPath),
      ).then(() => indexUnderConstruction);
      targetKeyIndexCache.set(cacheKey, index);
    }
    return index;
  }

  /**
   * Load one referenced folder's destination mappings, resolving the DESTINATION connection's
   * folder name once for the whole folder.
   *
   * `referencedDataFolderId` is the SOURCE folder of the referenced table pair, so we hop
   * through SyncTablePair to that pair's DESTINATION folder and read ITS connection's display
   * name — using the source connection here would emit a ref that resolves to the wrong
   * connection at publish (DEV-10880). Without that name there is no workspace-absolute
   * pseudo-ref to write at all, so the folder loads in the `connection_unresolved` shape and
   * every FK that names a destination record in it fails loudly.
   */
  async function loadDestinationMappingsForReferencedFolder(
    referencedDataFolderId: DataFolderId,
  ): Promise<ReferencedFolderDestinationMappings> {
    const referencedTablePair = await db.client.syncTablePair.findFirst({
      where: { syncId, sourceDataFolderId: referencedDataFolderId },
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
    const destinationConnectionDisplayName = referencedTablePair?.destinationDataFolder.connectorAccount?.displayName;

    const rows = await db.client.syncRemoteIdMapping.findMany({
      where: {
        syncId,
        dataFolderId: referencedDataFolderId,
      },
      select: { sourceRemoteId: true, destinationFilePath: true, destinationRemoteId: true },
    });

    // Only the rows BOTH shapes below drop — see `sourceRemoteIdsSyncedWithoutDestination`.
    const sourceRemoteIdsSyncedWithoutDestination = new Set(
      rows.filter((row) => !row.destinationFilePath).map((row) => row.sourceRemoteId),
    );
    const folderIdentity = {
      sourceRemoteIdsSyncedWithoutDestination,
      syncedSourceRecordRowCount: rows.length,
      referencedFolderName: referencedTablePair?.sourceDataFolder.name ?? null,
      referencedFolderService: referencedTablePair?.sourceDataFolder.connectorService ?? null,
    };

    if (destinationConnectionDisplayName === undefined) {
      const sourceRemoteIdsWithDestination = new Set<string>();
      for (const row of rows) {
        if (row.destinationFilePath) sourceRemoteIdsWithDestination.add(row.sourceRemoteId);
      }
      return {
        kind: 'connection_unresolved',
        reason:
          referencedTablePair === null
            ? `this sync has no table pair whose source folder is ${referencedDataFolderId}, so the connection its destination records live in is unknown`
            : `the destination folder "${referencedTablePair.destinationDataFolder.name}" ` +
              `(${referencedTablePair.destinationDataFolderId}) is not attached to a connection`,
        sourceRemoteIdsWithDestination,
        ...folderIdentity,
      };
    }

    const destinationConnectionFolder = sanitizeConnectionFolderName(destinationConnectionDisplayName);
    const mappingBySourceRemoteId = new Map<string, FkMappingResult>();
    for (const row of rows) {
      if (!row.destinationFilePath) continue;
      mappingBySourceRemoteId.set(row.sourceRemoteId, {
        destinationFilePath: row.destinationFilePath,
        destinationRemoteId: row.destinationRemoteId ?? null,
        destinationConnectionFolder,
      });
    }
    return { kind: 'resolved', mappingBySourceRemoteId, ...folderIdentity };
  }

  /**
   * Work out WHY a source remote id reached no destination record in the referenced folder — the
   * distinction `SyncRemoteIdMapping` can make but `mappingBySourceRemoteId` alone cannot
   * (DEV-11223). Shared by both folder shapes: an FK that maps nowhere reports the same cause
   * whether or not the folder's destination connection could be named.
   *
   * Named for classification, not description: the sentence a user reads is built from this cause
   * by `describeMissingDestinationRecord` in `source-fk-to-dest-fk.transformer.ts`.
   */
  function classifyMissingDestinationRecordCause(
    folderMappings: ReferencedFolderDestinationMappings,
    sourceFkValue: string,
  ): DestinationMappingResolution {
    const { sourceRemoteIdsSyncedWithoutDestination, syncedSourceRecordRowCount } = folderMappings;
    // `sourceFkValue` has already missed the destination-bearing lookup at both call sites, so a
    // hit here means "a row exists, it just has no destination path yet".
    const cause =
      syncedSourceRecordRowCount === 0
        ? 'referenced_folder_synced_nothing'
        : sourceRemoteIdsSyncedWithoutDestination.has(sourceFkValue)
          ? 'referenced_record_awaiting_destination'
          : 'referenced_record_not_synced';
    return {
      kind: 'no_destination_record',
      cause,
      referencedFolderName: folderMappings.referencedFolderName,
      referencedFolderService: folderMappings.referencedFolderService,
    };
  }

  return {
    async resolveForeignKeyValueToTargetRemoteId(
      foreignKeyValue: string,
      referencedDataFolderId: DataFolderId,
      targetKeyPath?: string,
    ): Promise<ForeignKeyTargetResolution> {
      // No declared key ⇒ the value already IS the target's remote id. Identity, no I/O — the
      // path every connector but Framer takes.
      if (targetKeyPath === undefined) {
        return { kind: 'resolved', targetSourceRemoteId: foreignKeyValue };
      }
      const index = await getTargetKeyIndex(referencedDataFolderId, targetKeyPath);
      return resolveForeignKeyValueAgainstTargetKeyIndex(index, foreignKeyValue);
    },

    async getDestinationMappingForSourceFk(
      sourceFkValue: string,
      referencedDataFolderId: DataFolderId,
    ): Promise<DestinationMappingResolution> {
      // Lazy-load all mappings for this referenced folder on first access.
      // Subsequent calls for the same folder hit the in-memory Map (O(1) lookup)
      // instead of making a DB round-trip per FK element.
      let folderMappings = fkMappingCache.get(referencedDataFolderId);
      if (!folderMappings) {
        folderMappings = await loadDestinationMappingsForReferencedFolder(referencedDataFolderId);
        fkMappingCache.set(referencedDataFolderId, folderMappings);
      }

      if (folderMappings.kind === 'connection_unresolved') {
        // "Maps nowhere" is checked FIRST so an FK with no destination record at all keeps
        // reporting `no_destination_record` — the outcome `onUnresolved: 'ignore'` lets a user
        // skip. Only an FK that genuinely names a destination record we can't address is a
        // hard failure.
        return folderMappings.sourceRemoteIdsWithDestination.has(sourceFkValue)
          ? { kind: 'destination_connection_unresolved', reason: folderMappings.reason }
          : classifyMissingDestinationRecordCause(folderMappings, sourceFkValue);
      }

      const mapping = folderMappings.mappingBySourceRemoteId.get(sourceFkValue);
      return mapping === undefined
        ? classifyMissingDestinationRecordCause(folderMappings, sourceFkValue)
        : { kind: 'mapped', mapping };
    },

    async lookupFieldFromFkRecord(
      sourceFkValue: string,
      referencedDataFolderId: DataFolderId,
      fieldPath: string,
    ): Promise<unknown> {
      // First, try to find the FK record in the cache
      const cachedRecord = await db.client.syncForeignKeyRecord.findFirst({
        where: {
          syncId,
          dataFolderId: referencedDataFolderId,
          foreignKeyValue: sourceFkValue,
        },
        select: { recordData: true },
      });

      if (cachedRecord?.recordData) {
        // Extract the field using the dot-path.
        // Normalize undefined (missing path) to null so callers can distinguish
        // "record not found" (undefined) from "field is null/missing" (null).
        const value: unknown = readFieldValueAtPath(cachedRecord.recordData, fieldPath);
        return value === undefined ? null : value;
      }

      // Record not found in cache — return undefined as a sentinel value.
      // Callers can distinguish this from a null field value in the referenced record.
      return undefined;
    },

    async getOrCreateDestinationAssetMapping(
      sourceAssetRemoteId: string,
      sourceDataFolderId: DataFolderId,
      destinationDataFolderId: DataFolderId,
    ): Promise<AssetMappingResult> {
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
    },

    async matchDestinationAssetByHash(
      sourceAssetRemoteId: string,
      sourceDataFolderId: DataFolderId,
      destinationDataFolderId: DataFolderId,
    ): Promise<string[]> {
      const cacheKey = `${sourceDataFolderId}:${destinationDataFolderId}`;

      // Lazy-load the cache for this folder pair
      let cache = hashMatchCache.get(cacheKey);
      if (!cache) {
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

        cache = { sourceHashByRemoteId, destRemoteIdsByHash };
        hashMatchCache.set(cacheKey, cache);
      }

      const sourceHash = cache.sourceHashByRemoteId.get(sourceAssetRemoteId);
      if (!sourceHash) return [];
      return cache.destRemoteIdsByHash.get(sourceHash) ?? [];
    },
  };
}
