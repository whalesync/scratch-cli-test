// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockSearch = jest.fn();
const mockRetrievePage = jest.fn();

// Mock the api-client so the connector's `this.client` is the mock. Real error
// classes / constants are kept via requireActual (the connector imports them).
jest.mock('../notion-api-client', () => ({
  ...jest.requireActual<typeof import('../notion-api-client')>('../notion-api-client'),
  NotionApiClient: jest.fn().mockImplementation(() => ({
    search: mockSearch,
    retrievePage: mockRetrievePage,
  })),
}));

jest.mock('turndown', () =>
  jest.fn().mockImplementation(() => ({
    addRule: jest.fn().mockReturnThis(),
    turndown: jest.fn(() => ''),
  })),
);

import { NotionApiErrorCode, NotionError } from '../notion-api-client';
import { NotionConnector, titleContainsEveryWord } from '../notion-connector';

describe('NotionConnector.listCreateDestinations', () => {
  let connector: NotionConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new NotionConnector('fake-key');
  });

  it('searches for pages and returns them as { id, name } create destinations', async () => {
    mockSearch.mockResolvedValue({
      results: [
        {
          object: 'page',
          id: 'page_1',
          properties: { Name: { type: 'title', title: [{ plain_text: 'Engineering' }] } },
        },
        {
          object: 'page',
          id: 'page_2',
          properties: { Title: { type: 'title', title: [{ plain_text: 'Marketing' }] } },
        },
      ],
      has_more: false,
    });

    const destinations = await connector.listCreateDestinations();

    expect(mockSearch).toHaveBeenCalledWith({
      filter: { property: 'object', value: 'page' },
      page_size: 100,
    });
    expect(destinations).toEqual([
      { id: 'page_1', name: 'Engineering', created: true },
      { id: 'page_2', name: 'Marketing', created: true },
    ]);
  });

  it('falls back to the page id when a page has no title and drops non-page results', async () => {
    mockSearch.mockResolvedValue({
      results: [
        { object: 'page', id: 'page_untitled', properties: {} },
        // A data_source result (no `properties`) must be filtered out.
        { object: 'data_source', id: 'ds_1' },
      ],
      has_more: false,
    });

    const destinations = await connector.listCreateDestinations();

    expect(destinations).toEqual([{ id: 'page_untitled', name: 'page_untitled', created: true }]);
  });
});

describe('NotionConnector.searchCreateDestinations', () => {
  let connector: NotionConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new NotionConnector('fake-key');
  });

  it('searches pages by term and passes through hasMore', async () => {
    mockSearch.mockResolvedValue({
      results: [
        {
          object: 'page',
          id: 'page_1',
          properties: { Name: { type: 'title', title: [{ plain_text: 'Engineering' }] } },
        },
      ],
      has_more: true,
    });

    const result = await connector.searchCreateDestinations('eng');

    expect(mockSearch).toHaveBeenCalledWith({
      query: 'eng',
      filter: { property: 'object', value: 'page' },
      page_size: 100,
    });
    expect(result).toEqual({ destinations: [{ id: 'page_1', name: 'Engineering', created: true }], hasMore: true });
  });

  it('omits the query for an empty term, mirroring the list endpoint', async () => {
    mockSearch.mockResolvedValue({ results: [], has_more: false });

    const result = await connector.searchCreateDestinations('   ');

    expect(mockSearch).toHaveBeenCalledWith({
      filter: { property: 'object', value: 'page' },
      page_size: 100,
    });
    expect(result).toEqual({ destinations: [], hasMore: false });
  });

  const page = (id: string, title: string): object => ({
    object: 'page',
    id,
    properties: { Name: { type: 'title', title: [{ plain_text: title }] } },
  });

  it("ranks title matches ahead of Notion's fuzzy extras, keeping Notion's order within each group", async () => {
    mockSearch.mockResolvedValue({
      results: [
        page('p1', 'Action items'),
        page('p2', 'Export to Attio'),
        page('p3', 'Ratio analysis'),
        page('p4', 'attio crm notes'),
      ],
      has_more: true,
    });

    const result = await connector.searchCreateDestinations('Attio');

    expect(result.destinations.map((destination) => destination.id)).toEqual(['p2', 'p4', 'p1', 'p3']);
    expect(result.hasMore).toBe(true);
  });

  it('matches every word of a multi-word term in any order', async () => {
    mockSearch.mockResolvedValue({
      results: [page('p1', 'Export log'), page('p2', 'Attio CRM'), page('p3', 'Export to Attio')],
      has_more: false,
    });

    const result = await connector.searchCreateDestinations('attio export');

    expect(result.destinations.map((destination) => destination.id)).toEqual(['p3', 'p1', 'p2']);
  });

  it("keeps Notion's fuzzy results, in Notion's order, when no title contains the term (e.g. a typo)", async () => {
    mockSearch.mockResolvedValue({
      results: [page('p1', 'Attio CRM'), page('p2', 'Attio notes')],
      has_more: false,
    });

    const result = await connector.searchCreateDestinations('Atio');

    expect(result.destinations.map((destination) => destination.id)).toEqual(['p1', 'p2']);
  });
});

describe('titleContainsEveryWord', () => {
  it('is case-insensitive and order-independent', () => {
    expect(titleContainsEveryWord('Export to Attio', 'attio EXPORT')).toBe(true);
    expect(titleContainsEveryWord('Export to Attio', 'attio crm')).toBe(false);
  });

  it('treats an empty or whitespace term as matching everything', () => {
    expect(titleContainsEveryWord('Anything', '')).toBe(true);
    expect(titleContainsEveryWord('Anything', '  \t ')).toBe(true);
  });
});

describe('NotionConnector.lookupCreateDestination', () => {
  let connector: NotionConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new NotionConnector('fake-key');
  });

  it('resolves a page by id to a { id, name } destination', async () => {
    mockRetrievePage.mockResolvedValue({
      object: 'page',
      id: 'page_1',
      properties: { Name: { type: 'title', title: [{ plain_text: 'Engineering' }] } },
    });

    const destination = await connector.lookupCreateDestination('page_1');

    expect(mockRetrievePage).toHaveBeenCalledWith({ page_id: 'page_1' });
    expect(destination).toEqual({ id: 'page_1', name: 'Engineering', created: true });
  });

  it('maps object_not_found to null (deleted / inaccessible page)', async () => {
    mockRetrievePage.mockRejectedValue(
      new NotionError({ code: NotionApiErrorCode.ObjectNotFound, message: 'Not found', status: 404 }),
    );

    const destination = await connector.lookupCreateDestination('page_gone');

    expect(destination).toBeNull();
  });

  it('maps restricted_resource to null (reauthorized into a different account)', async () => {
    mockRetrievePage.mockRejectedValue(
      new NotionError({ code: NotionApiErrorCode.RestrictedResource, message: 'Restricted', status: 403 }),
    );

    const destination = await connector.lookupCreateDestination('page_restricted');

    expect(destination).toBeNull();
  });

  it('rethrows transport/server errors so the caller keeps the saved id', async () => {
    mockRetrievePage.mockRejectedValue(
      new NotionError({ code: NotionApiErrorCode.ServiceUnavailable, message: 'Down', status: 503 }),
    );

    await expect(connector.lookupCreateDestination('page_1')).rejects.toThrow('Down');
  });
});
