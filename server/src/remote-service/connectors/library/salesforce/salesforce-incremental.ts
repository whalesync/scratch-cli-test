/**
 * Helpers for the Salesforce incremental-pull modified-since mechanism.
 *
 * SOQL filters server-side, so an incremental pull is the full pull's query with one more predicate:
 * `<lastModifiedField> > <since>`. The field is the one the schema annotates with
 * `x-scratch-last-modified-field` — `SystemModstamp` (indexed, and bumped by system changes such as a formula's
 * dependency or a workflow update, not only by user edits) or `LastModifiedDate` on the rare object without it.
 *
 * Deletes are not reported by this filter (SOQL `query` omits recycle-bin records); the periodic full pull
 * reconciles them.
 */

/**
 * Clock-skew safety margin subtracted from the watermark before building the predicate. SOQL `>` is exclusive
 * and the watermark is captured on the worker while `SystemModstamp` is written by Salesforce, so the overlap
 * keeps a record modified right at the boundary (or under clock drift) from being missed. Idempotent commits
 * absorb the re-pulled duplicates.
 */
export const SALESFORCE_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

/** The `since` instant to filter by: the stored watermark minus the clock-skew margin. */
export function salesforceModifiedSinceWithClockSkewMargin(since: Date): Date {
  return new Date(since.getTime() - SALESFORCE_INCREMENTAL_CLOCK_SKEW_MS);
}
