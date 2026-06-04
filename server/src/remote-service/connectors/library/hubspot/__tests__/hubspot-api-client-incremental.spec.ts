import { HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS, HUBSPOT_SEARCH_PAGE_SIZE } from '../hubspot-incremental';
import { HubspotRecord } from '../hubspot-types';

const mockPost = jest.fn();
const mockGet = jest.fn();

// Mock the shared axios factory so no real HTTP client is constructed; the
// client's `this.http` becomes our { get, post } stub.
jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({ get: mockGet, post: mockPost })),
}));

import { HubspotApiClient } from '../hubspot-api-client';

function record(id: string, archived = false): HubspotRecord {
  return {
    id,
    properties: { name: `r${id}` },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    archived,
  };
}

/** The request body (2nd arg) of the nth POST call, typed for assertions. */
function postBody(callIndex: number): Record<string, unknown> {
  const args = mockPost.mock.calls[callIndex] as unknown[];
  return args[1] as Record<string, unknown>;
}

async function drain(
  gen: AsyncGenerator<{ records: HubspotRecord[]; nextCursor: string | undefined }>,
): Promise<{ records: HubspotRecord[]; nextCursor: string | undefined }[]> {
  const pages: { records: HubspotRecord[]; nextCursor: string | undefined }[] = [];
  for await (const page of gen) {
    pages.push(page);
  }
  return pages;
}

describe('HubspotApiClient.searchRecordsModifiedSince', () => {
  let client: HubspotApiClient;
  const since = new Date('2026-05-14T12:00:00.000Z');
  const expectedValue = String(since.getTime() - HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS);

  beforeEach(() => {
    jest.clearAllMocks();
    client = new HubspotApiClient('test-token');
  });

  it('POSTs to the CRM Search endpoint with the GTE filter, ascending sort, properties, and limit', async () => {
    mockPost.mockResolvedValueOnce({ data: { total: 1, results: [record('1')] } });

    const pages = await drain(
      client.searchRecordsModifiedSince('contacts', ['name', 'email'], 'hs_lastmodifieddate', since),
    );

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: expectedValue }] }],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties: ['name', 'email'],
      limit: HUBSPOT_SEARCH_PAGE_SIZE,
    });
    expect(pages).toEqual([{ records: [record('1')], nextCursor: undefined }]);
  });

  it('paginates via the search `after` cursor and re-sends the filter on every page', async () => {
    mockPost
      .mockResolvedValueOnce({ data: { total: 2, results: [record('1')], paging: { next: { after: '100' } } } })
      .mockResolvedValueOnce({ data: { total: 2, results: [record('2')] } });

    const pages = await drain(client.searchRecordsModifiedSince('deals', ['dealname'], 'hs_lastmodifieddate', since));

    expect(mockPost).toHaveBeenCalledTimes(2);
    // First page: no `after`.
    expect(postBody(0)).not.toHaveProperty('after');
    // Second page: carries the cursor and the same filter/sort.
    expect(postBody(1)).toMatchObject({
      after: '100',
      filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: expectedValue }] }],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
    });
    expect(pages.map((p) => p.records[0].id)).toEqual(['1', '2']);
    expect(pages.map((p) => p.nextCursor)).toEqual(['100', undefined]);
  });

  it('resumes from a provided start cursor', async () => {
    mockPost.mockResolvedValueOnce({ data: { total: 1, results: [record('9')] } });

    await drain(client.searchRecordsModifiedSince('companies', ['name'], 'hs_lastmodifieddate', since, 'CUR42'));

    expect(postBody(0)).toMatchObject({ after: 'CUR42' });
  });

  it('filters out archived records', async () => {
    mockPost.mockResolvedValueOnce({
      data: { total: 2, results: [record('1'), record('2', true)] },
    });

    const pages = await drain(client.searchRecordsModifiedSince('contacts', ['name'], 'hs_lastmodifieddate', since));

    expect(pages[0].records.map((r) => r.id)).toEqual(['1']);
  });

  it('does not yield an empty page when every result on a page is archived', async () => {
    mockPost.mockResolvedValueOnce({ data: { total: 1, results: [record('1', true)] } });

    const pages = await drain(client.searchRecordsModifiedSince('contacts', ['name'], 'hs_lastmodifieddate', since));

    expect(pages).toEqual([]);
  });
});
