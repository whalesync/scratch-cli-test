/**
 * DEV-9698 (T6) — the inverse / rollback of the Webflow folder-restructure
 * migration (T2). Re-parents every nested **v2** Webflow CMS collection folder
 * back to the flat **v1** layout:
 *
 *   `/<Site>/Collections/<Collection>`  →  `/<Site>/<Collection>`
 *
 * and flips `DataFolder.version` (and, once an account's nested collections are
 * all reverted, `ConnectorAccount.version`) from 2 back to 1. Assets and Pages
 * never moved in the forward direction, so they are untouched here too.
 *
 * This is the structural mirror of
 * [webflow-folder-restructure-backfill.ts](./webflow-folder-restructure-backfill.ts)
 * and deliberately reuses its shared primitives — `splitFolderPathIntoParentAndLeaf`,
 * `classifyWebflowTableByTableId`, the dependency-injected
 * `WebflowFolderRestructureDeps`, and the atomic path-rewrite (parameterized by
 * target version) — so the two directions can never drift in how they parse paths
 * or rewrite columns. The orchestrator lives in
 * [CodeMigrationsController](./code-migrations.controller.ts)
 * (`runWebflowFolderRestructureInverse`), triggered via the admin
 * `POST /code-migrations/run` endpoint with
 * `migration: 'webflow-folder-restructure-inverse'`.
 *
 * Idempotency & crash-safety
 * --------------------------
 * The per-folder idempotency key is `DataFolder.version`: a folder at version < 2
 * is already flat and is skipped. The git move and the atomic DB rewrite (which
 * sets `version := 1` in the same transaction as the path columns) are ordered so
 * `version` only reaches 1 once the path has been rewritten. A crash between the
 * git move and the DB commit leaves `version` still 2 with the nested path; a
 * re-run recomputes the same flat target, finds the git move already done (the
 * `move_folder` route no-ops when the source is gone and the destination present),
 * and finishes the DB commit. Every step converges.
 *
 * The "Collections"-named mirror case
 * -----------------------------------
 * A collection literally named "Collections" sits at `/<Site>/Collections/Collections`
 * in v2 and reverts to `/<Site>/Collections` in v1 — the destination is an ANCESTOR
 * of the source ("new is a prefix of old"), which the `move_folder` route handles
 * symmetrically (DEV-9698 T6 scratch-git change). It MUST revert AFTER all its
 * siblings have vacated `/<Site>/Collections/` (the opposite of the forward
 * ordering, where it moved first): until then the destination still holds the
 * siblings' records and the move is correctly refused. See
 * `sortWebflowCollectionFoldersForSafeInverseMoveOrder`.
 */

import { Prisma } from '@prisma/client';
import {
  WEBFLOW_COLLECTIONS_FOLDER_SEGMENT,
  WEBFLOW_NESTED_STRUCTURE_VERSION,
} from 'src/remote-service/connectors/library/webflow/webflow-folder-paths';
import { escapeConnectorFolderPathSegment } from 'src/workbook/connector-folder-path.util';
import {
  classifyWebflowTableByTableId,
  splitFolderPathIntoParentAndLeaf,
  WebflowCollectionFolderToMigrate,
  WebflowFolderRestructureDeps,
} from './webflow-folder-restructure-backfill';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker placed on audit-log entries created by the inverse migration so they are
 * distinguishable from the forward migration's moves (and from ordinary user
 * activity). Queryable via `WHERE context->>'marker' = 'webflow_folder_restructure_inverse'`.
 */
export const WEBFLOW_FOLDER_RESTRUCTURE_INVERSE_AUDIT_MARKER = 'webflow_folder_restructure_inverse';

// ---------------------------------------------------------------------------
// Pure path computation — the inverse of `computeNestedWebflowCollectionPath`.
// ---------------------------------------------------------------------------

export type FlatCollectionPathResult = { kind: 'ok'; newFolderPath: string } | { kind: 'bad_shape'; reason: string };

/**
 * Computes the flat v1 path for a Webflow CMS collection given its current nested
 * v2 path and the collection's display name.
 *
 *   `/<Site>/Collections/<Collection>`  →  `/<Site>/<escape(name)>`
 *
 * The site segment(s) are taken verbatim from the path's GRANDPARENT dir — i.e.
 * the dirname of the dirname, which strips exactly the `/Collections/` parent and
 * is robust to legacy ≥3-segment site paths (e.g. `/Webflow/<Site>/Collections/<Coll>`
 * → `/Webflow/<Site>/<Coll>`). The leaf is recomputed from `DataFolder.name`
 * through the **shared** escaper (the same one the forward migration and a fresh
 * pull use), so a round-trip is byte-stable and any `ensureUniquePath` `-{id5}`
 * suffix that the nested leaf may carry is dropped (and re-applied only if the flat
 * target genuinely collides — see the orchestrator's `ensureUniqueFolderPath`).
 *
 * Returns `bad_shape` for any path that is not a well-formed nested
 * `/<Site>/Collections/<Collection>` (too shallow, or its parent dir is not the
 * `Collections` segment) — the migration skips-with-warning rather than mangle it.
 */
export function computeFlatWebflowCollectionPath(
  currentFolderPath: string,
  collectionName: string,
): FlatCollectionPathResult {
  const split = splitFolderPathIntoParentAndLeaf(currentFolderPath);
  if (!split) {
    return { kind: 'bad_shape', reason: `path is not a well-formed nested path: "${currentFolderPath}"` };
  }

  const parentSplit = splitFolderPathIntoParentAndLeaf(split.parentDirPath);
  if (!parentSplit) {
    return {
      kind: 'bad_shape',
      reason: `nested path has no grandparent dir (expected /<Site>/Collections/<Collection>): "${currentFolderPath}"`,
    };
  }
  if (parentSplit.leafSegment !== WEBFLOW_COLLECTIONS_FOLDER_SEGMENT) {
    return {
      kind: 'bad_shape',
      reason: `nested path's parent dir is not "${WEBFLOW_COLLECTIONS_FOLDER_SEGMENT}": "${currentFolderPath}"`,
    };
  }

  const escapedLeafSegment = escapeConnectorFolderPathSegment(collectionName);
  if (escapedLeafSegment.length === 0) {
    return { kind: 'bad_shape', reason: `collection name escapes to an empty segment: "${collectionName}"` };
  }

  const newFolderPath = `${parentSplit.parentDirPath}/${escapedLeafSegment}`;
  return { kind: 'ok', newFolderPath };
}

/**
 * True when a nested v2 folder is the mirror of a CMS collection literally named
 * "Collections" — i.e. its path is `/<Site>/Collections/Collections`. Such a
 * folder reverts to `/<Site>/Collections` (destination is an ancestor of the
 * source) and MUST revert AFTER its siblings. See
 * `sortWebflowCollectionFoldersForSafeInverseMoveOrder`.
 */
export function isInverseCollectionsNamedFolder(currentFolderPath: string): boolean {
  const split = splitFolderPathIntoParentAndLeaf(currentFolderPath);
  if (!split || split.leafSegment !== WEBFLOW_COLLECTIONS_FOLDER_SEGMENT) return false;
  const parentSplit = splitFolderPathIntoParentAndLeaf(split.parentDirPath);
  return parentSplit?.leafSegment === WEBFLOW_COLLECTIONS_FOLDER_SEGMENT;
}

// ---------------------------------------------------------------------------
// Move ordering — "Collections"-named collections revert LAST per site.
// ---------------------------------------------------------------------------

/**
 * Orders a batch of nested collection folders so that, within each site (a unique
 * `connectorAccountId` + grandparent-dir pair), a collection literally named
 * "Collections" — whose flat destination `/<Site>/Collections` still holds its
 * siblings until they have all moved out — reverts LAST. This is the exact mirror
 * of the forward ordering (where it moved first).
 *
 * Stable decorate-sort-undecorate keyed on
 * `(connectorAccountId, siteDir, collectionsNamedLast, originalIndex)`. Re-runs
 * stay safe regardless of order — once reverted, the source is gone and the move
 * converges to a no-op.
 */
export function sortWebflowCollectionFoldersForSafeInverseMoveOrder<
  T extends { connectorAccountId: string; path: string },
>(folders: readonly T[]): T[] {
  // The site grouping key for a nested folder is its GRANDPARENT dir — the
  // `/<Site>` above the `/Collections` segment.
  const siteDirOf = (path: string): string => {
    const split = splitFolderPathIntoParentAndLeaf(path);
    if (!split) return path;
    const parentSplit = splitFolderPathIntoParentAndLeaf(split.parentDirPath);
    return parentSplit ? parentSplit.parentDirPath : split.parentDirPath;
  };

  return folders
    .map((folder, originalIndex) => ({ folder, originalIndex }))
    .sort((a, b) => {
      if (a.folder.connectorAccountId !== b.folder.connectorAccountId) {
        return a.folder.connectorAccountId < b.folder.connectorAccountId ? -1 : 1;
      }
      const siteDirA = siteDirOf(a.folder.path);
      const siteDirB = siteDirOf(b.folder.path);
      if (siteDirA !== siteDirB) {
        return siteDirA < siteDirB ? -1 : 1;
      }
      // "Collections"-named LAST (rank 1) so its siblings vacate the destination first.
      const collectionsNamedRankA = isInverseCollectionsNamedFolder(a.folder.path) ? 1 : 0;
      const collectionsNamedRankB = isInverseCollectionsNamedFolder(b.folder.path) ? 1 : 0;
      if (collectionsNamedRankA !== collectionsNamedRankB) {
        return collectionsNamedRankA - collectionsNamedRankB;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map((entry) => entry.folder);
}

// ---------------------------------------------------------------------------
// Core logic — the per-folder inversion decision, the unit-test target.
// ---------------------------------------------------------------------------

export type WebflowCollectionFolderInversionResult =
  | { kind: 'skipped_already_flat' }
  | { kind: 'skipped_not_a_collection'; tableType: 'assets' | 'pages' }
  | { kind: 'skipped_bad_path_shape'; path: string; reason: string }
  | { kind: 'skipped_repo_missing'; path: string }
  | { kind: 'would_revert'; oldPath: string; newPath: string } // dry-run only
  | { kind: 'reverted'; oldPath: string; newPath: string; movedInGit: boolean }
  | { kind: 'errored'; error: unknown };

/**
 * Revert a single nested Webflow collection folder back to the flat v1 layout.
 * The structural mirror of `migrateWebflowCollectionFolder`; same dependency
 * surface (`WebflowFolderRestructureDeps`), with the controller wiring the flat
 * target version (1) into `applyFolderMovePathRewrite`.
 *
 * Decision tree:
 *   1. version < 2                        → already flat, skip (idempotency).
 *   2. tableId says Assets / Pages        → never moved, skip (defensive #13).
 *   3. path is not `/<Site>/Collections/<Collection>` → skip-with-warning.
 *   4. (dry-run) report the would-be flat target and stop.
 *   5. ensureUniquePath                   → re-suffix only on a genuine flat collision.
 *   6. move_folder in git (idempotent)    → repo_missing ⇒ skip (re-run after pull).
 *   7. one atomic DB rewrite              → path + version(=1) + dependent columns.
 *   8. audit-log the revert.
 */
export async function invertWebflowCollectionFolder(
  folder: WebflowCollectionFolderToMigrate,
  deps: WebflowFolderRestructureDeps,
): Promise<WebflowCollectionFolderInversionResult> {
  if (folder.version < WEBFLOW_NESTED_STRUCTURE_VERSION) {
    return { kind: 'skipped_already_flat' };
  }

  const tableType = classifyWebflowTableByTableId(folder.tableId);
  if (tableType !== 'collection') {
    return { kind: 'skipped_not_a_collection', tableType };
  }

  const computed = computeFlatWebflowCollectionPath(folder.path, folder.name);
  if (computed.kind === 'bad_shape') {
    return { kind: 'skipped_bad_path_shape', path: folder.path, reason: computed.reason };
  }

  if (deps.dryRun) {
    return { kind: 'would_revert', oldPath: folder.path, newPath: computed.newFolderPath };
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
    `[rollback] Un-nest Webflow collection "${folder.name}" → ${uniqueNewFolderPath}`,
  );
  if (gitMoveOutcome.kind === 'repo_missing') {
    // No git content to move yet (folder picked but never pulled). Leave the folder
    // at v2 and surface it; a re-run after the connection is pulled will finish it.
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
    message: `Un-nested Webflow collection "${folder.name}" from ${folder.path} to ${uniqueNewFolderPath}`,
    context: {
      marker: WEBFLOW_FOLDER_RESTRUCTURE_INVERSE_AUDIT_MARKER,
      action: 'move_folder',
      oldPath: folder.path,
      newPath: uniqueNewFolderPath,
      movedInGit: gitMoveOutcome.kind === 'moved',
    } satisfies Prisma.InputJsonObject,
  });

  return {
    kind: 'reverted',
    oldPath: folder.path,
    newPath: uniqueNewFolderPath,
    movedInGit: gitMoveOutcome.kind === 'moved',
  };
}

// ---------------------------------------------------------------------------
// Summary aggregation — also testable.
// ---------------------------------------------------------------------------

export interface WebflowFolderRestructureInverseSummary {
  total: number;
  reverted: number;
  would_revert: number;
  skipped_already_flat: number;
  skipped_not_a_collection: number;
  skipped_bad_path_shape: number;
  skipped_repo_missing: number;
  errored: number;
}

export function emptyWebflowFolderRestructureInverseSummary(): WebflowFolderRestructureInverseSummary {
  return {
    total: 0,
    reverted: 0,
    would_revert: 0,
    skipped_already_flat: 0,
    skipped_not_a_collection: 0,
    skipped_bad_path_shape: 0,
    skipped_repo_missing: 0,
    errored: 0,
  };
}

export function accumulateWebflowFolderRestructureInverse(
  summary: WebflowFolderRestructureInverseSummary,
  result: WebflowCollectionFolderInversionResult,
): void {
  summary.total += 1;
  switch (result.kind) {
    case 'reverted':
      summary.reverted += 1;
      break;
    case 'would_revert':
      summary.would_revert += 1;
      break;
    case 'skipped_already_flat':
      summary.skipped_already_flat += 1;
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
