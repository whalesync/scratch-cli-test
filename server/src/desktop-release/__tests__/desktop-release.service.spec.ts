/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining() / expect.anything() return any */
import { NotFoundException } from '@nestjs/common';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DesktopReleaseService } from '../desktop-release.service';

// Mock ioredis with a key-aware in-memory store so tests exercise the real cache-key behavior
// (fresh / last-known-good / negative markers all live under different keys).
let redisStore: Map<string, string>;
const mockRedisGet = jest.fn((key: string) => Promise.resolve(redisStore.get(key) ?? null));
const mockRedisSet = jest.fn((key: string, value: string) => {
  redisStore.set(key, value);
  return Promise.resolve('OK');
});
const mockRedisQuit = jest.fn().mockResolvedValue(undefined);

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    quit: mockRedisQuit,
  }));
});

const CACHE_KEY_PREFIX = 'desktop-release:latest:v4:';
const freshCacheKey = (kind: string, channel: string): string => `${CACHE_KEY_PREFIX}${kind}:${channel}`;
const lastKnownGoodCacheKey = (kind: string, channel: string): string =>
  `${CACHE_KEY_PREFIX}${kind}:${channel}:last-good`;
const negativeCacheKey = (kind: string, channel: string): string => `${CACHE_KEY_PREFIX}${kind}:${channel}:negative`;

interface FakeRelease {
  tag_name: string;
  name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  assets?: { name: string; browser_download_url: string; size: number }[];
}

function makeRelease(tag: string, overrides: Partial<FakeRelease> = {}, repo = 'whalesync/scratch-cli'): FakeRelease {
  return {
    tag_name: tag,
    name: tag,
    html_url: `https://github.com/${repo}/releases/tag/${tag}`,
    draft: false,
    published_at: '2026-05-01T00:00:00Z',
    assets: [],
    ...overrides,
  };
}

function makeDesktopRelease(tag: string, overrides: Partial<FakeRelease> = {}): FakeRelease {
  return makeRelease(tag, overrides, 'whalesync/scratch-desktop');
}

function mockFetchOnce(releases: FakeRelease[]): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValueOnce({
    ok: true,
    json: jest.fn().mockResolvedValue(releases),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function mockFetchNonOk(status: number): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({ ok: false, status, json: jest.fn() });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function makeService(isProduction: boolean, githubReleasesToken?: string): DesktopReleaseService {
  const config = {
    isProductionEnvironment: () => isProduction,
    getRedisHost: () => 'localhost',
    getRedisPort: () => 6379,
    getRedisPassword: () => undefined,
    getGithubReleasesToken: () => githubReleasesToken,
  } as unknown as ScratchConfigService;
  return new DesktopReleaseService(config);
}

describe('DesktopReleaseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisStore = new Map();
  });

  describe('getLatestCliRelease — production channel', () => {
    it('returns the latest tag matching ^v\\d+\\.\\d+\\.\\d+$ and skips desktop / test tags', async () => {
      mockFetchOnce([
        // First (newest) is a desktop-test build — should be skipped.
        makeRelease('v0.5.0-desktop-test'),
        // Then a desktop prod build — also skipped.
        makeRelease('v0.5.0-desktop'),
        // Then a CLI test build — also skipped.
        makeRelease('v0.4.2-test'),
        // Then the actual CLI prod build — this is the one we want.
        makeRelease('v0.4.1', {
          assets: [
            {
              name: 'scratchmd_darwin_arm64.tar.gz',
              browser_download_url: 'https://example/scratchmd_darwin_arm64.tar.gz',
              size: 1234,
            },
          ],
        }),
        // Older CLI prod build — would match the predicate but never reached.
        makeRelease('v0.4.0'),
      ]);

      const service = makeService(true);
      const result = await service.getLatestCliRelease();

      expect(result.tagName).toBe('v0.4.1');
      expect(result.version).toBe('0.4.1');
      expect(result.channel).toBe('production');
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].name).toBe('scratchmd_darwin_arm64.tar.gz');
    });
  });

  describe('getLatestCliRelease — test channel', () => {
    it('picks up -test tags but never -desktop-test', async () => {
      mockFetchOnce([
        // Newest is a desktop-test — must NOT be picked up by CLI test predicate.
        makeRelease('v0.5.0-desktop-test'),
        // Then a CLI test — this is the match.
        makeRelease('v0.4.2-test'),
        // Older entries
        makeRelease('v0.4.1'),
        makeRelease('v0.4.0-desktop-test'),
      ]);

      const service = makeService(false);
      const result = await service.getLatestCliRelease();

      expect(result.tagName).toBe('v0.4.2-test');
      expect(result.version).toBe('0.4.2');
      expect(result.channel).toBe('test');
    });
  });

  describe('getLatestDesktopRelease', () => {
    it('returns the latest tag matching ^v\\d+\\.\\d+\\.\\d+$ for production, from the main repo', async () => {
      const fetchMock = mockFetchOnce([
        makeDesktopRelease('v1.5.0-test'),
        makeDesktopRelease('v1.4.8', {
          assets: [
            {
              name: 'Scratch-1.4.8-arm64.dmg',
              browser_download_url: 'https://example/Scratch-1.4.8-arm64.dmg',
              size: 9999,
            },
          ],
        }),
        makeDesktopRelease('v1.4.7'),
      ]);

      const service = makeService(true);
      const result = await service.getLatestDesktopRelease();

      expect(result.tagName).toBe('v1.4.8');
      expect(result.version).toBe('1.4.8');
      expect(result.channel).toBe('production');
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].name).toBe('Scratch-1.4.8-arm64.dmg');
      // Production desktop releases come from the main repo, never the -test repo (DEV-11320).
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('whalesync/scratch-desktop/releases'),
        expect.anything(),
      );
    });

    it('skips production releases marked as prerelease', async () => {
      mockFetchOnce([makeDesktopRelease('v1.5.0', { prerelease: true }), makeDesktopRelease('v1.4.8')]);

      const service = makeService(true);
      const result = await service.getLatestDesktopRelease();

      expect(result.tagName).toBe('v1.4.8');
    });

    it('returns the latest -test tag for test channel, from the dedicated test repo', async () => {
      const fetchMock = mockFetchOnce([
        makeDesktopRelease('v1.4.8'),
        makeDesktopRelease('v0.5.1-test'),
        makeDesktopRelease('v0.5.0-test'),
      ]);

      const service = makeService(false);
      const result = await service.getLatestDesktopRelease();

      expect(result.tagName).toBe('v0.5.1-test');
      expect(result.version).toBe('0.5.1');
      expect(result.channel).toBe('test');
      // Test desktop releases live in their own GitHub repo, split from production (DEV-11320).
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('whalesync/scratch-desktop-test/releases'),
        expect.anything(),
      );
    });
  });

  describe('GitHub authentication', () => {
    it('sends an Authorization header when a token is configured', async () => {
      const fetchMock = mockFetchOnce([makeDesktopRelease('v1.4.8')]);

      const service = makeService(true, 'ghp_test_token');
      await service.getLatestDesktopRelease();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('whalesync/scratch-desktop'),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer ghp_test_token' }),
        }),
      );
    });

    it('omits the Authorization header when no token is configured', async () => {
      const fetchMock = mockFetchOnce([makeDesktopRelease('v1.4.8')]);

      const service = makeService(true);
      await service.getLatestDesktopRelease();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.not.objectContaining({ Authorization: expect.anything() }),
        }),
      );
    });
  });

  describe('caching', () => {
    it('returns cached value without calling fetch', async () => {
      const cached = {
        name: 'v0.4.1',
        tagName: 'v0.4.1',
        version: '0.4.1',
        htmlUrl: 'https://example',
        publishedAt: '2026-05-01T00:00:00Z',
        channel: 'production' as const,
        assets: [],
      };
      redisStore.set(freshCacheKey('cli', 'production'), JSON.stringify(cached));
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;

      const service = makeService(true);
      const result = await service.getLatestCliRelease();

      expect(result).toEqual(cached);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('uses kind-specific cache keys (CLI cache miss does not return desktop entry)', async () => {
      const desktopCached = {
        name: 'v1.4.8',
        tagName: 'v1.4.8',
        version: '1.4.8',
        htmlUrl: 'https://example',
        publishedAt: '2026-05-01T00:00:00Z',
        channel: 'production' as const,
        assets: [],
      };
      // Desktop is cached; CLI is not — the CLI lookup must fall through to fetch.
      redisStore.set(freshCacheKey('desktop', 'production'), JSON.stringify(desktopCached));
      const fetchMock = mockFetchOnce([makeRelease('v0.4.1')]);

      const service = makeService(true);
      const cli = await service.getLatestCliRelease();
      const desktop = await service.getLatestDesktopRelease();

      expect(cli.tagName).toBe('v0.4.1');
      expect(desktop.tagName).toBe('v1.4.8');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('writes both the fresh and last-known-good cache entries on success', async () => {
      mockFetchOnce([makeDesktopRelease('v1.4.8')]);

      const service = makeService(true);
      await service.getLatestDesktopRelease();

      expect(redisStore.has(freshCacheKey('desktop', 'production'))).toBe(true);
      expect(redisStore.has(lastKnownGoodCacheKey('desktop', 'production'))).toBe(true);
    });
  });

  describe('resilience — stale-on-error and negative cache', () => {
    it('serves the last-known-good release when GitHub returns a non-ok status', async () => {
      const lastGood = {
        name: 'v1.4.8',
        tagName: 'v1.4.8',
        version: '1.4.8',
        htmlUrl: 'https://example',
        publishedAt: '2026-05-01T00:00:00Z',
        channel: 'production' as const,
        assets: [],
      };
      redisStore.set(lastKnownGoodCacheKey('desktop', 'production'), JSON.stringify(lastGood));
      mockFetchNonOk(403);

      const service = makeService(true);
      const result = await service.getLatestDesktopRelease();

      expect(result).toEqual(lastGood);
    });

    it('negative-caches a 404 so a second request does not re-hit GitHub', async () => {
      const fetchMock = mockFetchNonOk(403);

      const service = makeService(true);
      await expect(service.getLatestDesktopRelease()).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getLatestDesktopRelease()).rejects.toBeInstanceOf(NotFoundException);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(redisStore.has(negativeCacheKey('desktop', 'production'))).toBe(true);
    });
  });

  describe('failure cases', () => {
    it('throws NotFoundException when no matching release is found', async () => {
      mockFetchOnce([makeRelease('v0.4.0-desktop'), makeRelease('v0.4.0-desktop-test')]);

      const service = makeService(true);
      await expect(service.getLatestCliRelease()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when GitHub fetch fails and there is no last-known-good', async () => {
      global.fetch = jest.fn().mockRejectedValueOnce(new Error('network down')) as unknown as typeof fetch;

      const service = makeService(true);
      await expect(service.getLatestCliRelease()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('skips draft releases', async () => {
      mockFetchOnce([makeRelease('v0.4.2', { draft: true }), makeRelease('v0.4.1', { draft: false })]);

      const service = makeService(true);
      const result = await service.getLatestCliRelease();

      expect(result.tagName).toBe('v0.4.1');
    });
  });
});
