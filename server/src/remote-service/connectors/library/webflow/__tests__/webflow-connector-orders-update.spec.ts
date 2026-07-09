import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { WebflowConnector } from '../webflow-connector';
import { buildWebflowOrdersJsonTableSpec } from '../webflow-json-schema';
import { Order, Site, WEBFLOW_ORDERS_TABLE_ID_PREFIX } from '../webflow-types';

// Mock display-names to break circular import chain (it imports all connectors).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Mock the WebflowApiClient so the connector's internal `this.client` is the mock.
// The orders branch of `updateRecords` only touches `updateOrder` (the PATCH
// …/orders/{id} write) and `getOrder` (the post-write refetch).
const mockUpdateOrder = jest.fn();
const mockGetOrder = jest.fn();
jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => ({
    updateOrder: mockUpdateOrder,
    getOrder: mockGetOrder,
  })),
  WebflowError: class WebflowError extends Error {},
}));

// Mock html-minify (imported at module load by webflow-connector).
jest.mock('src/wrappers/html-minify', () => ({
  minifyHtml: jest.fn((input: string) => Promise.resolve(`minified:${input}`)),
}));

const site = { id: 'site-1', displayName: 'My Site', shortName: 'mysite' } as Site;

function makeApiOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: 'order-1',
    status: 'fulfilled',
    comment: 'existing note',
    shippingProvider: 'UPS',
    shippingTracking: '1Z-EXISTING',
    shippingTrackingURL: 'https://ups.com/track/1Z-EXISTING',
    acceptedOn: '2024-01-01T00:00:00.000Z',
    customerInfo: { fullName: 'Ada Lovelace', email: 'ada@example.com' },
    purchasedItemsCount: 3,
    ...overrides,
  };
}

describe('WebflowConnector.updateRecords (orders — shipping/comment)', () => {
  let connector: WebflowConnector;
  let ordersTableSpec: BaseJsonTableSpec;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new WebflowConnector('test-token');
    ordersTableSpec = buildWebflowOrdersJsonTableSpec(
      {
        wsId: `${WEBFLOW_ORDERS_TABLE_ID_PREFIX}site-1`,
        remoteId: ['site-1', `${WEBFLOW_ORDERS_TABLE_ID_PREFIX}site-1`],
      },
      site,
    );
  });

  it('forwards every writable field (comment + shipping tracking) to updateOrder with the site id', async () => {
    mockUpdateOrder.mockResolvedValue(undefined);
    mockGetOrder.mockResolvedValue(makeApiOrder());

    const files: ConnectorFile[] = [
      {
        orderId: 'order-1',
        comment: 'new note',
        shippingProvider: 'FedEx',
        shippingTracking: '9999',
        shippingTrackingURL: 'https://fedex.com/track/9999',
      } as unknown as ConnectorFile,
    ];

    await connector.updateRecords(ordersTableSpec, files);

    expect(mockUpdateOrder).toHaveBeenCalledTimes(1);
    expect(mockUpdateOrder).toHaveBeenCalledWith('site-1', 'order-1', {
      comment: 'new note',
      shippingProvider: 'FedEx',
      shippingTracking: '9999',
      shippingTrackingURL: 'https://fedex.com/track/9999',
    });
  });

  it('returns the refetched order verbatim (byte-equal to a fresh pull)', async () => {
    mockUpdateOrder.mockResolvedValue(undefined);
    const refetched = makeApiOrder({ comment: 'new note' });
    mockGetOrder.mockResolvedValue(refetched);

    const files: ConnectorFile[] = [{ orderId: 'order-1', comment: 'new note' } as unknown as ConnectorFile];

    const result = await connector.updateRecords(ordersTableSpec, files);

    expect(mockGetOrder).toHaveBeenCalledWith('site-1', 'order-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(refetched);
  });

  it('sends only the changed field when changedFields scopes the edit', async () => {
    mockUpdateOrder.mockResolvedValue(undefined);
    mockGetOrder.mockResolvedValue(makeApiOrder());

    const files: ConnectorFile[] = [{ orderId: 'order-1', shippingTracking: '1Z-NEW' } as unknown as ConnectorFile];
    const changedFields: (Record<string, unknown> | undefined)[] = [{ shippingTracking: '1Z-NEW' }];

    await connector.updateRecords(ordersTableSpec, files, changedFields);

    expect(mockUpdateOrder).toHaveBeenCalledWith('site-1', 'order-1', { shippingTracking: '1Z-NEW' });
  });

  // DEV-10729: editing a read-only order field (status, customerInfo, totals, …) is
  // a genuine read-only edit — surface it instead of silently no-op'ing while
  // reporting success (Pages guard, applied to orders).
  it('throws when only a read-only field changed, and does not call the API', async () => {
    const files: ConnectorFile[] = [{ orderId: 'order-1', status: 'fulfilled' } as unknown as ConnectorFile];
    const changedFields: (Record<string, unknown> | undefined)[] = [{ status: 'refunded' }];

    await expect(connector.updateRecords(ordersTableSpec, files, changedFields)).rejects.toThrow(
      /"status" is read-only/,
    );
    expect(mockUpdateOrder).not.toHaveBeenCalled();
    expect(mockGetOrder).not.toHaveBeenCalled();
  });

  it('does not fire a write when no writable field is present (returns the input unchanged)', async () => {
    const files: ConnectorFile[] = [{ orderId: 'order-1' } as unknown as ConnectorFile];

    const result = await connector.updateRecords(ordersTableSpec, files);

    expect(mockUpdateOrder).not.toHaveBeenCalled();
    expect(mockGetOrder).not.toHaveBeenCalled();
    expect(result[0]).toEqual({ orderId: 'order-1' });
  });

  it('processes multiple orders in input order', async () => {
    mockUpdateOrder.mockResolvedValue(undefined);
    mockGetOrder.mockImplementation((_siteId: string, orderId: string) =>
      Promise.resolve(makeApiOrder({ orderId, comment: `c-${orderId}` })),
    );

    const files: ConnectorFile[] = [
      { orderId: 'order-a', comment: 'A' } as unknown as ConnectorFile,
      { orderId: 'order-b', comment: 'B' } as unknown as ConnectorFile,
    ];

    const result = await connector.updateRecords(ordersTableSpec, files);

    expect(mockUpdateOrder).toHaveBeenNthCalledWith(1, 'site-1', 'order-a', { comment: 'A' });
    expect(mockUpdateOrder).toHaveBeenNthCalledWith(2, 'site-1', 'order-b', { comment: 'B' });
    expect(result.map((f) => f.orderId)).toEqual(['order-a', 'order-b']);
  });
});
