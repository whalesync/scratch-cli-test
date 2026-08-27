/**
 * DEV-11362 — single-folder (table-scoped) publish target resolution.
 *
 * Pure helper (no React, no IPC) so it can be unit-tested directly, per the
 * desktop renderer's "pure logic tests" convention. The sibling of
 * `single-connection-publish-target.ts` and `single-record-publish-target.ts`:
 * it resolves a mapped folder/table node in the FolderTree into everything the
 * publish modal needs to publish ONLY that table's approved changes, leaving
 * every other table's approved changes local.
 *
 * Lives in its own `.ts` (not in a component module) so the renderer's
 * `react-refresh/only-export-components` rule stays satisfied.
 */

import { DataFolder } from '@spinner/shared-types';

/** Everything the publish modal needs to scope a publish to one folder/table. */
export interface SingleFolderPublishTarget {
  /** The folder's connection id (connector account id) — plan/run, reconcile. */
  connectionId: string;
  /**
   * The connection's display/dir name — the key the modal filters unreviewed
   * changes / validation stats by, and the key it looks up the connection's
   * post-upload `dirtyHead` in the upload result by (`c.connectionName === connectionName`).
   */
  connectionName: string;
  /**
   * Workspace-relative `<connection>/<folder>` path — what `files upload
   * --folder` and the folder-scoped accept/discard CLI ops address. This is the
   * FolderTree node's `folder.name`.
   */
  folderWorkspaceRelativePath: string;
  /**
   * Connection-relative folder path (the `DataFolder.path`, e.g. `/People`) —
   * the defensive `folderPath` over-publish scope on the publish plan. The
   * server normalizes the leading slash.
   */
  folderRepoRelativePath: string;
  /** The table's display name (the FolderTree node name) — menu label + modal wording. */
  folderDisplayName: string;
}

export type ResolveSingleFolderPublishTargetResult =
  | { ok: true; target: SingleFolderPublishTarget }
  | { ok: false; error: string };

/**
 * Resolve a mapped folder node into a publish target.
 *
 * `folderWorkspaceRelativePath` is the FolderTree node's `folder.name`
 * (`<connection>/<folder>`); `folderDisplayName` is the node's display name;
 * `folder` is the mapped `DataFolder` (its `connectorAccountId` and `path` are
 * `string | null`, so both are guarded here).
 *
 * Returns a discriminated result so the caller can withhold (or disable) the
 * "Publish this table" menu item with a precise reason instead of publishing
 * nothing.
 */
export function resolveSingleFolderPublishTarget(
  folderWorkspaceRelativePath: string,
  folderDisplayName: string,
  folder: Pick<DataFolder, 'connectorAccountId' | 'path'>,
): ResolveSingleFolderPublishTargetResult {
  const connectionName = folderWorkspaceRelativePath.split('/')[0];
  if (!connectionName || !folderWorkspaceRelativePath.includes('/')) {
    return { ok: false, error: `"${folderDisplayName}" is not a table inside a connection.` };
  }
  if (!folder.connectorAccountId) {
    return { ok: false, error: `No connector account id for "${folderDisplayName}".` };
  }
  if (!folder.path) {
    return { ok: false, error: `No folder path for "${folderDisplayName}".` };
  }
  return {
    ok: true,
    target: {
      connectionId: folder.connectorAccountId,
      connectionName,
      folderWorkspaceRelativePath,
      folderRepoRelativePath: folder.path,
      folderDisplayName,
    },
  };
}
