import { Injectable } from '@nestjs/common';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';

/**
 * Persistence + lookup helper for the `RecreatedIdMap` table.
 *
 * The table records `(folder, priorRemoteId) → newRemoteId` per
 * `(workbookId, connectorAccountId)`. It is populated by the publish job when
 * a record carrying a `scratch_pending_recreate_<old_id>` sentinel id is
 * successfully created (the connector assigns a fresh id; we store the
 * mapping). It is read by the publish job when dispatching create batches to
 * rewrite FK fields whose literal value matches a prior id — so sibling
 * reverts that referenced the old id automatically relink to the new id.
 *
 * Transitive chains (a recreated record is itself deleted-and-recreated
 * again) are resolved by chain-following at lookup time, with a depth limit
 * to guard against any cycle that could form from data corruption.
 */
@Injectable()
export class RecreatedIdMapService {
  /** Max chain length when resolving transitive remaps. Cycles produce a warn-and-return. */
  private static readonly MAX_CHAIN_DEPTH = 16;

  constructor(private readonly db: DbService) {}

  /**
   * Upsert a `priorRemoteId → newRemoteId` mapping. Called from the publish
   * job's create dispatch after the connector confirms the new id. Safe to
   * call repeatedly for the same prior id — the second call overwrites the
   * first (same record was deleted-and-recreated more than once before the
   * dispatch path saw the previous mapping; the newer id is canonical).
   */
  async upsert(args: {
    workbookId: string;
    connectorAccountId: string;
    folder: string;
    priorRemoteId: string;
    newRemoteId: string;
  }): Promise<void> {
    await this.db.client.recreatedIdMap.upsert({
      where: {
        workbookId_connectorAccountId_folder_priorRemoteId: {
          workbookId: args.workbookId,
          connectorAccountId: args.connectorAccountId,
          folder: args.folder,
          priorRemoteId: args.priorRemoteId,
        },
      },
      create: {
        workbookId: args.workbookId,
        connectorAccountId: args.connectorAccountId,
        folder: args.folder,
        priorRemoteId: args.priorRemoteId,
        newRemoteId: args.newRemoteId,
      },
      update: {
        newRemoteId: args.newRemoteId,
        settledAt: new Date(),
      },
    });
  }

  /**
   * Resolve `priorRemoteId` to its current `newRemoteId` for a given folder,
   * chain-following through repeated recreate cycles. Returns `null` if no
   * mapping exists at all (the literal id is either still valid on the
   * connector or was never reverted-and-recreated).
   *
   * Chain-follow example: project id 5 was deleted+revived as 105, then 105
   * was deleted+revived as 205. Map has `(5→105)` and `(105→205)`.
   * `resolveLatest(folder=projects, 5)` walks 5 → 105 → 205 → done → returns
   * `205`.
   */
  async resolveLatest(args: {
    workbookId: string;
    connectorAccountId: string;
    folder: string;
    priorRemoteId: string;
  }): Promise<string | null> {
    const seen = new Set<string>();
    let current = args.priorRemoteId;
    for (let depth = 0; depth < RecreatedIdMapService.MAX_CHAIN_DEPTH; depth++) {
      if (seen.has(current)) {
        WSLogger.warn({
          source: 'RecreatedIdMapService.resolveLatest',
          message: 'Cycle detected in RecreatedIdMap chain — returning last id visited',
          workbookId: args.workbookId,
          data: {
            connectorAccountId: args.connectorAccountId,
            folder: args.folder,
            startId: args.priorRemoteId,
            cycledAt: current,
          },
        });
        return current;
      }
      seen.add(current);
      const row = await this.db.client.recreatedIdMap.findUnique({
        where: {
          workbookId_connectorAccountId_folder_priorRemoteId: {
            workbookId: args.workbookId,
            connectorAccountId: args.connectorAccountId,
            folder: args.folder,
            priorRemoteId: current,
          },
        },
        select: { newRemoteId: true },
      });
      if (!row) {
        // First iteration with no row means the prior id has no mapping at
        // all — return null so the caller knows to leave the FK alone.
        // Subsequent iteration with no row means we walked the chain and
        // landed on a stable id — return it.
        return depth === 0 ? null : current;
      }
      current = row.newRemoteId;
    }
    WSLogger.warn({
      source: 'RecreatedIdMapService.resolveLatest',
      message: 'Hit MAX_CHAIN_DEPTH while resolving RecreatedIdMap chain — returning current id',
      workbookId: args.workbookId,
      data: {
        connectorAccountId: args.connectorAccountId,
        folder: args.folder,
        startId: args.priorRemoteId,
        depth: RecreatedIdMapService.MAX_CHAIN_DEPTH,
      },
    });
    return current;
  }

  /**
   * Batch variant of `resolveLatest`. Returns a `Map<priorRemoteId, newRemoteId>`
   * containing only the prior ids that had a resolution. Useful when a single
   * record's FK fields reference multiple parents — one DB pass per chain
   * step, batched across all priors at that step.
   *
   * For v1 this is just a wrapper around `resolveLatest`. If the per-publish
   * volume gets meaningful we can switch to a single SQL `WITH RECURSIVE`
   * query.
   */
  async resolveLatestBatch(args: {
    workbookId: string;
    connectorAccountId: string;
    folder: string;
    priorRemoteIds: string[];
  }): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const priorId of args.priorRemoteIds) {
      const resolved = await this.resolveLatest({
        workbookId: args.workbookId,
        connectorAccountId: args.connectorAccountId,
        folder: args.folder,
        priorRemoteId: priorId,
      });
      if (resolved !== null && resolved !== priorId) {
        out.set(priorId, resolved);
      }
    }
    return out;
  }

  /**
   * Build a lookup table mapping each FK schema's `linkedTableId` (the
   * connector's identifier for the FK target table) to the on-disk folder
   * path of that target table. Used by `dispatchCreateBatch` to resolve FK
   * fields against the remap (which is keyed by folder).
   *
   * The match heuristic is **suffix-based** because connectors encode their
   * `linkedTableId` differently from how DataFolder stores `tableId`:
   *
   *   - Postgres: FK schema's `linkedTableId = "authors"` (unqualified for
   *     the `public` schema; `"<schema>.<table>"` otherwise). DataFolder's
   *     `path = "/public/authors"` and `tableId = ["public", "authors"]`.
   *     We match by `path` ending with `/<linkedTableId>` OR with
   *     `/<linkedTableId.replace('.', '/')>`.
   *   - Airtable / Webflow / SaaS connectors: usually use opaque ids
   *     (`tblXYZ`, `coll123`). DataFolder.path typically contains them too,
   *     either as the leaf segment or somewhere in the path. Suffix match
   *     covers both.
   *
   * Returns a `Map<linkedTableId, folderPath>` — empty when no DataFolders
   * exist for the connector account, or none match. Caller falls back to
   * leaving FKs alone when a particular FK's target table isn't in the map.
   */
  async resolveFkTargetFolders(args: {
    workbookId: string;
    connectorAccountId: string;
    linkedTableIds: string[];
  }): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (args.linkedTableIds.length === 0) return result;

    const folders = await this.db.client.dataFolder.findMany({
      where: {
        workbookId: args.workbookId,
        connectorAccountId: args.connectorAccountId,
      },
      select: { path: true, tableId: true },
    });

    for (const linkedTableId of args.linkedTableIds) {
      const slashed = `/${linkedTableId.replace(/\./g, '/')}`;
      const candidates = folders.filter(
        (f) => f.path !== null && (f.path.endsWith(`/${linkedTableId}`) || f.path.endsWith(slashed)),
      );
      if (candidates.length === 1 && candidates[0].path) {
        // Strip leading slash to match the folder string the CLI stores
        // (file paths in patches are `public/posts/post-1.json`, the
        // RecreatedIdMap row's `folder` is `public/posts`).
        result.set(linkedTableId, candidates[0].path.replace(/^\//, ''));
      }
      // Zero matches or ambiguous matches → don't surface; the FK rewrite
      // skips this field. Logged once per ambiguous case below for observability.
      if (candidates.length > 1) {
        WSLogger.warn({
          source: 'RecreatedIdMapService.resolveFkTargetFolders',
          message: 'Ambiguous FK target folder match — skipping rewrite for this linkedTableId',
          workbookId: args.workbookId,
          data: {
            connectorAccountId: args.connectorAccountId,
            linkedTableId,
            candidates: candidates.map((c) => c.path),
          },
        });
      }
    }
    return result;
  }

  /**
   * Cascade cleanup for `WorkbookService.delete`. The table has no Prisma
   * relation back to Workbook (matches the FileIndex pattern), so explicit
   * deletion before the workbook row goes away keeps the table from
   * accumulating orphaned rows.
   */
  async deleteForWorkbook(workbookId: string): Promise<void> {
    const result = await this.db.client.recreatedIdMap.deleteMany({
      where: { workbookId },
    });
    if (result.count > 0) {
      WSLogger.info({
        source: 'RecreatedIdMapService.deleteForWorkbook',
        message: `Removed ${result.count} RecreatedIdMap row(s) for workbook ${workbookId}`,
        workbookId,
      });
    }
  }
}
