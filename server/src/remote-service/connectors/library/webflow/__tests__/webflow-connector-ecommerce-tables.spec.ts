import { WebflowConnector } from '../webflow-connector';
import { WEBFLOW_ORDERS_TABLE_ID_PREFIX } from '../webflow-types';

// Mock display-names to break circular import chain (it imports all connectors).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Mock the WebflowApiClient so listTables reads our canned sites/collections.
// `locales.secondary: []` on each site is the unambiguous "no secondary locales"
// signal, so getSecondaryLocales never needs a getSite fetch (unmocked here).
const mockListSites = jest.fn();
const mockListCollections = jest.fn();
jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => ({
    listSites: mockListSites,
    listCollections: mockListCollections,
  })),
  WebflowError: class WebflowError extends Error {},
}));

// Mock html-minify (imported at module load by webflow-connector).
jest.mock('src/wrappers/html-minify', () => ({
  minifyHtml: jest.fn((input: string) => Promise.resolve(`minified:${input}`)),
}));

const site = { id: 'site-1', displayName: 'My Site', shortName: 'mysite', locales: { secondary: [] } };

function collection(id: string, displayName: string, slug: string) {
  return { id, displayName, slug };
}

describe('WebflowConnector.listTables — Ecommerce (DEV-10729)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('routes Products/SKUs/Categories under /<Site>/Ecommerce and adds an Orders table there', async () => {
    mockListSites.mockResolvedValue({ sites: [site] });
    mockListCollections.mockResolvedValue({
      collections: [
        collection('c-blog', 'Blog Posts', 'blog-posts'),
        collection('c-prod', 'Products', 'product'),
        collection('c-sku', 'SKUs', 'sku'),
        collection('c-cat', 'Categories', 'category'),
      ],
    });

    // v2 account so ordinary collections nest under /Collections (distinct from /Ecommerce).
    const connector = new WebflowConnector('token', { structureVersion: 2 });
    const tables = await connector.listTables();
    const byName = new Map(tables.map((t) => [t.displayName, t]));

    // Ordinary collection → /<Site>/Collections
    expect(byName.get('Blog Posts')?.parentPath).toBe('My Site/Collections');
    // Ecommerce collections → /<Site>/Ecommerce
    expect(byName.get('Products')?.parentPath).toBe('My Site/Ecommerce');
    expect(byName.get('SKUs')?.parentPath).toBe('My Site/Ecommerce');
    expect(byName.get('Categories')?.parentPath).toBe('My Site/Ecommerce');

    // Orders table present, under /<Site>/Ecommerce, read-only create/delete.
    const orders = byName.get('Orders');
    expect(orders).toBeDefined();
    expect(orders?.parentPath).toBe('My Site/Ecommerce');
    expect(orders?.id.wsId).toBe(`${WEBFLOW_ORDERS_TABLE_ID_PREFIX}site-1`);
    expect(orders?.disabledCreates).toBe(true);
    expect(orders?.disabledDeletes).toBe(true);
  });

  it('adds NO Orders table for a site with no ecommerce collections', async () => {
    mockListSites.mockResolvedValue({ sites: [site] });
    mockListCollections.mockResolvedValue({
      collections: [collection('c-blog', 'Blog Posts', 'blog-posts')],
    });

    const connector = new WebflowConnector('token', { structureVersion: 2 });
    const tables = await connector.listTables();

    expect(tables.some((t) => t.displayName === 'Orders')).toBe(false);
    // Assets + Pages are still always present.
    expect(tables.some((t) => t.displayName === 'Assets')).toBe(true);
    expect(tables.some((t) => t.displayName === 'Pages')).toBe(true);
  });
});
