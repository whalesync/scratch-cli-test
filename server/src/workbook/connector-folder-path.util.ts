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
