/**
 * Helpers for the Webflow incremental-pull modified-since mechanism. Mirrors the
 * _shape_ of `moco/moco-incremental.ts` and `pipedrive/pipedrive-incremental.ts`
 * so the per-connector code reads the same. Webflow's modified-since mechanism is
 * the `lastUpdated[gte]=<iso>` range filter on the v2 List Collection Items
 * endpoint (added in Webflow's 08/08/2025 "Enhanced filtering and sorting"
 * changelog), passed on every CMS-collection list call.
 *
 * Every Webflow CMS item carries a server-side `lastUpdated`, and the filter is
 * the same regardless of collection — Webflow is the Moco/Pipedrive-style "fixed
 * system field" variant, NOT the Airtable/HubSpot resolver+override variant
 * (there is no per-collection variation in which field to use, so no annotation
 * resolver and no `modifiedAtField` advanced setting). Support is gated only by
 * TABLE TYPE: the site-level Assets and Pages tables have no changed-since filter
 * on their list endpoints, so they always full-pull (see
 * {@link webflowIncrementalPullSupport}). Webflow has no user `options.filter`
 * today, so there is no filter-combiner here; this module owns the clock-skew
 * constant, the watermark formatter, and the per-table capability gate.
 *
 * Unlike Moco/Pipedrive (whose `updated_after`/`updated_since` parsers reject the
 * fractional-second component `Date.toISOString()` emits), Webflow itself emits
 * `lastUpdated` as millisecond-precision ISO-8601 UTC (e.g.
 * `2024-01-15T10:30:00.000Z`), so the watermark is formatted to match exactly —
 * the format Webflow accepts and round-trips. No millisecond stripping.
 */

import { IncrementalPullSupport } from '@spinner/shared-types';
import { WEBFLOW_ASSETS_TABLE_ID_PREFIX } from './webflow-json-schema';
import { WEBFLOW_ORDERS_TABLE_ID_PREFIX, WEBFLOW_PAGES_TABLE_ID_PREFIX } from './webflow-types';

/**
 * Clock-skew safety margin subtracted from the watermark before formatting the
 * `lastUpdated[gte]` filter value. Webflow's `lastUpdated[gte]` is **inclusive**
 * (`>=`), but `lastUpdated` is written server-side while our watermark is
 * captured client-side, so without an overlap a record modified right at the
 * boundary (or while clocks drift) could be missed. The 60s margin re-pulls a
 * small window each run; idempotent pull commits absorb the duplicates.
 */
export const WEBFLOW_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

/**
 * Build the `lastUpdated[gte]` query value: subtract the clock-skew margin from
 * the watermark and render the resulting instant as a full millisecond-precision
 * ISO-8601 UTC string (`YYYY-MM-DDTHH:mm:ss.SSSZ`) — the exact format Webflow
 * emits for `lastUpdated`, so it round-trips cleanly. Passed verbatim as the
 * `lastUpdated[gte]` query value on the List Collection Items endpoint. See
 * {@link WEBFLOW_INCREMENTAL_CLOCK_SKEW_MS}.
 */
export function buildWebflowLastUpdatedFilter(since: Date): string {
  return new Date(since.getTime() - WEBFLOW_INCREMENTAL_CLOCK_SKEW_MS).toISOString();
}

/**
 * True when a Webflow table's collection remote id refers to a real CMS
 * collection (whose List Collection Items endpoint accepts the `lastUpdated`
 * filter), as opposed to the synthetic site-level Assets, Pages, or Orders tables
 * (whose list endpoints have no changed-since filter). `collectionRemoteId` is the
 * second element of the table's remoteId / `DataFolder.tableId`
 * (`[siteId, collectionId]`); for the Assets, Pages, and Orders tables it carries
 * the respective prefix, while a real collection id never does. (Ecommerce
 * Products/SKUs/Categories are ordinary CMS collections, so they ARE supported.)
 */
export function isWebflowCollectionItemsTable(collectionRemoteId: string): boolean {
  return (
    !collectionRemoteId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX) &&
    !collectionRemoteId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX) &&
    !collectionRemoteId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX)
  );
}

/**
 * Three-state incremental-pull capability for a Webflow table, keyed on the
 * collection remote id. CMS collections support a server-side `lastUpdated`
 * filter, so they are unconditionally `SUPPORTED`; the synthetic Assets and Pages
 * tables have no changed-since filter and so are `NOT_SUPPORTED` (never
 * `NEEDS_CONFIGURATION` — `lastUpdated` is a fixed system field, there is nothing
 * for the user to configure). Pure (no `this`, no network) so the REST capability
 * layer can call it from the registered `resolveIncrementalPullSupport` without
 * instantiating the connector.
 */
export function webflowIncrementalPullSupport(collectionRemoteId: string): IncrementalPullSupport {
  return isWebflowCollectionItemsTable(collectionRemoteId)
    ? IncrementalPullSupport.SUPPORTED
    : IncrementalPullSupport.NOT_SUPPORTED;
}
