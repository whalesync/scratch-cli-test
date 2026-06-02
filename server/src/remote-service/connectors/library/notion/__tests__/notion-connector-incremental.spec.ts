import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, PullRecordFilesOptions, idPath } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockDataSourcesQuery = jest.fn();

jest.mock('@notionhq/client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    dataSources: { query: mockDataSourcesQuery },
  })),
  APIResponseError: class extends Error {},
  RequestTimeoutError: { isRequestTimeoutError: jest.fn(() => false) },
  APIErrorCode: {},
  isFullDatabase: jest.fn(() => true),
  isFullDataSource: jest.fn(() => true),
}));

jest.mock('turndown', () =>
  jest.fn().mockImplementation(() => ({
    addRule: jest.fn().mockReturnThis(),
    turndown: jest.fn(() => ''),
  })),
);

import { NotionConnector } from '../notion-connector';
import { buildNotionLastEditedFilter } from '../notion-incremental';

function buildTableSpec(): BaseJsonTableSpec {
  // remoteId is `[databaseId, dataSourceId]` after the Phase 2 backfill —
  // exercising the post-backfill path here avoids invoking the connector's
  // resolveDataSourceId fallback (which would hit the unmocked databases.retrieve).
  return {
    id: { wsId: 'db', remoteId: ['db_123', 'ds_123'] },
    slug: 'db',
    name: 'db',
    idColumnRemoteId: idPath('id'),
    schema: {} as unknown as TSchema,
  };
}

function lastQueryFilter(): unknown {
  const [args] = mockDataSourcesQuery.mock.calls[0] as [{ filter?: unknown }];
  return args.filter;
}

function lastQueryDataSourceId(): string {
  const [args] = mockDataSourcesQuery.mock.calls[0] as [{ data_source_id: string }];
  return args.data_source_id;
}

describe('NotionConnector.supportsIncrementalPull', () => {
  it('is always true — every Notion page has a server-side last_edited_time', () => {
    const connector = new NotionConnector('fake-key');
    expect(connector.supportsIncrementalPull({} as PullRecordFilesOptions, buildTableSpec())).toBe(true);
  });
});

describe('NotionConnector.pullRecordFiles (incremental)', () => {
  let connector: NotionConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockDataSourcesQuery.mockResolvedValue({
      results: [{ object: 'page', id: 'page_1', last_edited_time: '2026-05-14T13:00:00.000Z' }],
      has_more: false,
      next_cursor: null,
    });
    connector = new NotionConnector('fake-key');
  });

  it('runs a full pull and returns {} when pullMode is not incremental', async () => {
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, {
      pullMode: 'full',
      excludePageContent: true,
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(lastQueryFilter()).toBeUndefined();
    expect(lastQueryDataSourceId()).toBe('ds_123');
  });

  it('injects the last_edited_time filter and returns a newWatermark when incremental', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const options = { pullMode: 'incremental', since, excludePageContent: true } as PullRecordFilesOptions;

    const before = Date.now();
    const result = await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, options);
    const after = Date.now();

    expect(lastQueryFilter()).toEqual(buildNotionLastEditedFilter(since));
    expect(result.newWatermark).toBeInstanceOf(Date);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
  });

  it('AND-combines a simple user filter with the incremental timestamp filter', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const userFilter = { property: 'Status', checkbox: { equals: true } };
    const options = {
      pullMode: 'incremental',
      since,
      excludePageContent: true,
      filter: JSON.stringify(userFilter),
    } as PullRecordFilesOptions;

    const result = await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, options);

    expect(lastQueryFilter()).toEqual({ and: [userFilter, buildNotionLastEditedFilter(since)] });
    expect(result.newWatermark).toBeInstanceOf(Date);
  });

  it('demotes to full (keeps user filter, no watermark) when the user filter is a compound and/or', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const userFilter = { and: [{ property: 'A', checkbox: { equals: true } }] };
    const options = {
      pullMode: 'incremental',
      since,
      excludePageContent: true,
      filter: JSON.stringify(userFilter),
    } as PullRecordFilesOptions;

    const result = await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, options);

    // The incremental timestamp filter is NOT applied — the raw user filter is
    // passed through unchanged and no watermark is returned.
    expect(lastQueryFilter()).toEqual(userFilter);
    expect(result).toEqual({});
  });
});
