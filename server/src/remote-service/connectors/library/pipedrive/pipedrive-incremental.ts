/**
 * Helpers for the Pipedrive incremental-pull modified-since mechanism. Pipedrive
 * expresses "modified since" as the v2 list-endpoint query param
 * `updated_since=<rfc3339>`, passed on every entity list call (deals, persons,
 * organizations).
 *
 * Every Pipedrive entity carries a server-side `update_time` and all three v2
 * list endpoints accept `updated_since` (verified against the installed
 * `pipedrive@31.2.1` SDK request types), so the param is identical regardless of
 * entity type — there is no per-folder configuration to inspect. Pipedrive has no
 * user `options.filter` today, so there is no filter-combiner here; this module
 * owns the clock-skew constant and the watermark formatter.
 *
 * Pipedrive's `updated_since` parser rejects the fractional-second component that
 * `Date.toISOString()` emits with
 * `ERR_SCHEMA_VALIDATION_FAILED: ... not a valid datetime` (verified live against
 * the v2 list endpoints — the documented example is a whole-second
 * `2025-01-01T10:20:00Z`). The formatter therefore strips milliseconds and
 * renders whole-second RFC3339 UTC.
 */

/**
 * Clock-skew safety margin subtracted from the watermark before formatting it as
 * `updated_since`. Pipedrive's `updated_since` is **inclusive** (`>=`: "only
 * deals with an `update_time` later than or equal to this time are returned"),
 * but `update_time` is written server-side while our watermark is captured
 * client-side, so without an overlap a record modified right at the boundary
 * (or while clocks drift) could be missed. The 60s margin re-pulls a small
 * window each run; idempotent commits absorb the duplicates.
 */
export const PIPEDRIVE_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

/**
 * Build the `updated_since` query value: subtract the clock-skew margin from the
 * watermark and render the resulting instant as a whole-second RFC3339 UTC string
 * (`YYYY-MM-DDTHH:mm:ssZ`). Milliseconds are stripped because Pipedrive's v2
 * parser rejects the fractional-second component (see the module comment).
 * Truncating to the second only widens the re-pulled window by <1s on top of the
 * deliberate {@link PIPEDRIVE_INCREMENTAL_CLOCK_SKEW_MS} overlap, so it can never
 * miss a record. Passed verbatim as the `updated_since` query param for any
 * entity type.
 */
export function buildPipedriveUpdatedSince(since: Date): string {
  const overlapped = new Date(since.getTime() - PIPEDRIVE_INCREMENTAL_CLOCK_SKEW_MS);
  return overlapped.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
