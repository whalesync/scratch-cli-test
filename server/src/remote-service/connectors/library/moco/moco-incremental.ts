/**
 * Helpers for the Moco incremental-pull modified-since mechanism. Mirrors the
 * _shape_ of `linear/linear-incremental.ts` and `wordpress/wordpress-incremental.ts`
 * so the per-connector code reads the same, even though Moco's modified-since
 * mechanism is the bare REST query param `?updated_after=<iso8601-utc>` on every
 * list endpoint (companies, contacts/people, projects) rather than a Linear
 * GraphQL filter input or an Airtable formula.
 *
 * Every Moco resource carries a server-side `updated_at` and Moco accepts
 * `updated_after` on "almost all resources", so the param is the same regardless
 * of entity type — Moco is the Linear-style "fixed system field, unconditional"
 * variant. Moco has no user `options.filter` today, so there is no
 * filter-combiner here; this module owns the clock-skew constant and the
 * watermark formatter.
 *
 * Unlike WordPress (which filters against a site-local column and so needs a
 * timezone conversion), Moco documents `updated_after` as ISO-8601 **UTC**, so
 * the formatter just subtracts the clock-skew margin and renders UTC — no
 * timezone handling needed. Moco's parser is strict about precision, though: it
 * requires *seconds* precision (`2020-01-23T07:29:56Z`) and rejects the
 * fractional-second component `Date.toISOString()` emits with a 400, so the
 * milliseconds are stripped.
 */

/**
 * Clock-skew safety margin subtracted from the watermark before formatting it as
 * `updated_after`. Moco's `updated_after` filter is effectively exclusive at the
 * boundary and `updated_at` is written server-side while our watermark is
 * captured client-side, so without an overlap a record modified right at the
 * boundary (or while clocks drift) could be missed. The 60s margin re-pulls a
 * small window each run; idempotent commits absorb the duplicates.
 */
export const MOCO_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

/**
 * Build the `updated_after` query value: subtract the clock-skew margin from the
 * watermark and render the resulting instant as an ISO-8601 UTC string at
 * **seconds precision** (`YYYY-MM-DDTHH:mm:ssZ`) — the format Moco's
 * `updated_after` requires. The trailing `.\d{3}` that `Date.toISOString()`
 * emits is stripped because Moco rejects fractional seconds with a 400. Passed
 * verbatim as the `updated_after` query param for any entity type. See
 * {@link MOCO_INCREMENTAL_CLOCK_SKEW_MS}.
 */
export function buildMocoUpdatedAfter(since: Date): string {
  const overlapped = new Date(since.getTime() - MOCO_INCREMENTAL_CLOCK_SKEW_MS);
  return overlapped.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
