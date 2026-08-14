/**
 * Helpers for building the Notion `dataSources.query` filter used by
 * incremental pulls. Mirrors the shape of `airtable/airtable-incremental.ts`
 * so the per-connector code reads the same, even though Notion's
 * modified-since mechanism is a server-side JSON filter on the system
 * `last_edited_time` timestamp rather than an Airtable formula or a SQL
 * `WHERE`.
 *
 * The connector composes two pieces:
 *   1. The user's pre-existing parsed `options.filter` (if any).
 *   2. A `last_edited_time` "on or after" timestamp filter built from the
 *      watermark.
 * Combined with `{ and: [...] }` when both are present — subject to Notion's
 * two-level compound-nesting limit (see `addRequiredMemberToNotionFilter`).
 *
 * This module also owns the connector's small filter algebra — the `NotionFilter`
 * types plus {@link addRequiredMemberToNotionFilter}, the one place that knows
 * how to bolt an extra required condition onto an arbitrary user filter without
 * exceeding Notion's nesting limit. `notion-query-continuation.ts` reuses it for
 * the 10k-limit `created_time` boundary, so both composition sites obey the same
 * rule.
 */
import type { QueryDataSourceParameters } from '@notionhq/client';

/** Non-nullable Notion `dataSources.query` filter. */
export type NotionFilter = NonNullable<QueryDataSourceParameters['filter']>;

/** The two top-level compound members (`{ and: [...] }` / `{ or: [...] }`). */
export type NotionCompoundFilter = Extract<NotionFilter, { and: unknown } | { or: unknown }>;

/** A single non-compound filter — a property filter or a timestamp filter. */
export type NotionLeafFilter = Exclude<NotionFilter, { and: unknown } | { or: unknown }>;

/**
 * A compound filter sitting one level *below* the top level. Notion's request
 * type caps these at leaf members only, which is precisely the second (and
 * last) permitted level of nesting.
 */
export type NotionNestedCompoundFilter = Extract<
  Extract<NotionFilter, { and: unknown }>['and'][number],
  { and: unknown } | { or: unknown }
>;

/**
 * Notion permits compound filters nested at most this many levels deep —
 * "Nesting is supported up to two levels deep"
 * (https://developers.notion.com/reference/post-database-query-filter).
 * Verified live against `Notion-Version: 2026-03-11`: `{ and: [{ or: [A, B] },
 * tsFilter] }` is accepted, and adding a third level returns a 400
 * `validation_error`.
 */
export const NOTION_MAX_COMPOUND_FILTER_NESTING_LEVELS = 2;

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

/** True when the filter is a top-level compound (`{ and: [...] }` / `{ or: [...] }`). */
export function isCompoundNotionFilter(filter: NotionFilter): filter is NotionCompoundFilter {
  return typeof filter === 'object' && filter !== null && ('and' in filter || 'or' in filter);
}

/**
 * True when none of the compound's own members is itself a compound — i.e. the
 * filter occupies exactly one nesting level, so it can still be wrapped in one
 * more `and` without exceeding {@link NOTION_MAX_COMPOUND_FILTER_NESTING_LEVELS}.
 *
 * Filters reach us via `JSON.parse` of a user-supplied string, so the request
 * type's own two-level cap isn't enforced at runtime — this is the runtime check
 * that earns the narrowing.
 */
export function isNotionCompoundFilterShallowEnoughToNest(
  filter: NotionCompoundFilter,
): filter is NotionNestedCompoundFilter {
  const members: unknown[] = 'and' in filter ? filter.and : filter.or;
  return members.every(
    (member) => typeof member !== 'object' || member === null || !('and' in member || 'or' in member),
  );
}

/**
 * Add `additionalFilter` as one more *required* condition of `baseFilter`,
 * staying within Notion's two-level compound-nesting limit. The single place
 * that knows this rule — used both for the incremental `last_edited_time`
 * filter and for the 10k-limit `created_time` continuation boundary
 * (`notion-query-continuation.ts`).
 *
 * - No base filter ⇒ `additionalFilter` alone.
 * - A simple (non-compound) base ⇒ `{ and: [base, additional] }` (1 level).
 * - An `and` base ⇒ `additionalFilter` is appended as one more top-level `and`
 *   member, leaving the nesting depth **unchanged**. Always possible.
 * - An `or` base whose members are all simple ⇒ `{ and: [base, additional] }`
 *   (2 levels — legal; verified live).
 * - An `or` base that already contains a nested compound ⇒ `null`: wrapping it
 *   would make three levels, which Notion rejects with a 400. This is the only
 *   un-combinable case; callers decide whether to degrade or fail.
 */
export function addRequiredMemberToNotionFilter(
  baseFilter: NotionFilter | undefined,
  additionalFilter: NotionLeafFilter,
): NotionFilter | null {
  if (!baseFilter) {
    return additionalFilter;
  }
  if (!isCompoundNotionFilter(baseFilter)) {
    return { and: [baseFilter, additionalFilter] };
  }
  if ('and' in baseFilter) {
    // Appending to the existing top-level `and` adds no nesting level, so this
    // is safe no matter how deep the members already are.
    return { and: [...baseFilter.and, additionalFilter] };
  }
  if (isNotionCompoundFilterShallowEnoughToNest(baseFilter)) {
    return { and: [baseFilter, additionalFilter] };
  }
  return null;
}

/**
 * Result of combining the user filter with the incremental timestamp filter.
 * `demoteToFull` tells the connector to skip the incremental filter and run a
 * full scan instead.
 */
export type CombinedNotionFilter = { demoteToFull: false; filter: NotionFilter } | { demoteToFull: true };

/**
 * Combine a parsed user filter with the incremental timestamp filter, per
 * {@link addRequiredMemberToNotionFilter}. Only a top-level `or` user filter
 * that already contains a nested compound forces `demoteToFull` — every other
 * shape, compound included, keeps the incremental filter and therefore keeps
 * the pull incremental.
 */
export function combineNotionFilters(
  userFilter: NotionFilter | undefined,
  timestampFilter: NotionLastEditedTimeFilter,
): CombinedNotionFilter {
  const combined = addRequiredMemberToNotionFilter(userFilter, timestampFilter);
  return combined === null ? { demoteToFull: true } : { demoteToFull: false, filter: combined };
}
