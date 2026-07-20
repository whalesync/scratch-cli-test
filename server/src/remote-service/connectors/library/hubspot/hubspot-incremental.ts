/**
 * Helpers for the HubSpot incremental-pull modified-since mechanism.
 *
 * HubSpot's standard list endpoint (`GET /crm/v3/objects/{type}`) cannot filter
 * by modified date, so incremental pulls switch to the **CRM Search API**
 * (`POST /crm/v3/objects/{type}/search`) with a `<modifiedAtField> GTE <since>`
 * filter, sorted ascending. The modified-date property is object-type-dependent
 * (`hs_lastmodifieddate` for most CRM objects, `lastmodifieddate` for contacts,
 * custom objects vary), so the property name is resolved per folder (annotated
 * field or explicit `modifiedAtField` override) and passed into the builder.
 *
 * This module owns the clock-skew constant and the search-body builder. HubSpot
 * has no user `options.filter` today, so there is no filter-combiner here.
 *
 * Two behaviors live with this mechanism (see the connector and
 * `CONNECTOR_GUIDE.md`):
 *   - The Search API returns `properties` but not `associations`, so the
 *     connector re-fetches each changed record via single-record GET to hydrate
 *     associations before emitting files (emitting search results bare would
 *     wipe previously-pulled association data). Association changes that don't
 *     bump the modified date are still reconciled by the periodic `FULL_PULL`.
 *   - HubSpot's Search API refuses to page past its first 10,000 results per
 *     query (offset `after` >= 10,000 returns HTTP 400, which is not retried), so
 *     a single `since` window can't be walked straight through when more than
 *     10,000 records changed. `searchRecordsModifiedSince` therefore **splits the
 *     window**: because results are sorted ascending by the modified-date field,
 *     when the next page would cross the 10,000 ceiling it re-anchors a fresh
 *     Search at the newest record's modified-date and resets the offset. This
 *     walks the whole delta in 10,000-record windows within a single run, so the
 *     watermark advances normally. The one shape it can't drain is a block of
 *     >10,000 records that all share the exact same modified timestamp; that tail
 *     is left for the periodic `FULL_PULL` to reconcile.
 */

import { HubspotSearchRequestBody } from './hubspot-types';

/** Page size for the CRM Search API. The Search endpoint allows up to 200; we
 * use 100 to match the list endpoint's page size. */
export const HUBSPOT_SEARCH_PAGE_SIZE = 100;

/**
 * HubSpot's CRM Search API caps any single query at its first 10,000 results:
 * requesting a page whose offset (`after`) reaches 10,000 returns HTTP 400
 * ("The maximum offset supported for search is 10,000"), which is a validation
 * error, not a rate limit, so it is never retried. `searchRecordsModifiedSince`
 * re-anchors a fresh window by modified-date before the offset reaches this
 * ceiling rather than paging into the 400.
 */
export const HUBSPOT_SEARCH_MAX_RESULT_WINDOW = 10_000;

/**
 * Clock-skew safety margin subtracted from the watermark before formatting the
 * `GTE` value. HubSpot's `GTE` operator is **inclusive** (`>=`), but
 * `hs_lastmodifieddate` is written server-side while our watermark is captured
 * client-side, so without an overlap a record modified right at the boundary
 * (or while clocks drift) could be missed. The 60s margin re-pulls a small
 * window each run; idempotent commits absorb the duplicates.
 */
export const HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

/**
 * Build the CRM Search request body for records modified on or after
 * `windowLowerBound`, which is the **exact** inclusive lower bound to query —
 * the caller applies the {@link HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS} overlap once
 * to the watermark, and re-anchored windows pass a HubSpot server timestamp
 * verbatim (no skew). It is rendered as **epoch milliseconds** (a string) — the
 * format HubSpot's Search API accepts uniformly for date/datetime properties
 * across every object type.
 *
 * Results are sorted ascending by the modified-date property so the cursor walks
 * oldest-changed → newest-changed; a record updated mid-pagination moves to the
 * tail (possible duplicate, never a miss). `propertyNames` requests the full
 * property set (HubSpot otherwise returns only a default subset). `after` is the
 * pagination cursor for subsequent pages; omitted on the first request.
 */
export function buildHubspotModifiedSinceSearch(
  modifiedAtField: string,
  windowLowerBound: Date,
  propertyNames: string[],
  after?: string,
): HubspotSearchRequestBody {
  const body: HubspotSearchRequestBody = {
    filterGroups: [
      {
        filters: [{ propertyName: modifiedAtField, operator: 'GTE', value: String(windowLowerBound.getTime()) }],
      },
    ],
    sorts: [{ propertyName: modifiedAtField, direction: 'ASCENDING' }],
    properties: propertyNames,
    limit: HUBSPOT_SEARCH_PAGE_SIZE,
  };
  if (after) {
    body.after = after;
  }
  return body;
}

/**
 * Parse a record's modified-date property value into epoch milliseconds, used to
 * re-anchor the next Search window at the boundary between two 10,000-record
 * pages. HubSpot returns datetime properties as ISO-8601 strings (e.g.
 * `2026-05-14T12:00:00.000Z`), but a raw epoch-ms string is tolerated too.
 * Returns `undefined` when the value is absent or unparseable.
 */
export function parseHubspotModifiedAtToEpochMs(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const parsedMs = Date.parse(value);
  return Number.isNaN(parsedMs) ? undefined : parsedMs;
}
