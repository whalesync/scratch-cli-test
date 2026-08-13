import { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { createApiClient } from '../create-api-client';

/**
 * An axios adapter that resolves a canned 200 response without any network I/O and
 * records the fully-merged request config, so we can assert on the headers axios
 * would actually have put on the wire.
 */
function recordingAdapter(recordedRequestConfigs: InternalAxiosRequestConfig[]) {
  return (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    recordedRequestConfigs.push(config);
    return Promise.resolve({
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      request: {},
    });
  };
}

describe('createApiClient — authorizationHeaderValueProvider', () => {
  it('resolves the Authorization header separately for every request', async () => {
    // A connection whose access token is refreshed by the host mid-job: the second
    // request must carry the new token, not the one that existed at construction
    // (DEV-11270 — a client that captured the token once 401'd for the rest of a
    // long publish once the original token expired).
    const accessTokensInIssueOrder = ['token-before-refresh', 'token-after-refresh'];
    const recordedRequestConfigs: InternalAxiosRequestConfig[] = [];

    const client = createApiClient(
      { baseURL: 'https://example.test', adapter: recordingAdapter(recordedRequestConfigs) },
      {
        authorizationHeaderValueProvider: () =>
          Promise.resolve(`Bearer ${accessTokensInIssueOrder.shift() ?? 'no-token-left'}`),
      },
    );

    await client.get('/first');
    await client.get('/second');

    expect(recordedRequestConfigs.map((config) => config.headers.Authorization)).toEqual([
      'Bearer token-before-refresh',
      'Bearer token-after-refresh',
    ]);
  });

  it('leaves other configured headers untouched', async () => {
    const recordedRequestConfigs: InternalAxiosRequestConfig[] = [];
    const client = createApiClient(
      {
        baseURL: 'https://example.test',
        headers: { 'Notion-Version': '2022-06-28' },
        adapter: recordingAdapter(recordedRequestConfigs),
      },
      { authorizationHeaderValueProvider: () => Promise.resolve('Bearer abc') },
    );

    await client.get('/anything');

    expect(recordedRequestConfigs[0].headers['Notion-Version']).toBe('2022-06-28');
    expect(recordedRequestConfigs[0].headers.Authorization).toBe('Bearer abc');
  });

  it('sends no Authorization header when no provider is supplied', async () => {
    const recordedRequestConfigs: InternalAxiosRequestConfig[] = [];
    const client = createApiClient({
      baseURL: 'https://example.test',
      adapter: recordingAdapter(recordedRequestConfigs),
    });

    await client.get('/anything');

    expect(recordedRequestConfigs[0].headers.Authorization).toBeUndefined();
  });

  it('propagates a provider failure to the caller instead of sending an unauthenticated request', async () => {
    const recordedRequestConfigs: InternalAxiosRequestConfig[] = [];
    const client = createApiClient(
      { baseURL: 'https://example.test', adapter: recordingAdapter(recordedRequestConfigs) },
      {
        authorizationHeaderValueProvider: () => Promise.reject(new Error('refresh token revoked')),
      },
    );

    await expect(client.get('/anything')).rejects.toThrow('refresh token revoked');
    expect(recordedRequestConfigs).toHaveLength(0);
  });
});
