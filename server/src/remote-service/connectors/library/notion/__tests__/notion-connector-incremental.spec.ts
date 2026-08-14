import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, PullRecordFilesOptions, dotPath } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockQueryDataSource = jest.fn();

// Mock the api-client so the connector's `this.client` is the mock. Real error
// classes / constants are kept via requireActual (the connector imports them).
jest.mock('../notion-api-client', () => ({
  ...jest.requireActual<typeof import('../notion-api-client')>('../notion-api-client'),
  NotionApiClient: jest.fn().mockImplementation(() => ({
    queryDataSource: mockQueryDataSource,
  })),
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
    idPath: dotPath('id'),
    schema: {} as unknown as TSchema,
  };
}

function lastQueryFilter(): unknown {
  const [args] = mockQueryDataSource.mock.calls[0] as [{ filter?: unknown }];
  return args.filter;
}

function lastQueryDataSourceId(): string {
  const [args] = mockQueryDataSource.mock.calls[0] as [{ data_source_id: string }];
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
    mockQueryDataSource.mockResolvedValue({
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

  it('stays incremental for a compound `and` user filter, appending the timestamp filter as one more member', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const memberA = { property: 'A', checkbox: { equals: true } };
    const options = {
      pullMode: 'incremental',
      since,
      excludePageContent: true,
      filter: JSON.stringify({ and: [memberA] }),
    } as PullRecordFilesOptions;

    const result = await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, options);

    // Appending to the existing top-level `and` adds no nesting level, so there
    // is nothing to demote for.
    expect(lastQueryFilter()).toEqual({ and: [memberA, buildNotionLastEditedFilter(since)] });
    expect(result.newWatermark).toBeInstanceOf(Date);
  });

  it('stays incremental for a compound `or` user filter of simple members, AND-wrapping it (two levels)', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const userFilter = {
      or: [
        { property: 'A', checkbox: { equals: true } },
        { property: 'B', checkbox: { equals: false } },
      ],
    };
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

  it('demotes to full (keeps user filter, no watermark) only when the `or` user filter already nests a compound', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const userFilter = {
      or: [{ and: [{ property: 'A', checkbox: { equals: true } }] }, { property: 'B', checkbox: { equals: true } }],
    };
    const options = {
      pullMode: 'incremental',
      since,
      excludePageContent: true,
      filter: JSON.stringify(userFilter),
    } as PullRecordFilesOptions;

    const result = await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, options);

    // Wrapping this in another `and` would be a third nesting level, which
    // Notion rejects — the raw user filter is passed through unchanged and no
    // watermark is returned.
    expect(lastQueryFilter()).toEqual(userFilter);
    expect(result).toEqual({});
  });
});
