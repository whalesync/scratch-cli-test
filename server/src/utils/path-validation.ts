/**
 * Path-validation helpers for paths flowing in from CLI / desktop clients.
 *
 * Used by the `/upload-patch/commit` flow to gate every `patch.path` before the
 * ApplyPatchesJob worker writes anything to the dirty branch. Defense-in-depth:
 * the CLI may pre-validate for UX, but the server is the gate.
 *
 * Rules:
 *  - Must be non-empty.
 *  - No leading `/` (paths are relative to the connection root, e.g.
 *    `Companies/rec123.json`, NOT `/Companies/...`).
 *  - No `..` segments anywhere (path traversal).
 *  - No `.git/` or `.scratch/` prefix (reserved for internal use).
 *  - Must live inside one of the workbook's known DataFolder paths.
 */

export type PathValidationCode = 'empty' | 'absolute' | 'traversal' | 'reserved' | 'outside-data-folder';

export class PathValidationError extends Error {
  constructor(
    public readonly code: PathValidationCode,
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'PathValidationError';
  }
}

export interface DataFolderPathRef {
  /** DataFolder.path — always starts with `/` and uses POSIX format. */
  path: string;
}

/**
 * Validate a single record file path and return it normalized (no leading
 * slash, POSIX separators, no trailing slash). Throws PathValidationError on
 * any rule violation.
 *
 * `dataFolders` is the set of known DataFolder rows for the connector — the
 * caller is responsible for narrowing to a single connector before calling.
 * An empty list disables the inside-folder check (caller's responsibility to
 * decide whether that's appropriate).
 */
export function validateRecordPath(rawPath: string, dataFolders: ReadonlyArray<DataFolderPathRef>): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new PathValidationError('empty', 'Path is empty', String(rawPath));
  }

  // Normalize Windows-style separators that may slip in from a desktop client.
  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');

  if (normalized.startsWith('/')) {
    throw new PathValidationError(
      'absolute',
      `Path must be relative to the connection root (no leading slash): ${rawPath}`,
      rawPath,
    );
  }

  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      throw new PathValidationError('traversal', `Path contains a traversal segment: ${rawPath}`, rawPath);
    }
  }

  if (segments[0] === '.git' || segments[0] === '.scratch') {
    throw new PathValidationError('reserved', `Path uses a reserved prefix (.git/ or .scratch/): ${rawPath}`, rawPath);
  }

  if (dataFolders.length > 0 && !isInsideKnownDataFolder(normalized, dataFolders)) {
    throw new PathValidationError(
      'outside-data-folder',
      `Path is not inside any known DataFolder for this connector: ${rawPath}`,
      rawPath,
    );
  }

  return normalized;
}

function isInsideKnownDataFolder(normalized: string, dataFolders: ReadonlyArray<DataFolderPathRef>): boolean {
  // Strip leading slash from each DataFolder.path so it composes with the
  // normalized record path (which has no leading slash). The folder itself is
  // a directory — a record path must be STRICTLY inside it, so we require a
  // `${folder}/` prefix (not just equality).
  for (const folder of dataFolders) {
    if (!folder.path) continue;
    const stripped = folder.path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (stripped.length === 0) continue;
    if (normalized.startsWith(`${stripped}/`)) {
      return true;
    }
  }
  return false;
}
