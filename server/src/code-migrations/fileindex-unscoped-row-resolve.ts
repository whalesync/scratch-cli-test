/**
 * DEV-11242 — resolve the last `FileIndex.connectorAccountId IS NULL` rows by asking
 * git which connection actually holds the file.
 *
 * `fileindex-connector-account-backfill` (DEV-10880) recovers ownership from
 * `(workbookId, folderPath)` alone, so it can only decide a folderPath owned by exactly
 * one connection. Every row that survived it sits at a folderPath claimed by 2+
 * connections — two HubSpot connections both exposing `Products`, a Shopify and a
 * WordPress connection both exposing `Pages` — which is precisely the case that
 * inference declares ambiguous and skips.
 *
 * The signal it never consults is the one that *defines* ownership: each connection has
 * its own git repo, so the connection whose repo contains a file at
 * `<folderPath>/<filename>` is the row's owner. Measured on prod 2026-08-09, that probe
 * decides 82 of the 88 survivors outright, proves 5 more dead (no claimant repo holds
 * the file on `main` or `dirty`), and leaves 1 that needs the content tie-break below.
 *
 * The functions here are pure and unit-tested without a database or a git service; the
 * controller orchestrator does the repo listings and the (dry-run-able) writes.
 */

/** How a single unscoped row should be resolved, once its candidate owners are known. */
export type UnscopedFileIndexRowResolution =
  | { kind: 'scope'; connectorAccountId: string }
  | { kind: 'delete' }
  | { kind: 'skip-no-connector-claimant' }
  | { kind: 'unresolvable'; candidateConnectorAccountIds: string[] };

/**
 * Which of the workbook's connections could own a row stored at `rowFolderPath`?
 *
 * A connection claims the row when one of its DataFolders is the **longest-prefix**
 * owner of the row's folderPath — the folder's own path, or an ancestor of it when the
 * row sits deeper than any folder path (the Shopify-GID shape). Longest-prefix rather
 * than any-prefix so a live nested child folder (e.g. a Webflow secondary-locale folder
 * at `/<Site>/Collections/<Collection>/<Locale>`) claims its own rows instead of handing
 * them to its parent. All paths are the no-leading-slash form `FileIndex.folderPath` is
 * stored in.
 */
export function findClaimantConnectorAccountIdsForFolderPath(
  rowFolderPath: string,
  connectorFolderPathsByConnectorAccountId: { connectorAccountId: string; folderPathNoSlash: string }[],
): string[] {
  const owningFolders = connectorFolderPathsByConnectorAccountId.filter(
    (folder) => rowFolderPath === folder.folderPathNoSlash || rowFolderPath.startsWith(`${folder.folderPathNoSlash}/`),
  );
  if (owningFolders.length === 0) return [];

  const longestOwningFolderPathLength = Math.max(...owningFolders.map((folder) => folder.folderPathNoSlash.length));
  const longestPrefixOwners = owningFolders.filter(
    (folder) => folder.folderPathNoSlash.length === longestOwningFolderPathLength,
  );
  return [...new Set(longestPrefixOwners.map((folder) => folder.connectorAccountId))].sort();
}

/**
 * Decide a row from its claimant connections and the subset of them whose repo holds
 * its file.
 *
 * - **No claimant at all** — no connector-backed folder owns this row's folderPath, so
 *   there was no repo to probe and "no holder" says nothing about whether the file
 *   exists. Leave the row alone. Two very different populations land here and NEITHER
 *   belongs to this migration: a row under a connector-less (scratch) folder, whose NULL
 *   is the one legitimate NULL and must stay; and a row orphaned by a past connection
 *   delete/reset, which is `fileindex-filereference-orphan-gc`'s job — that migration
 *   considers ALL DataFolders (scratch included) and sweeps the matching FileReference
 *   rows, neither of which happens here. Measured 2026-08-09: 0 such rows on prod, 47,113
 *   on test (47,111 orphans + 2 scratch), so treating them as dead would have been a
 *   47k-row mistake on test.
 * - **Exactly one** holder — ownership is decided; scope the row to it.
 * - **None, but claimants exist** — the record is gone from every claimant repo (checked
 *   on `main` AND `dirty`, so an unpublished local state can only rescue a row, never
 *   condemn one), so the row points at a file that no longer exists. Nothing will ever
 *   refresh it: pulls only upsert rows for records they still see, and no code path GCs a
 *   FileIndex row when its record disappears upstream. Delete it.
 * - **Several** — fall to {@link resolveMultiOwnerUnscopedRowByContent}, which is the only
 *   thing that can tell "the same record pulled twice" from "two different records that
 *   happen to share a filename".
 */
export function classifyUnscopedRowOwnership(
  claimantConnectorAccountIds: string[],
  connectorAccountIdsHoldingTheFile: string[],
): UnscopedFileIndexRowResolution {
  if (claimantConnectorAccountIds.length === 0) {
    return { kind: 'skip-no-connector-claimant' };
  }
  if (connectorAccountIdsHoldingTheFile.length === 1) {
    return { kind: 'scope', connectorAccountId: connectorAccountIdsHoldingTheFile[0] };
  }
  if (connectorAccountIdsHoldingTheFile.length === 0) {
    return { kind: 'delete' };
  }
  return { kind: 'unresolvable', candidateConnectorAccountIds: [...connectorAccountIdsHoldingTheFile].sort() };
}

/**
 * Tie-break a row whose file exists in several claimant repos, by comparing the file
 * contents.
 *
 * **Identical in every candidate** — they are literally the same record (same remote id
 * in the same verbatim payload; on prod this is a user who connected one Notion workspace
 * twice and pulled the same database). The row's `recordId` is correct no matter which
 * candidate we name, so the choice is free: take the lowest `connectorAccountId`. That is
 * arbitrary, but it is deterministic, it is logged, and it is the same pick a re-run
 * makes. It is also the pick a pull would have made anyway — the unique key
 * `(workbookId, folderPath, recordId)` can only ever hold ONE row for this record, so
 * whichever connection pulls next claims it regardless.
 *
 * **Different in any candidate** — the candidates are different records that merely share
 * a filename, and nothing here can say which one this row describes. Return
 * `unresolvable` and leave the row NULL: reporting an undecidable row beats writing a
 * wrong owner, which would silently point one connection's publish at another
 * connection's remote record.
 */
export function resolveMultiOwnerUnscopedRowByContent(
  fileContentByConnectorAccountId: { connectorAccountId: string; content: string | null }[],
): UnscopedFileIndexRowResolution {
  const candidateConnectorAccountIds = [...fileContentByConnectorAccountId.map((c) => c.connectorAccountId)].sort();
  if (fileContentByConnectorAccountId.length === 0) {
    return { kind: 'unresolvable', candidateConnectorAccountIds };
  }

  const [firstCandidate, ...remainingCandidates] = fileContentByConnectorAccountId;
  if (firstCandidate.content == null) {
    return { kind: 'unresolvable', candidateConnectorAccountIds };
  }
  const everyCandidateHasIdenticalContent = remainingCandidates.every(
    (candidate) => candidate.content === firstCandidate.content,
  );
  if (!everyCandidateHasIdenticalContent) {
    return { kind: 'unresolvable', candidateConnectorAccountIds };
  }
  return { kind: 'scope', connectorAccountId: candidateConnectorAccountIds[0] };
}
