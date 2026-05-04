import { NotFoundException } from '@nestjs/common';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DesktopReleaseService } from '../desktop-release.service';

// Mock ioredis — prevent real connections. Each test resets the get/set mocks.
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisQuit = jest.fn().mockResolvedValue(undefined);

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    quit: mockRedisQuit,
  }));
});

interface FakeRelease {
  tag_name: string;
  name?: string;
  html_url?: string;
  draft?: boolean;
  published_at?: string;
  assets?: { name: string; browser_download_url: string; size: number }[];
}

function makeRelease(tag: string, overrides: Partial<FakeRelease> = {}): FakeRelease {
  return {
    tag_name: tag,
    name: tag,
    html_url: `https://github.com/whalesync/scratch-cli/releases/tag/${tag}`,
    draft: false,
    published_at: '2026-05-01T00:00:00Z',
    assets: [],
    ...overrides,
  };
}

function mockFetchOnce(releases: FakeRelease[]): void {
  global.fetch = jest.fn().mockResolvedValueOnce({
    ok: true,
    json: jest.fn().mockResolvedValue(releases),
  }) as unknown as typeof fetch;
}

function makeService(isProduction: boolean): DesktopReleaseService {
  const config = {
    isProductionEnvironment: () => isProduction,
    getRedisHost: () => 'localhost',
    getRedisPort: () => 6379,
    getRedisPassword: () => undefined,
  } as unknown as ScratchConfigService;
  return new DesktopReleaseService(config);
}

describe('DesktopReleaseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
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
    it('still works for production (suffix -desktop)', async () => {
      mockFetchOnce([makeRelease('v0.5.0-desktop-test'), makeRelease('v0.4.1'), makeRelease('v0.4.0-desktop')]);

      const service = makeService(true);
      const result = await service.getLatestDesktopRelease();

      expect(result.tagName).toBe('v0.4.0-desktop');
      expect(result.channel).toBe('production');
    });

    it('still works for test (suffix -desktop-test)', async () => {
      mockFetchOnce([makeRelease('v0.4.2-test'), makeRelease('v0.4.0-desktop-test'), makeRelease('v0.4.0-desktop')]);

      const service = makeService(false);
      const result = await service.getLatestDesktopRelease();

      expect(result.tagName).toBe('v0.4.0-desktop-test');
      expect(result.channel).toBe('test');
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
      mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;

      const service = makeService(true);
      const result = await service.getLatestCliRelease();

      expect(result).toEqual(cached);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('uses kind-specific cache keys (CLI cache miss does not return desktop entry)', async () => {
      const desktopCached = {
        name: 'v0.4.0-desktop',
        tagName: 'v0.4.0-desktop',
        version: '0.4.0',
        htmlUrl: 'https://example',
        publishedAt: '2026-05-01T00:00:00Z',
        channel: 'production' as const,
        assets: [],
      };
      // First call (CLI) — miss; second call (desktop) — hit.
      mockRedisGet
        .mockImplementationOnce((key: string) => {
          expect(key).toContain('cli');
          return Promise.resolve(null);
        })
        .mockImplementationOnce((key: string) => {
          expect(key).toContain('desktop');
          return Promise.resolve(JSON.stringify(desktopCached));
        });
      mockFetchOnce([makeRelease('v0.4.1')]);

      const service = makeService(true);
      const cli = await service.getLatestCliRelease();
      const desktop = await service.getLatestDesktopRelease();

      expect(cli.tagName).toBe('v0.4.1');
      expect(desktop.tagName).toBe('v0.4.0-desktop');
    });
  });

  describe('failure cases', () => {
    it('throws NotFoundException when no matching release is found', async () => {
      mockFetchOnce([makeRelease('v0.4.0-desktop'), makeRelease('v0.4.0-desktop-test')]);

      const service = makeService(true);
      await expect(service.getLatestCliRelease()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when GitHub fetch fails', async () => {
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
