import { OAuthService } from '../../../oauth/oauth.service';
import { ConnectorAuthTokenProvider } from '../connector-auth-token';
import { ConnectorsService } from '../connectors.service';

/**
 * `createOAuthAccessTokenProvider` is private (connectors only ever receive it
 * through the factory context), so reach it through a narrow structural cast
 * rather than exposing it on the public surface just for tests.
 */
function accessTokenProviderFor(
  connectorsService: ConnectorsService,
  connectorAccountId: string,
): ConnectorAuthTokenProvider {
  const withPrivateFactory = connectorsService as unknown as {
    createOAuthAccessTokenProvider(connectorAccountId: string): ConnectorAuthTokenProvider;
  };
  return withPrivateFactory.createOAuthAccessTokenProvider(connectorAccountId);
}

function buildConnectorsService(getValidAccessToken: jest.Mock): {
  connectorsService: ConnectorsService;
  getValidAccessToken: jest.Mock;
} {
  const oauthService = { getValidAccessToken } as unknown as OAuthService;
  const connectorsService = new ConnectorsService(
    oauthService,
    // The provider only touches OAuthService; the other collaborators are never
    // reached on this path.
    {} as never,
    {} as never,
    {} as never,
  );
  return { connectorsService, getValidAccessToken };
}

describe('ConnectorsService — OAuth access token provider (DEV-11270)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('re-resolves the token once the reuse window has elapsed, so a long job picks up a refresh', async () => {
    jest.useFakeTimers();
    const getValidAccessToken = jest
      .fn<Promise<string>, [string]>()
      .mockResolvedValueOnce('token-issued-at-start')
      .mockResolvedValueOnce('token-issued-after-refresh');
    const { connectorsService } = buildConnectorsService(getValidAccessToken);
    const provider = accessTokenProviderFor(connectorsService, 'coa_1');

    await expect(provider()).resolves.toBe('token-issued-at-start');
    // Still inside the reuse window: served from memory, no credential read.
    jest.setSystemTime(Date.now() + 30_000);
    await expect(provider()).resolves.toBe('token-issued-at-start');
    expect(getValidAccessToken).toHaveBeenCalledTimes(1);

    // Past the reuse window: the host is consulted again and hands back the
    // token it refreshed in the meantime.
    jest.setSystemTime(Date.now() + 61_000);
    await expect(provider()).resolves.toBe('token-issued-after-refresh');
    expect(getValidAccessToken).toHaveBeenCalledTimes(2);
    expect(getValidAccessToken).toHaveBeenCalledWith('coa_1');
  });

  it('shares one in-flight resolution across concurrent callers', async () => {
    let resolveTokenResolution: ((accessToken: string) => void) | undefined;
    const getValidAccessToken = jest.fn<Promise<string>, [string]>().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveTokenResolution = resolve;
        }),
    );
    const { connectorsService } = buildConnectorsService(getValidAccessToken);
    const provider = accessTokenProviderFor(connectorsService, 'coa_1');

    const concurrentResolutions = Promise.all([provider(), provider(), provider()]);
    resolveTokenResolution?.('shared-token');

    await expect(concurrentResolutions).resolves.toEqual(['shared-token', 'shared-token', 'shared-token']);
    expect(getValidAccessToken).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent resolutions across connector instances on the same connection', async () => {
    // Two connector instances on one connection — e.g. a publish and a pull, or
    // two publish plans — both crossing the refresh boundary at once. Without
    // cross-instance coalescing each would enter refreshOAuthTokens, whose
    // unguarded read-modify-write can persist an already-consumed refresh token
    // for the providers that rotate them (Airtable, Intuit, GoHighLevel).
    let resolveTokenResolution: ((accessToken: string) => void) | undefined;
    const getValidAccessToken = jest.fn<Promise<string>, [string]>().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveTokenResolution = resolve;
        }),
    );
    const { connectorsService } = buildConnectorsService(getValidAccessToken);

    const publishJobResolution = accessTokenProviderFor(connectorsService, 'coa_1')();
    const pullJobResolution = accessTokenProviderFor(connectorsService, 'coa_1')();
    resolveTokenResolution?.('single-refreshed-token');

    await expect(Promise.all([publishJobResolution, pullJobResolution])).resolves.toEqual([
      'single-refreshed-token',
      'single-refreshed-token',
    ]);
    expect(getValidAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce across different connections', async () => {
    const getValidAccessToken = jest
      .fn<Promise<string>, [string]>()
      .mockImplementation((connectorAccountId) => Promise.resolve(`token-for-${connectorAccountId}`));
    const { connectorsService } = buildConnectorsService(getValidAccessToken);

    await expect(
      Promise.all([
        accessTokenProviderFor(connectorsService, 'coa_1')(),
        accessTokenProviderFor(connectorsService, 'coa_2')(),
      ]),
    ).resolves.toEqual(['token-for-coa_1', 'token-for-coa_2']);
    expect(getValidAccessToken).toHaveBeenCalledTimes(2);
  });

  it('retains no in-flight entry once a resolution settles, so a later job reads fresh credentials', async () => {
    const getValidAccessToken = jest
      .fn<Promise<string>, [string]>()
      .mockResolvedValueOnce('token-before-reauth')
      .mockResolvedValueOnce('token-after-reauth');
    const { connectorsService } = buildConnectorsService(getValidAccessToken);

    await expect(accessTokenProviderFor(connectorsService, 'coa_1')()).resolves.toBe('token-before-reauth');
    // Sequential, not concurrent: nothing to join, so the stored credential is read again.
    await expect(accessTokenProviderFor(connectorsService, 'coa_1')()).resolves.toBe('token-after-reauth');
    expect(getValidAccessToken).toHaveBeenCalledTimes(2);
  });

  it('does not retain a failed resolution, so the next caller retries', async () => {
    const getValidAccessToken = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(new Error('token endpoint unavailable'))
      .mockResolvedValueOnce('token-after-recovery');
    const { connectorsService } = buildConnectorsService(getValidAccessToken);

    await expect(accessTokenProviderFor(connectorsService, 'coa_1')()).rejects.toThrow('token endpoint unavailable');
    await expect(accessTokenProviderFor(connectorsService, 'coa_1')()).resolves.toBe('token-after-recovery');
  });

  it('surfaces a resolution failure and retries on the next call rather than caching it', async () => {
    const getValidAccessToken = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(new Error('refresh token revoked'))
      .mockResolvedValueOnce('token-after-reconnect');
    const { connectorsService } = buildConnectorsService(getValidAccessToken);
    const provider = accessTokenProviderFor(connectorsService, 'coa_1');

    await expect(provider()).rejects.toThrow('refresh token revoked');
    await expect(provider()).resolves.toBe('token-after-reconnect');
    expect(getValidAccessToken).toHaveBeenCalledTimes(2);
  });

  it('gives each connector instance its own cache, so a new job starts from stored credentials', async () => {
    const getValidAccessToken = jest
      .fn<Promise<string>, [string]>()
      .mockResolvedValueOnce('token-for-first-job')
      .mockResolvedValueOnce('token-for-second-job');
    const { connectorsService } = buildConnectorsService(getValidAccessToken);

    await expect(accessTokenProviderFor(connectorsService, 'coa_1')()).resolves.toBe('token-for-first-job');
    await expect(accessTokenProviderFor(connectorsService, 'coa_1')()).resolves.toBe('token-for-second-job');
  });
});
