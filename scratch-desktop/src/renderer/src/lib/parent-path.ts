/**
 * Returns the parent directory of a workspace root path (POSIX or Windows).
 * Used as `cwd` for `scratchmd workspaces init`, which expects the parent folder
 * that contains the workspace directory.
 */
export function parentDirectoryPath(workspaceRoot: string): string {
  const trimmed = workspaceRoot.replace(/[/\\]+$/, '');
  if (trimmed.length === 0) {
    return workspaceRoot;
  }
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (lastSep === -1) {
    return trimmed;
  }
  if (lastSep === 0) {
    return '/';
  }
  return trimmed.slice(0, lastSep);
}
