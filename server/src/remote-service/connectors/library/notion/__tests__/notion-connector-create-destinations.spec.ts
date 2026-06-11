// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockSearch = jest.fn();

// Mock the api-client so the connector's `this.client` is the mock. Real error
// classes / constants are kept via requireActual (the connector imports them).
jest.mock('../notion-api-client', () => ({
  ...jest.requireActual<typeof import('../notion-api-client')>('../notion-api-client'),
  NotionApiClient: jest.fn().mockImplementation(() => ({
    search: mockSearch,
  })),
}));

jest.mock('turndown', () =>
  jest.fn().mockImplementation(() => ({
    addRule: jest.fn().mockReturnThis(),
    turndown: jest.fn(() => ''),
  })),
);

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
      { id: 'page_1', name: 'Engineering' },
      { id: 'page_2', name: 'Marketing' },
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

    expect(destinations).toEqual([{ id: 'page_untitled', name: 'page_untitled' }]);
  });
});
