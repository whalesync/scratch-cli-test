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
 * Two documented v1 limitations live with this mechanism (see the connector and
 * `CONNECTOR_GUIDE.md`):
 *   - The Search API returns `properties` but not `associations`, so incremental
 *     pulls don't refresh association data — the periodic `FULL_PULL` reconciles.
 *   - A single Search result set is capped at 10,000 records; steady-state deltas
 *     are far smaller, bootstrap is always a full pull, and the watermark advances
 *     by what returned, so the next run continues. `FULL_PULL` is the safety net.
 */

import { HubspotSearchRequestBody } from './hubspot-types';

/** Page size for the CRM Search API. The Search endpoint allows up to 200; we
 * use 100 to match the list endpoint's page size. */
export const HUBSPOT_SEARCH_PAGE_SIZE = 100;

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
 * Build the CRM Search request body for records modified on or after `since`,
 * applying the clock-skew overlap. The watermark is rendered as **epoch
 * milliseconds** (a string) — the format HubSpot's Search API accepts uniformly
 * for date/datetime properties across every object type.
 *
 * Results are sorted ascending by the modified-date property so the cursor walks
 * oldest-changed → newest-changed; a record updated mid-pagination moves to the
 * tail (possible duplicate, never a miss). `propertyNames` requests the full
 * property set (HubSpot otherwise returns only a default subset). `after` is the
 * pagination cursor for subsequent pages; omitted on the first request.
 */
export function buildHubspotModifiedSinceSearch(
  modifiedAtField: string,
  since: Date,
  propertyNames: string[],
  after?: string,
): HubspotSearchRequestBody {
  const overlapped = new Date(since.getTime() - HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS);
  const body: HubspotSearchRequestBody = {
    filterGroups: [
      {
        filters: [{ propertyName: modifiedAtField, operator: 'GTE', value: String(overlapped.getTime()) }],
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
