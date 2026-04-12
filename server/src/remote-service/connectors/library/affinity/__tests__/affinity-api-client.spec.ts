/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import axios from 'axios';
import { AffinityApiClient, AffinityError } from '../affinity-api-client';

// Mock create-api-client to return a mock axios instance whose `get` we can
// inspect. This lets us assert on the *exact* path and query params each
// client method sends — the only place where bugs like passing the wrong
// `fieldTypes` constant become visible. The connector-level spec mocks the
// entire AffinityApiClient and so can't catch this kind of regression.
const mockGet = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: mockGet,
  })),
}));

// Helper: build a paginated response envelope. `nextCursor` is the cursor
// that will appear in the returned `nextUrl`'s query string (so the next
// `paginate` iteration receives it via `extractCursor`). Pass `null` for the
// final page.
function pagedResponse<T>(data: T[], nextCursor: string | null = null) {
  const nextUrl =
    nextCursor === null ? null : `https://api.affinity.co/v2/some-endpoint?cursor=${encodeURIComponent(nextCursor)}`;
  return { data: { data, pagination: { prevUrl: null, nextUrl } } };
}

describe('AffinityApiClient', () => {
  let client: AffinityApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new AffinityApiClient('test-api-key');
  });

  // ---------------------------------------------------------------------------
  // testConnection
  // ---------------------------------------------------------------------------

  describe('testConnection', () => {
    it('hits /v2/lists with limit=1 and resolves on success', async () => {
      mockGet.mockResolvedValue({ data: { data: [], pagination: { nextUrl: null } } });

      await expect(client.testConnection()).resolves.toBeUndefined();
      expect(mockGet).toHaveBeenCalledWith('/v2/lists', { params: { limit: 1 } });
    });

    it('translates 401 into a friendly AffinityError', async () => {
      const err = new axios.AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config: {} as never,
        data: { message: 'bad key' },
      });
      mockGet.mockRejectedValue(err);

      await expect(client.testConnection()).rejects.toThrow(AffinityError);
      await expect(client.testConnection()).rejects.toThrow(/v2 permissions/);
    });

    it('translates 403 into the same friendly AffinityError', async () => {
      const err = new axios.AxiosError('Forbidden', '403', undefined, undefined, {
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        config: {} as never,
        data: {},
      });
      mockGet.mockRejectedValue(err);

      await expect(client.testConnection()).rejects.toThrow(AffinityError);
    });

    it('rethrows non-auth errors verbatim', async () => {
      const err = new Error('network down');
      mockGet.mockRejectedValue(err);

      await expect(client.testConnection()).rejects.toThrow('network down');
    });
  });

  // ---------------------------------------------------------------------------
  // paginate (exercised via list methods) — cursor extraction + termination
  // ---------------------------------------------------------------------------

  describe('paginate (via listAllLists)', () => {
    it('terminates on the first page when nextUrl is null', async () => {
      mockGet.mockResolvedValue(pagedResponse([{ id: 1 }, { id: 2 }]));

      const result = await client.listAllLists();

      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
      expect(mockGet).toHaveBeenCalledTimes(1);
      // First call should have no cursor and use the default page limit.
      expect(mockGet.mock.calls[0]).toEqual(['/v2/lists', { params: { limit: 100 } }]);
    });

    it('follows nextUrl by extracting the cursor query param across pages', async () => {
      mockGet
        .mockResolvedValueOnce(pagedResponse([{ id: 1 }], 'cursor-page-2'))
        .mockResolvedValueOnce(pagedResponse([{ id: 2 }], 'cursor-page-3'))
        .mockResolvedValueOnce(pagedResponse([{ id: 3 }], null));

      const result = await client.listAllLists();

      expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(mockGet).toHaveBeenCalledTimes(3);
      // Subsequent calls should carry the cursor from the previous page's nextUrl.
      expect(mockGet.mock.calls[1][1].params).toMatchObject({ cursor: 'cursor-page-2' });
      expect(mockGet.mock.calls[2][1].params).toMatchObject({ cursor: 'cursor-page-3' });
    });

    it('treats data: null on the page envelope as an empty page', async () => {
      mockGet.mockResolvedValue({ data: { data: null, pagination: { nextUrl: null } } });

      const result = await client.listAllLists();

      expect(result).toEqual([]);
    });

    it('stops paginating if nextUrl is a relative URL (cursor cannot be extracted)', async () => {
      // Defensive: if Affinity ever returns a relative nextUrl, `new URL(...)` throws,
      // extractCursor returns undefined, and the loop terminates rather than spinning forever.
      mockGet.mockResolvedValue({
        data: {
          data: [{ id: 1 }],
          pagination: { nextUrl: '/v2/lists?cursor=abc' },
        },
      });

      const result = await client.listAllLists();

      expect(result).toEqual([{ id: 1 }]);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('stops paginating if nextUrl has no cursor query param', async () => {
      mockGet.mockResolvedValue({
        data: {
          data: [{ id: 1 }],
          pagination: { nextUrl: 'https://api.affinity.co/v2/lists?other=foo' },
        },
      });

      const result = await client.listAllLists();

      expect(result).toEqual([{ id: 1 }]);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // listListEntries — must pass fieldTypes including 'list'
  // ---------------------------------------------------------------------------

  describe('listListEntries', () => {
    it('hits the correct list-entries path with all four fieldTypes', async () => {
      mockGet.mockResolvedValue(pagedResponse([]));

      const generator = client.listListEntries(12345);
      await generator.next();

      expect(mockGet).toHaveBeenCalledTimes(1);
      const [path, config] = mockGet.mock.calls[0];
      expect(path).toBe('/v2/lists/12345/list-entries');
      // List entries CAN have list-specific fields, so 'list' must be in fieldTypes.
      // Regression guard against accidentally swapping FIELD_TYPES with TENANT_FIELD_TYPES.
      expect(config.params.fieldTypes).toEqual(['list', 'enriched', 'global', 'relationship-intelligence']);
      expect(config.params.fieldTypes).toContain('list');
    });

    it('passes the resumeCursor through to the first request', async () => {
      mockGet.mockResolvedValue(pagedResponse([]));

      const generator = client.listListEntries(12345, 'resume-from-here');
      await generator.next();

      expect(mockGet.mock.calls[0][1].params).toMatchObject({ cursor: 'resume-from-here' });
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant-wide endpoints — MUST NOT pass fieldTypes=list
  // (the bug we just fixed)
  // ---------------------------------------------------------------------------

  describe('listAllPersons', () => {
    it('hits /v2/persons with the three tenant field types — and crucially no "list"', async () => {
      mockGet.mockResolvedValue(pagedResponse([]));

      const generator = client.listAllPersons();
      await generator.next();

      expect(mockGet).toHaveBeenCalledTimes(1);
      const [path, config] = mockGet.mock.calls[0];
      expect(path).toBe('/v2/persons');
      expect(config.params.fieldTypes).toEqual(['enriched', 'global', 'relationship-intelligence']);
      // Affinity rejects fieldTypes=list on /v2/persons with HTTP 400. This is the
      // exact assertion that would have caught the original tenant-table bug.
      expect(config.params.fieldTypes).not.toContain('list');
    });

    it('threads the resumeCursor into the first paginate call', async () => {
      mockGet.mockResolvedValue(pagedResponse([]));

      const generator = client.listAllPersons('p2-cursor');
      await generator.next();

      expect(mockGet.mock.calls[0][1].params).toMatchObject({ cursor: 'p2-cursor' });
    });
  });

  describe('listAllCompanies', () => {
    it('hits /v2/companies with TENANT_FIELD_TYPES — no "list"', async () => {
      mockGet.mockResolvedValue(pagedResponse([]));

      const generator = client.listAllCompanies();
      await generator.next();

      const [path, config] = mockGet.mock.calls[0];
      expect(path).toBe('/v2/companies');
      expect(config.params.fieldTypes).toEqual(['enriched', 'global', 'relationship-intelligence']);
      expect(config.params.fieldTypes).not.toContain('list');
    });
  });

  describe('listAllOpportunities', () => {
    it('hits /v2/opportunities with NO fieldTypes parameter', async () => {
      mockGet.mockResolvedValue(pagedResponse([]));

      const generator = client.listAllOpportunities();
      await generator.next();

      const [path, config] = mockGet.mock.calls[0];
      expect(path).toBe('/v2/opportunities');
      // Opportunities tenant endpoint returns id/name/listId only — no field
      // data, no fieldTypes parameter accepted.
      expect(config.params).not.toHaveProperty('fieldTypes');
      expect(config.params).toEqual({ limit: 100 });
    });
  });

  // ---------------------------------------------------------------------------
  // Field-metadata endpoints — note the path is /v2/{kind}/fields,
  // NOT /v2/{kind}/metadata/fields (Affinity's docs are wrong about this).
  // ---------------------------------------------------------------------------

  describe('listListFields', () => {
    it('paginates /v2/lists/{id}/fields', async () => {
      mockGet.mockResolvedValue(pagedResponse([{ id: 'field-a' }]));

      const result = await client.listListFields(12345);

      expect(result).toEqual([{ id: 'field-a' }]);
      expect(mockGet.mock.calls[0][0]).toBe('/v2/lists/12345/fields');
    });
  });

  describe('listPersonFields', () => {
    it('paginates /v2/persons/fields (NOT /v2/persons/metadata/fields)', async () => {
      mockGet.mockResolvedValue(pagedResponse([{ id: 'affinity-data-current-organization' }]));

      const result = await client.listPersonFields();

      expect(result).toEqual([{ id: 'affinity-data-current-organization' }]);
      // The actual path Affinity exposes — the /metadata/fields path in their
      // public docs returns 404 in production. Pinning the right path here so
      // a future docs-driven "fix" doesn't break it.
      expect(mockGet.mock.calls[0][0]).toBe('/v2/persons/fields');
    });
  });

  describe('listCompanyFields', () => {
    it('paginates /v2/companies/fields (NOT /v2/companies/metadata/fields)', async () => {
      mockGet.mockResolvedValue(pagedResponse([{ id: 'affinity-data-industry' }]));

      const result = await client.listCompanyFields();

      expect(result).toEqual([{ id: 'affinity-data-industry' }]);
      expect(mockGet.mock.calls[0][0]).toBe('/v2/companies/fields');
    });
  });

  // ---------------------------------------------------------------------------
  // Single-record fetchers — return null on 404, throw on other errors
  // ---------------------------------------------------------------------------

  describe('getList', () => {
    it('returns the list on 200', async () => {
      mockGet.mockResolvedValue({ data: { id: 12345, name: 'My List' } });

      const result = await client.getList(12345);

      expect(result).toEqual({ id: 12345, name: 'My List' });
      expect(mockGet).toHaveBeenCalledWith('/v2/lists/12345');
    });

    it('returns null on 404', async () => {
      const err = new axios.AxiosError('Not Found', '404', undefined, undefined, {
        status: 404,
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
        data: {},
      });
      mockGet.mockRejectedValue(err);

      const result = await client.getList(12345);

      expect(result).toBeNull();
    });

    it('rethrows non-404 axios errors', async () => {
      const err = new axios.AxiosError('Server Error', '500', undefined, undefined, {
        status: 500,
        statusText: 'Server Error',
        headers: {},
        config: {} as never,
        data: {},
      });
      mockGet.mockRejectedValue(err);

      await expect(client.getList(12345)).rejects.toThrow();
    });
  });

  describe('getListEntry', () => {
    it('passes fieldTypes including "list" (it IS a list-entry endpoint)', async () => {
      mockGet.mockResolvedValue({ data: { id: 1 } });

      await client.getListEntry(12345, 1);

      const [path, config] = mockGet.mock.calls[0];
      expect(path).toBe('/v2/lists/12345/list-entries/1');
      expect(config.params.fieldTypes).toContain('list');
    });

    it('returns null on 404', async () => {
      const err = new axios.AxiosError('Not Found', '404', undefined, undefined, {
        status: 404,
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
        data: {},
      });
      mockGet.mockRejectedValue(err);

      const result = await client.getListEntry(12345, 99);

      expect(result).toBeNull();
    });
  });

  describe('getPerson', () => {
    it('passes TENANT_FIELD_TYPES (no "list")', async () => {
      mockGet.mockResolvedValue({ data: { id: 7101 } });

      await client.getPerson(7101);

      const [path, config] = mockGet.mock.calls[0];
      expect(path).toBe('/v2/persons/7101');
      expect(config.params.fieldTypes).not.toContain('list');
      expect(config.params.fieldTypes).toEqual(['enriched', 'global', 'relationship-intelligence']);
    });

    it('returns null on 404', async () => {
      const err = new axios.AxiosError('Not Found', '404', undefined, undefined, {
        status: 404,
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
        data: {},
      });
      mockGet.mockRejectedValue(err);

      const result = await client.getPerson(7101);

      expect(result).toBeNull();
    });
  });

  describe('getCompany', () => {
    it('passes TENANT_FIELD_TYPES (no "list")', async () => {
      mockGet.mockResolvedValue({ data: { id: 7001 } });

      await client.getCompany(7001);

      const [path, config] = mockGet.mock.calls[0];
      expect(path).toBe('/v2/companies/7001');
      expect(config.params.fieldTypes).not.toContain('list');
    });

    it('returns null on 404', async () => {
      const err = new axios.AxiosError('Not Found', '404', undefined, undefined, {
        status: 404,
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
        data: {},
      });
      mockGet.mockRejectedValue(err);

      expect(await client.getCompany(7001)).toBeNull();
    });
  });

  describe('getOpportunity', () => {
    it('passes NO fieldTypes parameter (Affinity v2 opportunity endpoint takes no field types)', async () => {
      mockGet.mockResolvedValue({ data: { id: 7201, name: 'Acme Upsell', listId: 1003 } });

      const result = await client.getOpportunity(7201);

      const [path, config] = mockGet.mock.calls[0];
      expect(path).toBe('/v2/opportunities/7201');
      // No params at all — getOpportunity calls http.get without a config.
      expect(config).toBeUndefined();
      expect(result).toEqual({ id: 7201, name: 'Acme Upsell', listId: 1003 });
    });

    it('returns null on 404', async () => {
      const err = new axios.AxiosError('Not Found', '404', undefined, undefined, {
        status: 404,
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
        data: {},
      });
      mockGet.mockRejectedValue(err);

      expect(await client.getOpportunity(7201)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getQuota — v1-era endpoint, no /v2 prefix
  // ---------------------------------------------------------------------------

  describe('getQuota', () => {
    it('hits /rate-limit (no /v2 prefix) and returns the body', async () => {
      mockGet.mockResolvedValue({
        data: {
          rate: {
            api_key_per_minute: { limit: 900, remaining: 850, used: 50, reset: 30 },
            org_monthly: { limit: 100000, remaining: 99000, used: 1000, reset: 86400 },
          },
        },
      });

      const result = await client.getQuota();

      expect(mockGet).toHaveBeenCalledWith('/rate-limit');
      expect(result.rate.api_key_per_minute.limit).toBe(900);
    });
  });
});
