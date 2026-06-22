/**
 * DEV-10413 — single-record publish target resolution.
 *
 * Pure helper (no React, no IPC) so it can be unit-tested directly, per the
 * desktop renderer's "pure logic tests" convention (no @testing-library/react
 * is installed). Resolves a clicked record's workspace-relative CLI path into
 * everything the publish modal needs to publish ONLY that record.
 */

/** Everything the publish modal needs to scope a publish to one record. */
export interface SingleRecordPublishTarget {
  /** Workspace-relative path (connection dir first, no leading slash) — CLI upload + reconcile. */
  filePath: string;
  /**
   * Connection-relative path (no leading slash) — the publish plan's `filePath`
   * scope. Must match `getRepoStatus`'s path format exactly; a mismatch silently
   * matches nothing (see the path-column-slash convention).
   */
  relPath: string;
  /** The owning connection's id (connector account id). */
  connectionId: string;
  /** The owning connection's display/dir name — for the progress UI. */
  connectionName: string;
  /** Absolute folder path of the record — for the scoped validation check. */
  folderPath: string;
  /** Record filename — for the scoped validation check. */
  filename: string;
}

export type ResolveSingleRecordPublishTargetResult =
  | { ok: true; target: SingleRecordPublishTarget }
  | { ok: false; error: string };

/**
 * Resolve `cliPath` (workspace-relative, connection dir first, e.g.
 * `My Airtable/posts/rec_1.json`) against the workspace's connection list.
 *
 * The first path segment is the connection dir name; the remainder is the
 * connection-relative path. A leading slash is tolerated. Returns a
 * discriminated result so the caller can surface a precise error instead of
 * silently no-op'ing.
 */
export function resolveSingleRecordPublishTarget(
  localPath: string,
  cliPath: string,
  connections: ReadonlyArray<{ id: string; dirName: string }>,
): ResolveSingleRecordPublishTargetResult {
  const normalized = cliPath.replace(/^\/+/, '');
  const firstSlash = normalized.indexOf('/');
  const lastSlash = normalized.lastIndexOf('/');
  const connectionDirName = normalized.slice(0, firstSlash);
  const relPath = normalized.slice(firstSlash + 1); // connection-relative, no leading slash
  const filename = normalized.slice(lastSlash + 1);
  const folderPath = `${localPath}/${normalized.slice(0, lastSlash)}`; // absolute folder dir
  // Need a connection segment, a non-empty connection-relative remainder, and a
  // filename (rejects `rec.json`, `Conn/`, and a bare `Conn`).
  if (firstSlash <= 0 || relPath.length === 0 || filename.length === 0) {
    return { ok: false, error: `Unexpected record path "${cliPath}".` };
  }
  const connection = connections.find((c) => c.dirName === connectionDirName);
  if (!connection) {
    return { ok: false, error: `No connection matches "${connectionDirName}".` };
  }
  return {
    ok: true,
    target: {
      filePath: normalized,
      relPath,
      connectionId: connection.id,
      connectionName: connection.dirName,
      folderPath,
      filename,
    },
  };
}
