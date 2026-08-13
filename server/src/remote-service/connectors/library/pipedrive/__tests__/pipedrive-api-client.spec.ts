import axios from 'axios';
import { PipedriveApiClient } from '../pipedrive-api-client';

// Mock create-api-client to return a mock axios instance whose verbs we can
// inspect. This pins the exact path / query / body each method sends — the whole
// point of an api-client test (the connector-level spec mocks the entire client
// and so can't catch a wrong URL, a dropped query param, or a mis-shaped body).
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();

/**
 * Every `authorizationHeaderValueProvider` handed to `createApiClient`, in call
 * order. Captured here (rather than dug out of `mock.calls`) so the provider stays
 * typed — the OAuth path resolves its bearer token per request now, so the
 * provider is the thing worth asserting on.
 */
const mockAuthorizationHeaderValueProviders: (() => Promise<string>)[] = [];

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(
    (_config?: unknown, options?: { authorizationHeaderValueProvider?: () => Promise<string> }) => {
      if (options?.authorizationHeaderValueProvider) {
        mockAuthorizationHeaderValueProviders.push(options.authorizationHeaderValueProvider);
      }
      return {
        get: mockGet,
        post: mockPost,
        patch: mockPatch,
        put: mockPut,
        delete: mockDelete,
      };
    },
  ),
}));

import { createApiClient } from '../../../create-api-client';

/** Build an axios error carrying a given HTTP status + response body. */
function makeAxiosError(status: number, data: unknown): axios.AxiosError {
  return new axios.AxiosError(`Request failed with status code ${status}`, String(status), undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: {} as never,
    data,
  });
}

/** Consume an async generator to exhaustion. */
async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _page of gen) {
    // consume the generator
  }
}

describe('PipedriveApiClient', () => {
  let client: PipedriveApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorizationHeaderValueProviders.length = 0;
    client = new PipedriveApiClient('test-key');
  });

  describe('constructor', () => {
    it('configures the bare host base URL and authenticates the API key via the x-api-token header', () => {
      expect(createApiClient).toHaveBeenCalledWith({
        baseURL: 'https://api.pipedrive.com',
        headers: {
          'Content-Type': 'application/json',
          'x-api-token': 'test-key',
        },
      });
    });

    it('authenticates an OAuth token via the Authorization Bearer header (no x-api-token)', async () => {
      jest.clearAllMocks();
      new PipedriveApiClient('oauth-token', { authType: 'oauth' });
      // The OAuth bearer is a provider, not a static header, so a job outliving
      // the access token picks up the refreshed one (DEV-11270).
      expect(createApiClient).toHaveBeenCalledWith(
        {
          baseURL: 'https://api.pipedrive.com',
          headers: { 'Content-Type': 'application/json' },
        },
        { authorizationHeaderValueProvider: mockAuthorizationHeaderValueProviders[0] },
      );
      await expect(mockAuthorizationHeaderValueProviders[0]()).resolves.toBe('Bearer oauth-token');
    });

    it('re-resolves the OAuth bearer token on every request', async () => {
      const accessTokens = ['first-token', 'second-token'];
      new PipedriveApiClient(() => Promise.resolve(accessTokens.shift() ?? 'exhausted'), { authType: 'oauth' });

      const provider = mockAuthorizationHeaderValueProviders[0];
      await expect(provider()).resolves.toBe('Bearer first-token');
      await expect(provider()).resolves.toBe('Bearer second-token');
    });
  });

  describe('testConnection', () => {
    it('GETs the v2 /deals path with limit 1', async () => {
      mockGet.mockResolvedValue({ data: { data: [], additional_data: {} } });
      await client.testConnection();
      expect(mockGet).toHaveBeenCalledWith('/api/v2/deals', { params: { limit: 1 } });
    });

    it('maps a 401 to a PipedriveError with status 401', async () => {
      mockGet.mockRejectedValue(makeAxiosError(401, { error: 'unauthorized' }));
      await expect(client.testConnection()).rejects.toMatchObject({
        name: 'PipedriveError',
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
    });

    it('re-throws non-401 errors unchanged (no PipedriveError wrapping)', async () => {
      const error = makeAxiosError(500, { error: 'boom' });
      mockGet.mockRejectedValue(error);
      await expect(client.testConnection()).rejects.toBe(error);
    });
  });

  describe('getFields', () => {
    it('GETs the per-entity v2 Fields path and unwraps the data array', async () => {
      mockGet.mockResolvedValue({
        data: { data: [{ field_code: 'title', is_custom_field: false }], additional_data: {} },
      });
      const fields = await client.getFields('deals');
      expect(mockGet).toHaveBeenCalledWith('/api/v2/dealFields', { params: { limit: 500 } });
      expect(fields).toEqual([{ field_code: 'title', is_custom_field: false }]);
    });

    it.each([
      ['persons', '/api/v2/personFields'],
      ['organizations', '/api/v2/organizationFields'],
      ['products', '/api/v2/productFields'],
      ['activities', '/api/v2/activityFields'],
      // Leads have no Fields endpoint of their own — they share deals' custom fields.
      ['leads', '/api/v2/dealFields'],
    ] as const)('uses %s → %s', async (entityType, path) => {
      mockGet.mockResolvedValue({ data: { data: [], additional_data: {} } });
      await client.getFields(entityType);
      expect(mockGet).toHaveBeenCalledWith(path, { params: { limit: 500 } });
    });

    it('returns [] without any HTTP call for entities with no Fields endpoint (notes)', async () => {
      const fields = await client.getFields('notes');
      expect(fields).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('follows next_cursor across pages and concatenates fields', async () => {
      mockGet
        .mockResolvedValueOnce({ data: { data: [{ field_code: 'a' }], additional_data: { next_cursor: 'P2' } } })
        .mockResolvedValueOnce({ data: { data: [{ field_code: 'b' }], additional_data: {} } });

      const fields = await client.getFields('deals');

      expect(mockGet).toHaveBeenNthCalledWith(1, '/api/v2/dealFields', { params: { limit: 500 } });
      expect(mockGet).toHaveBeenNthCalledWith(2, '/api/v2/dealFields', { params: { limit: 500, cursor: 'P2' } });
      expect(fields).toEqual([{ field_code: 'a' }, { field_code: 'b' }]);
    });
  });

  describe('listEntities — cursor pagination (v2)', () => {
    it('yields one page and stops when next_cursor is absent', async () => {
      mockGet.mockResolvedValue({ data: { data: [{ id: 1 }], additional_data: {} } });
      const pages: unknown[] = [];
      for await (const page of client.listEntities('deals')) pages.push(page);
      expect(pages).toEqual([{ data: [{ id: 1 }], nextCursor: undefined }]);
      expect(mockGet).toHaveBeenCalledWith('/api/v2/deals', { params: { limit: 500 } });
    });

    it('threads the resume cursor', async () => {
      mockGet.mockResolvedValue({ data: { data: [{ id: 1 }], additional_data: {} } });
      await drain(client.listEntities('activities', { cursor: 'CUR9' }));
      expect(mockGet).toHaveBeenCalledWith('/api/v2/activities', { params: { limit: 500, cursor: 'CUR9' } });
    });
  });

  describe('listEntities — offset pagination (v1)', () => {
    it('GETs /v1/{collection} with start=0 and stops when more_items_in_collection is false', async () => {
      mockGet.mockResolvedValue({
        data: { data: [{ id: 1 }], additional_data: { pagination: { more_items_in_collection: false } } },
      });
      const pages: unknown[] = [];
      for await (const page of client.listEntities('notes')) pages.push(page);
      expect(pages).toEqual([{ data: [{ id: 1 }], nextStart: undefined }]);
      expect(mockGet).toHaveBeenCalledWith('/v1/notes', { params: { limit: 500, start: 0 } });
    });

    it('advances by next_start across pages and exposes it as the resume marker', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: {
            data: [{ id: 1 }],
            additional_data: { pagination: { more_items_in_collection: true, next_start: 2 } },
          },
        })
        .mockResolvedValueOnce({
          data: { data: [{ id: 3 }], additional_data: { pagination: { more_items_in_collection: false } } },
        });

      const pages: Array<{ data: unknown[]; nextStart?: number }> = [];
      for await (const page of client.listEntities('leads')) pages.push(page);

      expect(mockGet).toHaveBeenNthCalledWith(1, '/v1/leads', { params: { limit: 500, start: 0 } });
      expect(mockGet).toHaveBeenNthCalledWith(2, '/v1/leads', { params: { limit: 500, start: 2 } });
      expect(pages).toEqual([
        { data: [{ id: 1 }], nextStart: 2 },
        { data: [{ id: 3 }], nextStart: undefined },
      ]);
    });

    it('resumes from a start offset', async () => {
      mockGet.mockResolvedValue({
        data: { data: [{ id: 7 }], additional_data: { pagination: { more_items_in_collection: false } } },
      });
      await drain(client.listEntities('notes', { start: 40 }));
      expect(mockGet).toHaveBeenCalledWith('/v1/notes', { params: { limit: 500, start: 40 } });
    });

    it('passes updated_since alongside the offset', async () => {
      mockGet.mockResolvedValue({
        data: { data: [{ id: 1 }], additional_data: { pagination: { more_items_in_collection: false } } },
      });
      await drain(client.listEntities('leads', undefined, '2026-05-14T11:59:00Z'));
      expect(mockGet).toHaveBeenCalledWith('/v1/leads', {
        params: { limit: 500, start: 0, updated_since: '2026-05-14T11:59:00Z' },
      });
    });
  });

  describe('getEntity', () => {
    it('GETs the v2 /{collection}/{id} path and returns the unwrapped record', async () => {
      mockGet.mockResolvedValue({ data: { data: { id: 7, title: 'Deal' } } });
      const entity = await client.getEntity('deals', 7);
      expect(mockGet).toHaveBeenCalledWith('/api/v2/deals/7');
      expect(entity).toEqual({ id: 7, title: 'Deal' });
    });

    it('GETs a v1 entity by its integer id', async () => {
      mockGet.mockResolvedValue({ data: { data: { id: 5 } } });
      await client.getEntity('notes', 5);
      expect(mockGet).toHaveBeenCalledWith('/v1/notes/5');
    });

    it('GETs a lead by its UUID string id (not parsed as a number)', async () => {
      mockGet.mockResolvedValue({ data: { data: { id: 'abc-uuid' } } });
      await client.getEntity('leads', 'abc-uuid');
      expect(mockGet).toHaveBeenCalledWith('/v1/leads/abc-uuid');
    });

    it('returns null on 404', async () => {
      mockGet.mockRejectedValue(makeAxiosError(404, { error: 'not found' }));
      await expect(client.getEntity('persons', 99)).resolves.toBeNull();
      expect(mockGet).toHaveBeenCalledWith('/api/v2/persons/99');
    });

    it('re-throws non-404 errors', async () => {
      const error = makeAxiosError(500, { error: 'boom' });
      mockGet.mockRejectedValue(error);
      await expect(client.getEntity('deals', 1)).rejects.toBe(error);
    });
  });

  // The client POSTs/PATCHes the record verbatim — Pipedrive's read and write
  // shapes are identical, so no custom-field reshaping is needed (DEV-10353). The
  // connector strips read-only system fields before calling, so these tests pass
  // already-writable data.
  describe('createEntity', () => {
    it('POSTs the record verbatim (no custom fields)', async () => {
      mockPost.mockResolvedValue({ data: { data: { id: 1, title: 'New' } } });
      const created = await client.createEntity('deals', { title: 'New', value: 100 });
      expect(mockPost).toHaveBeenCalledWith('/api/v2/deals', { title: 'New', value: 100 });
      expect(created).toEqual({ id: 1, title: 'New' });
    });

    it('POSTs a v2 record with custom fields nested under custom_fields (the on-disk shape) verbatim', async () => {
      mockPost.mockResolvedValue({ data: { data: { id: 2 } } });
      await client.createEntity('deals', { title: 'New', custom_fields: { abc123: 'custom-val', def456: 42 } });
      expect(mockPost).toHaveBeenCalledWith('/api/v2/deals', {
        title: 'New',
        custom_fields: { abc123: 'custom-val', def456: 42 },
      });
    });

    it('POSTs a v1 lead with custom fields as flat top-level hash keys verbatim', async () => {
      mockPost.mockResolvedValue({ data: { data: { id: 'lead-uuid' } } });
      await client.createEntity('leads', { title: 'New Lead', abc123: 'custom-val' });
      expect(mockPost).toHaveBeenCalledWith('/v1/leads', { title: 'New Lead', abc123: 'custom-val' });
    });

    it('POSTs notes to the v1 path', async () => {
      mockPost.mockResolvedValue({ data: { data: { id: 9 } } });
      await client.createEntity('notes', { content: 'hi', deal_id: 3 });
      expect(mockPost).toHaveBeenCalledWith('/v1/notes', { content: 'hi', deal_id: 3 });
    });

    it('returns {} when the response carries no data', async () => {
      mockPost.mockResolvedValue({ data: {} });
      await expect(client.createEntity('deals', { title: 'X' })).resolves.toEqual({});
    });
  });

  describe('updateEntity', () => {
    it('PATCHes the v2 /{collection}/{id} path with the body verbatim', async () => {
      mockPatch.mockResolvedValue({ data: { data: { id: 42 } } });
      await client.updateEntity('organizations', 42, { name: 'Acme', custom_fields: { abc: 'cv' } });
      expect(mockPatch).toHaveBeenCalledWith('/api/v2/organizations/42', {
        name: 'Acme',
        custom_fields: { abc: 'cv' },
      });
    });

    it('PATCHes a v2 custom-field-only edit shaped as the publish diff nests it (DEV-10353 regression)', async () => {
      // The publish diff for an edited v2 custom field arrives nested under
      // custom_fields — `{ custom_fields: { <hash>: <newValue> } }` — which is
      // exactly the write shape, so it goes through verbatim. The original bug
      // dropped this wrapper and shipped an empty body.
      mockPatch.mockResolvedValue({ data: { data: { id: 7 } } });
      await client.updateEntity('deals', 7, { custom_fields: { abc123: 'new value' } });
      expect(mockPatch).toHaveBeenCalledWith('/api/v2/deals/7', { custom_fields: { abc123: 'new value' } });
    });

    it('PATCHes a lead by UUID id with custom fields kept flat (verbatim)', async () => {
      mockPatch.mockResolvedValue({ data: { data: { id: 'lead-uuid' } } });
      await client.updateEntity('leads', 'lead-uuid', { title: 'Updated', abc: 'cv' });
      expect(mockPatch).toHaveBeenCalledWith('/v1/leads/lead-uuid', { title: 'Updated', abc: 'cv' });
    });

    it('PUTs notes (the v1 update verb for notes)', async () => {
      mockPut.mockResolvedValue({ data: { data: { id: 9 } } });
      await client.updateEntity('notes', 9, { content: 'edited' });
      expect(mockPut).toHaveBeenCalledWith('/v1/notes/9', { content: 'edited' });
      expect(mockPatch).not.toHaveBeenCalled();
    });
  });

  describe('deleteEntity', () => {
    it('DELETEs the v2 /{collection}/{id} path', async () => {
      mockDelete.mockResolvedValue({ data: { data: { id: 1 } } });
      await client.deleteEntity('deals', 1);
      expect(mockDelete).toHaveBeenCalledWith('/api/v2/deals/1');
    });

    it('DELETEs a lead by UUID id on the v1 path', async () => {
      mockDelete.mockResolvedValue({ data: { data: { id: 'lead-uuid' } } });
      await client.deleteEntity('leads', 'lead-uuid');
      expect(mockDelete).toHaveBeenCalledWith('/v1/leads/lead-uuid');
    });

    it('swallows a 404 (already deleted)', async () => {
      mockDelete.mockRejectedValue(makeAxiosError(404, { error: 'not found' }));
      await expect(client.deleteEntity('deals', 1)).resolves.toBeUndefined();
    });

    it('re-throws non-404 errors', async () => {
      const error = makeAxiosError(500, { error: 'boom' });
      mockDelete.mockRejectedValue(error);
      await expect(client.deleteEntity('deals', 1)).rejects.toBe(error);
    });
  });
});
