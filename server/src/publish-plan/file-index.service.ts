import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { chunk } from 'lodash';
import { DbService } from '../db/db.service';
import { escapeLikeWildcards } from '../utils/prisma-like';
import { parsePath } from './utils';

/**
 * How stale a FileIndex row's `lastSeenAt` may get before `upsertBatch` rewrites an otherwise
 * unchanged row just to refresh it. Keeps repeated pulls of an unchanged folder write-free while
 * leaving `lastSeenAt` a day-granular liveness signal (orphan investigations rely on live rows
 * being re-stamped and orphans ageing — see DEV-10885 / DEV-11242).
 */
export const FILE_INDEX_LAST_SEEN_AT_REFRESH_INTERVAL_HOURS = 24;

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
   * Bulk upsert index entries: one multi-row `INSERT ... ON CONFLICT DO UPDATE` per chunk.
   *
   * An existing row is only rewritten when something about it changed — its filename (a rename),
   * its connection (a backfill of the DEV-10880 discriminator) — or when its `lastSeenAt` is older
   * than {@link FILE_INDEX_LAST_SEEN_AT_REFRESH_INTERVAL_HOURS}. Re-pulling a large unchanged
   * folder used to rewrite every row (and, while `lastSeenAt` was indexed, every index) on every
   * run; now it writes nothing until the daily refresh is due. `lastSeenAt` therefore means "a
   * pull or publish saw this row within that interval of this timestamp", which still separates
   * live rows from orphans that nothing re-affirms any more.
   */
  async upsertBatch(entries: FileIndexEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // A multi-row ON CONFLICT DO UPDATE fails if one statement touches the same key twice, so
    // collapse duplicates first. Last entry wins, matching the per-row upserts this replaced.
    const lastEntryByUniqueKey = new Map<string, FileIndexEntry>();
    for (const entry of entries) {
      lastEntryByUniqueKey.set(JSON.stringify([entry.workbookId, entry.folderPath, entry.recordId]), entry);
    }
    const dedupedEntries = [...lastEntryByUniqueKey.values()];

    // 5 bind parameters per row, well under the 32,767 bind-parameter limit (int16 max in
    // Postgres' extended protocol; see publish-plan-build.service.ts for the measurement).
    // `lastSeenAt` is stamped in SQL as UTC wall-clock time, the same convention Prisma uses
    // for its `timestamp(3)` DateTime columns.
    for (const entryChunk of chunk(dedupedEntries, 1000)) {
      const values = Prisma.join(
        entryChunk.map(
          (entry) =>
            Prisma.sql`(gen_random_uuid()::text, ${entry.workbookId}, ${entry.folderPath}, ${entry.recordId}, ${entry.filename}, ${entry.connectorAccountId}, NOW() AT TIME ZONE 'UTC')`,
        ),
      );
      // `connectorAccountId`: backfill the connection discriminator when a caller supplies one,
      // but never clobber an already-set value back to NULL. Every connector-backed caller now
      // supplies a real id, so in practice a NULL only arrives for a connector-less (scratch)
      // row, whose NULL is already correct.
      await this.db.client.$executeRaw`
        INSERT INTO "FileIndex" ("id", "workbookId", "folderPath", "recordId", "filename", "connectorAccountId", "lastSeenAt")
        VALUES ${values}
        ON CONFLICT ("workbookId", "folderPath", "recordId") DO UPDATE
        SET "filename" = EXCLUDED."filename",
            "connectorAccountId" = COALESCE(EXCLUDED."connectorAccountId", "FileIndex"."connectorAccountId"),
            "lastSeenAt" = EXCLUDED."lastSeenAt"
        WHERE "FileIndex"."filename" IS DISTINCT FROM EXCLUDED."filename"
           OR "FileIndex"."connectorAccountId" IS DISTINCT FROM COALESCE(EXCLUDED."connectorAccountId", "FileIndex"."connectorAccountId")
           OR "FileIndex"."lastSeenAt" IS NULL
           OR "FileIndex"."lastSeenAt" < EXCLUDED."lastSeenAt" - make_interval(hours => ${FILE_INDEX_LAST_SEEN_AT_REFRESH_INTERVAL_HOURS}::int)
      `;
    }
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
        const entries = await this.db.runQueryWithCustomPlanForBoundParameterValues(
          this.db.client.fileIndex.findMany({
            where: { workbookId, folderPath, filename: { in: filenameChunk } },
            select: { folderPath: true, filename: true, recordId: true, connectorAccountId: true },
          }),
        );
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
      const entries = await this.db.runQueryWithCustomPlanForBoundParameterValues(
        this.db.client.fileIndex.findMany({
          where: { workbookId, folderPath, recordId: { in: recordIdChunk } },
          select: { recordId: true, filename: true },
        }),
      );
      for (const e of entries) {
        map.set(e.recordId, e.filename);
      }
    }
    return map;
  }

  /**
   * `filename → recordId` for the given filenames in one folder, across every connection
   * (the last matching row wins for a filename two connections share). Used by publish's
   * rename phase to find the ids its create phase assigned to pending files.
   */
  async getRecordIdsByFilenamesInFolder(
    workbookId: string,
    folderPath: string,
    filenames: string[],
  ): Promise<Map<string, string>> {
    const recordIdByFilename = new Map<string, string>();
    for (const filenameChunk of chunk(filenames, 1000)) {
      const entries = await this.db.runQueryWithCustomPlanForBoundParameterValues(
        this.db.client.fileIndex.findMany({
          where: { workbookId, folderPath, filename: { in: filenameChunk } },
          select: { filename: true, recordId: true },
        }),
      );
      for (const entry of entries) {
        recordIdByFilename.set(entry.filename, entry.recordId);
      }
    }
    return recordIdByFilename;
  }

  /**
   * `recordId → filename` for every row indexed in the folder, in one query. A full pull reads
   * this once up front instead of looking up each connector page's record ids separately; the
   * map's values double as the folder's taken-filename set.
   */
  async readRecordIdToFilenameMapForFolder(workbookId: string, folderPath: string): Promise<Map<string, string>> {
    const entries = await this.db.client.fileIndex.findMany({
      where: { workbookId, folderPath },
      select: { recordId: true, filename: true },
    });
    return new Map(entries.map((entry) => [entry.recordId, entry.filename]));
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

  /**
   * Delete the index rows for record files that a pull's stale-file cleanup has
   * just removed from the repo — every row whose (folderPath, filename) matches
   * one of `deletedFilePaths` (`<folderPath>/<filename>`, no leading slash).
   *
   * Without this the index keeps a row for every file a full pull ever deleted,
   * and `listFilenamesForFolder` — which seeds the filename-collision set for
   * pulled and published creates — keeps reporting those ghost names as taken.
   * A record that was deleted upstream and re-created with a new id then gets
   * an id-suffixed filename (`brand-new-company-<id>.json`) for no reason
   * (DEV-11438).
   *
   * Scoped strictly to `connectorAccountId`, like `deleteRowsOwnedByDeletedFolder`:
   * folder paths are workbook-global, so two connections can hold an
   * identically-named file at the same path, and only this connection's row
   * may go. Legacy rows with a NULL connection are intentionally not matched
   * (see the `connectorAccountId` schema comment).
   */
  async deleteRowsForDeletedFiles(
    workbookId: string,
    connectorAccountId: string | null,
    deletedFilePaths: string[],
  ): Promise<void> {
    const filenamesByFolderPath = new Map<string, string[]>();
    for (const deletedFilePath of deletedFilePaths) {
      const { folderPath, filename } = parsePath(deletedFilePath);
      const filenames = filenamesByFolderPath.get(folderPath);
      if (filenames) {
        filenames.push(filename);
      } else {
        filenamesByFolderPath.set(folderPath, [filename]);
      }
    }
    for (const [folderPath, filenames] of filenamesByFolderPath) {
      for (const filenameChunk of chunk(filenames, 1000)) {
        await this.db.runQueryWithCustomPlanForBoundParameterValues(
          this.db.client.fileIndex.deleteMany({
            where: { workbookId, connectorAccountId, folderPath, filename: { in: filenameChunk } },
          }),
        );
      }
    }
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
