/**
 * Single source of truth for escaping one segment of a connector folder path
 * (a site name, a grouping segment such as "Collections", or a table /
 * collection name) into a filesystem-safe string.
 *
 * This is shared by:
 *  - `DataFolderService.buildConnectorFolderPath` — the path a fresh pull writes
 *    to disk, and
 *  - the Webflow folder-restructure migration's target-path computation
 *    (`computeNestedWebflowCollectionPath`) — the path an existing folder is
 *    moved to.
 *
 * Sharing the exact escape routine is what guarantees the migration produces a
 * byte-identical path to what a fresh v2 pull would produce for the same
 * collection (DEV-9698, finding C1 — the drift guard). Change the escape rules
 * here and both producers move in lockstep.
 *
 * The routine is idempotent: applying it to an already-escaped segment is a
 * no-op, so re-deriving the site segment from an existing (already-escaped) path
 * does not change it.
 */
export function escapeConnectorFolderPathSegment(segment: string): string {
  return Array.from(segment)
    .map((c) => (c === '\t' ? ' ' : c)) // convert tabs to spaces
    .filter((c) => c.charCodeAt(0) > 31) // strip other control characters
    .join('')
    .replace(/[/*?"<>|]/g, ' ') // replace filesystem-unsafe chars
    .replace(/ {2,}/g, ' ') // collapse consecutive spaces
    .replace(/^[\s]+|[\s.]+$/g, ''); // trim leading whitespace; trim trailing whitespace and dots
}

/**
 * Sanitize a connector's display name into the **connection folder name** — the
 * first segment of a workspace-absolute pseudo-reference (`@/<connection>/…`).
 *
 * This is the TypeScript twin of the Rust CLI's `sanitize_filename`
 * (`scratch-git-2/src/cli/config/markers.rs`), which is what actually names the
 * top-level connection folder on disk. It is intentionally a DIFFERENT (and
 * narrower) routine than `escapeConnectorFolderPathSegment` above: the CLI only
 * replaces the filesystem-reserved set `/ \\ : * ? " < > |` with `-` and leaves
 * everything else (spaces, dots, casing) verbatim. Keep the two in lockstep — if
 * the CLI's `sanitize_filename` changes, change this too, or the publish
 * resolver will stop matching the connection segment authored by the desktop.
 *
 * For ordinary display names ("HubSpot", "HubSpot Testing", "Airtable") this is
 * the identity function; the replacement only bites for names containing
 * reserved characters.
 */
export function sanitizeConnectionFolderName(displayName: string): string {
  return displayName.replace(/[/\\:*?"<>|]/g, '-');
}

/**
 * The legacy connection-folder naming scheme (`"<SERVICE> - <DisplayName>"`,
 * then sanitized) that older workspaces used. New workspaces use the bare
 * sanitized display name (`sanitizeConnectionFolderName`). Both variants are
 * accepted when matching a pseudo-ref's connection segment, since a workspace
 * may have been created under either scheme. Mirrors the Rust CLI's
 * `connector_dir_name_legacy`.
 */
export function sanitizeLegacyConnectionFolderName(service: string, displayName: string): string {
  return sanitizeConnectionFolderName(`${service} - ${displayName}`);
}
