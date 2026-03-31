import {
  createAssetId,
  createScratchPendingPublishId,
  DataFolderId,
  Service,
  SyncId,
  WorkbookId,
} from '@spinner/shared-types';
import get from 'lodash/get';
import { DbService } from 'src/db/db.service';
import { AssetMappingResult, FkMappingResult, LookupTools } from './transformer.types';

/**
 * Creates a no-op LookupTools where every method returns null / rejects.
 * Useful in tests for transformers that don't need FK or asset lookups.
 */
export function createNullLookupTools(): LookupTools {
  return {
    getDestinationMappingForSourceFk: () => Promise.resolve(null),
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
 */
export function createLookupTools(
  db: DbService,
  syncId: SyncId,
  workbookId: WorkbookId,
  sourceService: Service,
  destinationService: Service,
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
  // Keyed by referencedDataFolderId → Map of sourceRemoteId → FkMappingResult.
  // ───────────────────────────────────────────────────────────────────────────
  const fkMappingCache = new Map<DataFolderId, Map<string, FkMappingResult>>();

  // Cache for hash matching: loaded once per (sourceFolder, destFolder) pair, then in-memory lookups
  const hashMatchCache = new Map<
    string,
    { sourceHashByRemoteId: Map<string, string>; destRemoteIdsByHash: Map<string, string[]> }
  >();

  return {
    async getDestinationMappingForSourceFk(
      sourceFkValue: string,
      referencedDataFolderId: DataFolderId,
    ): Promise<FkMappingResult | null> {
      // Lazy-load all mappings for this referenced folder on first access.
      // Subsequent calls for the same folder hit the in-memory Map (O(1) lookup)
      // instead of making a DB round-trip per FK element.
      if (!fkMappingCache.has(referencedDataFolderId)) {
        const rows = await db.client.syncRemoteIdMapping.findMany({
          where: {
            syncId,
            dataFolderId: referencedDataFolderId,
          },
          select: { sourceRemoteId: true, destinationFilePath: true, destinationRemoteId: true },
        });

        const map = new Map<string, FkMappingResult>();
        for (const row of rows) {
          if (row.destinationFilePath) {
            map.set(row.sourceRemoteId, {
              destinationFilePath: row.destinationFilePath,
              destinationRemoteId: row.destinationRemoteId ?? null,
            });
          }
        }
        fkMappingCache.set(referencedDataFolderId, map);
      }

      return fkMappingCache.get(referencedDataFolderId)!.get(sourceFkValue) ?? null;
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
        const value: unknown = get(cachedRecord.recordData as object, fieldPath);
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
      if (!hashMatchCache.has(cacheKey)) {
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

        hashMatchCache.set(cacheKey, { sourceHashByRemoteId, destRemoteIdsByHash });
      }

      const cache = hashMatchCache.get(cacheKey)!;
      const sourceHash = cache.sourceHashByRemoteId.get(sourceAssetRemoteId);
      if (!sourceHash) return [];
      return cache.destRemoteIdsByHash.get(sourceHash) ?? [];
    },
  };
}
