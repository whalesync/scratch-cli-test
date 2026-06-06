import axios from 'axios';
import { PipedriveApiClient } from '../pipedrive-api-client';

// Mock create-api-client to return a mock axios instance whose verbs we can
// inspect. This pins the exact path / query / body each method sends — the whole
// point of an api-client test (the connector-level spec mocks the entire client
// and so can't catch a wrong URL, a dropped query param, or a mis-shaped body).
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockDelete = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    delete: mockDelete,
  })),
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

describe('PipedriveApiClient', () => {
  let client: PipedriveApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new PipedriveApiClient('test-key');
  });

  describe('constructor', () => {
    it('configures the v2 base URL and authenticates the API key via the x-api-token header', () => {
      expect(createApiClient).toHaveBeenCalledWith({
        baseURL: 'https://api.pipedrive.com/api/v2',
        headers: {
          'Content-Type': 'application/json',
          'x-api-token': 'test-key',
        },
      });
    });

    it('authenticates an OAuth token via the Authorization Bearer header (no x-api-token)', () => {
      jest.clearAllMocks();
      new PipedriveApiClient('oauth-token', { authType: 'oauth' });
      expect(createApiClient).toHaveBeenCalledWith({
        baseURL: 'https://api.pipedrive.com/api/v2',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer oauth-token',
        },
      });
    });
  });

  describe('testConnection', () => {
    it('GETs /deals with limit 1', async () => {
      mockGet.mockResolvedValue({ data: { data: [], additional_data: {} } });
      await client.testConnection();
      expect(mockGet).toHaveBeenCalledWith('/deals', { params: { limit: 1 } });
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
    it('GETs the per-entity Fields path and unwraps the data array', async () => {
      mockGet.mockResolvedValue({
        data: { data: [{ field_code: 'title', is_custom_field: false }], additional_data: {} },
      });
      const fields = await client.getFields('deals');
      expect(mockGet).toHaveBeenCalledWith('/dealFields', { params: { limit: 500 } });
      expect(fields).toEqual([{ field_code: 'title', is_custom_field: false }]);
    });

    it.each([
      ['persons', '/personFields'],
      ['organizations', '/organizationFields'],
    ] as const)('uses %s → %s', async (entityType, path) => {
      mockGet.mockResolvedValue({ data: { data: [], additional_data: {} } });
      await client.getFields(entityType);
      expect(mockGet).toHaveBeenCalledWith(path, { params: { limit: 500 } });
    });

    it('follows next_cursor across pages and concatenates fields', async () => {
      mockGet
        .mockResolvedValueOnce({ data: { data: [{ field_code: 'a' }], additional_data: { next_cursor: 'P2' } } })
        .mockResolvedValueOnce({ data: { data: [{ field_code: 'b' }], additional_data: {} } });

      const fields = await client.getFields('deals');

      expect(mockGet).toHaveBeenNthCalledWith(1, '/dealFields', { params: { limit: 500 } });
      expect(mockGet).toHaveBeenNthCalledWith(2, '/dealFields', { params: { limit: 500, cursor: 'P2' } });
      expect(fields).toEqual([{ field_code: 'a' }, { field_code: 'b' }]);
    });
  });

  describe('getEntity', () => {
    it('GETs /{collection}/{id} and returns the unwrapped record', async () => {
      mockGet.mockResolvedValue({ data: { data: { id: 7, title: 'Deal' } } });
      const entity = await client.getEntity('deals', 7);
      expect(mockGet).toHaveBeenCalledWith('/deals/7');
      expect(entity).toEqual({ id: 7, title: 'Deal' });
    });

    it('returns null on 404', async () => {
      mockGet.mockRejectedValue(makeAxiosError(404, { error: 'not found' }));
      await expect(client.getEntity('persons', 99)).resolves.toBeNull();
      expect(mockGet).toHaveBeenCalledWith('/persons/99');
    });

    it('re-throws non-404 errors', async () => {
      const error = makeAxiosError(500, { error: 'boom' });
      mockGet.mockRejectedValue(error);
      await expect(client.getEntity('deals', 1)).rejects.toBe(error);
    });
  });

  describe('createEntity', () => {
    it('POSTs system fields verbatim when there are no custom fields', async () => {
      mockPost.mockResolvedValue({ data: { data: { id: 1, title: 'New' } } });
      const created = await client.createEntity('deals', { title: 'New', value: 100 }, new Set());
      expect(mockPost).toHaveBeenCalledWith('/deals', { title: 'New', value: 100 });
      expect(created).toEqual({ id: 1, title: 'New' });
    });

    it('nests custom-field keys under a custom_fields wrapper', async () => {
      mockPost.mockResolvedValue({ data: { data: { id: 2 } } });
      await client.createEntity('deals', { title: 'New', abc123: 'custom-val' }, new Set(['abc123']));
      expect(mockPost).toHaveBeenCalledWith('/deals', { title: 'New', custom_fields: { abc123: 'custom-val' } });
    });

    it('drops read-only system fields (id/add_time/update_time) and the custom_fields wrapper itself', async () => {
      mockPost.mockResolvedValue({ data: { data: { id: 3 } } });
      await client.createEntity(
        'persons',
        { id: 5, add_time: 't1', update_time: 't2', custom_fields: { x: 1 }, name: 'Jane' },
        new Set(),
      );
      expect(mockPost).toHaveBeenCalledWith('/persons', { name: 'Jane' });
    });

    it('returns {} when the response carries no data', async () => {
      mockPost.mockResolvedValue({ data: {} });
      await expect(client.createEntity('deals', { title: 'X' }, new Set())).resolves.toEqual({});
    });
  });

  describe('updateEntity', () => {
    it('PATCHes /{collection}/{id} with the separated body', async () => {
      mockPatch.mockResolvedValue({ data: { data: { id: 42 } } });
      await client.updateEntity('organizations', 42, { name: 'Acme', abc: 'cv' }, new Set(['abc']));
      expect(mockPatch).toHaveBeenCalledWith('/organizations/42', {
        name: 'Acme',
        custom_fields: { abc: 'cv' },
      });
    });
  });

  describe('deleteEntity', () => {
    it('DELETEs /{collection}/{id}', async () => {
      mockDelete.mockResolvedValue({ data: { data: { id: 1 } } });
      await client.deleteEntity('deals', 1);
      expect(mockDelete).toHaveBeenCalledWith('/deals/1');
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

  describe('separateFields', () => {
    it('splits system vs custom fields and skips read-only / wrapper keys', () => {
      const result = client.separateFields(
        { title: 'D', abc123: 'c', id: 9, add_time: 't', update_time: 'u', custom_fields: {} },
        new Set(['abc123']),
      );
      expect(result).toEqual({ systemFields: { title: 'D' }, customFields: { abc123: 'c' } });
    });
  });
});
