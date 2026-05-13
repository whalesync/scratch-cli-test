import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockPagesUpdate = jest.fn();

jest.mock('@notionhq/client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    pages: { update: mockPagesUpdate },
  })),
  APIResponseError: class extends Error {},
  RequestTimeoutError: { isRequestTimeoutError: jest.fn(() => false) },
  APIErrorCode: {},
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
    idColumnRemoteId: 'id',
    schema: {} as unknown as TSchema,
  };
}

describe('NotionConnector.updateRecords', () => {
  let connector: NotionConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPagesUpdate.mockResolvedValue(undefined);
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

    expect(mockPagesUpdate).toHaveBeenCalledTimes(1);
    const [callArg] = mockPagesUpdate.mock.calls[0] as [{ page_id: string; properties: Record<string, unknown> }];
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

    await connector.updateRecords(buildTableSpec(), files, changedFields);

    expect(mockPagesUpdate).not.toHaveBeenCalled();
  });
});
