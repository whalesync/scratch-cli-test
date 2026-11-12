import { ShopifyApiClient, ShopifyError } from '../shopify-api-client';

const mockPost = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({ post: mockPost })),
}));

function graphqlResponse(body: Record<string, unknown>) {
  return Promise.resolve({ data: body });
}

async function collectPages(generator: AsyncGenerator<{ nodes: Record<string, unknown>[] }, void>) {
  const pages: Record<string, unknown>[][] = [];
  for await (const page of generator) pages.push(page.nodes);
  return pages;
}

describe('ShopifyApiClient for Customers and Orders', () => {
  let client: ShopifyApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new ShopifyApiClient({ shopDomain: 'my-store', accessToken: 'shpat_test' });
  });

  it('filters an incremental list by updated_at and sorts it by UPDATED_AT', async () => {
    mockPost.mockReturnValueOnce(
      graphqlResponse({
        data: {
          orders: { nodes: [{ id: 'gid://shopify/Order/1' }], pageInfo: { hasNextPage: false, endCursor: 'c1' } },
        },
      }),
    );

    await collectPages(
      client.listEntities('orders', 50, undefined, { updatedAtSearchQuery: "updated_at:>='2026-11-12T09:55:00.000Z'" }),
    );

    const [, requestBody] = mockPost.mock.calls[0] as [string, { query: string; variables: Record<string, unknown> }];
    expect(requestBody.query).toContain('orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT)');
    expect(requestBody.variables).toEqual({
      query: "updated_at:>='2026-11-12T09:55:00.000Z'",
      first: 50,
      after: null,
    });
  });

  it('sends no filter or sort on a full list', async () => {
    mockPost.mockReturnValueOnce(
      graphqlResponse({ data: { customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    );

    await collectPages(client.listEntities('customers'));

    const [, requestBody] = mockPost.mock.calls[0] as [string, { query: string; variables: Record<string, unknown> }];
    expect(requestBody.query).toContain('customers(first: $first, after: $after)');
    expect(requestBody.query).not.toContain('sortKey');
    expect(requestBody.variables).toEqual({ first: 50, after: null });
  });

  it('requests only ids when asked for parent ids', async () => {
    mockPost.mockReturnValueOnce(
      graphqlResponse({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    );

    await collectPages(client.listEntities('orders', 250, undefined, { selectOnlyRecordIds: true }));

    const [, requestBody] = mockPost.mock.calls[0] as [string, { query: string }];
    expect(requestBody.query.replace(/\s+/g, ' ')).toContain('nodes { id }');
  });

  it('refuses an updated_at filter for a table whose list has none', async () => {
    await expect(
      collectPages(client.listEntities('products', 50, undefined, { updatedAtSearchQuery: "updated_at:>='x'" })),
    ).rejects.toThrow("Incremental pulls aren't supported for products");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('fetches the granted access scopes once per client', async () => {
    mockPost.mockReturnValueOnce(
      graphqlResponse({
        data: { currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, { handle: 'read_customers' }] } },
      }),
    );

    const first = await client.fetchGrantedAccessScopeHandles();
    const second = await client.fetchGrantedAccessScopeHandles();

    expect([...first]).toEqual(['read_orders', 'read_customers']);
    expect(second).toBe(first);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('turns an ACCESS_DENIED GraphQL error into a 403 that says how to fix the access', async () => {
    mockPost.mockReturnValueOnce(
      graphqlResponse({
        data: { customers: null },
        errors: [
          {
            message: 'Access denied for customers field. Required access: `read_customers` access scope.',
            extensions: { code: 'ACCESS_DENIED' },
          },
        ],
      }),
    );

    const pull = collectPages(client.listEntities('customers'));

    await expect(pull).rejects.toBeInstanceOf(ShopifyError);
    await expect(pull).rejects.toMatchObject({ statusCode: 403, code: 'ACCESS_DENIED' });
    await expect(pull).rejects.toThrow(
      'Shopify denied access: Access denied for customers field. Required access: `read_customers` access scope. ' +
        "Add the missing access to your Shopify app's Access scopes",
    );
  });
});
