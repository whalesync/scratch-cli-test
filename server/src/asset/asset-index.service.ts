import { Injectable } from '@nestjs/common';
import { chunk } from 'lodash';
import { DbService } from '../db/db.service';
import { AssetIndexEntry } from './asset.types';

/**
 * CRUD service for the Asset index table.
 * Follows the same pattern as FileIndexService.
 */
@Injectable()
export class AssetIndexService {
  constructor(private readonly db: DbService) {}

  /**
   * Bulk upsert asset entries.
   * Updates lastSeenAt and all metadata fields on conflict.
   */
  async upsertBatch(entries: AssetIndexEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const now = new Date();
    const chunks = chunk(entries, 500);

    for (const c of chunks) {
      // Filter to entries with a dataFolderId — required by the unique constraint
      const valid = c.filter((e) => e.dataFolderId != null);

      await this.db.client.$transaction(
        valid.map((entry) =>
          this.db.client.asset.upsert({
            where: {
              workbookId_dataFolderId_remoteAssetId: {
                workbookId: entry.workbookId,
                dataFolderId: entry.dataFolderId!,
                remoteAssetId: entry.remoteAssetId,
              },
            },
            update: {
              service: entry.service,
              url: entry.url,
              filename: entry.filename,
              mimeType: entry.mimeType,
              size: entry.size,
              width: entry.width,
              height: entry.height,
              altText: entry.altText,
              mediaType: entry.mediaType,
              urlExpiresAt: entry.urlExpiresAt,
              lastSeenAt: now,
            },
            create: {
              workbookId: entry.workbookId,
              service: entry.service,
              remoteAssetId: entry.remoteAssetId,
              dataFolderId: entry.dataFolderId,
              url: entry.url,
              filename: entry.filename,
              mimeType: entry.mimeType,
              size: entry.size,
              width: entry.width,
              height: entry.height,
              altText: entry.altText,
              mediaType: entry.mediaType,
              urlExpiresAt: entry.urlExpiresAt,
              lastSeenAt: now,
            },
          }),
        ),
      );
    }
  }

  /**
   * Find asset entries that haven't been seen since the given timestamp.
   */
  async findStaleEntries(workbookId: string, dataFolderId: string, before: Date, limit: number) {
    return this.db.client.asset.findMany({
      where: {
        workbookId,
        dataFolderId,
        OR: [{ lastSeenAt: { lt: before } }, { lastSeenAt: null }],
      },
      take: limit,
    });
  }

  /**
   * Remove specific entries by ID.
   */
  async removeBatch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.client.asset.deleteMany({
      where: { id: { in: ids } },
    });
  }

  /**
   * Get all assets for a specific data folder.
   */
  async getAssetsForDataFolder(workbookId: string, dataFolderId: string) {
    return this.db.client.asset.findMany({
      where: { workbookId, dataFolderId },
    });
  }

  /**
   * Delete all assets for a workbook.
   */
  async deleteForWorkbook(workbookId: string): Promise<void> {
    await this.db.client.asset.deleteMany({
      where: { workbookId },
    });
  }
}
