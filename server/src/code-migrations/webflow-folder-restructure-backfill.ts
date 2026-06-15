/**
 * DEV-9698 (T2) — per-folder decision logic for the Webflow folder-restructure
 * migration: re-parents every existing Webflow **CMS collection** folder from
 * the flat v1 layout `/<Site>/<Collection>` to the nested v2 layout
 * `/<Site>/Collections/<Collection>`. Assets and Pages folders never move.
 *
 * This module is the pure, dependency-injected core. The orchestrator lives in
 * [CodeMigrationsController](./code-migrations.controller.ts)
 * (`runWebflowFolderRestructure`) — it wires the real Prisma / scratch-git /
 * audit services into `WebflowFolderRestructureDeps`, sorts the candidate
 * folders into a safe move order, calls `migrateWebflowCollectionFolder` once
 * per folder, then flips `ConnectorAccount.version` to 2 for every account whose
 * collection folders are all migrated. Triggered via the admin
 * `POST /code-migrations/run` endpoint with
 * `migration: 'webflow-folder-restructure'`.
 *
 * Idempotency & crash-safety
 * --------------------------
 * The per-folder idempotency key is `DataFolder.version`: a folder at version >=
 * 2 is already nested and is skipped. The git move (step b) and the atomic DB
 * rewrite (step c — `DataFolder.path` + `version` + every dependent path column
 * in ONE Postgres transaction) are ordered so that `version` only reaches 2 once
 * the path has been rewritten in the same commit. Therefore a crash between the
 * git move and the DB commit leaves `version` still 1 with the old path, and
 * a re-run recomputes the same target, finds the git move already done (the
 * `move_folder` route is a no-op when the source is gone and the destination is
 * present), and finishes the DB commit. Every step converges.
 */

import { Prisma } from '@prisma/client';
import { DataFolderId } from '@spinner/shared-types';
import {
  WEBFLOW_COLLECTIONS_FOLDER_SEGMENT,
  WEBFLOW_NESTED_STRUCTURE_VERSION,
} from 'src/remote-service/connectors/library/webflow/webflow-folder-paths';
import {
  WEBFLOW_ASSETS_TABLE_ID_PREFIX,
  WEBFLOW_PAGES_TABLE_ID_PREFIX,
} from 'src/remote-service/connectors/library/webflow/webflow-json-schema';
import { escapeConnectorFolderPathSegment } from 'src/workbook/connector-folder-path.util';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker placed on audit-log entries created by this migration so a future
 * rollback (or an audit) can identify exactly which DataFolder moves came from
 * this migration vs. ordinary user activity. Queryable via
 * `WHERE context->>'marker' = 'webflow_folder_restructure'`.
 */
export const WEBFLOW_FOLDER_RESTRUCTURE_AUDIT_MARKER = 'webflow_folder_restructure';

// ---------------------------------------------------------------------------
// Pure path computation — the C1 drift-guarded target-path derivation.
// ---------------------------------------------------------------------------

/**
 * Splits a leading-slash POSIX folder path into `{ parentDirPath, leafSegment }`
 * — i.e. dirname/basename — preserving the leading slash on the parent. Returns
 * `null` for any shape that is not a well-formed `/a/b[/c…]` path with at least
 * two non-empty segments (e.g. `/`, `/x`, `//x`, a trailing slash, or an empty
 * interior segment), which the migration skips-with-warning rather than moving.
 */
export function splitFolderPathIntoParentAndLeaf(
  folderPath: string,
): { parentDirPath: string; leafSegment: string } | null {
  if (!folderPath.startsWith('/')) return null;
  const segments = folderPath.split('/');
  // A leading-slash path splits with an empty first element; every remaining
  // element must be a non-empty segment, and there must be at least two of them
  // (a site segment and a collection segment).
  const nonRootSegments = segments.slice(1);
  if (nonRootSegments.length < 2) return null;
  if (nonRootSegments.some((segment) => segment.length === 0)) return null;

  const leafSegment = nonRootSegments[nonRootSegments.length - 1];
  const parentDirPath = '/' + nonRootSegments.slice(0, -1).join('/');
  return { parentDirPath, leafSegment };
}

export type NestedCollectionPathResult = { kind: 'ok'; newFolderPath: string } | { kind: 'bad_shape'; reason: string };

/**
 * Computes the v2 (nested) path for a Webflow CMS collection given its current
 * v1 (flat) path and the collection's display name.
 *
 *   `/<Site>/<Collection>`  →  `/<Site>/Collections/<escape(name)>`
 *
 * The parent (site) segment is taken verbatim from the current path's dirname —
 * it is already an escaped segment that a prior pull wrote, so re-using it keeps
 * the site name byte-identical. The leaf is recomputed from `DataFolder.name`
 * through the **shared** segment escaper, which (a) matches what a fresh v2 pull
 * would write for the same collection (finding C1) and (b) repairs any
 * `ensureUniquePath` `-{id5}` collision suffix that the old leaf may have carried
 * (the suffix only ever lands on `path`, never on `name`).
 */
export function computeNestedWebflowCollectionPath(
  currentFolderPath: string,
  collectionName: string,
): NestedCollectionPathResult {
  const split = splitFolderPathIntoParentAndLeaf(currentFolderPath);
  if (!split) {
    return { kind: 'bad_shape', reason: `path is not a well-formed /<Site>/<Collection> path: "${currentFolderPath}"` };
  }

  const escapedLeafSegment = escapeConnectorFolderPathSegment(collectionName);
  if (escapedLeafSegment.length === 0) {
    return { kind: 'bad_shape', reason: `collection name escapes to an empty segment: "${collectionName}"` };
  }

  const newFolderPath = `${split.parentDirPath}/${WEBFLOW_COLLECTIONS_FOLDER_SEGMENT}/${escapedLeafSegment}`;
  return { kind: 'ok', newFolderPath };
}

/**
 * True when a folder's current path is itself the `/<Site>/Collections` shape —
 * i.e. a CMS collection a user literally named "Collections". Such a folder is
 * the prefix case (`/<Site>/Collections` → `/<Site>/Collections/Collections`)
 * and MUST migrate before its siblings: once any sibling has moved into
 * `/<Site>/Collections/<Sibling>`, the `move_folder` route sees those relocated
 * siblings as nested folders under `/<Site>/Collections` and refuses to move the
 * "Collections" collection. See `sortWebflowCollectionFoldersForSafeMoveOrder`.
 */
export function isCollectionsNamedCollectionFolder(currentFolderPath: string): boolean {
  const split = splitFolderPathIntoParentAndLeaf(currentFolderPath);
  return split?.leafSegment === WEBFLOW_COLLECTIONS_FOLDER_SEGMENT;
}

// ---------------------------------------------------------------------------
// Pure file-path prefix rewrite — mirrors the SQL the executor runs in Postgres.
// ---------------------------------------------------------------------------

/**
 * Rewrites a single file path that lives directly under `oldFolderPath` so it
 * lives under `newFolderPath` instead, returning the path unchanged if it is not
 * actually under `oldFolderPath`.
 *
 * Prefix-safety (finding #10): the match is on the folder boundary
 * `oldFolderPath + '/'`, so moving `Site/Blog` never touches `Site/Blog Posts`.
 * Because `move_folder` refuses to move a folder that contains a nested data
 * folder, every record file under a migrated folder is a direct child
 * (`<oldFolderPath>/<filename>` with no further slashes), so swapping the folder
 * prefix is sufficient.
 *
 * This is the JS twin of the boundary-prefix `UPDATE` the controller's executor
 * runs (`left(col, len(old)+1) = old || '/'`); both are kept deliberately
 * identical so the unit tests here pin the semantics the SQL implements. Pass the
 * SAME slash convention the target column stores: the record/file-path columns
 * (FileReference/SyncMatchKeys/SyncRemoteIdMapping/UploadPatchMeta/FileIndex) store
 * paths with **no leading slash** (`My Site/Blog Posts/rec.json`), so `old`/`new`
 * here are the no-leading-slash folder paths — NOT `DataFolder.path`'s leading-slash
 * form. (Mismatching the convention would silently match nothing.)
 */
export function rewriteFilePathFolderPrefix(filePath: string, oldFolderPath: string, newFolderPath: string): string {
  const boundaryPrefix = oldFolderPath + '/';
  if (!filePath.startsWith(boundaryPrefix)) return filePath;
  return newFolderPath + filePath.slice(oldFolderPath.length);
}

// ---------------------------------------------------------------------------
// Move ordering — "Collections"-named collections migrate first per site.
// ---------------------------------------------------------------------------

/**
 * Orders a batch of candidate collection folders so that, within each site (a
 * unique `connectorAccountId` + parent-dir pair), a collection literally named
 * "Collections" — the prefix case — migrates before any of its siblings. Without
 * this, a sibling that has already moved into `/<Site>/Collections/<Sibling>`
 * makes `/<Site>/Collections` look like it contains nested folders and
 * `move_folder` refuses the "Collections" collection.
 *
 * A stable, total-order decorate-sort-undecorate keyed on
 * `(connectorAccountId, parentDir, collectionsNamedFirst, originalIndex)`:
 * folders in different sites keep their relative order, and within a site the
 * non-prefix collections also keep their relative order behind the prefix one.
 * Re-runs stay safe regardless of order — once moved, the "Collections"
 * collection's source is gone and its move converges to a no-op.
 */
export function sortWebflowCollectionFoldersForSafeMoveOrder<T extends { connectorAccountId: string; path: string }>(
  folders: readonly T[],
): T[] {
  const parentDirOf = (path: string): string => {
    const split = splitFolderPathIntoParentAndLeaf(path);
    return split ? split.parentDirPath : path;
  };

  return folders
    .map((folder, originalIndex) => ({ folder, originalIndex }))
    .sort((a, b) => {
      if (a.folder.connectorAccountId !== b.folder.connectorAccountId) {
        return a.folder.connectorAccountId < b.folder.connectorAccountId ? -1 : 1;
      }
      const parentDirA = parentDirOf(a.folder.path);
      const parentDirB = parentDirOf(b.folder.path);
      if (parentDirA !== parentDirB) {
        return parentDirA < parentDirB ? -1 : 1;
      }
      const collectionsNamedRankA = isCollectionsNamedCollectionFolder(a.folder.path) ? 0 : 1;
      const collectionsNamedRankB = isCollectionsNamedCollectionFolder(b.folder.path) ? 0 : 1;
      if (collectionsNamedRankA !== collectionsNamedRankB) {
        return collectionsNamedRankA - collectionsNamedRankB;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map((entry) => entry.folder);
}

// ---------------------------------------------------------------------------
// Discriminator — collection vs Assets/Pages, by tableId prefix only (#13).
// ---------------------------------------------------------------------------

export type WebflowTableType = 'collection' | 'assets' | 'pages';

/**
 * Classifies a Webflow DataFolder by its `tableId` ONLY — never by name or path
 * (finding #13: a CMS collection a user named "Assets" exists at a suffixed path
 * today and must NOT be mistaken for the synthetic Assets table). The synthetic
 * Assets / Pages tables carry a sentinel collection id (`__assets__<siteId>` /
 * `__pages__<siteId>`) in their `tableId`; a real collection carries the
 * Webflow collection's own id.
 */
export function classifyWebflowTableByTableId(tableId: readonly string[]): WebflowTableType {
  if (tableId.some((segment) => segment.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX))) return 'assets';
  if (tableId.some((segment) => segment.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX))) return 'pages';
  return 'collection';
}

// ---------------------------------------------------------------------------
// Core types — injected into `migrateWebflowCollectionFolder` for unit testing.
// ---------------------------------------------------------------------------

/**
 * Per-folder state needed to migrate, drawn from the `DataFolder` row and its
 * parent `Workbook` (for the audit entry's organizationId).
 */
export interface WebflowCollectionFolderToMigrate {
  id: DataFolderId;
  workbookId: string;
  organizationId: string;
  connectorAccountId: string;
  /** The collection's display name — the source of the recomputed leaf segment. */
  name: string;
  /** Current on-disk path, leading slash (e.g. `/My Site/Blog Posts`). */
  path: string;
  /** `DataFolder.version` — the idempotency key (>= 2 means already nested). */
  version: number;
  /** `[siteId, collectionId]`; the collection id discriminates collection vs Assets/Pages. */
  tableId: string[];
}

export interface FolderMovePathRewriteInput {
  folderId: DataFolderId;
  workbookId: string;
  connectorAccountId: string;
  oldFolderPath: string;
  newFolderPath: string;
}

export type GitFolderMoveOutcome = { kind: 'moved' } | { kind: 'noop' } | { kind: 'repo_missing' };

export interface AuditLogEntry {
  entityId: DataFolderId;
  organizationId: string;
  message: string;
  /** Free-form context. Always includes `marker: WEBFLOW_FOLDER_RESTRUCTURE_AUDIT_MARKER`. */
  context: Prisma.InputJsonObject;
}

export interface WebflowFolderRestructureDeps {
  /**
   * Resolve a non-colliding target path for `candidateFolderPath`, re-suffixing
   * (`-{id5}`) ONLY on a genuine collision with another folder in the same
   * connector account — the canonical `DataFolderService.ensureUniquePath`.
   */
  ensureUniqueFolderPath: (
    workbookId: string,
    connectorAccountId: string,
    candidateFolderPath: string,
    folderId: DataFolderId,
  ) => Promise<string>;

  /**
   * Move the folder (and its `.scratch/<path>` metadata sibling) in git on both
   * the main and dirty branches, preserving blob OIDs. Idempotent: a re-run
   * where the source is already gone returns `noop`. `repo_missing` when the
   * connection's git repo does not exist yet (a folder picked but never pulled).
   */
  moveFolderInGit: (
    connectorAccountId: string,
    oldFolderPath: string,
    newFolderPath: string,
    commitMessage: string,
  ) => Promise<GitFolderMoveOutcome>;

  /**
   * Apply, in ONE atomic Postgres transaction, the full path rewrite:
   * `DataFolder.path` := new and `DataFolder.version` := 2, plus every dependent
   * path column (FileIndex, FileReference, SyncMatchKeys, SyncRemoteIdMapping
   * destination side, RecreatedIdMap, UploadPatchMeta). Committing `path` and
   * `version` together is what makes the version-based idempotency crash-safe.
   */
  applyFolderMovePathRewrite: (input: FolderMovePathRewriteInput) => Promise<void>;

  logAudit: (entry: AuditLogEntry) => Promise<void>;

  /** When true, no writes happen — the function returns the would-be target path. */
  dryRun: boolean;
}

export type WebflowCollectionFolderMigrationResult =
  | { kind: 'skipped_already_migrated' }
  | { kind: 'skipped_not_a_collection'; tableType: 'assets' | 'pages' }
  | { kind: 'skipped_bad_path_shape'; path: string; reason: string }
  | { kind: 'skipped_repo_missing'; path: string }
  | { kind: 'would_migrate'; oldPath: string; newPath: string } // dry-run only
  | { kind: 'migrated'; oldPath: string; newPath: string; movedInGit: boolean }
  | { kind: 'errored'; error: unknown };

// ---------------------------------------------------------------------------
// Core logic — the per-folder migration decision, the unit-test target.
// ---------------------------------------------------------------------------

/**
 * Migrate a single Webflow collection folder to the nested v2 layout. Pure-ish:
 * every side effect goes through `deps`, so the test substitutes in-memory stubs
 * and asserts on the call graph.
 *
 * Decision tree:
 *   1. version >= 2                      → already nested, skip (idempotency).
 *   2. tableId says Assets / Pages       → never moves, skip (defensive #13).
 *   3. path is not `/<Site>/<Collection>`→ skip-with-warning (#5).
 *   4. (dry-run) report the would-be target and stop.
 *   5. ensureUniquePath                  → re-suffix only on a genuine collision.
 *   6. move_folder in git (idempotent)   → repo_missing ⇒ skip (re-run after pull).
 *   7. one atomic DB rewrite             → path + version + dependent columns.
 *   8. audit-log the move.
 */
export async function migrateWebflowCollectionFolder(
  folder: WebflowCollectionFolderToMigrate,
  deps: WebflowFolderRestructureDeps,
): Promise<WebflowCollectionFolderMigrationResult> {
  if (folder.version >= WEBFLOW_NESTED_STRUCTURE_VERSION) {
    return { kind: 'skipped_already_migrated' };
  }

  const tableType = classifyWebflowTableByTableId(folder.tableId);
  if (tableType !== 'collection') {
    return { kind: 'skipped_not_a_collection', tableType };
  }

  const computed = computeNestedWebflowCollectionPath(folder.path, folder.name);
  if (computed.kind === 'bad_shape') {
    return { kind: 'skipped_bad_path_shape', path: folder.path, reason: computed.reason };
  }

  if (deps.dryRun) {
    return { kind: 'would_migrate', oldPath: folder.path, newPath: computed.newFolderPath };
  }

  const uniqueNewFolderPath = await deps.ensureUniqueFolderPath(
    folder.workbookId,
    folder.connectorAccountId,
    computed.newFolderPath,
    folder.id,
  );

  const gitMoveOutcome = await deps.moveFolderInGit(
    folder.connectorAccountId,
    folder.path,
    uniqueNewFolderPath,
    `[migration] Nest Webflow collection "${folder.name}" → ${uniqueNewFolderPath}`,
  );
  if (gitMoveOutcome.kind === 'repo_missing') {
    // No git content to move yet (folder picked but never pulled). Leave the
    // folder at v1 and surface it; a re-run after the connection is pulled will
    // finish it. The account stays v1 while any collection remains unmigrated.
    return { kind: 'skipped_repo_missing', path: folder.path };
  }

  await deps.applyFolderMovePathRewrite({
    folderId: folder.id,
    workbookId: folder.workbookId,
    connectorAccountId: folder.connectorAccountId,
    oldFolderPath: folder.path,
    newFolderPath: uniqueNewFolderPath,
  });

  await deps.logAudit({
    entityId: folder.id,
    organizationId: folder.organizationId,
    message: `Nested Webflow collection "${folder.name}" from ${folder.path} to ${uniqueNewFolderPath}`,
    context: {
      marker: WEBFLOW_FOLDER_RESTRUCTURE_AUDIT_MARKER,
      action: 'move_folder',
      oldPath: folder.path,
      newPath: uniqueNewFolderPath,
      movedInGit: gitMoveOutcome.kind === 'moved',
    },
  });

  return {
    kind: 'migrated',
    oldPath: folder.path,
    newPath: uniqueNewFolderPath,
    movedInGit: gitMoveOutcome.kind === 'moved',
  };
}

// ---------------------------------------------------------------------------
// Summary aggregation — also testable.
// ---------------------------------------------------------------------------

export interface WebflowFolderRestructureSummary {
  total: number;
  migrated: number;
  would_migrate: number;
  skipped_already_migrated: number;
  skipped_not_a_collection: number;
  skipped_bad_path_shape: number;
  skipped_repo_missing: number;
  errored: number;
}

export function emptyWebflowFolderRestructureSummary(): WebflowFolderRestructureSummary {
  return {
    total: 0,
    migrated: 0,
    would_migrate: 0,
    skipped_already_migrated: 0,
    skipped_not_a_collection: 0,
    skipped_bad_path_shape: 0,
    skipped_repo_missing: 0,
    errored: 0,
  };
}

export function accumulateWebflowFolderRestructure(
  summary: WebflowFolderRestructureSummary,
  result: WebflowCollectionFolderMigrationResult,
): void {
  summary.total += 1;
  switch (result.kind) {
    case 'migrated':
      summary.migrated += 1;
      break;
    case 'would_migrate':
      summary.would_migrate += 1;
      break;
    case 'skipped_already_migrated':
      summary.skipped_already_migrated += 1;
      break;
    case 'skipped_not_a_collection':
      summary.skipped_not_a_collection += 1;
      break;
    case 'skipped_bad_path_shape':
      summary.skipped_bad_path_shape += 1;
      break;
    case 'skipped_repo_missing':
      summary.skipped_repo_missing += 1;
      break;
    case 'errored':
      summary.errored += 1;
      break;
  }
}
