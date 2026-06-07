import axios from 'axios';
import { StripeApiClient, StripeError } from '../stripe-api-client';

// Mock create-api-client to return a mock axios instance
const mockGet = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: mockGet,
  })),
}));

describe('StripeApiClient', () => {
  let client: StripeApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new StripeApiClient({ apiKey: 'sk_test_123' });
  });

  // ---------------------------------------------------------------------------
  // validateCredentials
  // ---------------------------------------------------------------------------

  describe('validateCredentials', () => {
    it('succeeds when API returns 200', async () => {
      mockGet.mockResolvedValue({ data: { object: 'list', data: [], has_more: false } });

      await expect(client.validateCredentials()).resolves.toBeUndefined();
      expect(mockGet).toHaveBeenCalledWith('/v1/customers', { params: { limit: 1 } });
    });

    it('throws StripeError on 401', async () => {
      const error = new axios.AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: { error: { message: 'Invalid API Key provided', type: 'authentication_error' } },
        statusText: 'Unauthorized',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      await expect(client.validateCredentials()).rejects.toThrow(StripeError);
      await expect(client.validateCredentials()).rejects.toThrow('Invalid API Key provided');
    });

    it('throws StripeError with fallback message when error body has no message', async () => {
      const error = new axios.AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: {},
        statusText: 'Unauthorized',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      await expect(client.validateCredentials()).rejects.toThrow('Invalid API key');
    });

    it('rethrows non-401 errors', async () => {
      const error = new Error('Network error');
      mockGet.mockRejectedValue(error);

      await expect(client.validateCredentials()).rejects.toThrow('Network error');
    });
  });

  // ---------------------------------------------------------------------------
  // listEntities
  // ---------------------------------------------------------------------------

  describe('listEntities', () => {
    it('yields pages of entities with cursor-based pagination', async () => {
      const page1 = {
        data: {
          object: 'list',
          data: [
            { id: 'cus_1', object: 'customer' },
            { id: 'cus_2', object: 'customer' },
          ],
          has_more: true,
        },
      };
      const page2 = {
        data: {
          object: 'list',
          data: [{ id: 'cus_3', object: 'customer' }],
          has_more: false,
        },
      };

      mockGet.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

      const pages: unknown[][] = [];
      for await (const page of client.listEntities('customers', 2)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(pages[0]).toHaveLength(2);
      expect(pages[1]).toHaveLength(1);

      // Second call should use starting_after from last item of first page
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet).toHaveBeenNthCalledWith(2, '/v1/customers', {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        params: expect.objectContaining({ starting_after: 'cus_2', limit: 2 }),
      });
    });

    it('stops when has_more is false', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          object: 'list',
          data: [{ id: 'prod_1', object: 'product' }],
          has_more: false,
        },
      });

      const pages: unknown[][] = [];
      for await (const page of client.listEntities('products')) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('handles empty result', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          object: 'list',
          data: [],
          has_more: false,
        },
      });

      const pages: unknown[][] = [];
      for await (const page of client.listEntities('charges')) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
    });

    it('passes status=all for subscriptions so canceled/ended ones are not omitted', async () => {
      mockGet.mockResolvedValue({
        data: { object: 'list', data: [], has_more: false },
      });

      const gen: AsyncGenerator<unknown[]> = client.listEntities('subscriptions');
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _page of gen) {
        // consume
      }

      expect(mockGet).toHaveBeenCalledWith('/v1/subscriptions', {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        params: expect.objectContaining({ status: 'all' }),
      });
    });

    it('does not pass a status filter for entity types that list all records by default', async () => {
      mockGet.mockResolvedValue({
        data: { object: 'list', data: [], has_more: false },
      });

      for (const entityType of ['customers', 'products', 'prices', 'invoices', 'payment_intents', 'charges'] as const) {
        mockGet.mockClear();
        const gen: AsyncGenerator<unknown[]> = client.listEntities(entityType);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _page of gen) {
          // consume
        }

        expect(mockGet).toHaveBeenCalledWith(expect.any(String), {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          params: expect.not.objectContaining({ status: expect.anything() }),
        });
      }
    });

    it('calls correct endpoints for each entity type', async () => {
      const emptyResponse = {
        data: { object: 'list', data: [], has_more: false },
      };
      mockGet.mockResolvedValue(emptyResponse);

      const entityEndpoints: [string, string][] = [
        ['customers', '/v1/customers'],
        ['products', '/v1/products'],
        ['prices', '/v1/prices'],
        ['subscriptions', '/v1/subscriptions'],
        ['invoices', '/v1/invoices'],
        ['payment_intents', '/v1/payment_intents'],
        ['charges', '/v1/charges'],
      ];

      for (const [entityType, endpoint] of entityEndpoints) {
        mockGet.mockClear();
        const gen: AsyncGenerator<unknown[]> = client.listEntities(entityType as 'customers');
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _page of gen) {
          // consume
        }
        expect(mockGet).toHaveBeenCalledWith(endpoint, expect.any(Object));
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getEntity
  // ---------------------------------------------------------------------------

  describe('getEntity', () => {
    it('returns entity by ID', async () => {
      const customer = { id: 'cus_123', object: 'customer', name: 'Test Customer' };
      mockGet.mockResolvedValue({ data: customer });

      const result = await client.getEntity('customers', 'cus_123');

      expect(result).toEqual(customer);
      expect(mockGet).toHaveBeenCalledWith('/v1/customers/cus_123', { params: {} });
    });

    it('returns null on 404', async () => {
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: { error: { message: 'No such customer' } },
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      const result = await client.getEntity('customers', 'cus_nonexistent');
      expect(result).toBeNull();
    });

    it('rethrows non-404 errors', async () => {
      const error = new axios.AxiosError('Server error', '500', undefined, undefined, {
        status: 500,
        data: {},
        statusText: 'Internal Server Error',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      await expect(client.getEntity('customers', 'cus_123')).rejects.toThrow();
    });

    it('fetches from correct endpoint for different entity types', async () => {
      const entity = { id: 'pi_123', object: 'payment_intent' };
      mockGet.mockResolvedValue({ data: entity });

      await client.getEntity('payment_intents', 'pi_123');

      expect(mockGet).toHaveBeenCalledWith('/v1/payment_intents/pi_123', { params: {} });
    });
  });

  // ---------------------------------------------------------------------------
  // Subscription items hydration (Stripe truncates expanded items to 10)
  // ---------------------------------------------------------------------------

  describe('subscription items hydration', () => {
    it('follows pagination to backfill subscriptions whose expanded items list is truncated', async () => {
      const truncatedSubscription = {
        id: 'sub_1',
        object: 'subscription',
        items: {
          object: 'list',
          url: '/v1/subscription_items?subscription=sub_1',
          has_more: true,
          data: [{ id: 'si_1', object: 'subscription_item' }],
        },
      };

      mockGet
        // Single page of subscriptions
        .mockResolvedValueOnce({
          data: { object: 'list', data: [truncatedSubscription], has_more: false },
        })
        // subscription_items page 1
        .mockResolvedValueOnce({
          data: {
            object: 'list',
            data: [
              { id: 'si_1', object: 'subscription_item' },
              { id: 'si_2', object: 'subscription_item' },
            ],
            has_more: true,
          },
        })
        // subscription_items page 2
        .mockResolvedValueOnce({
          data: {
            object: 'list',
            data: [{ id: 'si_3', object: 'subscription_item' }],
            has_more: false,
          },
        });

      const pages: Record<string, unknown>[][] = [];
      for await (const page of client.listEntities('subscriptions')) {
        pages.push(page);
      }

      // The yielded subscription now carries the full, untruncated item set.
      expect(pages).toHaveLength(1);
      const subscription = pages[0][0];
      const items = subscription.items as { has_more: boolean; data: { id: string }[] };
      expect(items.has_more).toBe(false);
      expect(items.data.map((item) => item.id)).toEqual(['si_1', 'si_2', 'si_3']);

      // It fetched items from the dedicated endpoint, scoped to the subscription
      // and following the cursor across pages.
      expect(mockGet).toHaveBeenCalledWith('/v1/subscription_items', {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        params: expect.objectContaining({ subscription: 'sub_1', limit: 100 }),
      });
      expect(mockGet).toHaveBeenCalledWith('/v1/subscription_items', {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        params: expect.objectContaining({ subscription: 'sub_1', starting_after: 'si_2' }),
      });
    });

    it('does not re-fetch items for subscriptions that fit in a single page', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          object: 'list',
          data: [
            {
              id: 'sub_small',
              object: 'subscription',
              items: {
                object: 'list',
                has_more: false,
                data: [{ id: 'si_1', object: 'subscription_item' }],
              },
            },
          ],
          has_more: false,
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _page of client.listEntities('subscriptions')) {
        // consume
      }

      // Only the subscriptions list call — no subscription_items follow-up.
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockGet).not.toHaveBeenCalledWith('/v1/subscription_items', expect.anything());
    });

    it('hydrates truncated items when fetching a single subscription via getEntity', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: {
            id: 'sub_1',
            object: 'subscription',
            items: {
              object: 'list',
              has_more: true,
              data: [{ id: 'si_1', object: 'subscription_item' }],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            object: 'list',
            data: [
              { id: 'si_1', object: 'subscription_item' },
              { id: 'si_2', object: 'subscription_item' },
            ],
            has_more: false,
          },
        });

      const subscription = await client.getEntity('subscriptions', 'sub_1');

      const items = subscription?.items as { has_more: boolean; data: { id: string }[] };
      expect(items.has_more).toBe(false);
      expect(items.data.map((item) => item.id)).toEqual(['si_1', 'si_2']);
      expect(mockGet).toHaveBeenCalledWith('/v1/subscription_items', {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        params: expect.objectContaining({ subscription: 'sub_1' }),
      });
    });
  });
});
