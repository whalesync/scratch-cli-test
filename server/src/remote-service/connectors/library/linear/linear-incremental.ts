/**
 * Helpers for building the Linear GraphQL connection `filter` used by
 * incremental pulls. Mirrors the shape of `airtable/airtable-incremental.ts`
 * and `notion/notion-incremental.ts` so the per-connector code reads the same,
 * even though Linear's modified-since mechanism is a typed GraphQL filter input
 * (`filter: { updatedAt: { gt: $since } }`) on the universal server-side
 * `updatedAt` system field rather than an Airtable formula or a Notion JSON
 * timestamp filter.
 *
 * Every Linear list connection (issues, projects, teams, users, issueLabels,
 * cycles) accepts an `updatedAt: DateComparator` comparator, so the filter is
 * the same regardless of entity type. Linear has no user `options.filter`
 * today, so there is no filter-combiner here (unlike Airtable/Notion) — the
 * connector passes this filter through unchanged.
 */

/**
 * Linear's `updatedAt` comparator restricted to the single operator we use.
 * `gt` maps to the GraphQL `DateComparator.gt` (greater-than) input.
 */
export type LinearUpdatedAtFilter = { updatedAt: { gt: string } };

/**
 * Clock-skew safety margin subtracted from the watermark when building the
 * `updatedAt > <since>` comparator. Linear's `gt` is **exclusive** and
 * `updatedAt` is written server-side while our watermark is captured
 * client-side, so without an overlap a record modified right at the boundary
 * (or while clocks drift) could be missed. The 60s margin re-pulls a small
 * window each run; idempotent commits absorb the duplicates.
 */
export const LINEAR_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

/**
 * Build the Linear connection filter matching entities whose `updatedAt` is
 * strictly after `since` (minus the clock-skew margin — see
 * {@link LINEAR_INCREMENTAL_CLOCK_SKEW_MS}). Passed verbatim as the GraphQL
 * `$filter` variable for any entity type.
 */
export function buildLinearUpdatedAtFilter(since: Date): LinearUpdatedAtFilter {
  const overlapped = new Date(since.getTime() - LINEAR_INCREMENTAL_CLOCK_SKEW_MS);
  return { updatedAt: { gt: overlapped.toISOString() } };
}
