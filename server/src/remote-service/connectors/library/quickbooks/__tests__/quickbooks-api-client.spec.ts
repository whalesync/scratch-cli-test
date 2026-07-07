import { AxiosError } from 'axios';
import { QuickBooksApiClient } from '../quickbooks-api-client';

// Mock create-api-client to return an axios stand-in whose verbs we can inspect,
// pinning the exact path / query / body each write method sends.
const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: mockGet,
    post: mockPost,
  })),
}));

function makeAxiosError(status: number, data: unknown): AxiosError {
  return new AxiosError(`Request failed with status code ${status}`, String(status), undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: {} as never,
    data,
  });
}

describe('QuickBooksApiClient (write)', () => {
  let client: QuickBooksApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new QuickBooksApiClient({ accessToken: 'tok', realmId: 'realm-1' });
  });

  describe('createEntity', () => {
    it('POSTs to the lowercased collection path and unwraps the entity envelope', async () => {
      const created = { Id: '10', SyncToken: '0', DisplayName: 'Acme' };
      mockPost.mockResolvedValue({ data: { Customer: created } });

      const result = await client.createEntity('Customer', { DisplayName: 'Acme' });

      expect(mockPost).toHaveBeenCalledWith('/customer', { DisplayName: 'Acme' });
      expect(result).toEqual(created);
    });
  });

  describe('updateEntity', () => {
    it('POSTs the sparse body to the collection path and unwraps the entity envelope', async () => {
      const updated = { Id: '5', SyncToken: '4' };
      mockPost.mockResolvedValue({ data: { Invoice: updated } });

      const body = { Id: '5', SyncToken: '3', sparse: true, DocNumber: '1001' };
      const result = await client.updateEntity('Invoice', body);

      expect(mockPost).toHaveBeenCalledWith('/invoice', body);
      expect(result).toEqual(updated);
    });
  });

  describe('deleteTransaction', () => {
    it('POSTs { Id, SyncToken } with ?operation=delete and returns true', async () => {
      mockPost.mockResolvedValue({ data: {} });

      const result = await client.deleteTransaction('Invoice', '9', '2');

      expect(mockPost).toHaveBeenCalledWith(
        '/invoice',
        { Id: '9', SyncToken: '2' },
        { params: { operation: 'delete' } },
      );
      expect(result).toBe(true);
    });

    it('returns false when the record is already gone (404)', async () => {
      mockPost.mockRejectedValue(makeAxiosError(404, { Fault: { Error: [{ code: '610' }] } }));
      expect(await client.deleteTransaction('Invoice', '9', '2')).toBe(false);
    });

    it('rethrows non-404 errors', async () => {
      mockPost.mockRejectedValue(makeAxiosError(400, { Fault: { Error: [{ code: '5010' }] } }));
      await expect(client.deleteTransaction('Invoice', '9', '2')).rejects.toBeInstanceOf(AxiosError);
    });
  });

  describe('isStaleObjectError', () => {
    it('is true for a 400 with fault code 5010', () => {
      expect(
        QuickBooksApiClient.isStaleObjectError(makeAxiosError(400, { Fault: { Error: [{ code: '5010' }] } })),
      ).toBe(true);
    });

    it('is true for a 400 whose message mentions a stale object', () => {
      expect(
        QuickBooksApiClient.isStaleObjectError(
          makeAxiosError(400, { Fault: { Error: [{ Message: 'Stale Object Error' }] } }),
        ),
      ).toBe(true);
    });

    it('is false for other 400 faults and non-axios errors', () => {
      expect(
        QuickBooksApiClient.isStaleObjectError(makeAxiosError(400, { Fault: { Error: [{ code: '6000' }] } })),
      ).toBe(false);
      expect(QuickBooksApiClient.isStaleObjectError(makeAxiosError(409, {}))).toBe(false);
      expect(QuickBooksApiClient.isStaleObjectError(new Error('nope'))).toBe(false);
    });
  });
});
