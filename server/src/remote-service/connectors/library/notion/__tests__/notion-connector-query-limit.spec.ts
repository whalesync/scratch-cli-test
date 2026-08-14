/**
 * Tests for the DEV-11267 handling of Notion's 10,000-result per-query limit
 * in `pullRecordFiles`: every data-source query sorts ascending by
 * `created_time`, and a query that ends incomplete
 * (`request_status.type === 'incomplete'` with `has_more: false`) rolls to a
 * new query window filtered to `created_time` on_or_after the last returned
 * row's `created_time`.
 */
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

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'db', remoteId: ['db_123', 'ds_123'] },
    slug: 'db',
    name: 'db',
    idPath: dotPath('id'),
    schema: {} as unknown as TSchema,
  };
}

const FULL_PULL_OPTIONS = { pullMode: 'full', excludePageContent: true } as PullRecordFilesOptions;

function page(id: string, createdTime: string): { object: 'page'; id: string; created_time: string } {
  return { object: 'page', id, created_time: createdTime };
}

function completeResponse(results: unknown[]): unknown {
  return { results, has_more: false, next_cursor: null, request_status: { type: 'complete' } };
}

function incompleteAtLimitResponse(results: unknown[]): unknown {
  return {
    results,
    has_more: false,
    next_cursor: null,
    request_status: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' },
  };
}

function queryArgsOfCall(callIndex: number): Record<string, unknown> {
  const [args] = mockQueryDataSource.mock.calls[callIndex] as [Record<string, unknown>];
  return args;
}

describe('NotionConnector.pullRecordFiles — 10,000-result query limit (DEV-11267)', () => {
  let connector: NotionConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new NotionConnector('fake-key');
  });

  it('sorts every query ascending by created_time', async () => {
    mockQueryDataSource.mockResolvedValueOnce(completeResponse([page('page_1', '2026-08-01T10:00:00.000Z')]));

    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, FULL_PULL_OPTIONS);

    expect(queryArgsOfCall(0).sorts).toEqual([{ timestamp: 'created_time', direction: 'ascending' }]);
  });

  it('rolls to a created_time-filtered query window when a query ends incomplete at the limit', async () => {
    mockQueryDataSource
      .mockResolvedValueOnce(
        incompleteAtLimitResponse([
          page('page_1', '2026-08-01T10:00:00.000Z'),
          page('page_2', '2026-08-01T10:05:00.000Z'),
        ]),
      )
      .mockResolvedValueOnce(completeResponse([page('page_3', '2026-08-01T10:07:00.000Z')]));

    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, FULL_PULL_OPTIONS);

    expect(mockQueryDataSource).toHaveBeenCalledTimes(2);
    // The rolled query starts a NEW query (no cursor) filtered to the last
    // returned row's created_time, inclusive.
    expect(queryArgsOfCall(1).start_cursor).toBeUndefined();
    expect(queryArgsOfCall(1).filter).toEqual({
      timestamp: 'created_time',
      created_time: { on_or_after: '2026-08-01T10:05:00.000Z' },
    });
    // The checkpoint written for the batch that hit the limit already carries
    // the rolled window, so a resumed job re-queries the new window.
    const [firstCallbackParams] = callback.mock.calls[0] as [{ connectorProgress?: unknown }];
    expect(firstCallbackParams.connectorProgress).toEqual({
      nextCursor: undefined,
      createdOnOrAfter: '2026-08-01T10:05:00.000Z',
      sortedByCreatedTime: true,
    });
  });

  it('does not re-deliver boundary-minute pages that the rolled window re-returns', async () => {
    const boundaryMinute = '2026-08-01T10:05:00.000Z';
    mockQueryDataSource
      .mockResolvedValueOnce(
        incompleteAtLimitResponse([
          page('page_1', '2026-08-01T10:00:00.000Z'),
          page('page_2', boundaryMinute),
          page('page_3', boundaryMinute),
        ]),
      )
      // The rolled window (on_or_after boundaryMinute, inclusive) re-returns
      // the already-delivered boundary-minute pages before the new ones.
      .mockResolvedValueOnce(
        completeResponse([
          page('page_2', boundaryMinute),
          page('page_3', boundaryMinute),
          page('page_4', boundaryMinute),
          page('page_5', '2026-08-01T10:07:00.000Z'),
        ]),
      );

    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, FULL_PULL_OPTIONS);

    const [firstBatch] = callback.mock.calls[0] as [{ files: Array<{ id: string }> }];
    const [secondBatch] = callback.mock.calls[1] as [{ files: Array<{ id: string }> }];
    expect(firstBatch.files.map((f) => f.id)).toEqual(['page_1', 'page_2', 'page_3']);
    // page_2 and page_3 were already delivered by the first window — only the
    // genuinely new pages are delivered again.
    expect(secondBatch.files.map((f) => f.id)).toEqual(['page_4', 'page_5']);
  });

  it('delivers every distinct page sharing one created_time within a single window (no over-filtering)', async () => {
    const sharedMinute = '2026-08-01T10:00:00.000Z';
    mockQueryDataSource.mockResolvedValueOnce(
      completeResponse([page('page_1', sharedMinute), page('page_2', sharedMinute), page('page_3', sharedMinute)]),
    );

    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, FULL_PULL_OPTIONS);

    const [onlyBatch] = callback.mock.calls[0] as [{ files: Array<{ id: string }> }];
    expect(onlyBatch.files.map((f) => f.id)).toEqual(['page_1', 'page_2', 'page_3']);
  });

  it('AND-combines the continuation filter with a simple user filter', async () => {
    const userFilter = { property: 'Status', checkbox: { equals: true } };
    mockQueryDataSource
      .mockResolvedValueOnce(incompleteAtLimitResponse([page('page_1', '2026-08-01T10:00:00.000Z')]))
      .mockResolvedValueOnce(completeResponse([]));

    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, {
      ...FULL_PULL_OPTIONS,
      filter: JSON.stringify(userFilter),
    } as PullRecordFilesOptions);

    expect(queryArgsOfCall(1).filter).toEqual({
      and: [userFilter, { timestamp: 'created_time', created_time: { on_or_after: '2026-08-01T10:00:00.000Z' } }],
    });
  });

  it('appends the continuation filter to an `and`-compound user filter without extra nesting', async () => {
    const memberA = { property: 'A', checkbox: { equals: true } };
    mockQueryDataSource
      .mockResolvedValueOnce(incompleteAtLimitResponse([page('page_1', '2026-08-01T10:00:00.000Z')]))
      .mockResolvedValueOnce(completeResponse([]));

    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, {
      ...FULL_PULL_OPTIONS,
      filter: JSON.stringify({ and: [memberA] }),
    } as PullRecordFilesOptions);

    expect(queryArgsOfCall(1).filter).toEqual({
      and: [memberA, { timestamp: 'created_time', created_time: { on_or_after: '2026-08-01T10:00:00.000Z' } }],
    });
  });

  it('AND-wraps an `or`-compound user filter of simple members (two levels — Notion allows this)', async () => {
    const orCompoundUserFilter = {
      or: [
        { property: 'A', checkbox: { equals: true } },
        { property: 'B', checkbox: { equals: false } },
      ],
    };
    mockQueryDataSource
      .mockResolvedValueOnce(incompleteAtLimitResponse([page('page_1', '2026-08-01T10:00:00.000Z')]))
      .mockResolvedValueOnce(completeResponse([]));

    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, {
      ...FULL_PULL_OPTIONS,
      filter: JSON.stringify(orCompoundUserFilter),
    } as PullRecordFilesOptions);

    expect(queryArgsOfCall(1).filter).toEqual({
      and: [
        orCompoundUserFilter,
        { timestamp: 'created_time', created_time: { on_or_after: '2026-08-01T10:00:00.000Z' } },
      ],
    });
  });

  it('throws instead of silently truncating when the `or`-compound user filter already nests a compound', async () => {
    mockQueryDataSource.mockResolvedValueOnce(incompleteAtLimitResponse([page('page_1', '2026-08-01T10:00:00.000Z')]));

    await expect(
      connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, {
        ...FULL_PULL_OPTIONS,
        filter: JSON.stringify({
          or: [{ and: [{ property: 'A', checkbox: { equals: true } }] }, { property: 'B', checkbox: { equals: true } }],
        }),
      } as PullRecordFilesOptions),
    ).rejects.toThrow(/two-level compound-nesting limit/);
  });

  it('throws instead of looping when the boundary cannot advance (an entire window shares one created_time)', async () => {
    const sharedCreatedTime = '2026-08-01T10:00:00.000Z';
    mockQueryDataSource
      .mockResolvedValueOnce(incompleteAtLimitResponse([page('page_1', sharedCreatedTime)]))
      .mockResolvedValueOnce(incompleteAtLimitResponse([page('page_2', sharedCreatedTime)]));

    await expect(
      connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, FULL_PULL_OPTIONS),
    ).rejects.toThrow(/cannot advance/);
    expect(mockQueryDataSource).toHaveBeenCalledTimes(2);
  });

  it('throws when a query reports incomplete but returned no page to resume from', async () => {
    mockQueryDataSource.mockResolvedValueOnce(incompleteAtLimitResponse([]));

    await expect(
      connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, FULL_PULL_OPTIONS),
    ).rejects.toThrow(/no page/);
  });

  it('resumes from an earlier batch when the window reports incomplete on a page-less final batch', async () => {
    // Notion can end a window incomplete on a batch carrying no page objects.
    // The last row of an earlier batch in the SAME window is still a valid
    // resume boundary, so the pull must roll rather than abandon itself.
    mockQueryDataSource
      .mockResolvedValueOnce({
        results: [page('page_1', '2026-08-01T10:00:00.000Z'), page('page_2', '2026-08-01T10:05:00.000Z')],
        has_more: true,
        next_cursor: 'cursor-mid-window',
        request_status: { type: 'complete' },
      })
      .mockResolvedValueOnce(incompleteAtLimitResponse([]))
      .mockResolvedValueOnce(completeResponse([page('page_3', '2026-08-01T10:09:00.000Z')]));

    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, FULL_PULL_OPTIONS);

    expect(mockQueryDataSource).toHaveBeenCalledTimes(3);
    expect(queryArgsOfCall(2).start_cursor).toBeUndefined();
    expect(queryArgsOfCall(2).filter).toEqual({
      timestamp: 'created_time',
      created_time: { on_or_after: '2026-08-01T10:05:00.000Z' },
    });
  });

  it('measures the non-advancing-boundary guard against the window that hit the limit, not an earlier one', async () => {
    // Window 1 ends at 10:00. Window 2 starts there and advances to 10:05, so
    // the pull must NOT mistake the reset window tracker for a stalled boundary.
    mockQueryDataSource
      .mockResolvedValueOnce(incompleteAtLimitResponse([page('page_1', '2026-08-01T10:00:00.000Z')]))
      .mockResolvedValueOnce(
        incompleteAtLimitResponse([
          page('page_1', '2026-08-01T10:00:00.000Z'),
          page('page_2', '2026-08-01T10:05:00.000Z'),
        ]),
      )
      .mockResolvedValueOnce(completeResponse([page('page_3', '2026-08-01T10:09:00.000Z')]));

    await connector.pullRecordFiles(buildTableSpec(), callback, { nextCursor: undefined }, FULL_PULL_OPTIONS);

    expect(mockQueryDataSource).toHaveBeenCalledTimes(3);
    expect(queryArgsOfCall(2).filter).toEqual({
      timestamp: 'created_time',
      created_time: { on_or_after: '2026-08-01T10:05:00.000Z' },
    });
  });

  it('discards a checkpointed cursor from a pre-sort build and restarts from scratch', async () => {
    mockQueryDataSource.mockResolvedValueOnce(completeResponse([page('page_1', '2026-08-01T10:00:00.000Z')]));

    await connector.pullRecordFiles(
      buildTableSpec(),
      callback,
      { nextCursor: 'cursor-from-an-unsorted-query' },
      FULL_PULL_OPTIONS,
    );

    expect(queryArgsOfCall(0).start_cursor).toBeUndefined();
  });

  it('resumes a checkpointed sorted query window: cursor and created_time boundary are both reused', async () => {
    mockQueryDataSource.mockResolvedValueOnce(completeResponse([page('page_9', '2026-08-01T11:00:00.000Z')]));

    await connector.pullRecordFiles(
      buildTableSpec(),
      callback,
      {
        nextCursor: 'cursor-from-a-sorted-query',
        createdOnOrAfter: '2026-08-01T10:05:00.000Z',
        sortedByCreatedTime: true,
      },
      FULL_PULL_OPTIONS,
    );

    expect(queryArgsOfCall(0).start_cursor).toBe('cursor-from-a-sorted-query');
    expect(queryArgsOfCall(0).filter).toEqual({
      timestamp: 'created_time',
      created_time: { on_or_after: '2026-08-01T10:05:00.000Z' },
    });
  });
});
