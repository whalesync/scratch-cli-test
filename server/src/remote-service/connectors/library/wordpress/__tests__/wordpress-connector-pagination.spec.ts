import { TSchema } from '@sinclair/typebox';
import { WSLogger } from 'src/logger';
import { BaseJsonTableSpec, ConnectorFile, dotPath, PullRecordFilesOptions } from '../../../types';
import { WordPressMaxPagesReachedError, WordPressOffsetIgnoredError } from '../wordpress-errors';

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

type CallbackParam = { files: ConnectorFile[]; connectorProgress: { nextOffset: number | undefined } };

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

  it('throws WordPressOffsetIgnoredError when a site ignores offset but reports X-WP-Total', async () => {
    // Same first page at every offset, X-WP-Total says 468 exist.
    const firstPage = pageOfRecords(1, PAGE_SIZE);
    mockPollRecords.mockResolvedValue({ records: firstPage, total: 468 });

    await expect(connector.pullRecordFiles(postSpec(), callback, { nextOffset: undefined }, FULL_PULL)).rejects.toThrow(
      WordPressOffsetIgnoredError,
    );

    // Detected on the second page (before hammering the API 5× to reach `total`).
    expect(mockPollRecords).toHaveBeenCalledTimes(2);
    // The duplicate page is never re-emitted: only page 1's records were committed.
    expect(callback).toHaveBeenCalledTimes(1);
    expect(emittedRecordCount(callback)).toBe(PAGE_SIZE);
  });

  it('throws WordPressOffsetIgnoredError when a site ignores offset and omits X-WP-Total', async () => {
    const firstPage = pageOfRecords(1, PAGE_SIZE);
    mockPollRecords.mockResolvedValue({ records: firstPage }); // no total header

    await expect(connector.pullRecordFiles(postSpec(), callback, { nextOffset: undefined }, FULL_PULL)).rejects.toThrow(
      WordPressOffsetIgnoredError,
    );

    expect(mockPollRecords).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('pulls every record across a healthy multi-page collection (100/100/50)', async () => {
    mockPollRecords.mockImplementation((_tableId: string, offset: number) => {
      const remaining = Math.max(0, 250 - offset);
      return Promise.resolve({ records: pageOfRecords(offset + 1, Math.min(PAGE_SIZE, remaining)), total: 250 });
    });

    const result = await connector.pullRecordFiles(postSpec(), callback, { nextOffset: undefined }, FULL_PULL);

    expect(result).toEqual({});
    expect(mockPollRecords).toHaveBeenCalledTimes(3);
    expect(emittedRecordCount(callback)).toBe(250);
    // Final page signals completion.
    expect(callbackArg(callback).connectorProgress.nextOffset).toBeUndefined();
  });

  it('stops at offset >= total on an exact page-size multiple (no extra empty fetch)', async () => {
    // 200 records = two full pages. The old short-page-only logic needed a 3rd
    // (empty) fetch; the X-WP-Total check ends it after exactly 2.
    mockPollRecords.mockImplementation((_tableId: string, offset: number) => {
      const remaining = Math.max(0, 200 - offset);
      return Promise.resolve({ records: pageOfRecords(offset + 1, Math.min(PAGE_SIZE, remaining)), total: 200 });
    });

    await connector.pullRecordFiles(postSpec(), callback, { nextOffset: undefined }, FULL_PULL);

    expect(mockPollRecords).toHaveBeenCalledTimes(2);
    expect(emittedRecordCount(callback)).toBe(200);
    expect(callbackArg(callback).connectorProgress.nextOffset).toBeUndefined();
  });

  it('throws WordPressMaxPagesReachedError when a headerless site returns distinct full pages forever', async () => {
    // Distinct ids every page (so the offset-ignoring guard never fires) and no
    // total header — only the page-count backstop (mocked to 5) can stop it.
    mockPollRecords.mockImplementation((_tableId: string, offset: number) =>
      Promise.resolve({ records: pageOfRecords(offset + 1, PAGE_SIZE) }),
    );

    await expect(connector.pullRecordFiles(postSpec(), callback, { nextOffset: undefined }, FULL_PULL)).rejects.toThrow(
      WordPressMaxPagesReachedError,
    );

    // Stops on the 5th fetch (backstop), having emitted pages 1–4.
    expect(mockPollRecords).toHaveBeenCalledTimes(5);
    expect(callback).toHaveBeenCalledTimes(4);
  });
});
