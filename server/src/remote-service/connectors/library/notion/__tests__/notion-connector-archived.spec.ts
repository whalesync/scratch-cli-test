import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, dotPath, PullRecordFilesOptions } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockQueryDataSource = jest.fn();
const mockRetrievePage = jest.fn();
const mockUpdatePage = jest.fn();

// Mock the api-client so the connector's `this.client` is the mock. Real error
// classes / constants are kept via requireActual (the connector imports them).
jest.mock('../notion-api-client', () => ({
  ...jest.requireActual<typeof import('../notion-api-client')>('../notion-api-client'),
  NotionApiClient: jest.fn().mockImplementation(() => ({
    queryDataSource: mockQueryDataSource,
    retrievePage: mockRetrievePage,
    updatePage: mockUpdatePage,
  })),
}));

jest.mock('turndown', () =>
  jest.fn().mockImplementation(() => ({
    addRule: jest.fn().mockReturnThis(),
    turndown: jest.fn(() => ''),
  })),
);

import { isArchivedOrTrashedNotionPage, NotionConnector } from '../notion-connector';

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'db', remoteId: ['db_123', 'ds_123'] },
    slug: 'db',
    name: 'db',
    idPath: dotPath('id'),
    schema: {} as unknown as TSchema,
  };
}

function pulledPageIds(callback: jest.Mock): string[] {
  return callback.mock.calls.flatMap(([{ files }]: [{ files: ConnectorFile[] }]) =>
    files.map((f) => f['id'] as string),
  );
}

/** A single writable (title) property change, so `updateRecords` issues a PATCH. */
function titleChange(text: string): Record<string, unknown> {
  return {
    properties: {
      Name: { type: 'title', id: 'title', title: [{ type: 'text', text: { content: text }, plain_text: text }] },
    },
  };
}

function lastUpdatePageBody(): Record<string, unknown> {
  const [args] = mockUpdatePage.mock.calls[mockUpdatePage.mock.calls.length - 1] as [Record<string, unknown>];
  return args;
}

describe('isArchivedOrTrashedNotionPage', () => {
  it('is true when any of the legacy/renamed archive/trash flags is set', () => {
    expect(isArchivedOrTrashedNotionPage({ archived: true })).toBe(true);
    expect(isArchivedOrTrashedNotionPage({ in_trash: true })).toBe(true);
    expect(isArchivedOrTrashedNotionPage({ is_archived: true })).toBe(true);
  });

  it('is false for a live page (all flags absent or false)', () => {
    expect(isArchivedOrTrashedNotionPage({})).toBe(false);
    expect(isArchivedOrTrashedNotionPage({ archived: false, in_trash: false, is_archived: false })).toBe(false);
  });
});

describe('NotionConnector.pullRecordFiles — archived pages kept verbatim (DEV-10957)', () => {
  let connector: NotionConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new NotionConnector('fake-key');
  });

  it('does not skip archived pages — they stay paired so a later sync can unarchive-and-update', async () => {
    mockQueryDataSource.mockResolvedValue({
      results: [
        { object: 'page', id: 'live_1', last_edited_time: '2026-05-14T13:00:00.000Z' },
        { object: 'page', id: 'legacy_archived', archived: true },
        { object: 'page', id: 'archived', is_archived: true },
        { object: 'page', id: 'live_2' },
      ],
      has_more: false,
      next_cursor: null,
    });

    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, {
      pullMode: 'full',
      excludePageContent: true,
    } as PullRecordFilesOptions);

    expect(pulledPageIds(callback)).toEqual(['live_1', 'legacy_archived', 'archived', 'live_2']);
  });
});

describe('NotionConnector.updateRecords — unarchive-and-update archived pages (DEV-10957)', () => {
  let connector: NotionConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdatePage.mockResolvedValue({ object: 'page', id: 'pg', properties: {} });
    mockRetrievePage.mockImplementation(({ page_id }: { page_id: string }) =>
      Promise.resolve({ object: 'page', id: page_id, properties: {} }),
    );
    connector = new NotionConnector('fake-key');
  });

  it('folds is_archived: false into the same PATCH for a page pulled as archived', async () => {
    const file = { id: 'pg', is_archived: true, properties: {} } as ConnectorFile;

    await connector.updateRecords(buildTableSpec(), [file], [titleChange('New')]);

    const body = lastUpdatePageBody();
    expect(body).toMatchObject({ page_id: 'pg', is_archived: false });
    expect(body).toHaveProperty('properties.Name');
    expect(body).not.toHaveProperty('archived');
    expect(body).not.toHaveProperty('in_trash');
  });

  it('clears every archive flag the record carries (both spellings, in case a user sees either)', async () => {
    const file = { id: 'pg', archived: true, is_archived: true, properties: {} } as ConnectorFile;

    await connector.updateRecords(buildTableSpec(), [file], [titleChange('New')]);

    const body = lastUpdatePageBody();
    expect(body).toMatchObject({ page_id: 'pg', archived: false, is_archived: false });
  });

  it('sends no archive flags for a live (non-archived) page', async () => {
    const file = { id: 'pg', is_archived: false, properties: {} } as ConnectorFile;

    await connector.updateRecords(buildTableSpec(), [file], [titleChange('New')]);

    const body = lastUpdatePageBody();
    expect(body).not.toHaveProperty('archived');
    expect(body).not.toHaveProperty('in_trash');
    expect(body).not.toHaveProperty('is_archived');
  });
});
