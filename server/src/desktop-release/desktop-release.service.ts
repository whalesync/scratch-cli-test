import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { DesktopReleaseAsset, DesktopReleaseResponse } from '@spinner/shared-types';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';

const GITHUB_REPO = 'whalesync/scratch-cli';
const RELEASES_PER_PAGE = 30;
const MAX_RELEASE_PAGES = 5;

function releasesListUrl(page: number): string {
  return `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`;
}
const CACHE_KEY_PREFIX = 'desktop-release:latest:v2:';
const CACHE_TTL_SECONDS = 5 * 60;
const FETCH_TIMEOUT_MS = 5000;

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  draft: boolean;
  published_at: string;
  assets: GitHubReleaseAsset[];
}

type Channel = 'production' | 'test';

function extractVersion(tagName: string): string {
  return tagName.match(/\d+\.\d+\.\d+/)?.[0] ?? tagName;
}

@Injectable()
export class DesktopReleaseService implements OnModuleDestroy {
  private readonly redis: IORedis;

  constructor(private readonly configService: ScratchConfigService) {
    this.redis = new IORedis({
      host: this.configService.getRedisHost(),
      port: this.configService.getRedisPort(),
      password: this.configService.getRedisPassword(),
      maxRetriesPerRequest: null,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => {});
  }

  async getLatestDesktopRelease(): Promise<DesktopReleaseResponse> {
    const channel: Channel = this.configService.isProductionEnvironment() ? 'production' : 'test';
    const tagSuffix = channel === 'production' ? '-desktop' : '-desktop-test';

    const cached = await this.readFromCache(channel);
    if (cached) return cached;

    const release = await this.fetchLatestRelease(tagSuffix);
    if (!release) {
      throw new NotFoundException(`No desktop release found matching tag suffix "${tagSuffix}"`);
    }

    const response: DesktopReleaseResponse = {
      name: release.name,
      tagName: release.tag_name,
      version: extractVersion(release.tag_name),
      htmlUrl: release.html_url,
      publishedAt: release.published_at,
      channel,
      assets: release.assets.map(
        (a): DesktopReleaseAsset => ({
          name: a.name,
          url: a.browser_download_url,
          size: a.size,
        }),
      ),
    };

    await this.writeToCache(channel, response);
    return response;
  }

  private cacheKey(channel: Channel): string {
    return `${CACHE_KEY_PREFIX}${channel}`;
  }

  private async readFromCache(channel: Channel): Promise<DesktopReleaseResponse | null> {
    try {
      const data = await this.redis.get(this.cacheKey(channel));
      return data ? (JSON.parse(data) as DesktopReleaseResponse) : null;
    } catch (err) {
      WSLogger.warn({
        source: 'DesktopReleaseService',
        message: 'Failed to read desktop release from Redis cache',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async writeToCache(channel: Channel, value: DesktopReleaseResponse): Promise<void> {
    try {
      await this.redis.set(this.cacheKey(channel), JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
    } catch (err) {
      WSLogger.warn({
        source: 'DesktopReleaseService',
        message: 'Failed to write desktop release to Redis cache',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async fetchLatestRelease(tagSuffix: string): Promise<GitHubRelease | null> {
    try {
      for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
        const res = await fetch(releasesListUrl(page), {
          headers: { Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          WSLogger.warn({
            source: 'DesktopReleaseService',
            message: 'GitHub releases API returned non-ok status',
            status: res.status,
            page,
          });
          return null;
        }
        const releases = (await res.json()) as GitHubRelease[];
        const match = releases.find((r) => !r.draft && r.tag_name.endsWith(tagSuffix));
        if (match) return match;
        if (releases.length < RELEASES_PER_PAGE) break;
      }
      return null;
    } catch (err) {
      WSLogger.error({
        source: 'DesktopReleaseService',
        message: 'Failed to fetch GitHub releases',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
