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
    matchDestinationAssetByHash: () => Promise.resolve(null),
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
  // Cache for hash matching: loaded once per (sourceFolder, destFolder) pair, then in-memory lookups
  const hashMatchCache = new Map<
    string,
    { sourceHashByRemoteId: Map<string, string>; destRemoteIdByHash: Map<string, string> }
  >();

  return {
    async getDestinationMappingForSourceFk(
      sourceFkValue: string,
      referencedDataFolderId: DataFolderId,
    ): Promise<FkMappingResult | null> {
      // Look up the destination file path and remote ID for the source FK value.
      // The FK value is a remote ID from the source system, and we need to find
      // the corresponding destination mapping using SyncRemoteIdMapping.
      const mapping = await db.client.syncRemoteIdMapping.findFirst({
        where: {
          syncId,
          dataFolderId: referencedDataFolderId,
          sourceRemoteId: sourceFkValue,
        },
        select: { destinationFilePath: true, destinationRemoteId: true },
      });

      if (!mapping?.destinationFilePath) {
        return null;
      }

      return {
        destinationFilePath: mapping.destinationFilePath,
        destinationRemoteId: mapping.destinationRemoteId ?? null,
      };
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
    ): Promise<string | null> {
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
        const destRemoteIdByHash = new Map<string, string>();
        for (const a of destAssets) {
          if (a.contentHash) destRemoteIdByHash.set(a.contentHash, a.remoteAssetId);
        }

        hashMatchCache.set(cacheKey, { sourceHashByRemoteId, destRemoteIdByHash });
      }

      const cache = hashMatchCache.get(cacheKey)!;
      const sourceHash = cache.sourceHashByRemoteId.get(sourceAssetRemoteId);
      if (!sourceHash) return null;
      return cache.destRemoteIdByHash.get(sourceHash) ?? null;
    },
  };
}
