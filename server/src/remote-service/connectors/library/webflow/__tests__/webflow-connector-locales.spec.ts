import { BaseJsonTableSpec, ConnectorFile, TablePreview } from '../../../types';
import { WebflowConnector } from '../webflow-connector';

// Mock display-names to break the circular import chain (it imports all connectors).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Mock the WebflowApiClient so `this.client` is fully controllable.
const mockListSites = jest.fn();
const mockListCollections = jest.fn();
const mockGetSite = jest.fn();
const mockListCollectionItems = jest.fn();
const mockGetCollectionItem = jest.fn();
const mockUpdateItemsLive = jest.fn();
const mockCreateItemsLive = jest.fn();
const mockDeleteItemsLive = jest.fn();
const mockDeleteItems = jest.fn();

jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => ({
    listSites: mockListSites,
    listCollections: mockListCollections,
    getSite: mockGetSite,
    listCollectionItems: mockListCollectionItems,
    getCollectionItem: mockGetCollectionItem,
    updateItemsLive: mockUpdateItemsLive,
    createItemsLive: mockCreateItemsLive,
    deleteItemsLive: mockDeleteItemsLive,
    deleteItems: mockDeleteItems,
  })),
  WebflowError: class WebflowError extends Error {},
}));

jest.mock('src/wrappers/html-minify', () => ({
  minifyHtml: jest.fn((input: string) => Promise.resolve(input)),
}));

const SITE_WITH_LOCALES = {
  id: 'site-1',
  displayName: 'My Site',
  locales: {
    primary: { cmsLocaleId: 'cms-en', displayName: 'English' },
    secondary: [
      { cmsLocaleId: 'cms-es', displayName: 'Spanish (Spain)', enabled: true },
      { cmsLocaleId: 'cms-fr', displayName: 'French', enabled: true },
      { cmsLocaleId: 'cms-de', displayName: 'German (disabled)', enabled: false },
    ],
  },
};

function localeTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'col1_cms_es', remoteId: ['site-1', 'col-1', 'cms-es'] },
    schema: { properties: { fieldData: { properties: { name: { type: 'string' } } } } },
  } as unknown as BaseJsonTableSpec;
}

describe('WebflowConnector — secondary locales (DEV-10529)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('listTables', () => {
    it('emits one extra table per ENABLED secondary locale, nested under the primary collection', async () => {
      mockListSites.mockResolvedValue({ sites: [SITE_WITH_LOCALES] });
      mockListCollections.mockResolvedValue({
        collections: [{ id: 'col-1', displayName: 'Blog Posts', slug: 'blog' }],
      });

      const connector = new WebflowConnector('token', { structureVersion: 2 });
      const tables = await connector.listTables();

      const localeTables = tables.filter((t: TablePreview) => t.id.remoteId.length === 3);
      expect(localeTables.map((t) => t.id.remoteId[2]).sort()).toEqual(['cms-es', 'cms-fr']);
      // The disabled locale (cms-de) is excluded.
      expect(localeTables.map((t) => t.id.remoteId[2])).not.toContain('cms-de');

      const es = localeTables.find((t) => t.id.remoteId[2] === 'cms-es');
      expect(es?.displayName).toBe('Spanish (Spain)');
      expect(es?.parentPath).toBe('My Site/Collections/Blog Posts');
      expect(es?.disabledCreates).toBe(true);
      expect(es?.disabledDeletes).toBe(true);

      // The primary collection table is still present and unchanged (2-element id).
      expect(tables.some((t) => t.id.remoteId.length === 2 && t.id.remoteId[1] === 'col-1')).toBe(true);
      // getSite is not called when listSites already carries locales.
      expect(mockGetSite).not.toHaveBeenCalled();
    });

    it('falls back to getSite when listSites omits locales entirely', async () => {
      mockListSites.mockResolvedValue({ sites: [{ id: 'site-1', displayName: 'My Site' }] });
      mockListCollections.mockResolvedValue({ collections: [{ id: 'col-1', displayName: 'Blog Posts' }] });
      mockGetSite.mockResolvedValue(SITE_WITH_LOCALES);

      const connector = new WebflowConnector('token', { structureVersion: 2 });
      const tables = await connector.listTables();

      expect(mockGetSite).toHaveBeenCalledWith('site-1');
      expect(tables.filter((t) => t.id.remoteId.length === 3)).toHaveLength(2);
    });

    it('falls back to getSite when listSites returns a partial locales (primary but no secondary array)', async () => {
      // The robustness case: listSites may truncate `locales` to just `primary`;
      // getSite carries the full secondary list.
      mockListSites.mockResolvedValue({
        sites: [{ id: 'site-1', displayName: 'My Site', locales: { primary: { cmsLocaleId: 'cms-en' } } }],
      });
      mockListCollections.mockResolvedValue({ collections: [{ id: 'col-1', displayName: 'Blog Posts' }] });
      mockGetSite.mockResolvedValue(SITE_WITH_LOCALES);

      const connector = new WebflowConnector('token', { structureVersion: 2 });
      const tables = await connector.listTables();

      expect(mockGetSite).toHaveBeenCalledWith('site-1');
      expect(tables.filter((t) => t.id.remoteId.length === 3)).toHaveLength(2);
    });

    it('trusts an explicit empty secondary array without an extra getSite', async () => {
      mockListSites.mockResolvedValue({
        sites: [
          { id: 'site-1', displayName: 'My Site', locales: { primary: { cmsLocaleId: 'cms-en' }, secondary: [] } },
        ],
      });
      mockListCollections.mockResolvedValue({ collections: [{ id: 'col-1', displayName: 'Blog Posts' }] });

      const connector = new WebflowConnector('token', { structureVersion: 2 });
      const tables = await connector.listTables();

      expect(tables.filter((t) => t.id.remoteId.length === 3)).toHaveLength(0);
      expect(mockGetSite).not.toHaveBeenCalled();
    });
  });

  describe('pullRecordFiles', () => {
    it('passes the cmsLocaleId to listCollectionItems for a locale table', async () => {
      mockListCollectionItems.mockResolvedValue({
        items: [{ id: 'i1', cmsLocaleId: 'cms-es', fieldData: { name: 'Hola' } }],
        pagination: { total: 1, offset: 0, limit: 100 },
      });
      const connector = new WebflowConnector('token', { structureVersion: 2 });

      const pulled: ConnectorFile[] = [];
      const collect = ({ files }: { files: ConnectorFile[] }): Promise<void> => {
        pulled.push(...files);
        return Promise.resolve();
      };
      await connector.pullRecordFiles(localeTableSpec(), collect, {}, { pullMode: 'full' } as never);

      expect(mockListCollectionItems).toHaveBeenCalledWith('col-1', expect.objectContaining({ cmsLocaleId: 'cms-es' }));
      expect(pulled).toHaveLength(1);
    });
  });

  describe('updateRecords', () => {
    it('stamps each item with the locale cmsLocaleId so the edit targets that locale', async () => {
      mockUpdateItemsLive.mockResolvedValue({ items: [{ id: 'i1', cmsLocaleId: 'cms-es', fieldData: {} }] });
      const connector = new WebflowConnector('token', { structureVersion: 2 });

      await connector.updateRecords(localeTableSpec(), [{ id: 'i1', fieldData: { name: 'Hola' } } as ConnectorFile]);

      expect(mockUpdateItemsLive).toHaveBeenCalledWith('col-1', {
        skipInvalidFiles: false,
        items: [{ id: 'i1', cmsLocaleId: 'cms-es', fieldData: { name: 'Hola' } }],
      });
    });

    it('does NOT add cmsLocaleId for a primary (2-element) table', async () => {
      mockUpdateItemsLive.mockResolvedValue({ items: [{ id: 'i1', fieldData: {} }] });
      const connector = new WebflowConnector('token', { structureVersion: 2 });
      const primarySpec = {
        id: { wsId: 'col1', remoteId: ['site-1', 'col-1'] },
        schema: { properties: { fieldData: { properties: { name: { type: 'string' } } } } },
      } as unknown as BaseJsonTableSpec;

      await connector.updateRecords(primarySpec, [{ id: 'i1', fieldData: { name: 'Hi' } } as ConnectorFile]);

      // The sent item has no cmsLocaleId key at all for a primary table.
      expect(mockUpdateItemsLive).toHaveBeenCalledWith('col-1', {
        skipInvalidFiles: false,
        items: [{ id: 'i1', fieldData: { name: 'Hi' } }],
      });
    });
  });

  describe('create/delete guards', () => {
    it('createRecords rejects on a secondary-locale table', async () => {
      const connector = new WebflowConnector('token', { structureVersion: 2 });
      await expect(connector.createRecords(localeTableSpec(), [{ fieldData: {} } as ConnectorFile])).rejects.toThrow(
        /secondary Webflow locale/i,
      );
      expect(mockCreateItemsLive).not.toHaveBeenCalled();
    });

    it('deleteRecords rejects on a secondary-locale table', async () => {
      const connector = new WebflowConnector('token', { structureVersion: 2 });
      await expect(connector.deleteRecords(localeTableSpec(), [{ id: 'i1' } as ConnectorFile])).rejects.toThrow(
        /secondary Webflow locale/i,
      );
      expect(mockDeleteItemsLive).not.toHaveBeenCalled();
      expect(mockDeleteItems).not.toHaveBeenCalled();
    });
  });
});
