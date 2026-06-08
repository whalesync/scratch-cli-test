import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, idPath } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockUpdatePage = jest.fn();

// Mock the api-client so the connector's `this.client` is the mock. Real error
// classes / constants are kept via requireActual (the connector imports them).
jest.mock('../notion-api-client', () => ({
  ...jest.requireActual<typeof import('../notion-api-client')>('../notion-api-client'),
  NotionApiClient: jest.fn().mockImplementation(() => ({
    updatePage: mockUpdatePage,
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

describe('NotionConnector.deleteRecords', () => {
  let connector: NotionConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdatePage.mockResolvedValue(undefined);
    connector = new NotionConnector('fake-key');
  });

  // DEV-10268 (Notion API 2026-03-11): deletes must soft-delete via `in_trash: true`,
  // the successor to the now-deprecated `archived: true`.
  it('moves the page to trash with in_trash: true (not the deprecated archived)', async () => {
    const files: ConnectorFile[] = [{ id: 'page_1' }];

    await connector.deleteRecords(buildTableSpec(), files);

    expect(mockUpdatePage).toHaveBeenCalledTimes(1);
    const [callArg] = mockUpdatePage.mock.calls[0] as [Record<string, unknown>];
    expect(callArg).toEqual({ page_id: 'page_1', in_trash: true });
    // The deprecated 2025-09-03 field must not be sent.
    expect(callArg).not.toHaveProperty('archived');
  });

  it('trashes every file passed in', async () => {
    const files: ConnectorFile[] = [{ id: 'page_1' }, { id: 'page_2' }, { id: 'page_3' }];

    await connector.deleteRecords(buildTableSpec(), files);

    expect(mockUpdatePage).toHaveBeenCalledTimes(3);
    const calls = mockUpdatePage.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls.map((call) => call[0])).toEqual([
      { page_id: 'page_1', in_trash: true },
      { page_id: 'page_2', in_trash: true },
      { page_id: 'page_3', in_trash: true },
    ]);
  });
});
