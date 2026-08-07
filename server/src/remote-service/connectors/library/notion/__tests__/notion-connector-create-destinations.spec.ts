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
import { NotionConnector } from '../notion-connector';

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
