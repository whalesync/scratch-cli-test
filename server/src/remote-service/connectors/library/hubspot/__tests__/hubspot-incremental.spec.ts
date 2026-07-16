import {
  buildHubspotModifiedSinceSearch,
  HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS,
  HUBSPOT_SEARCH_MAX_RESULT_WINDOW,
  HUBSPOT_SEARCH_PAGE_SIZE,
  parseHubspotModifiedAtToEpochMs,
} from '../hubspot-incremental';

describe('HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS', () => {
  it('is 60s — hs_lastmodifieddate is server-side while the watermark is client-side', () => {
    expect(HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
  });
});

describe('HUBSPOT_SEARCH_MAX_RESULT_WINDOW', () => {
  it('is 10,000 — HubSpot Search 400s once the offset reaches this ceiling', () => {
    expect(HUBSPOT_SEARCH_MAX_RESULT_WINDOW).toBe(10_000);
  });
});

describe('buildHubspotModifiedSinceSearch', () => {
  const propertyNames = ['name', 'email', 'hs_lastmodifieddate'];

  it('builds a GTE filter rendering the exact epoch-ms window lower bound (no skew applied here)', () => {
    // The caller subtracts the clock skew before calling the builder; the builder
    // renders whatever lower bound it is handed verbatim.
    const windowLowerBound = new Date('2026-05-14T11:59:00.000Z');
    const body = buildHubspotModifiedSinceSearch('hs_lastmodifieddate', windowLowerBound, propertyNames);

    expect(body.filterGroups).toEqual([
      {
        filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(windowLowerBound.getTime()) }],
      },
    ]);
    expect(body.filterGroups[0].filters[0].value).toBe(String(Date.parse('2026-05-14T11:59:00.000Z')));
  });

  it('sorts ascending by the modified-date property so the cursor walks oldest→newest changes', () => {
    const body = buildHubspotModifiedSinceSearch(
      'lastmodifieddate',
      new Date('2026-01-01T00:00:00.000Z'),
      propertyNames,
    );
    expect(body.sorts).toEqual([{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }]);
  });

  it('requests the full property set and the search page size', () => {
    const body = buildHubspotModifiedSinceSearch(
      'hs_lastmodifieddate',
      new Date('2026-01-01T00:00:00.000Z'),
      propertyNames,
    );
    expect(body.properties).toEqual(propertyNames);
    expect(body.limit).toBe(HUBSPOT_SEARCH_PAGE_SIZE);
  });

  it('omits `after` on the first page and includes it on subsequent pages', () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    expect(buildHubspotModifiedSinceSearch('hs_lastmodifieddate', since, propertyNames).after).toBeUndefined();
    expect(buildHubspotModifiedSinceSearch('hs_lastmodifieddate', since, propertyNames, '100').after).toBe('100');
  });

  it('honors a custom modified-date property name (custom-object override)', () => {
    const body = buildHubspotModifiedSinceSearch(
      'my_custom_modified',
      new Date('2026-01-01T00:00:00.000Z'),
      propertyNames,
    );
    expect(body.filterGroups[0].filters[0].propertyName).toBe('my_custom_modified');
    expect(body.sorts[0].propertyName).toBe('my_custom_modified');
  });
});

describe('parseHubspotModifiedAtToEpochMs', () => {
  it('parses an ISO-8601 datetime (the shape HubSpot returns for date properties)', () => {
    expect(parseHubspotModifiedAtToEpochMs('2026-05-14T12:00:00.000Z')).toBe(Date.parse('2026-05-14T12:00:00.000Z'));
  });

  it('tolerates a raw epoch-ms string', () => {
    expect(parseHubspotModifiedAtToEpochMs('1747224000000')).toBe(1747224000000);
  });

  it('returns undefined for absent or unparseable values', () => {
    expect(parseHubspotModifiedAtToEpochMs(null)).toBeUndefined();
    expect(parseHubspotModifiedAtToEpochMs(undefined)).toBeUndefined();
    expect(parseHubspotModifiedAtToEpochMs('')).toBeUndefined();
    expect(parseHubspotModifiedAtToEpochMs('not-a-date')).toBeUndefined();
  });
});
