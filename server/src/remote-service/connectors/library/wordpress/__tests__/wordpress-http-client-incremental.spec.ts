import { createApiClient } from '../../../create-api-client';
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
    await client.pollRecords('posts', 0, 100);
    const url = lastRequestedUrl();
    expect(url.searchParams.get('modified_after')).toBeNull();
    expect(url.searchParams.get('status')).toBe('any');
    expect(url.searchParams.get('context')).toBe('edit');
  });

  it('passes the site-local datetime string through verbatim (no re-encoding of the value itself)', async () => {
    await client.pollRecords('posts', 0, 100, '2026-05-14T07:59:00');
    expect(lastRequestedUrl().searchParams.get('modified_after')).toBe('2026-05-14T07:59:00');
  });

  it('keeps offset pagination alongside modified_after', async () => {
    await client.pollRecords('posts', 200, 100, '2026-05-14T07:59:00');
    const url = lastRequestedUrl();
    expect(url.searchParams.get('offset')).toBe('200');
    expect(url.searchParams.get('modified_after')).toBe('2026-05-14T07:59:00');
  });

  it('media collections also accept modified_after (and skip status=any)', async () => {
    await client.pollRecords('media', 0, 100, '2026-05-14T07:59:00');
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
    await expect(client.pollRecords('categories', 0, 100)).resolves.toEqual({
      records: [{ id: 1 }],
      total: 468,
      totalPages: 5,
    });
  });

  it('leaves total/totalPages undefined when the headers are absent', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 1 }] });
    await expect(client.pollRecords('categories', 0, 100)).resolves.toEqual({
      records: [{ id: 1 }],
      total: undefined,
      totalPages: undefined,
    });
  });

  it('leaves total undefined for a malformed header value', async () => {
    mockGet.mockResolvedValue({ data: [], headers: { 'x-wp-total': 'not-a-number' } });
    const result = await client.pollRecords('categories', 0, 100);
    expect(result.total).toBeUndefined();
  });
});
