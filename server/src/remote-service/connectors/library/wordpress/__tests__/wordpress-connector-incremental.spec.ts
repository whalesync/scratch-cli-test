import { TSchema } from '@sinclair/typebox';
import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { BaseJsonTableSpec, dotPath, PullRecordFilesOptions } from '../../../types';
import { WORDPRESS_POLLING_PAGE_SIZE } from '../wordpress-constants';

// Break the connector-registry circular import chain (same shape as the
// Linear/Notion incremental specs).
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

import { WordPressConnector } from '../wordpress-connector';
import { formatWordPressModifiedAfter } from '../wordpress-incremental';

/** Post-type/media spec: `modified` annotated → incremental-capable. */
function postSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'posts', remoteId: ['posts'] },
    slug: 'posts',
    name: 'Posts',
    idPath: dotPath('id'),
    schema: {
      properties: {
        title: {},
        modified: { [X_SCRATCH_LAST_MODIFIED_FIELD]: true },
      },
    } as unknown as TSchema,
  };
}

/** Taxonomy spec: no `modified` column → not incremental-capable. */
function taxonomySpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'categories', remoteId: ['categories'] },
    slug: 'categories',
    name: 'Categories',
    idPath: dotPath('id'),
    schema: { properties: { name: {}, slug: {} } } as unknown as TSchema,
  };
}

function lastPollCall(): unknown[] {
  return mockPollRecords.mock.calls[mockPollRecords.mock.calls.length - 1] as unknown[];
}

describe('WordPressConnector.supportsIncrementalPull', () => {
  const connector = new WordPressConnector('user', 'pass', 'https://example.com/wp-json/');

  it('is true for a post-type collection (annotated `modified`)', () => {
    expect(connector.supportsIncrementalPull({} as PullRecordFilesOptions, postSpec())).toBe(true);
  });

  it('is false for a taxonomy collection (no `modified` column)', () => {
    expect(connector.supportsIncrementalPull({} as PullRecordFilesOptions, taxonomySpec())).toBe(false);
  });

  it('an explicit modifiedAtField override makes an unannotated collection incremental-capable', () => {
    expect(
      connector.supportsIncrementalPull({ modifiedAtField: 'modified' } as PullRecordFilesOptions, taxonomySpec()),
    ).toBe(true);
  });
});

describe('WordPressConnector.pullRecordFiles (incremental)', () => {
  let connector: WordPressConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    // One short page (< page size) ends the pagination loop after one call.
    mockPollRecords.mockResolvedValue({ records: [{ id: 1, modified: '2026-05-14T13:00:00' }], total: 1 });
    mockGetSiteTimezone.mockResolvedValue({}); // UTC unless a test overrides
    connector = new WordPressConnector('user', 'pass', 'https://example.com/wp-json/');
  });

  it('runs a full pull and returns {} when pullMode is not incremental (no modified_after, no tz lookup)', async () => {
    const result = await connector.pullRecordFiles(postSpec(), callback, {}, {
      pullMode: 'full',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    // pollRecords(tableId, page, pageSize, modifiedAfter) — first page, modifiedAfter undefined.
    expect(lastPollCall()).toEqual(['posts', 1, WORDPRESS_POLLING_PAGE_SIZE, undefined]);
    expect(mockGetSiteTimezone).not.toHaveBeenCalled();
  });

  it('passes the site-local-rendered modified_after string and returns a newWatermark when incremental', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const before = Date.now();
    const result = await connector.pullRecordFiles(postSpec(), callback, {}, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);
    const after = Date.now();

    expect(lastPollCall()).toEqual(['posts', 1, WORDPRESS_POLLING_PAGE_SIZE, formatWordPressModifiedAfter(since, {})]);
    expect(result.newWatermark).toBeInstanceOf(Date);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
  });

  it('renders modified_after in the resolved site timezone (DST-aware)', async () => {
    mockGetSiteTimezone.mockResolvedValue({ timezoneString: 'America/New_York' });
    const since = new Date('2026-05-01T12:00:00.000Z');

    await connector.pullRecordFiles(postSpec(), callback, {}, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);

    expect(lastPollCall()).toEqual([
      'posts',
      1,
      WORDPRESS_POLLING_PAGE_SIZE,
      formatWordPressModifiedAfter(since, { timezoneString: 'America/New_York' }),
    ]);
  });

  it('treats incremental without a `since` as a full pull (no modified_after, no watermark)', async () => {
    const result = await connector.pullRecordFiles(postSpec(), callback, {}, {
      pullMode: 'incremental',
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(lastPollCall()).toEqual(['posts', 1, WORDPRESS_POLLING_PAGE_SIZE, undefined]);
  });

  it('demotes an incremental run to full when the collection has no resolvable modified field', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const result = await connector.pullRecordFiles(taxonomySpec(), callback, {}, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);

    expect(result).toEqual({});
    expect(lastPollCall()).toEqual(['categories', 1, WORDPRESS_POLLING_PAGE_SIZE, undefined]);
  });

  it('resumes pagination from the saved page', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    await connector.pullRecordFiles(postSpec(), callback, { nextPage: 4 }, {
      pullMode: 'incremental',
      since,
    } as PullRecordFilesOptions);

    expect(lastPollCall()).toEqual(['posts', 4, WORDPRESS_POLLING_PAGE_SIZE, formatWordPressModifiedAfter(since, {})]);
  });
});
