/**
 * Helpers for building the Notion `databases.query` filter used by incremental
 * pulls. Mirrors the shape of `airtable/airtable-incremental.ts` so the
 * per-connector code reads the same, even though Notion's modified-since
 * mechanism is a server-side JSON filter on the system `last_edited_time`
 * timestamp rather than an Airtable formula or a SQL `WHERE`.
 *
 * The connector composes two pieces:
 *   1. The user's pre-existing parsed `options.filter` (if any).
 *   2. A `last_edited_time` "on or after" timestamp filter built from the
 *      watermark.
 * Combined with `{ and: [...] }` when both are present — subject to Notion's
 * single-level compound-nesting limit (see `combineNotionFilters`).
 */
import type { QueryDatabaseParameters } from '@notionhq/client/build/src/api-endpoints';

/** Non-nullable Notion `databases.query` filter. */
export type NotionFilter = NonNullable<QueryDatabaseParameters['filter']>;

/** The two top-level compound members (`{ and: [...] }` / `{ or: [...] }`). */
export type NotionCompoundFilter = Extract<NotionFilter, { and: unknown } | { or: unknown }>;

/** The system `last_edited_time` timestamp filter member. */
export type NotionLastEditedTimeFilter = Extract<NotionFilter, { timestamp: 'last_edited_time' }>;

/**
 * Clock-skew safety margin. Unlike Airtable/Postgres, Notion's
 * `last_edited_time` is written server-side AND the `on_or_after` filter is
 * *inclusive*, so the boundary record is always re-pulled and no margin is
 * needed (idempotent commits absorb the duplicate). Kept as a named `0`
 * constant for documentation parity with the other incremental connectors.
 */
export const NOTION_INCREMENTAL_CLOCK_SKEW_MS = 0;

/**
 * Build the timestamp filter matching pages whose `last_edited_time` is at or
 * after `since`. `on_or_after` is inclusive: the boundary record is re-pulled
 * each run and absorbed by idempotent commits, which is why no clock-skew
 * margin is subtracted (see {@link NOTION_INCREMENTAL_CLOCK_SKEW_MS}).
 */
export function buildNotionLastEditedFilter(since: Date): NotionLastEditedTimeFilter {
  return {
    timestamp: 'last_edited_time',
    last_edited_time: { on_or_after: since.toISOString() },
  };
}

/**
 * True when the filter is a top-level compound (`and`/`or`). Notion permits
 * only one level of compound nesting, so a compound user filter cannot be
 * wrapped in another `and` without exceeding that limit.
 */
export function isCompoundNotionFilter(filter: NotionFilter): filter is NotionCompoundFilter {
  return typeof filter === 'object' && filter !== null && ('and' in filter || 'or' in filter);
}

/**
 * Result of combining the user filter with the incremental timestamp filter.
 * `demoteToFull` tells the connector to skip the incremental filter and run a
 * full scan instead (used when the user filter is itself compound — wrapping
 * it would exceed Notion's nesting limit).
 */
export type CombinedNotionFilter = { demoteToFull: false; filter: NotionFilter } | { demoteToFull: true };

/**
 * Combine a parsed user filter with the incremental timestamp filter.
 *
 * - No user filter ⇒ the timestamp filter alone.
 * - A simple (non-compound) user filter ⇒ `{ and: [userFilter, tsFilter] }`.
 * - A compound (`and`/`or`) user filter ⇒ `demoteToFull`: wrapping it in
 *   another `and` would create two levels of compound nesting, which Notion
 *   rejects with a 400. The connector falls back to a full scan in that case.
 */
export function combineNotionFilters(
  userFilter: NotionFilter | undefined,
  timestampFilter: NotionLastEditedTimeFilter,
): CombinedNotionFilter {
  if (!userFilter) {
    return { demoteToFull: false, filter: timestampFilter };
  }
  if (isCompoundNotionFilter(userFilter)) {
    return { demoteToFull: true };
  }
  return { demoteToFull: false, filter: { and: [userFilter, timestampFilter] } };
}
