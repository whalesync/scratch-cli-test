/**
 * Helpers for building Airtable `filterByFormula` expressions used by incremental pulls.
 *
 * The connector composes two pieces:
 *   1. The user's pre-existing `options.filter` (if any) — passed through unchanged.
 *   2. A "modified since" expression built from `modifiedAtField` and the watermark.
 *
 * Combined with `AND(...)` when both are present.
 */

/**
 * Clock-skew safety margin subtracted from the watermark when building the
 * `IS_AFTER` expression. Airtable's `LAST_MODIFIED_TIME()` is server-side; our
 * watermark is captured client-side. If the clocks drift, a record modified
 * just before `pullStartedAt` could otherwise be missed. Idempotent commits
 * absorb the duplicate pulls this overlap creates.
 */
export const AIRTABLE_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

function escapeAirtableFieldName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/}/g, '\\}');
}

function escapeAirtableString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Build the Airtable formula fragment that matches records modified after
 * `since`, applying the clock-skew overlap. `modifiedAtField` is the display
 * name of the user's Last Modified Time column.
 */
export function buildAirtableModifiedSinceFormula(modifiedAtField: string, since: Date): string {
  const overlapped = new Date(since.getTime() - AIRTABLE_INCREMENTAL_CLOCK_SKEW_MS);
  return `IS_AFTER({${escapeAirtableFieldName(modifiedAtField)}}, '${escapeAirtableString(overlapped.toISOString())}')`;
}

/**
 * Combine a user-provided filter (already a valid Airtable formula) with an
 * additional formula fragment. Returns `undefined` only if both are empty.
 */
export function combineAirtableFormulas(
  userFilter: string | undefined,
  additional: string | undefined,
): string | undefined {
  const trimmedUser = userFilter && userFilter.trim() !== '' ? userFilter : undefined;
  const trimmedAdd = additional && additional.trim() !== '' ? additional : undefined;
  if (trimmedUser && trimmedAdd) {
    return `AND(${trimmedUser}, ${trimmedAdd})`;
  }
  return trimmedUser ?? trimmedAdd;
}
