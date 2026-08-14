/**
 * Helpers for continuing a Notion `dataSources.query` past the 10,000-result
 * per-query limit (DEV-11267).
 *
 * A single Notion data-source query — one (filter, sorts) combination — returns
 * at most 10,000 results. When the limit is reached, pagination simply stops:
 * `has_more` comes back `false` and the response carries
 * `request_status.type === "incomplete"`
 * (https://developers.notion.com/guides/data-apis/query-large-data-sources).
 *
 * The workaround, implemented here plus in the connector's pull loop, is the
 * one that guide recommends: sort the query ascending by the system
 * `created_time` timestamp, and when a query ends incomplete, start a NEW
 * query whose filter additionally requires `created_time` on_or_after the last
 * returned row's `created_time`.
 *
 * Why `created_time` and not the page id: Notion's query `sorts` accept only a
 * property sort or a timestamp sort (`created_time` / `last_edited_time`) —
 * there is no sort (or filter) on the page id, and page ids are random UUIDs
 * with no creation ordering anyway. `created_time` is immutable once set, so
 * an ascending sort over it is a stable order up to its minute granularity.
 *
 * Granularity caveat: Notion timestamps are rounded to the minute, so the
 * inclusive `on_or_after` boundary re-pulls every record sharing the boundary
 * minute (absorbed by idempotent pull commits). Only a data source with more
 * than 10,000 pages created in the same minute cannot make progress — the
 * connector detects the non-advancing boundary and fails with an explicit
 * error rather than looping forever.
 */
import { addRequiredMemberToNotionFilter, NotionFilter } from './notion-incremental';

/** The system `created_time` timestamp filter member. */
export type NotionCreatedTimeFilter = Extract<NotionFilter, { timestamp: 'created_time' }>;

/**
 * Build the timestamp filter matching pages whose `created_time` is at or
 * after `createdOnOrAfterBoundary` (an ISO timestamp previously returned by
 * Notion as a page's `created_time`). Inclusive on purpose: pages sharing the
 * boundary minute are re-pulled and absorbed by idempotent commits, so no page
 * created in that minute can be skipped.
 */
export function buildNotionCreatedOnOrAfterFilter(createdOnOrAfterBoundary: string): NotionCreatedTimeFilter {
  return {
    timestamp: 'created_time',
    created_time: { on_or_after: createdOnOrAfterBoundary },
  };
}

/**
 * Combine the pull's base filter (the user filter and/or the incremental
 * `last_edited_time` filter, already combined by the connector) with the
 * 10k-continuation `created_time` boundary filter, per the shared
 * {@link addRequiredMemberToNotionFilter} rule.
 *
 * Returns `null` only for the one shape Notion cannot express: a top-level `or`
 * base filter that already contains a nested compound, where adding the
 * boundary would need a third nesting level. The connector surfaces that as an
 * explicit error instead of silently truncating the pull.
 */
export function combineNotionFilterWithCreatedTimeContinuation(
  baseFilter: NotionFilter | undefined,
  createdOnOrAfterBoundary: string,
): NotionFilter | null {
  return addRequiredMemberToNotionFilter(baseFilter, buildNotionCreatedOnOrAfterFilter(createdOnOrAfterBoundary));
}
