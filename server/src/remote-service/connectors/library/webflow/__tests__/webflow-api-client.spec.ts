import { createHash } from 'node:crypto';
import { WebflowApiClient } from '../webflow-api-client';

// Mock create-api-client to return a mock axios instance whose verbs we can
// inspect. This pins the exact path / query / body each method sends — the whole
// point of an api-client test (the connector-level spec mocks the entire client
// and so can't catch a wrong URL or a dropped query param).
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();

/**
 * Every `authorizationHeaderValueProvider` handed to `createApiClient`, in call
 * order. Captured here (rather than dug out of `mock.calls`) so the provider stays
 * typed — the client resolves its bearer token per request now, so the provider is
 * the thing worth asserting on.
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

describe('WebflowApiClient', () => {
  let client: WebflowApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorizationHeaderValueProviders.length = 0;
    client = new WebflowApiClient('test-token');
  });

  describe('constructor', () => {
    it('configures the data-API instance with /v2 base URL and bearer auth (no accept-version header)', async () => {
      // First createApiClient call: the authenticated data-API instance. The
      // bearer token is supplied as a provider, not a static header, so a long
      // job picks up a refreshed OAuth access token (DEV-11270).
      expect(createApiClient).toHaveBeenNthCalledWith(
        1,
        {
          baseURL: 'https://api.webflow.com/v2',
          headers: { 'Content-Type': 'application/json' },
        },
        { authorizationHeaderValueProvider: mockAuthorizationHeaderValueProviders[0] },
      );
      await expect(mockAuthorizationHeaderValueProviders[0]()).resolves.toBe('Bearer test-token');
      // Second call: the auth-free instance used only for S3 presigned uploads.
      expect(createApiClient).toHaveBeenNthCalledWith(2);
    });

    it('re-resolves the bearer token on every request so a refreshed OAuth token is used', async () => {
      const accessTokens = ['first-token', 'second-token'];
      new WebflowApiClient(() => Promise.resolve(accessTokens.shift() ?? 'exhausted'));

      const provider = mockAuthorizationHeaderValueProviders[1];
      await expect(provider()).resolves.toBe('Bearer first-token');
      await expect(provider()).resolves.toBe('Bearer second-token');
    });
  });

  describe('sites & collections', () => {
    it('listSites → GET /sites and returns the wrapper verbatim', async () => {
      mockGet.mockResolvedValue({ data: { sites: [{ id: 's1' }] } });
      await expect(client.listSites()).resolves.toEqual({ sites: [{ id: 's1' }] });
      expect(mockGet).toHaveBeenCalledWith('/sites');
    });

    it('getSite → GET /sites/{id} with id encoded', async () => {
      mockGet.mockResolvedValue({ data: { id: 'site/1' } });
      await client.getSite('site/1');
      expect(mockGet).toHaveBeenCalledWith('/sites/site%2F1');
    });

    it('listCollections → GET /sites/{id}/collections', async () => {
      mockGet.mockResolvedValue({ data: { collections: [] } });
      await client.listCollections('s1');
      expect(mockGet).toHaveBeenCalledWith('/sites/s1/collections');
    });

    it('getCollection → GET /collections/{id}', async () => {
      mockGet.mockResolvedValue({ data: { id: 'c1', fields: [] } });
      await client.getCollection('c1');
      expect(mockGet).toHaveBeenCalledWith('/collections/c1');
    });
  });

  describe('collection items', () => {
    it('listCollectionItems → GET /collections/{id}/items with offset+limit params', async () => {
      mockGet.mockResolvedValue({ data: { items: [], pagination: { total: 0, offset: 0, limit: 100 } } });
      await client.listCollectionItems('c1', { offset: 100, limit: 100 });
      expect(mockGet).toHaveBeenCalledWith('/collections/c1/items', { params: { offset: 100, limit: 100 } });
    });

    it('listCollectionItems with lastUpdatedSince → adds the lastUpdated[gte] filter + descending lastUpdated sort (DEV-10791)', async () => {
      mockGet.mockResolvedValue({ data: { items: [], pagination: { total: 0, offset: 0, limit: 100 } } });
      await client.listCollectionItems('c1', { offset: 0, limit: 100, lastUpdatedSince: '2026-05-14T11:59:00.000Z' });
      expect(mockGet).toHaveBeenCalledWith('/collections/c1/items', {
        params: {
          offset: 0,
          limit: 100,
          'lastUpdated[gte]': '2026-05-14T11:59:00.000Z',
          sortBy: 'lastUpdated',
          sortOrder: 'desc',
        },
      });
    });

    it('listCollectionItems with cmsLocaleId → adds the cmsLocaleId query param (DEV-10529)', async () => {
      mockGet.mockResolvedValue({ data: { items: [], pagination: { total: 0, offset: 0, limit: 100 } } });
      await client.listCollectionItems('c1', { offset: 0, limit: 100, cmsLocaleId: 'cms-es' });
      expect(mockGet).toHaveBeenCalledWith('/collections/c1/items', {
        params: { offset: 0, limit: 100, cmsLocaleId: 'cms-es' },
      });
    });

    it('getCollectionItem → GET /collections/{id}/items/{itemId}', async () => {
      mockGet.mockResolvedValue({ data: { id: 'i1', fieldData: { name: 'x', slug: 'x' } } });
      await client.getCollectionItem('c1', 'i1');
      expect(mockGet).toHaveBeenCalledWith('/collections/c1/items/i1');
    });

    it('getCollectionItem with cmsLocaleId → adds the cmsLocaleId query param (DEV-10529)', async () => {
      mockGet.mockResolvedValue({ data: { id: 'i1', cmsLocaleId: 'cms-es', fieldData: { name: 'x', slug: 'x' } } });
      await client.getCollectionItem('c1', 'i1', 'cms-es');
      expect(mockGet).toHaveBeenCalledWith('/collections/c1/items/i1', { params: { cmsLocaleId: 'cms-es' } });
    });

    it('createItemsLive → POST /collections/{id}/items/live, body {items}, skipInvalidFiles as a query param', async () => {
      mockPost.mockResolvedValue({ data: { items: [{ id: 'new' }] } });
      const items = [{ fieldData: { name: 'n', slug: 's' } }];
      await expect(client.createItemsLive('c1', { skipInvalidFiles: false, items })).resolves.toEqual({
        items: [{ id: 'new' }],
      });
      expect(mockPost).toHaveBeenCalledWith(
        '/collections/c1/items/live',
        { items },
        { params: { skipInvalidFiles: false } },
      );
    });

    it('updateItemsLive → PATCH /collections/{id}/items/live, body {items}, skipInvalidFiles query param', async () => {
      mockPatch.mockResolvedValue({ data: { items: [] } });
      const items = [{ id: 'i1', fieldData: { name: 'n' } }];
      await client.updateItemsLive('c1', { skipInvalidFiles: false, items });
      expect(mockPatch).toHaveBeenCalledWith(
        '/collections/c1/items/live',
        { items },
        { params: { skipInvalidFiles: false } },
      );
    });

    it('deleteItemsLive → DELETE /collections/{id}/items/live with {items} in the request body', async () => {
      mockDelete.mockResolvedValue({ data: undefined });
      await client.deleteItemsLive('c1', { items: [{ id: 'i1' }] });
      expect(mockDelete).toHaveBeenCalledWith('/collections/c1/items/live', { data: { items: [{ id: 'i1' }] } });
    });

    it('deleteItems → DELETE /collections/{id}/items with {items} in the request body', async () => {
      mockDelete.mockResolvedValue({ data: undefined });
      await client.deleteItems('c1', { items: [{ id: 'i1' }] });
      expect(mockDelete).toHaveBeenCalledWith('/collections/c1/items', { data: { items: [{ id: 'i1' }] } });
    });
  });

  describe('pages', () => {
    it('listPages → GET /sites/{id}/pages with limit+offset params', async () => {
      mockGet.mockResolvedValue({ data: { pages: [], pagination: { total: 0 } } });
      await client.listPages('s1', { limit: 100, offset: 0 });
      expect(mockGet).toHaveBeenCalledWith('/sites/s1/pages', { params: { limit: 100, offset: 0 } });
    });

    it('getPageMetadata → GET /pages/{id}', async () => {
      mockGet.mockResolvedValue({ data: { id: 'p1' } });
      await client.getPageMetadata('p1');
      expect(mockGet).toHaveBeenCalledWith('/pages/p1');
    });

    it('updatePageSettings → PUT /pages/{id} with the metadata body', async () => {
      mockPut.mockResolvedValue({ data: { id: 'p1' } });
      const body = { title: 'New Title', seo: { title: 'SEO' } };
      await client.updatePageSettings('p1', body);
      expect(mockPut).toHaveBeenCalledWith('/pages/p1', body);
    });
  });

  describe('ecommerce orders (DEV-10729)', () => {
    it('listOrders → GET /sites/{id}/orders with offset+limit and returns the wrapper verbatim', async () => {
      mockGet.mockResolvedValue({ data: { orders: [{ orderId: 'o1' }], pagination: { total: 1 } } });
      await expect(client.listOrders('s1', { offset: 0, limit: 100 })).resolves.toEqual({
        orders: [{ orderId: 'o1' }],
        pagination: { total: 1 },
      });
      expect(mockGet).toHaveBeenCalledWith('/sites/s1/orders', { params: { offset: 0, limit: 100 } });
    });

    it('listOrders passes the optional status filter through', async () => {
      mockGet.mockResolvedValue({ data: { orders: [] } });
      await client.listOrders('s1', { offset: 0, limit: 100, status: 'fulfilled' });
      expect(mockGet).toHaveBeenCalledWith('/sites/s1/orders', {
        params: { offset: 0, limit: 100, status: 'fulfilled' },
      });
    });

    it('getOrder → GET /sites/{id}/orders/{orderId} with both segments encoded', async () => {
      mockGet.mockResolvedValue({ data: { orderId: 'o/1' } });
      await client.getOrder('s1', 'o/1');
      expect(mockGet).toHaveBeenCalledWith('/sites/s1/orders/o%2F1');
    });

    it('updateOrder → PATCH /sites/{id}/orders/{orderId} with the writable-fields body', async () => {
      mockPatch.mockResolvedValue({ data: { orderId: 'o1' } });
      const body = { comment: 'note', shippingTracking: '1Z' };
      await client.updateOrder('s1', 'o1', body);
      expect(mockPatch).toHaveBeenCalledWith('/sites/s1/orders/o1', body);
    });
  });

  describe('date normalization (byte-identical to the old SDK Date coercion)', () => {
    it('getAsset normalizes createdOn/lastUpdated to canonical ISO (millis + Z)', async () => {
      mockGet.mockResolvedValue({
        data: {
          id: 'a1',
          displayName: 'a',
          createdOn: '2024-01-15T10:30:00Z', // non-canonical (no millis)
          lastUpdated: '2024-01-15T10:30:00.000Z', // already canonical
        },
      });
      const asset = await client.getAsset('a1');
      expect(asset.createdOn).toBe('2024-01-15T10:30:00.000Z');
      expect(asset.lastUpdated).toBe('2024-01-15T10:30:00.000Z');
    });

    it('getAsset leaves an absent date field absent (no undefined key injected)', async () => {
      mockGet.mockResolvedValue({ data: { id: 'a1', displayName: 'a' } });
      const asset = await client.getAsset('a1');
      expect('createdOn' in asset).toBe(false);
      expect('lastUpdated' in asset).toBe(false);
    });

    it('listAssets normalizes each asset’s date fields', async () => {
      mockGet.mockResolvedValue({
        data: { assets: [{ id: 'a1', displayName: 'a', createdOn: '2024-01-15T10:30:00+00:00' }] },
      });
      const result = await client.listAssets('s1', { offset: 0, limit: 100 });
      expect(result.assets?.[0]?.createdOn).toBe('2024-01-15T10:30:00.000Z');
    });

    it('getPageMetadata normalizes createdOn/lastUpdated', async () => {
      mockGet.mockResolvedValue({ data: { id: 'p1', createdOn: '2024-01-15T10:30:00Z' } });
      const page = await client.getPageMetadata('p1');
      expect(page.createdOn).toBe('2024-01-15T10:30:00.000Z');
    });

    it('does NOT touch collection-item date fields (the SDK left these as raw strings)', async () => {
      mockGet.mockResolvedValue({
        data: { id: 'i1', createdOn: '2024-01-15T10:30:00Z', fieldData: { name: 'n', slug: 's' } },
      });
      const item = await client.getCollectionItem('c1', 'i1');
      expect(item.createdOn).toBe('2024-01-15T10:30:00Z'); // unchanged
    });
  });

  describe('uploadAsset', () => {
    it('computes the MD5, creates metadata, then posts the S3 form with policy fields first and file LAST', async () => {
      const fileBuffer = Buffer.from('hello webflow asset');
      const expectedMd5 = createHash('md5').update(fileBuffer).digest('hex');

      const uploadUrl = 'https://s3.amazonaws.com/webflow-bucket';
      const uploadDetails = {
        acl: 'public-read',
        bucket: 'webflow-bucket',
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        Policy: 'base64policy',
        'X-Amz-Signature': 'sig',
        'content-type': 'image/png',
      };
      mockPost
        .mockResolvedValueOnce({ data: { id: 'asset1', uploadUrl, uploadDetails, contentType: 'image/png' } })
        .mockResolvedValueOnce({ data: {} });

      const result = await client.uploadAsset('site1', { file: fileBuffer, fileName: 'pic.png' });

      expect(result).toEqual({ id: 'asset1', uploadUrl, uploadDetails, contentType: 'image/png' });

      // 1st POST: create asset metadata with the MD5 hash.
      expect(mockPost.mock.calls[0]).toEqual(['/sites/site1/assets', { fileName: 'pic.png', fileHash: expectedMd5 }]);

      // 2nd POST: the S3 presigned upload to the returned uploadUrl.
      const [s3Url, s3Form] = mockPost.mock.calls[1] as [string, FormData];
      expect(s3Url).toBe(uploadUrl);
      expect(s3Form).toBeInstanceOf(FormData);

      const fieldNames = [...s3Form.keys()];
      // Every uploadDetails policy field, under its exact wire key name, in order.
      expect(fieldNames).toEqual([
        'acl',
        'bucket',
        'X-Amz-Algorithm',
        'Policy',
        'X-Amz-Signature',
        'content-type',
        'file',
      ]);
      // The file part must be LAST (S3 presigned POST requirement).
      expect(fieldNames[fieldNames.length - 1]).toBe('file');
      expect(s3Form.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(s3Form.get('file')).toBeInstanceOf(Blob);
    });

    it('includes parentFolder in the create body when provided', async () => {
      mockPost
        .mockResolvedValueOnce({
          data: { id: 'a', uploadUrl: 'https://s3', uploadDetails: { key: 'k' }, contentType: 'image/png' },
        })
        .mockResolvedValueOnce({ data: {} });
      await client.uploadAsset('site1', { file: Buffer.from('x'), fileName: 'f.png', parentFolder: 'folder1' });
      const [, createBody] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
      expect(createBody).toMatchObject({ fileName: 'f.png', parentFolder: 'folder1' });
    });

    it('throws when the create step returns no S3 upload details', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'a' } }); // no uploadDetails / uploadUrl
      await expect(client.uploadAsset('site1', { file: Buffer.from('x'), fileName: 'f.png' })).rejects.toThrow(
        /no S3 upload details/,
      );
    });
  });
});
