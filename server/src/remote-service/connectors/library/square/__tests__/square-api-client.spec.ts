import axios from 'axios';
import { createApiClient } from '../../../create-api-client';
import {
  SQUARE_CONNECTOR_API_VERSION,
  SquareApiClient,
  SquareError,
  SquareRecordPage,
  isSquareRateLimitError,
} from '../square-api-client';
import { SQUARE_ENTITY_SCHEMAS_SQUARE_VERSION } from '../square-entity-schemas.generated';
import {
  SQUARE_ALL_ORDER_STATES,
  SQUARE_FULL_HISTORY_BEGIN_TIME,
  SQUARE_FULL_HISTORY_END_TIME,
  SquareEntityType,
} from '../square-types';

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({ get: mockGet, post: mockPost })),
}));

function axiosErrorWithStatus(status: number, data: unknown = {}): Error {
  return new axios.AxiosError(`Request failed with status code ${status}`, String(status), undefined, undefined, {
    status,
    data,
    statusText: '',
    headers: {},
    config: {} as never,
  });
}

async function collectPages(
  client: SquareApiClient,
  entityType: SquareEntityType,
  resumeFromProgress?: Parameters<SquareApiClient['listEntityPages']>[1],
): Promise<SquareRecordPage[]> {
  const pages: SquareRecordPage[] = [];
  for await (const page of client.listEntityPages(entityType, resumeFromProgress)) pages.push(page);
  return pages;
}

/** Route GET /v2/locations to a fixed location list; everything else to `otherGetHandler`. */
function mockLocationsThen(locationIds: string[], otherGetHandler: (path: string, config?: unknown) => unknown) {
  mockGet.mockImplementation((path: string, config?: unknown) => {
    if (path === '/v2/locations') {
      return Promise.resolve({ data: { locations: locationIds.map((id) => ({ id })) } });
    }
    return Promise.resolve(otherGetHandler(path, config));
  });
}

describe('SquareApiClient', () => {
  let client: SquareApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new SquareApiClient({ accessToken: 'EAAA-token', environment: 'production' });
  });

  describe('API version pinning', () => {
    // Without the header Square serves the application's default version, so payload shapes would
    // vary per app — and drift from the schemas generated for one specific version.
    it('sends Square-Version on every request', () => {
      const [config] = jest.mocked(createApiClient).mock.calls[0];
      expect(config?.headers).toMatchObject({ 'Square-Version': SQUARE_CONNECTOR_API_VERSION });
    });

    it('pins the same version the record schemas were generated from', () => {
      expect(SQUARE_CONNECTOR_API_VERSION).toBe(SQUARE_ENTITY_SCHEMAS_SQUARE_VERSION);
    });

    it('targets the production host for a production token and the sandbox host for a sandbox token', () => {
      new SquareApiClient({ accessToken: 't', environment: 'sandbox' });
      const baseUrls = jest.mocked(createApiClient).mock.calls.map(([config]) => config?.baseURL);
      expect(baseUrls).toEqual(['https://connect.squareup.com', 'https://connect.squareupsandbox.com']);
    });
  });

  describe('authentication', () => {
    it('sends a pasted access token as the Bearer token, outside the fixed headers', async () => {
      const [config, options] = jest.mocked(createApiClient).mock.calls[0];
      expect(config?.headers).not.toHaveProperty('Authorization');
      await expect(options?.authorizationHeaderValueProvider?.()).resolves.toBe('Bearer EAAA-token');
    });

    it("re-reads an OAuth connection's access token on every request, so a refresh mid-pull is picked up", async () => {
      const oauthAccessTokenProvider = jest
        .fn()
        .mockResolvedValueOnce('oauth-access-1')
        .mockResolvedValueOnce('oauth-access-2');
      new SquareApiClient({ accessToken: oauthAccessTokenProvider, environment: 'sandbox' });
      const [, options] = jest.mocked(createApiClient).mock.calls[1];

      await expect(options?.authorizationHeaderValueProvider?.()).resolves.toBe('Bearer oauth-access-1');
      await expect(options?.authorizationHeaderValueProvider?.()).resolves.toBe('Bearer oauth-access-2');
    });
  });

  describe('single-request listing (locations)', () => {
    it('returns every location from one call', async () => {
      mockGet.mockResolvedValue({ data: { locations: [{ id: 'L1' }, { id: 'L2', status: 'INACTIVE' }] } });

      const pages = await collectPages(client, 'locations');

      expect(pages).toEqual([{ records: [{ id: 'L1' }, { id: 'L2', status: 'INACTIVE' }], progressAfterPage: {} }]);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('cursor listing', () => {
    it('walks the cursor and records it as resume progress', async () => {
      mockGet
        .mockResolvedValueOnce({ data: { customers: [{ id: 'C1' }], cursor: 'next-1' } })
        .mockResolvedValueOnce({ data: { customers: [{ id: 'C2' }] } });

      const pages = await collectPages(client, 'customers');

      expect(pages).toEqual([
        { records: [{ id: 'C1' }], progressAfterPage: { cursor: 'next-1' } },
        { records: [{ id: 'C2' }], progressAfterPage: {} },
      ]);
      expect(mockGet).toHaveBeenNthCalledWith(2, '/v2/customers', { params: { limit: 100, cursor: 'next-1' } });
    });

    it('keeps walking past an empty page that still carries a cursor', async () => {
      mockGet
        .mockResolvedValueOnce({ data: { customers: [], cursor: 'next-1' } })
        .mockResolvedValueOnce({ data: { customers: [{ id: 'C1' }] } });

      const pages = await collectPages(client, 'customers');

      expect(pages.map((page) => page.records)).toEqual([[{ id: 'C1' }]]);
    });

    it('resumes from a saved cursor', async () => {
      mockGet.mockResolvedValueOnce({ data: { customers: [{ id: 'C9' }] } });

      await collectPages(client, 'customers', { cursor: 'saved-cursor' });

      expect(mockGet).toHaveBeenCalledWith('/v2/customers', { params: { limit: 100, cursor: 'saved-cursor' } });
    });

    it('asks the catalog for exactly one object type per table', async () => {
      mockGet.mockResolvedValueOnce({ data: { objects: [{ id: 'V1', type: 'ITEM_VARIATION' }] } });

      await collectPages(client, 'catalog_item_variations');

      expect(mockGet).toHaveBeenCalledWith('/v2/catalog/list', { params: { types: 'ITEM_VARIATION' } });
    });

    // ListRefunds defaults to the last year only; an explicit early begin_time pulls the full history.
    it('asks refunds for the full history, oldest first', async () => {
      mockGet.mockResolvedValueOnce({ data: { refunds: [] } });

      await collectPages(client, 'refunds');

      expect(mockGet).toHaveBeenCalledWith('/v2/refunds', {
        params: { begin_time: SQUARE_FULL_HISTORY_BEGIN_TIME, sort_order: 'ASC', limit: 100 },
      });
    });
  });

  describe('per-location listing (payments, payouts, invoices)', () => {
    // ListPayments covers only the seller's MAIN location unless given location_id, and only the last
    // year unless given begin_time — both defaults would silently drop data from a full pull.
    it('walks every location, sorted, asking each for the full history', async () => {
      mockLocationsThen(['L2', 'L1'], (_path, config) => {
        const locationId = (config as { params: { location_id: string } }).params.location_id;
        return { data: { payments: [{ id: `P-${locationId}` }] } };
      });

      const pages = await collectPages(client, 'payments');

      expect(pages).toEqual([
        { records: [{ id: 'P-L1' }], progressAfterPage: { locationIndex: 1 } },
        { records: [{ id: 'P-L2' }], progressAfterPage: { locationIndex: 2 } },
      ]);
      expect(mockGet).toHaveBeenCalledWith('/v2/payments', {
        params: { begin_time: SQUARE_FULL_HISTORY_BEGIN_TIME, sort_order: 'ASC', limit: 100, location_id: 'L1' },
      });
    });

    it('records the location and cursor mid-location, and resumes there', async () => {
      mockLocationsThen(['L1', 'L2'], (_path, config) => {
        const { location_id: locationId, cursor } = (config as { params: { location_id: string; cursor?: string } })
          .params;
        if (locationId === 'L1' && !cursor) return { data: { invoices: [{ id: 'I1' }], cursor: 'c-2' } };
        return { data: { invoices: [{ id: `I-${locationId}-${cursor ?? 'first'}` }] } };
      });

      const firstRunPages = await collectPages(client, 'invoices');
      expect(firstRunPages[0].progressAfterPage).toEqual({ locationIndex: 0, cursor: 'c-2' });

      mockGet.mockClear();
      const resumedClient = new SquareApiClient({ accessToken: 'EAAA-token', environment: 'production' });
      const resumedPages = await collectPages(resumedClient, 'invoices', { locationIndex: 0, cursor: 'c-2' });

      expect(resumedPages.map((page) => page.records)).toEqual([[{ id: 'I-L1-c-2' }], [{ id: 'I-L2-first' }]]);
    });

    it('fetches the location list once per client', async () => {
      mockLocationsThen(['L1'], () => ({ data: { payouts: [] } }));

      await collectPages(client, 'payouts');
      await collectPages(client, 'payments');

      expect(mockGet.mock.calls.filter(([path]) => path === '/v2/locations')).toHaveLength(1);
    });
  });

  describe('per-payout listing (payout entries)', () => {
    /**
     * Route payouts per location, then each payout's entries (two pages for P-A). Oldest first is P-B, P-C, P-A,
     * which is not id order. `newerPayout` adds a payout created after all of them.
     */
    function mockPayoutsAndEntries(newerPayout?: { id: string; created_at: string }) {
      mockLocationsThen(['L1', 'L2'], (path, config) => {
        if (path === '/v2/payouts') {
          const locationId = (config as { params: { location_id: string } }).params.location_id;
          const payouts =
            locationId === 'L1'
              ? [
                  { id: 'P-B', created_at: '2026-01-01T00:00:00Z' },
                  { id: 'P-A', created_at: '2026-03-01T00:00:00Z' },
                ]
              : [{ id: 'P-C', created_at: '2026-02-01T00:00:00Z' }, ...(newerPayout ? [newerPayout] : [])];
          return { data: { payouts } };
        }
        const cursor = (config as { params: { cursor?: string } }).params.cursor;
        if (path === '/v2/payouts/P-A/payout-entries' && !cursor) {
          return { data: { payout_entries: [{ id: 'E-A1', payout_id: 'P-A' }], cursor: 'c-A' } };
        }
        if (path === '/v2/payouts/P-A/payout-entries') {
          return { data: { payout_entries: [{ id: 'E-A2', payout_id: 'P-A' }] } };
        }
        const payoutId = path.split('/')[3];
        return { data: { payout_entries: [{ id: `E-${payoutId}`, payout_id: payoutId }] } };
      });
    }

    it("walks every payout of every location, oldest first, recording where it is in each payout's entries", async () => {
      mockPayoutsAndEntries();

      const pages = await collectPages(client, 'payout_entries');

      expect(pages).toEqual([
        { records: [{ id: 'E-P-B', payout_id: 'P-B' }], progressAfterPage: { payoutIndex: 1 } },
        { records: [{ id: 'E-P-C', payout_id: 'P-C' }], progressAfterPage: { payoutIndex: 2 } },
        { records: [{ id: 'E-A1', payout_id: 'P-A' }], progressAfterPage: { payoutIndex: 2, cursor: 'c-A' } },
        { records: [{ id: 'E-A2', payout_id: 'P-A' }], progressAfterPage: { payoutIndex: 3 } },
      ]);
      expect(mockGet).toHaveBeenCalledWith('/v2/payouts', {
        params: { begin_time: SQUARE_FULL_HISTORY_BEGIN_TIME, sort_order: 'ASC', limit: 100, location_id: 'L2' },
      });
      expect(mockGet).toHaveBeenCalledWith('/v2/payouts/P-B/payout-entries', {
        params: { sort_order: 'ASC', limit: 100 },
      });
    });

    it('resumes mid-payout from the saved cursor', async () => {
      mockPayoutsAndEntries();

      const pages = await collectPages(client, 'payout_entries', { payoutIndex: 2, cursor: 'c-A' });

      expect(pages.flatMap((page) => page.records.map((record) => record.id))).toEqual(['E-A2']);
    });

    // Payout ids are random, so a new payout's id can sort before the saved one; ordering by age puts it last.
    it('resumes at the same payout when a newer payout appeared in between, then walks the newer one', async () => {
      mockPayoutsAndEntries({ id: 'P-0', created_at: '2026-04-01T00:00:00Z' });

      const pages = await collectPages(client, 'payout_entries', { payoutIndex: 2, cursor: 'c-A' });

      expect(pages.flatMap((page) => page.records.map((record) => record.id))).toEqual(['E-A2', 'E-P-0']);
    });
  });

  describe('gift card activities', () => {
    // ListGiftCardActivities returns only the last year unless given a time range, and refuses a
    // begin_time sent without an end_time.
    it('asks for the full history as a closed time range, oldest first', async () => {
      mockGet.mockResolvedValueOnce({ data: { gift_card_activities: [{ id: 'GA1' }] } });

      await collectPages(client, 'gift_card_activities');

      expect(mockGet).toHaveBeenCalledWith('/v2/gift-cards/activities', {
        params: {
          begin_time: SQUARE_FULL_HISTORY_BEGIN_TIME,
          end_time: SQUARE_FULL_HISTORY_END_TIME,
          sort_order: 'ASC',
          limit: 100,
        },
      });
    });
  });

  describe('orders search', () => {
    it('searches every state, in batches of at most 10 locations', async () => {
      const locationIds = Array.from({ length: 12 }, (_unused, index) => `L${String(index).padStart(2, '0')}`);
      mockLocationsThen(locationIds, () => ({}));
      mockPost.mockImplementation((_path: string, body: { location_ids: string[] }) =>
        Promise.resolve({ data: { orders: [{ id: `O-${body.location_ids[0]}` }] } }),
      );

      const pages = await collectPages(client, 'orders');

      expect(mockPost).toHaveBeenCalledTimes(2);
      const [firstRequestBody, secondRequestBody] = mockPost.mock.calls.map(
        ([, body]) => body as { location_ids: string[]; query: unknown },
      );
      expect(firstRequestBody.location_ids).toEqual(locationIds.slice(0, 10));
      expect(secondRequestBody.location_ids).toEqual(locationIds.slice(10));
      expect(firstRequestBody.query).toEqual({
        filter: { state_filter: { states: SQUARE_ALL_ORDER_STATES } },
        sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' },
      });
      expect(pages.map((page) => page.progressAfterPage)).toEqual([{ locationIndex: 10 }, { locationIndex: 20 }]);
    });

    it('includes DRAFT orders', () => {
      expect(SQUARE_ALL_ORDER_STATES).toEqual(expect.arrayContaining(['OPEN', 'COMPLETED', 'CANCELED', 'DRAFT']));
    });
  });

  describe('cursor search (team members, subscriptions)', () => {
    it('sends no query, so subscriptions of every status are returned', async () => {
      mockPost.mockResolvedValueOnce({ data: { subscriptions: [{ id: 'S1', status: 'CANCELED' }] } });

      const pages = await collectPages(client, 'subscriptions');

      expect(pages.flatMap((page) => page.records)).toEqual([{ id: 'S1', status: 'CANCELED' }]);
      expect(mockPost).toHaveBeenCalledWith('/v2/subscriptions/search', { limit: 100 });
    });

    it('sends no query, so team members of every status are returned', async () => {
      mockPost
        .mockResolvedValueOnce({ data: { team_members: [{ id: 'T1' }], cursor: 'next' } })
        .mockResolvedValueOnce({ data: { team_members: [{ id: 'T2' }] } });

      const pages = await collectPages(client, 'team_members');

      expect(pages.flatMap((page) => page.records)).toEqual([{ id: 'T1' }, { id: 'T2' }]);
      expect(mockPost).toHaveBeenNthCalledWith(1, '/v2/team-members/search', { limit: 100 });
      expect(mockPost).toHaveBeenNthCalledWith(2, '/v2/team-members/search', { limit: 100, cursor: 'next' });
    });
  });

  describe('retrieveEntity', () => {
    it('unwraps the single-record envelope', async () => {
      mockGet.mockResolvedValueOnce({ data: { payment: { id: 'P1', status: 'COMPLETED' } } });

      await expect(client.retrieveEntity('payments', 'P1')).resolves.toEqual({ id: 'P1', status: 'COMPLETED' });
      expect(mockGet).toHaveBeenCalledWith('/v2/payments/P1');
    });

    it('returns null for a 404', async () => {
      mockGet.mockRejectedValueOnce(axiosErrorWithStatus(404, { errors: [{ code: 'NOT_FOUND' }] }));

      await expect(client.retrieveEntity('orders', 'missing')).resolves.toBeNull();
    });

    it('returns null for a catalog object of a different type than the table holds', async () => {
      mockGet.mockResolvedValueOnce({ data: { object: { id: 'X1', type: 'ITEM' } } });

      await expect(client.retrieveEntity('catalog_taxes', 'X1')).resolves.toBeNull();
    });

    // Answering null would tell the pull the record was deleted.
    it('refuses a table Square has no single-record endpoint for', async () => {
      await expect(client.retrieveEntity('gift_card_activities', 'GA1')).rejects.toThrow(
        "Square can't fetch a single Gift Card Activities record. Pull the whole table to refresh it.",
      );
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('retrieveGrantedScopes', () => {
    it("reads the token's scopes from RetrieveTokenStatus", async () => {
      mockPost.mockResolvedValueOnce({ data: { scopes: ['ITEMS_READ', 'PAYMENTS_READ'], merchant_id: 'M1' } });

      await expect(client.retrieveGrantedScopes()).resolves.toEqual(new Set(['ITEMS_READ', 'PAYMENTS_READ']));
      expect(mockPost).toHaveBeenCalledWith('/oauth2/token/status', {});
    });
  });

  describe('errors', () => {
    it("surfaces Square's own error detail", async () => {
      mockGet.mockRejectedValue(
        axiosErrorWithStatus(403, {
          errors: [{ category: 'AUTHENTICATION_ERROR', code: 'INSUFFICIENT_SCOPES', detail: 'Missing PAYOUTS_READ' }],
        }),
      );

      const pull = collectPages(client, 'locations');

      await expect(pull).rejects.toThrow(SquareError);
      await expect(collectPages(client, 'locations')).rejects.toThrow('Square API error (403): Missing PAYOUTS_READ');
    });

    it('treats 429 as a rate limit', () => {
      expect(isSquareRateLimitError(axiosErrorWithStatus(429))).toBe(true);
      expect(isSquareRateLimitError(axiosErrorWithStatus(500))).toBe(false);
    });
  });

  describe('detectEnvironmentForAccessToken', () => {
    it('picks production when production accepts the token', async () => {
      mockGet.mockResolvedValueOnce({ data: { merchant: { id: 'M1' } } });

      await expect(SquareApiClient.detectEnvironmentForAccessToken('t')).resolves.toBe('production');
    });

    it('falls back to sandbox when production rejects the token', async () => {
      mockGet
        .mockRejectedValueOnce(axiosErrorWithStatus(401))
        .mockResolvedValueOnce({ data: { merchant: { id: 'M1' } } });

      await expect(SquareApiClient.detectEnvironmentForAccessToken('t')).resolves.toBe('sandbox');
    });

    it('returns null when both environments reject the token', async () => {
      mockGet.mockRejectedValue(axiosErrorWithStatus(401));

      await expect(SquareApiClient.detectEnvironmentForAccessToken('t')).resolves.toBeNull();
    });

    it('does not mistake an outage for a bad token', async () => {
      mockGet.mockRejectedValue(axiosErrorWithStatus(503, { errors: [{ detail: 'Service unavailable' }] }));

      await expect(SquareApiClient.detectEnvironmentForAccessToken('t')).rejects.toThrow(SquareError);
    });
  });
});
