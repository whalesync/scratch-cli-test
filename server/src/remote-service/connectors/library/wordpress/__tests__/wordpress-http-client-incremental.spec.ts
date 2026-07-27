import { createApiClient } from '../../../create-api-client';
import { WordPressInvalidFirstPageError } from '../wordpress-errors';
import { WordPressHttpClient } from '../wordpress-http-client';

jest.mock('../../../create-api-client');

describe('WordPressHttpClient.pollRecords modified_after', () => {
  let mockGet: jest.Mock;
  let client: WordPressHttpClient;

  beforeEach(() => {
    mockGet = jest.fn().mockResolvedValue({ data: [] });
    (createApiClient as jest.Mock).mockReturnValue({ get: mockGet });
    client = new WordPressHttpClient('https://example.com/wp-json/', 'user', 'pass');
  });

  function lastRequestedUrl(): URL {
    const call = mockGet.mock.calls[mockGet.mock.calls.length - 1] as [string];
    return new URL(call[0]);
  }

  it('omits modified_after on a full scan (no value passed)', async () => {
    await client.pollRecords('posts', 1, 100);
    const url = lastRequestedUrl();
    expect(url.searchParams.get('modified_after')).toBeNull();
    expect(url.searchParams.get('status')).toBe('any');
    expect(url.searchParams.get('context')).toBe('edit');
  });

  it('paginates by page with a deterministic orderby=id&order=asc scan order', async () => {
    await client.pollRecords('posts', 3, 100);
    const url = lastRequestedUrl();
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.get('orderby')).toBe('id');
    expect(url.searchParams.get('order')).toBe('asc');
    // No offset param — pagination is page-based now.
    expect(url.searchParams.get('offset')).toBeNull();
  });

  it('passes the site-local datetime string through verbatim (no re-encoding of the value itself)', async () => {
    await client.pollRecords('posts', 1, 100, '2026-05-14T07:59:00');
    expect(lastRequestedUrl().searchParams.get('modified_after')).toBe('2026-05-14T07:59:00');
  });

  it('keeps page pagination alongside modified_after', async () => {
    await client.pollRecords('posts', 3, 100, '2026-05-14T07:59:00');
    const url = lastRequestedUrl();
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('modified_after')).toBe('2026-05-14T07:59:00');
  });

  it('media collections also accept modified_after (and skip status=any)', async () => {
    await client.pollRecords('media', 1, 100, '2026-05-14T07:59:00');
    const url = lastRequestedUrl();
    expect(url.searchParams.get('modified_after')).toBe('2026-05-14T07:59:00');
    expect(url.searchParams.get('status')).toBeNull();
  });
});

describe('WordPressHttpClient.getSiteTimezone', () => {
  let mockGet: jest.Mock;
  let client: WordPressHttpClient;

  beforeEach(() => {
    mockGet = jest.fn();
    (createApiClient as jest.Mock).mockReturnValue({ get: mockGet });
    client = new WordPressHttpClient('https://example.com/wp-json/', 'user', 'pass');
  });

  it('parses timezone_string and gmt_offset from the REST index', async () => {
    mockGet.mockResolvedValue({ data: { name: 'S', url: 'u', timezone_string: 'America/New_York', gmt_offset: -4 } });
    await expect(client.getSiteTimezone()).resolves.toEqual({
      timezoneString: 'America/New_York',
      gmtOffsetHours: -4,
    });
  });

  it('treats an empty timezone_string as absent (manual-offset sites)', async () => {
    mockGet.mockResolvedValue({ data: { name: 'S', url: 'u', timezone_string: '', gmt_offset: 5.5 } });
    await expect(client.getSiteTimezone()).resolves.toEqual({ gmtOffsetHours: 5.5 });
  });

  it('memoizes — only one REST-index fetch per client instance', async () => {
    mockGet.mockResolvedValue({ data: { name: 'S', url: 'u', timezone_string: 'UTC' } });
    await client.getSiteTimezone();
    await client.getSiteTimezone();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('degrades to {} (UTC) when the REST index cannot be read', async () => {
    mockGet.mockRejectedValue(new Error('network'));
    await expect(client.getSiteTimezone()).resolves.toEqual({});
  });

  it('degrades to {} when the index payload is not an object', async () => {
    mockGet.mockResolvedValue({ data: '<html>not json</html>' });
    await expect(client.getSiteTimezone()).resolves.toEqual({});
  });
});

describe('WordPressHttpClient.pollRecords total-count headers', () => {
  let mockGet: jest.Mock;
  let client: WordPressHttpClient;

  beforeEach(() => {
    mockGet = jest.fn();
    (createApiClient as jest.Mock).mockReturnValue({ get: mockGet });
    client = new WordPressHttpClient('https://example.com/wp-json/', 'user', 'pass');
  });

  it('parses X-WP-Total and X-WP-TotalPages from the response headers', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 1 }], headers: { 'x-wp-total': '468', 'x-wp-totalpages': '5' } });
    await expect(client.pollRecords('categories', 1, 100)).resolves.toEqual({
      records: [{ id: 1 }],
      total: 468,
      totalPages: 5,
    });
  });

  it('leaves total/totalPages undefined when the headers are absent', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 1 }] });
    await expect(client.pollRecords('categories', 1, 100)).resolves.toEqual({
      records: [{ id: 1 }],
      total: undefined,
      totalPages: undefined,
    });
  });

  it('leaves total undefined for a malformed header value', async () => {
    mockGet.mockResolvedValue({ data: [], headers: { 'x-wp-total': 'not-a-number' } });
    const result = await client.pollRecords('categories', 1, 100);
    expect(result.total).toBeUndefined();
  });
});

describe('WordPressHttpClient.pollRecords past-the-last-page handling', () => {
  let mockGet: jest.Mock;
  let client: WordPressHttpClient;

  beforeEach(() => {
    mockGet = jest.fn();
    (createApiClient as jest.Mock).mockReturnValue({ get: mockGet });
    client = new WordPressHttpClient('https://example.com/wp-json/', 'user', 'pass');
  });

  /** An axios-shaped rejection carrying a WordPress error body. */
  function axiosError(status: number, code: string) {
    return Object.assign(new Error(`HTTP ${status}`), {
      isAxiosError: true,
      response: { status, data: { code, message: 'error' } },
    });
  }

  it('maps a 400 rest_post_invalid_page_number to an empty page (clean end of collection)', async () => {
    mockGet.mockRejectedValue(axiosError(400, 'rest_post_invalid_page_number'));
    await expect(client.pollRecords('posts', 95, 100)).resolves.toEqual({
      records: [],
      total: undefined,
      totalPages: undefined,
    });
  });

  it('maps a term-controller *_invalid_page_number variant to an empty page too', async () => {
    mockGet.mockRejectedValue(axiosError(400, 'rest_term_invalid_page_number'));
    await expect(client.pollRecords('categories', 50, 100)).resolves.toEqual({
      records: [],
      total: undefined,
      totalPages: undefined,
    });
  });

  it('aborts (throws WordPressInvalidFirstPageError) when page 1 returns *_invalid_page_number', async () => {
    // Stock WordPress can't 400 on page 1 (empty table → empty page; the error
    // only fires past the last page). A page-1 400 means a plugin is overriding
    // pagination and reporting the whole table as out of range — completing here
    // would scan zero records and let the delete detector tombstone the table
    // (DEV-10912).
    mockGet.mockRejectedValue(axiosError(400, 'rest_post_invalid_page_number'));
    await expect(client.pollRecords('posts', 1, 100)).rejects.toThrow(WordPressInvalidFirstPageError);
  });

  it('aborts on a page-1 term-controller *_invalid_page_number variant too', async () => {
    mockGet.mockRejectedValue(axiosError(400, 'rest_term_invalid_page_number'));
    await expect(client.pollRecords('categories', 1, 100)).rejects.toThrow(WordPressInvalidFirstPageError);
  });

  it('rethrows a different 400 (e.g. rest_forbidden) rather than swallowing it', async () => {
    mockGet.mockRejectedValue(axiosError(400, 'rest_forbidden'));
    await expect(client.pollRecords('posts', 1, 100)).rejects.toThrow('HTTP 400');
  });
});
