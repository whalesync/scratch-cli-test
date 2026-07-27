import { TSchema } from '@sinclair/typebox';
import { WSLogger } from 'src/logger';
import { BaseJsonTableSpec, ConnectorFile, dotPath, PullRecordFilesOptions } from '../../../types';
import {
  WordPressInvalidFirstPageError,
  WordPressMaxPagesReachedError,
  WordPressPageIgnoredError,
} from '../wordpress-errors';

// Break the connector-registry circular import chain (same shape as the
// incremental spec).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'WordPress'),
}));

const mockPollRecords = jest.fn();
const mockGetSiteTimezone = jest.fn();

jest.mock('../wordpress-http-client', () => ({
  WordPressHttpClient: jest.fn().mockImplementation(() => ({
    pollRecords: mockPollRecords,
    getSiteTimezone: mockGetSiteTimezone,
  })),
}));

// Shrink the runaway backstop so the backstop test doesn't have to fetch 1000
// pages; everything else stays real (notably WORDPRESS_POLLING_PAGE_SIZE = 100).
jest.mock('../wordpress-constants', () => ({
  ...jest.requireActual<typeof import('../wordpress-constants')>('../wordpress-constants'),
  WORDPRESS_MAX_PULL_PAGES: 5,
}));

import { WordPressConnector } from '../wordpress-connector';

const PAGE_SIZE = 100;

/** Post-type spec (a `modified` annotation isn't needed for full-pull tests). */
function postSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'posts', remoteId: ['posts'] },
    slug: 'posts',
    name: 'Posts',
    idPath: dotPath('id'),
    schema: { properties: { title: {} } } as unknown as TSchema,
  };
}

/** Build a page of records with ids `start..start+count-1`. */
function pageOfRecords(start: number, count: number): { id: number }[] {
  return Array.from({ length: count }, (_v, i) => ({ id: start + i }));
}

/**
 * A `pollRecords` stub for an endpoint that honors the 1-based `page` param and
 * returns the correct contiguous id slice for each page — the shape of both a
 * healthy site and the offset-ignoring-but-page-honoring `categories` endpoint
 * (the connector only ever sends `page`, so the two are indistinguishable here).
 * With `withHeaders`, reports X-WP-Total / X-WP-TotalPages; without, the site
 * omitted them (proxy/plugin stripped) and only the short page terminates. Past
 * the last page it returns an empty page — exactly what the http client hands
 * back after swallowing a `400 rest_post_invalid_page_number`.
 */
function pageHonoringEndpoint(totalRecords: number, { withHeaders }: { withHeaders: boolean }) {
  const totalPages = Math.ceil(totalRecords / PAGE_SIZE);
  return (_tableId: string, page: number) => {
    const start = (page - 1) * PAGE_SIZE;
    const count = Math.max(0, Math.min(PAGE_SIZE, totalRecords - start));
    const records = count > 0 ? pageOfRecords(start + 1, count) : [];
    return Promise.resolve(withHeaders ? { records, total: totalRecords, totalPages } : { records });
  };
}

type CallbackParam = { files: ConnectorFile[]; connectorProgress: { nextPage: number | undefined } };

/** The typed argument passed to the callback on invocation `index` (default: last). */
function callbackArg(callback: jest.Mock, index?: number): CallbackParam {
  const calls = callback.mock.calls as Array<[CallbackParam]>;
  const resolvedIndex = index ?? calls.length - 1;
  return calls[resolvedIndex][0];
}

/** Total records emitted to the callback across all its invocations. */
function emittedRecordCount(callback: jest.Mock): number {
  const calls = callback.mock.calls as Array<[CallbackParam]>;
  return calls.reduce((sum, call) => sum + call[0].files.length, 0);
}

/** The `page` argument passed to `pollRecords` on invocation `index`. */
function requestedPage(index: number): number {
  const calls = mockPollRecords.mock.calls as Array<[string, number]>;
  return calls[index][1];
}

const FULL_PULL = { pullMode: 'full' } as PullRecordFilesOptions;

describe('WordPressConnector.pullRecordFiles pagination termination', () => {
  let connector: WordPressConnector;
  let callback: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
    mockGetSiteTimezone.mockResolvedValue({});
    callback = jest.fn().mockResolvedValue(undefined);
    connector = new WordPressConnector('user', 'pass', 'https://example.com/wp-json/');
  });

  it('pulls every record across a healthy multi-page collection (100/100/50)', async () => {
    mockPollRecords.mockImplementation(pageHonoringEndpoint(250, { withHeaders: true }));

    const result = await connector.pullRecordFiles(postSpec(), callback, {}, FULL_PULL);

    expect(result).toEqual({});
    expect(mockPollRecords).toHaveBeenCalledTimes(3);
    // Fetched pages 1, 2, 3 in order.
    expect([requestedPage(0), requestedPage(1), requestedPage(2)]).toEqual([1, 2, 3]);
    expect(emittedRecordCount(callback)).toBe(250);
    // Non-terminal page advances the cursor; the final page signals completion.
    expect(callbackArg(callback, 0).connectorProgress.nextPage).toBe(2);
    expect(callbackArg(callback).connectorProgress.nextPage).toBeUndefined();
  });

  it('completes a full scan on an offset-ignoring-but-page-honoring endpoint that omits X-WP-Total', async () => {
    // The DEV-10786 case: the site drops `offset` but advances by `page`, and its
    // plugin also strips the count headers — only the short final page ends it.
    mockPollRecords.mockImplementation(pageHonoringEndpoint(468, { withHeaders: false }));

    await connector.pullRecordFiles(postSpec(), callback, {}, FULL_PULL);

    // 468 = 4 full pages + a 68-record short page.
    expect(mockPollRecords).toHaveBeenCalledTimes(5);
    expect([requestedPage(0), requestedPage(4)]).toEqual([1, 5]);
    expect(emittedRecordCount(callback)).toBe(468);
    expect(callbackArg(callback).connectorProgress.nextPage).toBeUndefined();
  });

  it('stops on the last page (X-WP-TotalPages) at an exact page-size multiple with no extra empty fetch', async () => {
    // 200 records = two full pages. The last-page check ends it after exactly 2
    // fetches instead of needing a third (empty) fetch.
    mockPollRecords.mockImplementation(pageHonoringEndpoint(200, { withHeaders: true }));

    await connector.pullRecordFiles(postSpec(), callback, {}, FULL_PULL);

    expect(mockPollRecords).toHaveBeenCalledTimes(2);
    expect(emittedRecordCount(callback)).toBe(200);
    expect(callbackArg(callback).connectorProgress.nextPage).toBeUndefined();
  });

  it('treats the empty page past the last page (400 rest_post_invalid_page_number) as clean completion', async () => {
    // Exact multiple (200) with NO count headers: the last-page check can't fire,
    // so page 3 is requested and the http client returns an empty page (having
    // swallowed the 400). That empty short page completes the scan.
    mockPollRecords.mockImplementation(pageHonoringEndpoint(200, { withHeaders: false }));

    await connector.pullRecordFiles(postSpec(), callback, {}, FULL_PULL);

    expect(mockPollRecords).toHaveBeenCalledTimes(3);
    expect(requestedPage(2)).toBe(3);
    expect(emittedRecordCount(callback)).toBe(200);
    expect(callbackArg(callback).connectorProgress.nextPage).toBeUndefined();
  });

  it('migrates a legacy in-flight nextOffset cursor to the equivalent page', async () => {
    mockPollRecords.mockImplementation(pageHonoringEndpoint(500, { withHeaders: true }));

    // A cursor persisted before the page switch: offset 250 → page floor(250/100)+1 = 3.
    await connector.pullRecordFiles(postSpec(), callback, { nextOffset: 250 }, FULL_PULL);

    expect(requestedPage(0)).toBe(3);
    // Resumes at page 3 and runs to the last page (5), emitting pages 3, 4, 5.
    expect([requestedPage(0), requestedPage(1), requestedPage(2)]).toEqual([3, 4, 5]);
    expect(callbackArg(callback).connectorProgress.nextPage).toBeUndefined();
  });

  it('throws WordPressPageIgnoredError when a site ignores page but reports X-WP-Total', async () => {
    // Same first page at every page number, X-WP-Total says 468 exist.
    const firstPage = pageOfRecords(1, PAGE_SIZE);
    mockPollRecords.mockResolvedValue({ records: firstPage, total: 468 });

    await expect(connector.pullRecordFiles(postSpec(), callback, {}, FULL_PULL)).rejects.toThrow(
      WordPressPageIgnoredError,
    );

    // Detected on the second page (before hammering the API to reach `total`).
    expect(mockPollRecords).toHaveBeenCalledTimes(2);
    // The duplicate page is never re-emitted: only page 1's records were committed.
    expect(callback).toHaveBeenCalledTimes(1);
    expect(emittedRecordCount(callback)).toBe(PAGE_SIZE);
  });

  it('throws WordPressPageIgnoredError when a site ignores page and omits X-WP-Total', async () => {
    const firstPage = pageOfRecords(1, PAGE_SIZE);
    mockPollRecords.mockResolvedValue({ records: firstPage }); // no total header

    await expect(connector.pullRecordFiles(postSpec(), callback, {}, FULL_PULL)).rejects.toThrow(
      WordPressPageIgnoredError,
    );

    expect(mockPollRecords).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('throws WordPressMaxPagesReachedError when a headerless site returns distinct full pages forever', async () => {
    // Distinct ids every page (so the page-ignoring guard never fires) and no
    // total header — only the page-count backstop (mocked to 5) can stop it.
    mockPollRecords.mockImplementation((_tableId: string, page: number) =>
      Promise.resolve({ records: pageOfRecords((page - 1) * PAGE_SIZE + 1, PAGE_SIZE) }),
    );

    await expect(connector.pullRecordFiles(postSpec(), callback, {}, FULL_PULL)).rejects.toThrow(
      WordPressMaxPagesReachedError,
    );

    // Stops on the 5th fetch (backstop), having emitted pages 1–4.
    expect(mockPollRecords).toHaveBeenCalledTimes(5);
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it('aborts the scan (never completes) when page 1 returns *_invalid_page_number', async () => {
    // A plugin overriding pagination 400s on page 1 of a non-empty table; the http
    // client surfaces this as WordPressInvalidFirstPageError (DEV-10912). The pull
    // must propagate it and never complete — completing over zero records would let
    // the delete detector tombstone the whole table.
    mockPollRecords.mockRejectedValue(new WordPressInvalidFirstPageError('posts'));

    await expect(connector.pullRecordFiles(postSpec(), callback, {}, FULL_PULL)).rejects.toThrow(
      WordPressInvalidFirstPageError,
    );

    // Aborted on the first fetch, with no records emitted and no completion cursor
    // cleared — so the scan never finishes over an empty set.
    expect(mockPollRecords).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
  });
});
