/**
 * DEV-10596 — single-connection (connector-scoped) publish target resolution.
 *
 * Pure helper (no React, no IPC) so it can be unit-tested directly, per the
 * desktop renderer's "pure logic tests" convention. The sibling of
 * `single-record-publish-target.ts`, one level up: it resolves a connector node
 * in the FolderTree (its display name + its `DataFolder`s) into everything the
 * publish modal needs to publish ONLY that connector's changes.
 *
 * Lives in its own `.ts` (not in a component module) so the renderer's
 * `react-refresh/only-export-components` rule stays satisfied.
 */

import { DataFolder } from '@spinner/shared-types';

/** Everything the publish modal needs to scope a publish to one connection. */
export interface SingleConnectionPublishTarget {
  /** The connection's id (connector account id) — CLI `--connection`, plan/run, reconcile. */
  connectionId: string;
  /**
   * The connection's display/dir name — the progress UI, and the key the modal
   * filters unreviewed changes and validation stats by (`s.connection === connectionName`).
   */
  connectionName: string;
}

export type ResolveSingleConnectionPublishTargetResult =
  | { ok: true; target: SingleConnectionPublishTarget }
  | { ok: false; error: string };

/**
 * Resolve a connector node into a publish target. `connectionName` is the
 * connector's workspace dir name (the FolderTree node name); `connectionFolders`
 * are that connector's `DataFolder`s (every folder under it carries the same
 * `connectorAccountId`).
 *
 * Returns a discriminated result so the caller can withhold the "Publish
 * &lt;connector&gt;" menu item (and surface a precise reason) instead of silently
 * publishing nothing. `connectorAccountId` is `string | null` on `DataFolder`,
 * so it is null/empty-guarded here.
 */
export function resolveSingleConnectionPublishTarget(
  connectionName: string,
  connectionFolders: ReadonlyArray<Pick<DataFolder, 'connectorAccountId'>>,
): ResolveSingleConnectionPublishTargetResult {
  if (connectionName.length === 0) {
    return { ok: false, error: 'Connection has no name.' };
  }
  if (connectionFolders.length === 0) {
    return { ok: false, error: `No tables found for "${connectionName}".` };
  }
  // Prefer the first folder that actually carries a connector account id — a
  // `DataFolder` can have a null one (e.g. an unmapped local folder).
  const connectionId = connectionFolders.find((folder) => folder.connectorAccountId)?.connectorAccountId;
  if (!connectionId) {
    return { ok: false, error: `No connector account id for "${connectionName}".` };
  }
  return { ok: true, target: { connectionId, connectionName } };
}
