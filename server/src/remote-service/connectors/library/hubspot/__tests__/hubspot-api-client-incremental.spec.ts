import { WSLogger } from 'src/logger';
import {
  HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS,
  HUBSPOT_SEARCH_MAX_RESULT_WINDOW,
  HUBSPOT_SEARCH_PAGE_SIZE,
} from '../hubspot-incremental';
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

/** A record carrying an explicit modified-date property, used to exercise the
 * 10,000-result window re-anchoring (which reads that field off the last record). */
function recordModifiedAt(id: string, modifiedAt: string, modifiedField = 'hs_lastmodifieddate'): HubspotRecord {
  return {
    id,
    properties: { name: `r${id}`, [modifiedField]: modifiedAt },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: modifiedAt,
    archived: false,
  };
}

/** The GTE (modified-since) filter value carried by the nth POST body. */
function filterValue(callIndex: number): string {
  const body = postBody(callIndex) as {
    filterGroups: { filters: { value: string }[] }[];
  };
  return body.filterGroups[0].filters[0].value;
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

  describe('10,000-result window splitting', () => {
    it('re-anchors a fresh window by the last record modified-date instead of paging into the 400', async () => {
      // First page reports a next `after` at the 10,000 ceiling; the generator
      // must NOT request it (that would 400) and instead re-anchor at the newest
      // record's modified-date, resetting the offset.
      mockPost
        .mockResolvedValueOnce({
          data: {
            total: 99999,
            results: [recordModifiedAt('A', '2026-05-14T13:00:00.000Z')],
            paging: { next: { after: String(HUBSPOT_SEARCH_MAX_RESULT_WINDOW) } },
          },
        })
        .mockResolvedValueOnce({
          data: { total: 99999, results: [recordModifiedAt('B', '2026-05-14T14:00:00.000Z')] },
        });

      const pages = await drain(
        client.searchRecordsModifiedSince('contacts', ['name', 'hs_lastmodifieddate'], 'hs_lastmodifieddate', since),
      );

      expect(mockPost).toHaveBeenCalledTimes(2);
      // First window: skewed watermark, no offset.
      expect(filterValue(0)).toBe(expectedValue);
      expect(postBody(0)).not.toHaveProperty('after');
      // Second window: re-anchored at the last record's modified-date, offset reset.
      expect(filterValue(1)).toBe(String(Date.parse('2026-05-14T13:00:00.000Z')));
      expect(postBody(1)).not.toHaveProperty('after');
      // The ceiling page hands back NO resume cursor (an offset scoped to the
      // abandoned window would 400 on resume); the tail page carries none either.
      expect(pages.map((p) => p.records[0].id)).toEqual(['A', 'B']);
      expect(pages.map((p) => p.nextCursor)).toEqual([undefined, undefined]);
    });

    it('stops (rather than looping) when a full 10k window shares one timestamp', async () => {
      const warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
      // The whole window sits at the skewed lower bound itself, so re-anchoring
      // there can't advance. Only one call is mocked: a second call would prove an
      // infinite loop (and throw on undefined data).
      const skewedLowerBoundIso = new Date(since.getTime() - HUBSPOT_INCREMENTAL_CLOCK_SKEW_MS).toISOString();
      mockPost.mockResolvedValueOnce({
        data: {
          total: 99999,
          results: [recordModifiedAt('A', skewedLowerBoundIso)],
          paging: { next: { after: String(HUBSPOT_SEARCH_MAX_RESULT_WINDOW) } },
        },
      });

      const pages = await drain(
        client.searchRecordsModifiedSince('contacts', ['name', 'hs_lastmodifieddate'], 'hs_lastmodifieddate', since),
      );

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(pages.map((p) => p.records[0].id)).toEqual(['A']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });
});
