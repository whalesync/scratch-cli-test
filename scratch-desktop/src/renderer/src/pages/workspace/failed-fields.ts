/**
 * Per-cell "failed to publish" resolution for the data grid (publish redesign,
 * DEV-10048). Kept in a plain `.ts` (not the `.tsx` component) so it can be unit
 * tested and so exporting it doesn't trip `react-refresh/only-export-components`.
 */

/**
 * The connector's rejection message to show on a cell whose record a prior
 * publish failed, or `undefined` when the cell has no failed-publish detail.
 *
 * Precedence:
 *   1. a per-field message for the cell's effective (subfield) path,
 *   2. else a per-field message for the column's root field,
 *   3. else — only when the cell actually shows a diff (unreviewed/unpublished) —
 *      the record-level error, so a record that failed with no per-field
 *      attribution still flags the field the user is re-editing rather than
 *      lighting up every column.
 *
 * `failedFields` keys are dot-path field keys (already converted from the
 * `failed-patches.json` JSON Pointers on the main-process side).
 */
export function resolveCellFailedError(args: {
  failedFields: Record<string, string> | undefined;
  recordError: string | undefined;
  effectivePath: string;
  fieldName: string;
  hasDiff: boolean;
}): string | undefined {
  const { failedFields, recordError, effectivePath, fieldName, hasDiff } = args;
  return (
    failedFields?.[effectivePath] ?? failedFields?.[fieldName] ?? (hasDiff && recordError ? recordError : undefined)
  );
}
