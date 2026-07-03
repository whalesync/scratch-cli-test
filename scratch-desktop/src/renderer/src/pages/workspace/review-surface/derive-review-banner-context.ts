import type { WorkspaceConnection } from '../../../types/local-files';

/**
 * Pure helpers for the review context banner ("Review before publishing to
 * {connector} · {folder}"). Kept in a plain `.ts` module — not the banner `.tsx` —
 * so they stay unit-testable and don't trip `react-refresh/only-export-components`.
 */

/**
 * The folder path's non-empty POSIX segments. A `DataFolder.path` always starts with
 * `/` and lives under its connection's directory, so segment 0 is that `dirName`
 * (e.g. `/salesforce-tables/deals` → `['salesforce-tables', 'deals']`).
 */
function folderPathSegments(selectedFolderPath: string | null): string[] {
  if (!selectedFolderPath) return [];
  return selectedFolderPath.split('/').filter(Boolean);
}

/**
 * The connector's user-facing name for the folder currently under review, or `null`
 * when the folder path is empty or its first segment matches no loaded connection.
 *
 * A folder lives under its connection's on-disk directory, so the connector is the
 * connection whose `dirName` equals the path's first segment. Returns the connection's
 * `displayName` (what the user named it), never the internal `service` slug.
 */
export function deriveConnectorDisplayNameForFolder(
  selectedFolderPath: string | null,
  connections: readonly WorkspaceConnection[],
): string | null {
  const firstSegment = folderPathSegments(selectedFolderPath)[0];
  if (!firstSegment) return null;
  const matchingConnection = connections.find((connection) => connection.dirName === firstSegment);
  return matchingConnection ? matchingConnection.displayName : null;
}

/**
 * The leaf folder name shown after the connector in the banner (e.g.
 * `/salesforce-tables/deals` → `deals`). Mirrors `FolderDataGrid`'s
 * `selectedFolderPath?.split('/').filter(Boolean).pop()`. Returns `null` for an empty path.
 */
export function folderLeafName(selectedFolderPath: string | null): string | null {
  const segments = folderPathSegments(selectedFolderPath);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}
