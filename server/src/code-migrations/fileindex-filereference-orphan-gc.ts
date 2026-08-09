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
 *   - rows stored deeper than the DataFolder path (their owner is the still-live
 *     ancestor folder),
 *   - Webflow secondary-locale rows (the nested locale folder owns them),
 * and flags only rows under folders that no longer exist.
 *
 * A SECOND, narrower pass then removes the DEV-11015 split-recordId artifact rows,
 * which the orphan rule above cannot reach precisely because a live ancestor owns
 * them — see {@link isSplitRecordIdArtifactRow}. (An earlier revision of this file
 * described those rows as legitimate "Shopify-GID artifact rows" worth preserving;
 * that was wrong — they are the residue of a fixed filename bug.)
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

export interface FileIndexRowForSplitRecordIdArtifactCheck {
  id: string;
  folderPath: string;
  filename: string;
  recordId: string;
}

/**
 * Is this row a **DEV-11015 split-recordId artifact** — an index entry pointing at a
 * file that never really existed at that path?
 *
 * Until DEV-11015 was fixed (2026-07-23, deployed 2026-07-24), a table with no usable
 * slug fell back to the raw record id as the filename base WITHOUT sanitizing it. For
 * a connector whose ids contain `/` — Shopify GIDs, `gid://shopify/MediaImage/38012…`
 * — those slashes were read as directory separators, so the record staged into a
 * nested directory and the index recorded the split:
 *
 *   recordId   gid://shopify/MediaImage/38012599304435
 *   folderPath Product Media/gid://shopify/MediaImage      <- real folder + id prefix
 *   filename   38012599304435.json                         <- id's final segment
 *
 * The same pull's stale-file cleanup then deleted the staged tree, so the FILES are
 * long gone (verified on four prod repos: zero files under any such path, including
 * connections not re-pulled since the fix) while these index rows survive. Nothing
 * writes them any more and no pull will refresh them, but the orphan rule above can't
 * flag them because the real parent folder is still live and owns them as an ancestor.
 *
 * The test is structural, not connector-specific: the row's own `recordId` must
 * reconstruct its `folderPath` tail and its `filename` head. Requiring the recordId to
 * contain a `/` at all is what makes this safe — a Webflow secondary-locale row (or any
 * other legitimately-nested row) has a slash-free record id and can never match. A row
 * correctly indexed AT its folder also can't match: its folderPath is the plain folder
 * (`Product Media`), which does not contain the id prefix.
 *
 * `includes` rather than `endsWith` so it also catches the doubly-nested rows, where
 * `deduplicateFileName`'s collision suffix carried a second unsanitized id
 * (`…/MediaImage/44040420655417-gid://shopify/MediaImage`).
 *
 * Measured on prod 2026-08-09: 2,260 rows across 9 workbooks, all Shopify, and zero
 * rows matched this shape without also containing the Shopify GID marker — i.e. no
 * other connector is affected today.
 */
export function isSplitRecordIdArtifactRow(row: Omit<FileIndexRowForSplitRecordIdArtifactCheck, 'id'>): boolean {
  const lastSlashIndexInRecordId = row.recordId.lastIndexOf('/');
  // <= 0 covers both "no slash at all" and a leading slash (which would leave an
  // empty prefix that every folderPath trivially contains).
  if (lastSlashIndexInRecordId <= 0) return false;

  const recordIdPathPrefix = row.recordId.slice(0, lastSlashIndexInRecordId);
  const recordIdFinalSegment = row.recordId.slice(lastSlashIndexInRecordId + 1);
  if (recordIdFinalSegment.length === 0) return false;

  return row.folderPath.includes(`/${recordIdPathPrefix}`) && row.filename.startsWith(recordIdFinalSegment);
}

/** Ids of the rows in `rows` that are DEV-11015 split-recordId artifacts. */
export function selectSplitRecordIdArtifactRowIds(rows: FileIndexRowForSplitRecordIdArtifactCheck[]): string[] {
  return rows.filter((row) => isSplitRecordIdArtifactRow(row)).map((row) => row.id);
}
