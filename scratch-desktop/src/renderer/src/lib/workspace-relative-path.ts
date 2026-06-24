/**
 * Convert an absolute folder or record path that lives inside a workspace into
 * the workspace-relative, POSIX-separated path that the `scratchmd` CLI expects
 * (its `--folder` argument and the record paths passed to accept/reject).
 *
 * Both inputs may arrive with Windows (`\`) or POSIX (`/`) separators — on
 * Windows the renderer holds native backslash paths. We normalize both sides to
 * `/` before stripping the workspace prefix, then drop any leading separators so
 * the result is always relative and never rooted.
 *
 * This replaces the fragile `folderPath.slice(workspacePath.length).replace(/^\//, '')`
 * idiom that several call sites used: on Windows the slice left a leading
 * backslash (`\Conn\Folder`) that `replace(/^\//, '')` did not strip, so the CLI
 * received a rooted path and re-anchored it to the drive root (`C:\Conn\Folder`),
 * failing with "Folder '…' is not inside workspace '…'." (DEV approve-on-Windows bug).
 *
 * Returns `''` when `absolutePath` is the workspace root itself.
 */
export function workspaceRelativePosixPath(workspacePath: string, absolutePath: string): string {
  const normalizedWorkspace = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedTarget = absolutePath.replace(/\\/g, '/').replace(/\/+$/, '');

  if (normalizedTarget === normalizedWorkspace) {
    return '';
  }
  if (normalizedTarget.startsWith(`${normalizedWorkspace}/`)) {
    return normalizedTarget.slice(normalizedWorkspace.length + 1);
  }
  // Not under the workspace (or prefixes diverged) — strip any leading
  // separators so we still hand the CLI a relative, never rooted, path.
  return normalizedTarget.replace(/^\/+/, '');
}
