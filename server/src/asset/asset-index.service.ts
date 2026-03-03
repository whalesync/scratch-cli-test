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
      await this.db.client.$transaction(
        c.map((entry) =>
          this.db.client.asset.upsert({
            where: {
              workbookId_service_remoteAssetId_recordFilePath: {
                workbookId: entry.workbookId,
                service: entry.service,
                remoteAssetId: entry.remoteAssetId,
                recordFilePath: entry.recordFilePath,
              },
            },
            update: {
              recordRemoteId: entry.recordRemoteId,
              fieldPath: entry.fieldPath,
              assetContext: entry.assetContext,
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
              recordFilePath: entry.recordFilePath,
              recordRemoteId: entry.recordRemoteId,
              fieldPath: entry.fieldPath,
              assetContext: entry.assetContext,
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
  async findStaleEntries(workbookId: string, recordFilePath: string, before: Date, limit: number) {
    return this.db.client.asset.findMany({
      where: {
        workbookId,
        recordFilePath,
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
   * Get all assets for a specific record file.
   */
  async getAssetsForRecord(workbookId: string, recordFilePath: string) {
    return this.db.client.asset.findMany({
      where: { workbookId, recordFilePath },
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
