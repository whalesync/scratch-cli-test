import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { WebflowConnector } from '../webflow-connector';
import { buildWebflowPagesJsonTableSpec } from '../webflow-json-schema';
import { Page, Site } from '../webflow-types';

// Mock display-names to break circular import chain (it imports all connectors)
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Mock the WebflowApiClient so the connector's internal `this.client` is the
// mock. The pages branch of `updateRecords` only touches `updatePageSettings`
// (the PUT /pages/{id} write) and `getPageMetadata` (the post-write refetch).
const mockUpdatePageSettings = jest.fn();
const mockGetPageMetadata = jest.fn();
jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => ({
    updatePageSettings: mockUpdatePageSettings,
    getPageMetadata: mockGetPageMetadata,
  })),
  WebflowError: class WebflowError extends Error {},
}));

// Mock html-minify (imported at module load by webflow-connector).
jest.mock('src/wrappers/html-minify', () => ({
  minifyHtml: jest.fn((input: string) => Promise.resolve(`minified:${input}`)),
}));

function makeSite(overrides: Partial<Site> = {}): Site {
  return {
    id: 'site-1',
    displayName: 'My Site',
    shortName: 'mysite',
    ...overrides,
  } as Site;
}

/**
 * A full Page exactly as the Webflow API returns it from GET /pages/{id},
 * including fields the connector deliberately drops from the on-disk record
 * (siteId, collectionId, canBranch, isBranch, localeId). The refetch normalizer
 * must whitelist away these extras so a published page stays byte-equal to a
 * fresh pull.
 */
function makeApiPage(overrides: Partial<Page> = {}): Page {
  return {
    id: 'page-1',
    siteId: 'site-1',
    collectionId: 'col-xyz',
    title: 'About Us',
    slug: 'about-us',
    parentId: 'parent-1',
    archived: false,
    draft: false,
    canBranch: false,
    isBranch: false,
    localeId: 'locale-1',
    publishedPath: '/about-us',
    createdOn: '2024-01-01T00:00:00.000Z',
    lastUpdated: '2024-02-01T00:00:00.000Z',
    seo: { title: 'About Us — SEO', description: 'SEO description' },
    openGraph: { title: 'About Us — OG', titleCopied: false, description: 'OG description', descriptionCopied: false },
    ...overrides,
  };
}

describe('WebflowConnector.updateRecords (pages — SEO metadata)', () => {
  let connector: WebflowConnector;
  let pagesTableSpec: BaseJsonTableSpec;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new WebflowConnector('test-token');
    // The branch is selected by `tableSpec.id.remoteId[1]` starting with the
    // pages prefix, so build the real pages spec rather than a hand-rolled fake.
    pagesTableSpec = buildWebflowPagesJsonTableSpec(
      { wsId: '__pages__site-1', remoteId: ['site-1', '__pages__site-1'] },
      makeSite(),
    );
  });

  it('forwards every editable SEO field (title, slug, seo, openGraph) to updatePageSettings', async () => {
    mockUpdatePageSettings.mockResolvedValue(undefined);
    mockGetPageMetadata.mockResolvedValue(makeApiPage());

    const seo = { title: 'New SEO Title', description: 'New SEO Description' };
    const openGraph = {
      title: 'New OG Title',
      titleCopied: false,
      description: 'New OG Desc',
      descriptionCopied: false,
    };
    const files: ConnectorFile[] = [
      { id: 'page-1', title: 'New Title', slug: 'new-slug', seo, openGraph } as unknown as ConnectorFile,
    ];

    await connector.updateRecords(pagesTableSpec, files);

    expect(mockUpdatePageSettings).toHaveBeenCalledTimes(1);
    expect(mockUpdatePageSettings).toHaveBeenCalledWith('page-1', {
      title: 'New Title',
      slug: 'new-slug',
      seo,
      openGraph,
    });
  });

  it('normalizes the post-write refetch to the canonical on-disk shape (drops non-whitelisted API fields)', async () => {
    mockUpdatePageSettings.mockResolvedValue(undefined);
    mockGetPageMetadata.mockResolvedValue(makeApiPage());

    const files: ConnectorFile[] = [
      { id: 'page-1', seo: { title: 'x', description: 'y' } } as unknown as ConnectorFile,
    ];

    const result = await connector.updateRecords(pagesTableSpec, files);

    // The returned record is built from the refetch via the same normalizer as
    // pullPages — whitelisted fields only, in the same order as a fresh pull.
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'page-1',
      title: 'About Us',
      slug: 'about-us',
      publishedPath: '/about-us',
      parentId: 'parent-1',
      archived: false,
      draft: false,
      seo: { title: 'About Us — SEO', description: 'SEO description' },
      openGraph: {
        title: 'About Us — OG',
        titleCopied: false,
        description: 'OG description',
        descriptionCopied: false,
      },
      createdOn: '2024-01-01T00:00:00.000Z',
      lastUpdated: '2024-02-01T00:00:00.000Z',
    });
    // Extras the API returns but we never persist.
    expect(result[0]).not.toHaveProperty('siteId');
    expect(result[0]).not.toHaveProperty('collectionId');
    expect(result[0]).not.toHaveProperty('canBranch');
    expect(result[0]).not.toHaveProperty('localeId');
    // Refetched truth, not the input — so titleCopied overrides etc. round-trip.
    expect(mockGetPageMetadata).toHaveBeenCalledWith('page-1');
  });

  it('sends only the changed SEO sub-object when changedFields scopes the edit', async () => {
    mockUpdatePageSettings.mockResolvedValue(undefined);
    mockGetPageMetadata.mockResolvedValue(makeApiPage());

    const files: ConnectorFile[] = [
      {
        id: 'page-1',
        title: 'About Us',
        slug: 'about-us',
        seo: { title: 'Edited SEO Title', description: 'SEO description' },
      } as unknown as ConnectorFile,
    ];
    // Only seo changed — title/slug/openGraph must NOT be dragged into the PUT.
    const changedFields: (Record<string, unknown> | undefined)[] = [
      { seo: { title: 'Edited SEO Title', description: 'SEO description' } },
    ];

    await connector.updateRecords(pagesTableSpec, files, changedFields);

    expect(mockUpdatePageSettings).toHaveBeenCalledWith('page-1', {
      seo: { title: 'Edited SEO Title', description: 'SEO description' },
    });
  });

  // DEV-10597: editing a read-only page field (publishedPath, parentId, draft, …)
  // is a genuine read-only edit — surface it instead of silently no-op'ing while
  // reporting success.
  it('throws when only a read-only field changed, and does not call the API', async () => {
    const files: ConnectorFile[] = [{ id: 'page-1', title: 'About Us' } as unknown as ConnectorFile];
    const changedFields: (Record<string, unknown> | undefined)[] = [{ publishedPath: '/changed' }];

    await expect(connector.updateRecords(pagesTableSpec, files, changedFields)).rejects.toThrow(
      /"publishedPath" is read-only/,
    );
    expect(mockUpdatePageSettings).not.toHaveBeenCalled();
    expect(mockGetPageMetadata).not.toHaveBeenCalled();
  });

  it('processes multiple pages in input order', async () => {
    mockUpdatePageSettings.mockResolvedValue(undefined);
    mockGetPageMetadata.mockImplementation((pageId: string) =>
      Promise.resolve(makeApiPage({ id: pageId, title: `Title ${pageId}` })),
    );

    const files: ConnectorFile[] = [
      { id: 'page-a', seo: { title: 'A' } } as unknown as ConnectorFile,
      { id: 'page-b', seo: { title: 'B' } } as unknown as ConnectorFile,
    ];

    const result = await connector.updateRecords(pagesTableSpec, files);

    expect(mockUpdatePageSettings).toHaveBeenNthCalledWith(1, 'page-a', { seo: { title: 'A' } });
    expect(mockUpdatePageSettings).toHaveBeenNthCalledWith(2, 'page-b', { seo: { title: 'B' } });
    expect(result.map((f) => f.id)).toEqual(['page-a', 'page-b']);
  });
});
