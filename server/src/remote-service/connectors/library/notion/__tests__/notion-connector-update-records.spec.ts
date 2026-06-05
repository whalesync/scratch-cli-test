import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, idPath } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockUpdatePage = jest.fn();
const mockRetrievePage = jest.fn();
const mockListBlockChildren = jest.fn();

// Mock the api-client so the connector's `this.client` is the mock. Real error
// classes / constants are kept via requireActual (the connector imports them).
jest.mock('../notion-api-client', () => ({
  ...jest.requireActual<typeof import('../notion-api-client')>('../notion-api-client'),
  NotionApiClient: jest.fn().mockImplementation(() => ({
    updatePage: mockUpdatePage,
    retrievePage: mockRetrievePage,
    listBlockChildren: mockListBlockChildren,
  })),
}));

jest.mock('turndown', () =>
  jest.fn().mockImplementation(() => ({
    addRule: jest.fn().mockReturnThis(),
    turndown: jest.fn(() => ''),
  })),
);

import { NotionConnector } from '../notion-connector';

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'db', remoteId: ['db_123'] },
    slug: 'db',
    name: 'db',
    idColumnRemoteId: idPath('id'),
    schema: {} as unknown as TSchema,
  };
}

describe('NotionConnector.updateRecords', () => {
  let connector: NotionConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdatePage.mockResolvedValue(undefined);
    // updateRecords refetches via pages.retrieve + blocks.children.list after a
    // successful write so the returned ConnectorFile is byte-equal to a fresh
    // pull. Tests that don't care about the refetch shape just need both calls
    // to resolve to something benign.
    mockRetrievePage.mockImplementation(({ page_id }: { page_id: string }) =>
      Promise.resolve({ object: 'page', id: page_id, properties: {} }),
    );
    mockListBlockChildren.mockResolvedValue({ results: [], has_more: false, next_cursor: null });
    connector = new NotionConnector('fake-key');
  });

  // DEV-10125: sparse changedFields lacks each property's `type` wrapper, so the
  // RO-type check (formula/rollup/created_time/etc.) must look up the type from
  // the *full file*, not from changedFields. Otherwise a formula property that
  // appears in changedFields (e.g. due to a recompute) would leak through to
  // Notion's update API and trigger a 4xx.
  it('strips read-only property types using types looked up from the full file', async () => {
    const files: ConnectorFile[] = [
      {
        id: 'page_1',
        properties: {
          Title: { id: 'pid_a', type: 'title', title: [{ plain_text: 'Old' }] },
          Score: { id: 'pid_b', type: 'formula', formula: { type: 'number', number: 42 } },
        },
      },
    ];
    // Both Title and Score appear changed. Score is a formula (RO) — must not be sent.
    const changedFields: Record<string, unknown>[] = [
      {
        properties: {
          Title: { title: [{ plain_text: 'New' }] },
          Score: { formula: { type: 'number', number: 99 } },
        },
      },
    ];

    await connector.updateRecords(buildTableSpec(), files, changedFields);

    expect(mockUpdatePage).toHaveBeenCalledTimes(1);
    const [callArg] = mockUpdatePage.mock.calls[0] as [{ page_id: string; properties: Record<string, unknown> }];
    expect(callArg.page_id).toBe('page_1');
    // Only Title should reach the API; Score (formula) must be stripped.
    expect(Object.keys(callArg.properties)).toEqual(['Title']);
    expect(callArg.properties.Title).toEqual({ title: [{ plain_text: 'New' }] });
  });

  it('skips the API call entirely when only read-only properties changed', async () => {
    const files: ConnectorFile[] = [
      {
        id: 'page_1',
        properties: {
          Score: { id: 'pid_b', type: 'formula', formula: { type: 'number', number: 42 } },
        },
      },
    ];
    const changedFields: Record<string, unknown>[] = [
      { properties: { Score: { formula: { type: 'number', number: 99 } } } },
    ];

    const result = await connector.updateRecords(buildTableSpec(), files, changedFields);

    expect(mockUpdatePage).not.toHaveBeenCalled();
    // No write → no refetch. Skipped rows pass the input file through verbatim.
    expect(mockRetrievePage).not.toHaveBeenCalled();
    expect(result[0]).toBe(files[0]);
  });

  it('returns the refetched page (not the input file) for rows that were actually updated', async () => {
    const files: ConnectorFile[] = [
      {
        id: 'page_1',
        properties: {
          Title: { id: 'pid_a', type: 'title', title: [{ plain_text: 'Old' }] },
        },
        // page_content present on the input to simulate what pull would have written.
        page_content: [{ id: 'block_stale', type: 'paragraph' }],
      },
    ];
    const changedFields: Record<string, unknown>[] = [{ properties: { Title: { title: [{ plain_text: 'New' }] } } }];

    // Refetch returns the server-canonical page (server-normalized Title, new
    // last_edited_time, etc.) and refetched page_content. updateRecords must
    // surface this — not the input file — so the post-publish commit is
    // byte-equal to what a fresh pull would produce.
    mockRetrievePage.mockResolvedValueOnce({
      object: 'page',
      id: 'page_1',
      properties: {
        Title: { id: 'pid_a', type: 'title', title: [{ plain_text: 'New', annotations: {} }] },
      },
      last_edited_time: '2026-06-01T18:00:00.000Z',
    });
    mockListBlockChildren.mockResolvedValueOnce({
      results: [{ id: 'block_fresh', type: 'paragraph', has_children: false }],
      has_more: false,
      next_cursor: null,
    });

    const [result] = await connector.updateRecords(buildTableSpec(), files, changedFields);

    expect(mockUpdatePage).toHaveBeenCalledTimes(1);
    expect(mockRetrievePage).toHaveBeenCalledWith({ page_id: 'page_1' });
    expect(result).not.toBe(files[0]);
    expect((result as { last_edited_time?: string }).last_edited_time).toBe('2026-06-01T18:00:00.000Z');
    expect((result as { page_content?: { id: string }[] }).page_content?.[0]?.id).toBe('block_fresh');
  });
});
