/**
 * Helpers for building the Intercom Search-API `query` used by incremental
 * pulls of the Conversations table. Mirrors the shape of
 * `linear/linear-incremental.ts` and `notion/notion-incremental.ts` so the
 * per-connector code reads the same, even though Intercom's modified-since
 * mechanism is a `POST /conversations/search` body filter on the server-side
 * `updated_at` system field (Unix seconds) rather than a GraphQL filter input
 * or a Notion JSON timestamp filter.
 *
 * Only the Conversations table supports a server-side `updated_at` search;
 * Articles and Collections have no modified-since filter and stay full-scan
 * (the connector gates incremental on `tableSpec.id.wsId === 'conversations'`).
 * Intercom conversations have no user `options.filter`, so there is no
 * filter-combiner here (unlike Airtable/Notion) — the connector passes this
 * query through unchanged.
 */

/**
 * Intercom Search-API single-filter clause restricted to the single field and
 * operator we use. `value` is a **Unix timestamp in seconds** (Intercom stores
 * and filters timestamps in seconds, not milliseconds).
 */
export interface IntercomUpdatedSinceQuery {
  field: 'updated_at';
  operator: '>';
  value: number;
}

/**
 * Clock-skew safety margin subtracted from the watermark when building the
 * `updated_at > <since>` clause. Intercom's search `>` is **exclusive** and
 * `updated_at` is written server-side while our watermark is captured
 * client-side, so without an overlap a record modified right at the boundary
 * (or while clocks drift) could be missed. The 60s margin re-pulls a small
 * window each run; idempotent commits absorb the duplicates.
 */
export const INTERCOM_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

/**
 * Build the Intercom Search-API clause matching conversations whose
 * `updated_at` is strictly after `since` (minus the clock-skew margin — see
 * {@link INTERCOM_INCREMENTAL_CLOCK_SKEW_MS}). The watermark is in
 * milliseconds; Intercom timestamps are Unix **seconds**, so the overlapped
 * cutoff is floored to seconds.
 */
export function buildIntercomUpdatedSinceQuery(since: Date): IntercomUpdatedSinceQuery {
  const overlappedMs = since.getTime() - INTERCOM_INCREMENTAL_CLOCK_SKEW_MS;
  return { field: 'updated_at', operator: '>', value: Math.floor(overlappedMs / 1000) };
}
