/**
 * DEV-10885 Phase B — one-time GC of FileIndex / FileReference rows orphaned by
 * connection delete/reset BEFORE the Phase A forward fix cleaned them up.
 *
 * FileIndex/FileReference have no FK to DataFolder, so historically a
 * connection-level delete/reset left their rows behind against the surviving
 * workbook (~93.5k such FileIndex rows measured on prod during DEV-10880). A row
 * is an **orphan** when NO live DataFolder in its workbook is a prefix-owner of
 * its `folderPath` — i.e. neither the folder's own path (`folderPath === live`)
 * nor an ancestor of it (`folderPath` starts with `live + "/"`). That definition
 * deliberately PRESERVES:
 *   - live rows at a folder's own path,
 *   - Shopify-GID artifact rows stored deeper than the DataFolder path (their
 *     owner is the still-live `/Product Variants` folder),
 *   - Webflow secondary-locale rows (the nested locale folder owns them),
 * and flags only rows under folders that no longer exist.
 *
 * `connectorAccountId` is intentionally NOT consulted: some orphans predate the
 * column (NULL) and others carry a now-dead id, so ownership is decided purely by
 * the workbook's live DataFolder paths. All paths here are the no-leading-slash
 * form that FileIndex.folderPath / FileReference.sourceFilePath are stored in.
 *
 * These functions are pure and unit-tested without a database; the controller
 * orchestrator does the (dry-run-able) counts and deletes.
 */

/**
 * Does any live DataFolder own `rowFolderPath` — its own path, or an ancestor of
 * it? (The `/` boundary check keeps `Foo` from "owning" a sibling like `Foo Bar`.)
 */
export function folderPathHasLiveOwner(rowFolderPath: string, liveFolderPathsNoSlash: string[]): boolean {
  return liveFolderPathsNoSlash.some(
    (liveFolderPath) => rowFolderPath === liveFolderPath || rowFolderPath.startsWith(`${liveFolderPath}/`),
  );
}

/**
 * Of the workbook's distinct FileIndex folderPaths, return those with no live
 * DataFolder owner — the orphans safe to delete.
 */
export function computeOrphanFolderPaths(distinctFolderPaths: string[], liveFolderPathsNoSlash: string[]): string[] {
  return distinctFolderPaths.filter((folderPath) => !folderPathHasLiveOwner(folderPath, liveFolderPathsNoSlash));
}

/**
 * Reduce the orphan folderPaths to their "roots" — those NOT nested under another
 * orphan folder. FileReference is deleted by `sourceFilePath` prefix, so a root's
 * subtree delete already covers every ref under its descendant orphan folders;
 * iterating only the roots makes the dry-run COUNT match the live DELETION (a naive
 * per-orphan count double-tallies refs under a nested orphan — the ancestor's
 * `startsWith` already includes them) and avoids redundant deletes on a live run.
 * Safe because an orphan never sits under a LIVE folder (that would give it a live
 * owner), so a root's subtree holds only orphan refs plus any live-child subtrees,
 * which the caller still excludes.
 */
export function rootOrphanFolderPaths(orphanFolderPaths: string[]): string[] {
  return orphanFolderPaths.filter(
    (candidate) =>
      !orphanFolderPaths.some((otherOrphan) => otherOrphan !== candidate && candidate.startsWith(`${otherOrphan}/`)),
  );
}

/**
 * Live DataFolder paths nested strictly UNDER `orphanFolderPath`. Used to exclude
 * their subtrees when prefix-deleting FileReference rows, so an orphan parent
 * folder that happens to sit above a still-live child folder can't wipe the
 * child's refs (the FileReference table has no folder column to scope by, so the
 * delete is a `sourceFilePath` prefix match that would otherwise reach down).
 */
export function liveChildFolderPathsUnder(orphanFolderPath: string, liveFolderPathsNoSlash: string[]): string[] {
  return liveFolderPathsNoSlash.filter((liveFolderPath) => liveFolderPath.startsWith(`${orphanFolderPath}/`));
}
