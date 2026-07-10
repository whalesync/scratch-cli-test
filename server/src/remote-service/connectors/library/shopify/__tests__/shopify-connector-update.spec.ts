import { BaseJsonTableSpec, ConnectorFile, EntityId } from '../../../types';
import { ShopifyConnector } from '../shopify-connector';

// Break the circular import chain through ../../connector -> display-names.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Shopify'),
}));

const mockUpdateEntity = jest.fn();
const mockCreateEntity = jest.fn();

jest.mock('../shopify-api-client', () => ({
  // Keep the real SEO entity set (used at construction / pull time).
  SEO_METAFIELD_ENTITIES: new Set(['articles', 'pages', 'blogs']),
  ShopifyApiClient: jest.fn().mockImplementation(() => ({
    updateEntity: mockUpdateEntity,
    createEntity: mockCreateEntity,
  })),
  ShopifyError: class ShopifyError extends Error {
    statusCode?: number;
    code?: string;
    userErrors?: unknown;
    constructor(message: string, statusCode?: number, code?: string) {
      super(message);
      this.name = 'ShopifyError';
      this.statusCode = statusCode;
      this.code = code;
    }
  },
}));

function productsTableSpec(): BaseJsonTableSpec {
  const id: EntityId = { wsId: 'products', remoteId: ['products'] };
  return { id, slug: 'products', name: 'Products', idPath: 'id', schema: {} } as unknown as BaseJsonTableSpec;
}

function pagesTableSpec(): BaseJsonTableSpec {
  const id: EntityId = { wsId: 'pages', remoteId: ['pages'] };
  return { id, slug: 'pages', name: 'Pages', idPath: 'id', schema: {} } as unknown as BaseJsonTableSpec;
}

describe('ShopifyConnector.updateRecords', () => {
  let connector: ShopifyConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateEntity.mockResolvedValue({});
    connector = new ShopifyConnector({ shopDomain: 'my-store', accessToken: 'shpat_test' });
  });

  it('sends only the changed writable fields when changedFields is sparse', async () => {
    const files: ConnectorFile[] = [{ id: 'gid://shopify/Product/1', title: 'Old' }];
    const changedFields: Record<string, unknown>[] = [{ title: 'New' }];

    await connector.updateRecords(productsTableSpec(), files, changedFields);

    expect(mockUpdateEntity).toHaveBeenCalledWith('products', 'gid://shopify/Product/1', { title: 'New' });
  });

  // DEV-10597: a read-only field in the sparse changedFields is a genuine
  // read-only edit. Surface it instead of stripping it to an empty/partial no-op
  // mutation and reporting success.
  it('throws when a changed field is read-only, and does not call the API', async () => {
    const files: ConnectorFile[] = [{ id: 'gid://shopify/Product/1', createdAt: '2026-01-01T00:00:00Z' }];
    const changedFields: Record<string, unknown>[] = [{ createdAt: '2026-02-02T00:00:00Z' }];

    await expect(connector.updateRecords(productsTableSpec(), files, changedFields)).rejects.toThrow(
      /"createdAt" is read-only/,
    );
    expect(mockUpdateEntity).not.toHaveBeenCalled();
  });

  // DEV-10637: the verbatim SEO metafields land as `seoTitle`/`seoDescription` ({ value }).
  // Editing seoTitle.value presents the whole seoTitle object as the sparse change; it is a
  // writable field, so the connector forwards it to updateEntity (which converts it into the
  // global.title_tag metafield mutation — covered in shopify-seo-metafields.spec.ts).
  it('forwards a changed seoTitle for SEO metafield entities to updateEntity', async () => {
    const files: ConnectorFile[] = [{ id: 'gid://shopify/Page/1', seoTitle: { value: 'Old Title' } }];
    const changedFields: Record<string, unknown>[] = [{ seoTitle: { value: 'New Title' } }];

    await connector.updateRecords(pagesTableSpec(), files, changedFields);

    expect(mockUpdateEntity).toHaveBeenCalledWith('pages', 'gid://shopify/Page/1', {
      seoTitle: { value: 'New Title' },
    });
  });

  it('throws when a read-only field is changed alongside a writable one', async () => {
    const files: ConnectorFile[] = [{ id: 'gid://shopify/Product/1', title: 'Old', createdAt: 'x' }];
    const changedFields: Record<string, unknown>[] = [{ title: 'New', createdAt: 'y' }];

    await expect(connector.updateRecords(productsTableSpec(), files, changedFields)).rejects.toThrow(
      /read-only and cannot be published/,
    );
    expect(mockUpdateEntity).not.toHaveBeenCalled();
  });
});
