/**
 * DEV-11267: the standalone-pages pull and Notion Search's 10,000-result
 * per-query limit.
 *
 * Search accepts no timestamp *filter*, so the database pull's `created_time`
 * continuation has nothing to bite on. It does accept a `last_edited_time` sort
 * direction, and a query's result budget is per (filter, sort) pair — so the
 * pull sweeps the same search from both ends and stops when the sweeps meet.
 */
import { BaseJsonTableSpec, ConnectorFile, PullRecordFilesOptions } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockSearch = jest.fn();

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
import { buildNotionStandalonePagesTableSpec, NOTION_STANDALONE_PAGES_TABLE_ID } from '../notion-standalone-pages';

function buildStandalonePagesTableSpec(): BaseJsonTableSpec {
  return buildNotionStandalonePagesTableSpec({
    wsId: NOTION_STANDALONE_PAGES_TABLE_ID,
    remoteId: [NOTION_STANDALONE_PAGES_TABLE_ID],
  });
}

/** A workspace-parented (i.e. standalone) page with the given last_edited_time. */
function standalonePage(id: string, lastEditedTime: string): Record<string, unknown> {
  return {
    object: 'page',
    id,
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: lastEditedTime,
    parent: { type: 'workspace', workspace: true },
    in_trash: false,
    properties: {},
    url: `https://www.notion.so/${id}`,
  };
}

function completeSearchResponse(results: unknown[]): unknown {
  return { results, has_more: false, next_cursor: null, request_status: { type: 'complete' } };
}

function incompleteAtLimitSearchResponse(results: unknown[]): unknown {
  return {
    results,
    has_more: false,
    next_cursor: null,
    request_status: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' },
  };
}

function searchArgsOfCall(callIndex: number): Record<string, unknown> {
  const [args] = mockSearch.mock.calls[callIndex] as [Record<string, unknown>];
  return args;
}

const EXCLUDE_CONTENT_OPTIONS = { excludePageContent: true } as PullRecordFilesOptions;

describe('NotionConnector standalone-pages pull — Search 10,000-result limit (DEV-11267)', () => {
  let connector: NotionConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new NotionConnector('fake-key');
  });

  async function runPull(progress: Record<string, unknown> = { nextCursor: undefined }): Promise<void> {
    await connector.pullRecordFiles(
      buildStandalonePagesTableSpec(),
      callback,
      progress as never,
      EXCLUDE_CONTENT_OPTIONS,
    );
  }

  function deliveredPageIds(): string[] {
    return (callback.mock.calls as [{ files: ConnectorFile[] }][]).flatMap(([batch]) =>
      batch.files.map((file) => (file as unknown as { id: string }).id),
    );
  }

  it('sorts the search ascending by last_edited_time', async () => {
    mockSearch.mockResolvedValueOnce(completeSearchResponse([standalonePage('p_1', '2026-01-01T00:00:00.000Z')]));

    await runPull();

    expect(searchArgsOfCall(0).sort).toEqual({ timestamp: 'last_edited_time', direction: 'ascending' });
  });

  it('does not run a second sweep when the first one completes', async () => {
    mockSearch.mockResolvedValueOnce(completeSearchResponse([standalonePage('p_1', '2026-01-01T00:00:00.000Z')]));

    await runPull();

    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('sweeps again in descending order when the ascending sweep hits the limit', async () => {
    mockSearch
      .mockResolvedValueOnce(incompleteAtLimitSearchResponse([standalonePage('p_1', '2026-01-01T00:00:00.000Z')]))
      .mockResolvedValueOnce(completeSearchResponse([standalonePage('p_9', '2026-06-01T00:00:00.000Z')]));

    await runPull();

    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(searchArgsOfCall(1).sort).toEqual({ timestamp: 'last_edited_time', direction: 'descending' });
    // A new query, so no cursor carries over from the ascending sweep.
    expect(searchArgsOfCall(1).start_cursor).toBeUndefined();
    expect(deliveredPageIds()).toEqual(['p_1', 'p_9']);
  });

  it('stops the descending sweep once it reaches the ascending sweep — the enumeration is provably complete', async () => {
    mockSearch
      .mockResolvedValueOnce(
        incompleteAtLimitSearchResponse([
          standalonePage('p_1', '2026-01-01T00:00:00.000Z'),
          standalonePage('p_2', '2026-03-01T00:00:00.000Z'),
        ]),
      )
      // Descending: two genuinely newer pages, then one at the ascending
      // sweep's newest edit time — the windows overlap, so we can stop.
      .mockResolvedValueOnce({
        results: [
          standalonePage('p_9', '2026-06-01T00:00:00.000Z'),
          standalonePage('p_8', '2026-05-01T00:00:00.000Z'),
          standalonePage('p_2', '2026-03-01T00:00:00.000Z'),
          standalonePage('p_1', '2026-01-01T00:00:00.000Z'),
        ],
        has_more: true,
        next_cursor: 'cursor-that-must-not-be-followed',
        request_status: { type: 'complete' },
      });

    await runPull();

    // The descending sweep stopped at the overlap instead of walking the rest.
    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(deliveredPageIds()).toEqual(['p_1', 'p_2', 'p_9', 'p_8']);
    // Progress is cleared, so a resumed job doesn't re-enter a finished sweep.
    const lastBatch = callback.mock.calls[callback.mock.calls.length - 1] as [{ connectorProgress?: unknown }];
    expect((lastBatch[0].connectorProgress as { nextCursor?: string }).nextCursor).toBeUndefined();
  });

  it('warns but still delivers both sweeps when even 20,000 pages is not enough', async () => {
    mockSearch
      .mockResolvedValueOnce(incompleteAtLimitSearchResponse([standalonePage('p_1', '2026-01-01T00:00:00.000Z')]))
      .mockResolvedValueOnce(incompleteAtLimitSearchResponse([standalonePage('p_9', '2026-06-01T00:00:00.000Z')]));

    await runPull();

    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(deliveredPageIds()).toEqual(['p_1', 'p_9']);
  });

  it('checkpoints the sweep direction and the ascending watermark', async () => {
    mockSearch
      .mockResolvedValueOnce(incompleteAtLimitSearchResponse([standalonePage('p_1', '2026-01-01T00:00:00.000Z')]))
      .mockResolvedValueOnce(completeSearchResponse([]));

    await runPull();

    const [firstBatch] = callback.mock.calls[0] as [{ connectorProgress?: Record<string, unknown> }];
    expect(firstBatch.connectorProgress).toEqual({
      nextCursor: undefined,
      standalonePagesSearchDirection: 'descending',
      standalonePagesAscendingSweepNewestLastEditedTime: '2026-01-01T00:00:00.000Z',
    });
  });

  it('resumes a checkpointed descending sweep, keeping the overlap watermark', async () => {
    mockSearch.mockResolvedValueOnce(completeSearchResponse([standalonePage('p_9', '2026-06-01T00:00:00.000Z')]));

    await runPull({
      nextCursor: 'cursor-from-a-sorted-search',
      standalonePagesSearchDirection: 'descending',
      standalonePagesAscendingSweepNewestLastEditedTime: '2026-01-01T00:00:00.000Z',
    });

    expect(searchArgsOfCall(0).sort).toEqual({ timestamp: 'last_edited_time', direction: 'descending' });
    expect(searchArgsOfCall(0).start_cursor).toBe('cursor-from-a-sorted-search');
  });

  it('discards a checkpointed cursor from an unsorted search and restarts the sweep', async () => {
    mockSearch.mockResolvedValueOnce(completeSearchResponse([standalonePage('p_1', '2026-01-01T00:00:00.000Z')]));

    await runPull({ nextCursor: 'cursor-from-an-unsorted-search' });

    expect(searchArgsOfCall(0).start_cursor).toBeUndefined();
    expect(searchArgsOfCall(0).sort).toEqual({ timestamp: 'last_edited_time', direction: 'ascending' });
  });
});
