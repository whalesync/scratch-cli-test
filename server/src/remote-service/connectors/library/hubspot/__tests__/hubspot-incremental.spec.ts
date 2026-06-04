import {
  buildHubspotModifiedSinceSearch,
  HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS,
  HUBSPOT_SEARCH_PAGE_SIZE,
} from '../hubspot-incremental';

describe('HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS', () => {
  it('is 60s — hs_lastmodifieddate is server-side while the watermark is client-side', () => {
    expect(HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
  });
});

describe('buildHubspotModifiedSinceSearch', () => {
  const propertyNames = ['name', 'email', 'hs_lastmodifieddate'];

  it('builds a GTE filter on the modified-date property using the clock-skewed epoch-ms watermark', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    const body = buildHubspotModifiedSinceSearch('hs_lastmodifieddate', since, propertyNames);

    const expectedValue = String(since.getTime() - HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS);
    expect(body.filterGroups).toEqual([
      { filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: expectedValue }] },
    ]);
    // 2026-05-14T11:59:00.000Z in epoch-ms
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
