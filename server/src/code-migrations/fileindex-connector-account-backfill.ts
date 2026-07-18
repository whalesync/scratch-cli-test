/**
 * DEV-10880 — backfill `FileIndex.connectorAccountId` for rows written before the
 * column existed.
 *
 * `FileIndex.folderPath` is connection-relative (it is `DataFolder.path` minus the
 * leading slash) and the table is workbook-global, so the owning connection is
 * recovered by joining a folderPath back to the workbook's DataFolders. When a
 * folderPath is owned by exactly one connection the mapping is unambiguous and the
 * rows are scoped to it; when two connections in the same workbook expose an
 * identically-named folder (the very case the discriminator exists for) the
 * folderPath is ambiguous and its rows are LEFT NULL — the next pull of each
 * connection writes the correct `connectorAccountId` per connection, and until
 * then the publish resolver falls back to a workbook-global lookup for them.
 *
 * The pure resolution below is unit-tested without a database; the controller does
 * the (dry-run-able) `updateMany` writes.
 */

export interface DataFolderForConnectorAccountBackfill {
  path: string | null;
  connectorAccountId: string | null;
}

export interface FolderPathConnectorAccountResolution {
  /** Connection-relative folderPath (no leading slash) → the single owning connectorAccountId. */
  unambiguousFolderPathToConnectorAccountId: Map<string, string>;
  /** folderPaths owned by more than one connection — deliberately left NULL. */
  ambiguousFolderPaths: Set<string>;
}

/**
 * Group the workbook's DataFolders by their connection-relative folderPath and
 * split them into the folderPaths owned by exactly one connection (safe to
 * backfill) and those owned by several (ambiguous — left for a re-pull).
 */
export function resolveFolderPathsToConnectorAccountIds(
  dataFolders: DataFolderForConnectorAccountBackfill[],
): FolderPathConnectorAccountResolution {
  const folderPathToConnectorAccountIds = new Map<string, Set<string>>();
  for (const dataFolder of dataFolders) {
    if (!dataFolder.path || !dataFolder.connectorAccountId) continue;
    const folderPath = dataFolder.path.replace(/^\//, '');
    let connectorAccountIds = folderPathToConnectorAccountIds.get(folderPath);
    if (!connectorAccountIds) {
      connectorAccountIds = new Set();
      folderPathToConnectorAccountIds.set(folderPath, connectorAccountIds);
    }
    connectorAccountIds.add(dataFolder.connectorAccountId);
  }

  const unambiguousFolderPathToConnectorAccountId = new Map<string, string>();
  const ambiguousFolderPaths = new Set<string>();
  for (const [folderPath, connectorAccountIds] of folderPathToConnectorAccountIds) {
    if (connectorAccountIds.size === 1) {
      unambiguousFolderPathToConnectorAccountId.set(folderPath, [...connectorAccountIds][0]);
    } else {
      ambiguousFolderPaths.add(folderPath);
    }
  }
  return { unambiguousFolderPathToConnectorAccountId, ambiguousFolderPaths };
}
