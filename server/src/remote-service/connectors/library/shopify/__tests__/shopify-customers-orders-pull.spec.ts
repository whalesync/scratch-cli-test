import { IncrementalPullSupport } from '@spinner/shared-types';
import { resolveIncrementalPullSupportForService } from '../../../connector-registry';
import { Service } from '../../../service-constants';
import { BaseJsonTableSpec, ConnectorFile, PullRecordFilesOptions } from '../../../types';
import { ShopifyError } from '../shopify-api-client';
import { ShopifyConnector } from '../shopify-connector';

// Break the circular import chain through ../../connector -> display-names.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Shopify'),
}));

type ListEntitiesPage = { nodes: Record<string, unknown>[]; endCursor: string | null };

const mockListEntities = jest.fn<AsyncGenerator<ListEntitiesPage, void>, unknown[]>();
const mockFetchConnection = jest.fn<Promise<Record<string, unknown>[]>, unknown[]>();
const mockFetchGrantedAccessScopeHandles = jest.fn<Promise<ReadonlySet<string>>, []>();
const mockFetchNodesByIds = jest.fn<Promise<Record<string, unknown>[]>, unknown[]>();

jest.mock('../shopify-api-client', () => {
  const actualShopifyApiClientModule =
    jest.requireActual<typeof import('../shopify-api-client')>('../shopify-api-client');
  return {
    ...actualShopifyApiClientModule,
    ShopifyApiClient: jest.fn().mockImplementation(() => ({
      listEntities: mockListEntities,
      fetchConnection: mockFetchConnection,
      fetchGrantedAccessScopeHandles: mockFetchGrantedAccessScopeHandles,
      fetchNodesByIds: mockFetchNodesByIds,
    })),
  };
});

function tableSpecFor(entityType: string): BaseJsonTableSpec {
  return {
    id: { wsId: entityType, remoteId: [entityType] },
    slug: entityType,
    name: entityType,
    idPath: 'id',
    schema: {},
  } as unknown as BaseJsonTableSpec;
}

function listEntitiesYielding(...pages: ListEntitiesPage[]) {
  return async function* (): AsyncGenerator<ListEntitiesPage, void> {
    await Promise.resolve();
    for (const page of pages) yield page;
  };
}

const everyScopeTheSetupGuideGrants = new Set(['read_customers', 'read_orders', 'read_all_orders', 'read_products']);

async function pullAll(
  connector: ShopifyConnector,
  entityType: string,
  options: PullRecordFilesOptions = {},
): Promise<{ files: ConnectorFile[]; result: Awaited<ReturnType<ShopifyConnector['pullRecordFiles']>> }> {
  const files: ConnectorFile[] = [];
  const result = await connector.pullRecordFiles(
    tableSpecFor(entityType),
    async (batch) => {
      await Promise.resolve();
      files.push(...batch.files);
    },
    {},
    options,
  );
  return { files, result };
}

describe('ShopifyConnector Customers and Orders', () => {
  let connector: ShopifyConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchGrantedAccessScopeHandles.mockResolvedValue(everyScopeTheSetupGuideGrants);
    connector = new ShopifyConnector({ shopDomain: 'my-store', accessToken: 'shpat_test' });
  });

  it('lists Customers, Orders, and the order child tables on every plan', async () => {
    const tableIds = (await connector.listTables()).map((table) => table.id.wsId);
    expect(tableIds).toEqual(
      expect.arrayContaining(['customers', 'orders', 'order_line_items', 'order_shipping_lines', 'products']),
    );
    expect(tableIds).toHaveLength(13);
  });

  describe('incrementalPullSupport', () => {
    it.each(['customers', 'orders', 'order_line_items', 'order_shipping_lines'])('supports %s', (entityType) => {
      expect(connector.incrementalPullSupport({}, tableSpecFor(entityType))).toBe(IncrementalPullSupport.SUPPORTED);
    });

    it('tells the REST layer and clients, by table, without a connector instance', () => {
      const supportFor = (tableId: string[]) =>
        resolveIncrementalPullSupportForService({ service: Service.SHOPIFY, options: {}, tableSpec: null, tableId });
      expect(supportFor(['orders'])).toBe(IncrementalPullSupport.SUPPORTED);
      expect(supportFor(['order_line_items'])).toBe(IncrementalPullSupport.SUPPORTED);
      expect(supportFor(['products'])).toBe(IncrementalPullSupport.NOT_SUPPORTED);
    });

    it('full-pulls the other tables, and answers no when there is no table spec', () => {
      expect(connector.incrementalPullSupport({}, tableSpecFor('products'))).toBe(IncrementalPullSupport.NOT_SUPPORTED);
      expect(connector.incrementalPullSupport({}, null)).toBe(IncrementalPullSupport.NOT_SUPPORTED);
    });
  });

  it('full-pulls orders with no filter and returns no watermark', async () => {
    mockListEntities.mockImplementation(
      listEntitiesYielding({ nodes: [{ id: 'gid://shopify/Order/1' }], endCursor: 'c1' }),
    );

    const { files, result } = await pullAll(connector, 'orders', { pullMode: 'full' });

    expect(mockFetchGrantedAccessScopeHandles).toHaveBeenCalledTimes(1);
    expect(mockListEntities).toHaveBeenCalledWith('orders', 50, undefined, { updatedAtSearchQuery: undefined });
    expect(files).toEqual([{ id: 'gid://shopify/Order/1' }]);
    expect(result).toEqual({});
  });

  it('incrementally pulls customers updated since the watermark and returns the new watermark', async () => {
    mockListEntities.mockImplementation(
      listEntitiesYielding({ nodes: [{ id: 'gid://shopify/Customer/1' }], endCursor: null }),
    );
    const pullCalledAt = new Date();

    const { files, result } = await pullAll(connector, 'customers', {
      pullMode: 'incremental',
      since: new Date('2026-11-12T10:00:00.000Z'),
    });

    expect(mockListEntities).toHaveBeenCalledWith('customers', 50, undefined, {
      updatedAtSearchQuery: "updated_at:>='2026-11-12T09:55:00.000Z'",
    });
    expect(files).toHaveLength(1);
    expect(result.newWatermark).toBeInstanceOf(Date);
    expect(result.newWatermark?.getTime()).toBeGreaterThanOrEqual(pullCalledAt.getTime());
  });

  it('incrementally pulls order line items through the orders updated since the watermark, by id only', async () => {
    mockListEntities.mockImplementation(
      listEntitiesYielding({
        nodes: [{ id: 'gid://shopify/Order/7' }, { id: 'gid://shopify/Order/8' }],
        endCursor: null,
      }),
    );
    mockFetchConnection.mockImplementation((parentId: unknown) =>
      Promise.resolve([{ id: `gid://shopify/LineItem/for-${String(parentId).split('/').pop()}` }]),
    );

    const { files, result } = await pullAll(connector, 'order_line_items', {
      pullMode: 'incremental',
      since: new Date('2026-11-12T10:00:00.000Z'),
    });

    expect(mockListEntities).toHaveBeenCalledWith('orders', 250, undefined, {
      updatedAtSearchQuery: "updated_at:>='2026-11-12T09:55:00.000Z'",
      selectOnlyRecordIds: true,
    });
    expect(mockFetchConnection).toHaveBeenCalledWith('gid://shopify/Order/7', 'orders', 'lineItems');
    expect(files).toEqual([
      { id: 'gid://shopify/LineItem/for-7', orderId: 'gid://shopify/Order/7' },
      { id: 'gid://shopify/LineItem/for-8', orderId: 'gid://shopify/Order/8' },
    ]);
    expect(result.newWatermark).toBeInstanceOf(Date);
  });

  it('full-pulls a table without incremental support even when incremental is requested', async () => {
    mockListEntities.mockImplementation(
      listEntitiesYielding({ nodes: [{ id: 'gid://shopify/Product/1' }], endCursor: null }),
    );

    const { result } = await pullAll(connector, 'products', {
      pullMode: 'incremental',
      since: new Date('2026-11-12T10:00:00.000Z'),
    });

    expect(mockListEntities).toHaveBeenCalledWith('products', 50, undefined, { updatedAtSearchQuery: undefined });
    expect(result).toEqual({});
    // Products need no scope beyond what every Shopify connection already has.
    expect(mockFetchGrantedAccessScopeHandles).not.toHaveBeenCalled();
  });

  it('lists product parents by id only for a variants pull', async () => {
    mockListEntities.mockImplementation(
      listEntitiesYielding({ nodes: [{ id: 'gid://shopify/Product/1' }], endCursor: null }),
    );
    mockFetchConnection.mockResolvedValue([]);

    await pullAll(connector, 'product_variants');

    expect(mockListEntities).toHaveBeenCalledWith('products', 250, undefined, {
      updatedAtSearchQuery: undefined,
      selectOnlyRecordIds: true,
    });
  });

  it('fails an Orders pull up front, naming each scope the token is missing', async () => {
    mockFetchGrantedAccessScopeHandles.mockResolvedValue(new Set(['read_orders', 'read_products']));

    const pull = pullAll(connector, 'orders');

    await expect(pull).rejects.toBeInstanceOf(ShopifyError);
    await expect(pull).rejects.toMatchObject({ statusCode: 403, code: 'MISSING_ACCESS_SCOPES' });
    await expect(pull).rejects.toThrow(
      "This Shopify connection's access token is missing scopes needed for Orders: " +
        'read_all_orders (to read orders older than 60 days), read_customers (to read customers).',
    );
    expect(mockListEntities).not.toHaveBeenCalled();
  });

  it('fails a by-id Customers fetch up front when the token is missing read_customers', async () => {
    mockFetchGrantedAccessScopeHandles.mockResolvedValue(new Set(['read_orders']));

    await expect(
      connector.pullRecordFilesByIds(tableSpecFor('customers'), ['gid://shopify/Customer/1'], () => Promise.resolve()),
    ).rejects.toThrow('missing scopes needed for Customers: read_customers (to read customers)');
    expect(mockFetchNodesByIds).not.toHaveBeenCalled();
  });
});
