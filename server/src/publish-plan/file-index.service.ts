import { Injectable } from '@nestjs/common';
import { chunk } from 'lodash';
import { DbService } from '../db/db.service';
import { escapeLikeWildcards } from '../utils/prisma-like';

export interface FileIndexEntry {
  workbookId: string;
  folderPath: string;
  recordId: string;
  filename: string;
  // The connection this row belongs to. `folderPath` is connection-relative and
  // workbook-global, so this is the discriminator that lets a workspace-absolute
  // pseudo-ref resolve to the right connection when two connections expose an
  // identically-named folder (DEV-10880). `null` ONLY for a connector-less (scratch)
  // folder, which has no connection; every connector-backed row carries one
  // (DEV-11242 resolved the last legacy NULLs on prod).
  //
  // REQUIRED, not optional, even though `null` is a legal value: a scoped lookup is
  // now a strict match, so a write site that quietly omits this produces a row no
  // scoped lookup can ever resolve. Optionality hid exactly that bug in three
  // integration fixtures until publish failed at runtime with "Could not resolve
  // remote ID"; making it required turns the same mistake into a compile error.
  connectorAccountId: string | null;
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
    // Chunking to avoid the 32,767 bind-parameter limit (int16 max in Postgres'
    // extended protocol; see publish-plan-build.service.ts for the measurement)
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
              // Backfill the connection discriminator when a caller supplies one, but
              // leave an already-set value intact when it passes null — `undefined` tells
              // Prisma to skip the field rather than clobber it back to NULL. Every
              // connector-backed caller now supplies a real id, so in practice this only
              // skips for a connector-less (scratch) row, whose NULL is already correct.
              connectorAccountId: entry.connectorAccountId ?? undefined,
              lastSeenAt: now,
            },
            create: {
              workbookId: entry.workbookId,
              folderPath: entry.folderPath,
              recordId: entry.recordId,
              filename: entry.filename,
              connectorAccountId: entry.connectorAccountId ?? null,
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

  async getRecordId(
    workbookId: string,
    folderPath: string,
    filename: string,
    // When provided, this is a STRICT scope: the row belonging to this connection,
    // or null. It never resolves to another connection's row at the same
    // folderPath+filename. Omit it for a workbook-global lookup (a connector-less
    // scratch folder). See `pickPreferredRecordId`.
    connectorAccountId?: string | null,
  ): Promise<string | null> {
    const entries = await this.db.client.fileIndex.findMany({
      where: { workbookId, folderPath, filename },
      select: { recordId: true, connectorAccountId: true },
    });
    if (entries.length === 0) return null;
    return pickPreferredRecordId(entries, connectorAccountId);
  }

  /**
   * Bulk `(connection, folderPath, filename) → recordId` lookup, keyed by
   * {@link fileIndexLookupKey} — build the read key with that helper rather than by hand.
   *
   * The result carries ONE ENTRY PER LOOKUP, and the connection is part of the key. It used
   * to be keyed `folderPath:filename` with the connection as a mere row-preference hint, which
   * silently collapsed two lookups for the same path in different connections onto a single
   * entry — so a batch asking for `@/HubSpot/Contacts/x.json` AND
   * `@/HubSpot Testing/Contacts/x.json` got the SAME record id for both, and publish wrote the
   * wrong id to the service. That was tolerable only while pseudo-refs resolved within one
   * plan connection; now that every ref carries its own connection segment (DEV-11238) a batch
   * routinely spans connections, so the connection belongs in the key.
   *
   * Within a key, `connectorAccountId` **scopes** the match strictly (DEV-11242): a key whose
   * rows all belong to some other connection is simply absent from the result rather than
   * resolving to that connection's record. A lookup naming NO connection stays workbook-global
   * "first matching row wins" — the connector-less (scratch) folder case. See
   * {@link pickPreferredRecordId}.
   */
  async getRecordIds(
    workbookId: string,
    lookups: { folderPath: string; filename: string; connectorAccountId?: string | null }[],
  ): Promise<Map<string, string>> {
    if (lookups.length === 0) return new Map();

    // Group filenames by folderPath so we can query with `filename IN (...)` per
    // folder instead of a giant OR with thousands of conditions.
    const filenamesByFolder = new Map<string, Set<string>>();
    for (const { folderPath, filename } of lookups) {
      let filenameSet = filenamesByFolder.get(folderPath);
      if (!filenameSet) {
        filenameSet = new Set();
        filenamesByFolder.set(folderPath, filenameSet);
      }
      filenameSet.add(filename);
    }

    // Every matching row per path — across all connections, since the query can't filter by
    // connection without losing the NULL-scoped fallback rows.
    const rowsByPath = new Map<string, { connectorAccountId: string | null; recordId: string }[]>();
    for (const [folderPath, filenameSet] of filenamesByFolder) {
      for (const filenameChunk of chunk([...filenameSet], 1000)) {
        const entries = await this.db.client.fileIndex.findMany({
          where: { workbookId, folderPath, filename: { in: filenameChunk } },
          select: { folderPath: true, filename: true, recordId: true, connectorAccountId: true },
        });
        for (const e of entries) {
          const path = `${e.folderPath}:${e.filename}`;
          const rows = rowsByPath.get(path);
          if (rows) {
            rows.push({ connectorAccountId: e.connectorAccountId, recordId: e.recordId });
          } else {
            rowsByPath.set(path, [{ connectorAccountId: e.connectorAccountId, recordId: e.recordId }]);
          }
        }
      }
    }

    // Resolve each lookup independently against its own connection scope. A lookup whose
    // rows all belong to some OTHER connection resolves to nothing and is simply absent from
    // the map — the caller then reports it unresolved, which is the honest answer.
    const recordIdByLookupKey = new Map<string, string>();
    for (const lookup of lookups) {
      const rows = rowsByPath.get(`${lookup.folderPath}:${lookup.filename}`);
      if (rows === undefined) continue;
      const recordId = pickPreferredRecordId(rows, lookup.connectorAccountId);
      if (recordId !== null) recordIdByLookupKey.set(fileIndexLookupKey(lookup), recordId);
    }
    return recordIdByLookupKey;
  }

  async getFilename(workbookId: string, folderPath: string, recordId: string): Promise<string | null> {
    const entry = await this.db.client.fileIndex.findUnique({
      where: { workbookId_folderPath_recordId: { workbookId, folderPath, recordId } },
      select: { filename: true },
    });
    return entry?.filename || null;
  }

  async getFilenamesByRecordIds(
    workbookId: string,
    folderPath: string,
    recordIds: string[],
  ): Promise<Map<string, string>> {
    if (recordIds.length === 0) return new Map();

    const map = new Map<string, string>();
    for (const recordIdChunk of chunk(recordIds, 1000)) {
      const entries = await this.db.client.fileIndex.findMany({
        where: { workbookId, folderPath, recordId: { in: recordIdChunk } },
        select: { recordId: true, filename: true },
      });
      for (const e of entries) {
        map.set(e.recordId, e.filename);
      }
    }
    return map;
  }

  /**
   * Return every filename currently indexed for the folder. Used by pull jobs
   * to seed the dedup conflict set at the start of a pull so a new record's
   * suggested filename can't silently clobber another record's prior filename.
   * Backed by the @@index([workbookId, folderPath, filename]) on FileIndex.
   */
  async listFilenamesForFolder(workbookId: string, folderPath: string): Promise<string[]> {
    const entries = await this.db.client.fileIndex.findMany({
      where: { workbookId, folderPath },
      select: { filename: true },
    });
    return entries.map((e) => e.filename);
  }

  async deleteForWorkbook(workbookId: string): Promise<void> {
    await this.db.client.fileIndex.deleteMany({
      where: { workbookId },
    });
  }

  /**
   * Delete every index row for a whole connection. Post-DEV-10880 each row carries
   * `connectorAccountId`, so this single scoped delete removes the connection's rows
   * regardless of `folderPath` — including rows stored under a `folderPath` deeper
   * than the DataFolder path (e.g. a Shopify variant whose slash-bearing GID id
   * leaks into `folderPath`). Used when a connection is deleted or reset (DEV-10885).
   *
   * NOTE: legacy rows written before DEV-10880 have `connectorAccountId = NULL` and
   * are intentionally NOT matched here (Postgres treats NULL as distinct). Those
   * pre-existing orphans are swept by the one-time GC migration (DEV-10885 Phase B).
   */
  async deleteForConnection(workbookId: string, connectorAccountId: string): Promise<void> {
    await this.db.client.fileIndex.deleteMany({
      where: { workbookId, connectorAccountId },
    });
  }

  /**
   * Delete the index rows owned by a SINGLE data folder that is being deleted,
   * including rows stored under a `folderPath` deeper than the folder's own path
   * (the Shopify-GID case that a plain exact-`folderPath` delete misses). Two guards
   * keep this from deleting rows it shouldn't:
   *  - Scoped by `connectorAccountId` (nullable): folder paths are workbook-global
   *    and carry NO connection prefix (see `buildConnectorFolderPath`), so two
   *    connections can own an identically-named folder. Scoping prevents deleting a
   *    sibling connection's rows at the same `folderPath`.
   *  - Longest-prefix ownership: a deeper `folderPath` is deleted only when this
   *    folder is its longest-prefix owner among all live folders — so a live child
   *    DataFolder nested inside this one (e.g. a Webflow secondary-locale folder at
   *    `/<Site>/Collections/<Collection>/<Locale>`) keeps its rows.
   *
   * All folder paths are passed WITHOUT a leading slash to match how they are stored.
   */
  async deleteRowsOwnedByDeletedFolder(
    workbookId: string,
    connectorAccountId: string | null,
    deletedFolderPath: string,
    otherLiveFolderPathsInWorkbook: string[],
  ): Promise<void> {
    // Rows at the folder's own path always belong to it.
    await this.db.client.fileIndex.deleteMany({
      where: { workbookId, connectorAccountId, folderPath: deletedFolderPath },
    });

    // Rows deeper than the folder's path: keep only those this folder still owns.
    // Escape LIKE wildcards so a `_`/`%` in the folderPath (e.g. `product_variants`)
    // can't over-match rows in a different folder.
    const distinctDeeperFolderPaths = await this.db.client.fileIndex.findMany({
      where: {
        workbookId,
        connectorAccountId,
        folderPath: { startsWith: `${escapeLikeWildcards(deletedFolderPath)}/` },
      },
      select: { folderPath: true },
      distinct: ['folderPath'],
    });
    const orphanedDeeperFolderPaths = distinctDeeperFolderPaths
      .map((row) => row.folderPath)
      .filter((folderPath) =>
        isDeeperFolderPathOrphanedByDelete(folderPath, deletedFolderPath, otherLiveFolderPathsInWorkbook),
      );

    for (const folderPathBatch of chunk(orphanedDeeperFolderPaths, 1000)) {
      await this.db.client.fileIndex.deleteMany({
        where: { workbookId, connectorAccountId, folderPath: { in: folderPathBatch } },
      });
    }
  }
}

/**
 * Does the DataFolder at `ownerFolderPath` own a row stored at `rowFolderPath`?
 * Ownership means the row is at that folder's own path or somewhere beneath it.
 * Both paths are no-leading-slash. (`Foo` does NOT own `Foo Extra` — the `/`
 * boundary check prevents sibling-prefix false positives.)
 */
export function folderPathOwns(ownerFolderPath: string, rowFolderPath: string): boolean {
  return rowFolderPath === ownerFolderPath || rowFolderPath.startsWith(`${ownerFolderPath}/`);
}

/**
 * A row stored at `rowFolderPath` (deeper than `deletedFolderPath`) is orphaned by
 * deleting that folder iff the deleted folder is the row's LONGEST-prefix owner —
 * i.e. no OTHER live folder owns it more specifically (a strictly longer prefix).
 * This sweeps Shopify-GID artifact rows (owner is the plain folder) while preserving
 * rows of a live nested child DataFolder (owner is the deeper child folder).
 */
export function isDeeperFolderPathOrphanedByDelete(
  rowFolderPath: string,
  deletedFolderPath: string,
  otherLiveFolderPathsInWorkbook: string[],
): boolean {
  if (!folderPathOwns(deletedFolderPath, rowFolderPath)) return false;
  for (const otherFolderPath of otherLiveFolderPathsInWorkbook) {
    if (otherFolderPath.length > deletedFolderPath.length && folderPathOwns(otherFolderPath, rowFolderPath)) {
      return false;
    }
  }
  return true;
}

/**
 * The key a {@link FileIndexService.getRecordIds} result is stored under: the connection plus
 * the connection-relative path. Callers must build their read key with this, so the write side
 * and the read side can't drift on the separator or on how a missing connection is encoded.
 *
 * A lookup with no connection collapses to a leading empty segment, which keeps the old
 * `:folderPath:filename` shape for the callers that never scope by connection.
 */
export function fileIndexLookupKey(lookup: {
  folderPath: string;
  filename: string;
  connectorAccountId?: string | null;
}): string {
  return `${lookup.connectorAccountId ?? ''}:${lookup.folderPath}:${lookup.filename}`;
}

/**
 * Choose one recordId from the rows matching a `(folderPath, filename)` key.
 *
 * A lookup that names a connection is a STRICT match: it resolves to that
 * connection's row or to `null`. It never falls back to another connection's row,
 * because two connections can expose the same `folderPath`+`filename` for entirely
 * different records — returning the other one would point a publish at the wrong
 * remote record. The pre-DEV-10880 fallback to an unscoped (NULL) row existed only
 * for rows written before the discriminator column; DEV-11242 drove that population
 * to zero on prod, so the fallback is gone (see `fileindex-unscoped-row-resolve`).
 *
 * A lookup that names NO connection keeps the workbook-global "first matching row"
 * behavior — the legitimate case for a connector-less (scratch) folder, whose rows
 * are still stored with a NULL `connectorAccountId`.
 */
export function pickPreferredRecordId(
  rows: { connectorAccountId: string | null; recordId: string }[],
  preferredConnectorAccountId: string | null | undefined,
): string | null {
  if (preferredConnectorAccountId == null) {
    return rows[0]?.recordId ?? null;
  }
  return rows.find((row) => row.connectorAccountId === preferredConnectorAccountId)?.recordId ?? null;
}
