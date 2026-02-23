import { Injectable } from '@nestjs/common';
import { chunk } from 'lodash';
import { DbService } from '../db/db.service';

export interface FileIndexEntry {
  workbookId: string;
  folderPath: string;
  recordId: string;
  filename: string;
}

@Injectable()
export class FileIndexService {
  constructor(private readonly db: DbService) {}

  /**
   * Bulk upsert index entries.
   * Uses raw SQL for performance to handle conflicts (update lastSeenAt).
   */
  async upsertBatch(entries: FileIndexEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // Chunking is handled by the caller or we can do it here if needed.
    // Ideally caller handles chunking (e.g. 500 at a time).

    // We strive to use Prisma's createMany, but it doesn't support "ON CONFLICT UPDATE"
    // for all databases universally in a clean way via the typed API until recent versions,
    // and even then, `upsert` is single-row.
    // Given the prototype used raw SQL, we will implement optimized batching.

    // However, Prisma `createMany` with `skipDuplicates` ignores updates. We want to update `lastSeenAt`.
    // So we use a transaction of upserts or raw SQL. Raw SQL is faster for bulk.

    const now = new Date();

    // Use Prisma Transaction for upserts.
    // Chunking to avoid Postgres 65,535 parameter limit
    const chunks = chunk(entries, 1000);

    for (const c of chunks) {
      await this.db.client.$transaction(
        c.map((entry) =>
          this.db.client.fileIndex.upsert({
            where: {
              workbookId_folderPath_recordId: {
                workbookId: entry.workbookId,
                folderPath: entry.folderPath,
                recordId: entry.recordId,
              },
            },
            update: {
              filename: entry.filename, // Filename might change (rename)
              lastSeenAt: now,
            },
            create: {
              workbookId: entry.workbookId,
              folderPath: entry.folderPath,
              recordId: entry.recordId,
              filename: entry.filename,
              lastSeenAt: now,
            },
          }),
        ),
      );
    }
  }

  /**
   * Find entries that haven't been seen since the given timestamp.
   * These likely represent records deleted upstream.
   */
  async findStaleEntries(workbookId: string, folderPath: string, before: Date, limit: number) {
    return this.db.client.fileIndex.findMany({
      where: {
        workbookId,
        folderPath,
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
    await this.db.client.fileIndex.deleteMany({
      where: {
        id: { in: ids },
      },
    });
  }

  async countEntries(workbookId: string, folderPath: string): Promise<number> {
    return this.db.client.fileIndex.count({
      where: { workbookId, folderPath },
    });
  }

  async getRecordId(workbookId: string, folderPath: string, filename: string): Promise<string | null> {
    const entry = await this.db.client.fileIndex.findFirst({
      where: { workbookId, folderPath, filename },
      select: { recordId: true },
    });
    return entry?.recordId || null;
  }

  async getRecordIds(
    workbookId: string,
    lookups: { folderPath: string; filename: string }[],
  ): Promise<Map<string, string>> {
    if (lookups.length === 0) return new Map();

    // Group by folderPath so we can query with `filename IN (...)` per folder
    // instead of a giant OR with thousands of conditions.
    const byFolder = new Map<string, string[]>();
    for (const { folderPath, filename } of lookups) {
      const existing = byFolder.get(folderPath);
      if (existing) {
        existing.push(filename);
      } else {
        byFolder.set(folderPath, [filename]);
      }
    }

    const map = new Map<string, string>();

    for (const [folderPath, filenames] of byFolder) {
      for (const filenameChunk of chunk(filenames, 1000)) {
        const entries = await this.db.client.fileIndex.findMany({
          where: { workbookId, folderPath, filename: { in: filenameChunk } },
          select: { folderPath: true, filename: true, recordId: true },
        });
        for (const e of entries) {
          map.set(`${e.folderPath}:${e.filename}`, e.recordId);
        }
      }
    }

    return map;
  }

  async getFilename(workbookId: string, folderPath: string, recordId: string): Promise<string | null> {
    const entry = await this.db.client.fileIndex.findUnique({
      where: { workbookId_folderPath_recordId: { workbookId, folderPath, recordId } },
      select: { filename: true },
    });
    return entry?.filename || null;
  }

  async removeAll(workbookId: string, folderPath: string): Promise<void> {
    await this.db.client.fileIndex.deleteMany({
      where: { workbookId, folderPath },
    });
  }

  async deleteForWorkbook(workbookId: string): Promise<void> {
    await this.db.client.fileIndex.deleteMany({
      where: { workbookId },
    });
  }
}
