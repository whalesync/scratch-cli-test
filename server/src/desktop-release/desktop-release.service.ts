import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { DesktopReleaseAsset, DesktopReleaseResponse } from '@spinner/shared-types';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';

const RELEASES_PER_PAGE = 30;
const MAX_RELEASE_PAGES = 5;

const GITHUB_REPO_BY_KIND: Record<ReleaseKind, string> = {
  desktop: 'whalesync/scratch-desktop',
  cli: 'whalesync/scratch-cli',
};

function releasesListUrl(kind: ReleaseKind, page: number): string {
  return `https://api.github.com/repos/${GITHUB_REPO_BY_KIND[kind]}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`;
}
const CACHE_KEY_PREFIX = 'desktop-release:latest:v4:';
const FRESH_CACHE_TTL_SECONDS = 5 * 60;
// Long-lived fallback served when GitHub is unreachable/rate-limited (stale-while-error). As long as
// we successfully resolved a release at least once in this window, a GitHub outage won't 404 the page.
const LAST_KNOWN_GOOD_TTL_SECONDS = 30 * 24 * 60 * 60;
// Short throttle window. Applied both to a negative (404) result and to serving a stale release on
// error, so a sustained GitHub failure re-hits GitHub at most once per window instead of on every
// request — which is what kept the anonymous rate limit pinned in the original incident.
const SHORT_THROTTLE_TTL_SECONDS = 60;
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
  prerelease: boolean;
  published_at: string;
  assets: GitHubReleaseAsset[];
}

type Channel = 'production' | 'test';
type ReleaseKind = 'desktop' | 'cli';

/**
 * Outcome of scanning GitHub for the latest matching release. `error` (GitHub unreachable / non-ok
 * status) is kept distinct from `no-match` (we reached GitHub but nothing matched the predicate) so
 * `getLatest` can serve a stale release on `error` while still 404ing on a genuine `no-match`.
 */
type FetchReleaseResult = { status: 'found'; release: GitHubRelease } | { status: 'no-match' } | { status: 'error' };

interface ReleaseLookup {
  kind: ReleaseKind;
  channel: Channel;
  matchTag: (tag: string) => boolean;
  notFoundMessage: string;
}

function lookupFor(kind: ReleaseKind, channel: Channel): ReleaseLookup {
  if (kind === 'desktop') {
    const matchTag =
      channel === 'production'
        ? (t: string) => /^v\d+\.\d+\.\d+$/.test(t)
        : (t: string) => /^v\d+\.\d+\.\d+-test$/.test(t);
    return {
      kind,
      channel,
      matchTag,
      notFoundMessage: `No desktop release found for channel "${channel}"`,
    };
  }
  // kind === 'cli' — prod tags have no suffix (vX.Y.Z); test tags end in -test.
  // Legacy desktop tags (-desktop, -desktop-test) may still exist on the CLI repo
  // and must be excluded from the test predicate.
  const matchTag =
    channel === 'production'
      ? (t: string) => /^v\d+\.\d+\.\d+$/.test(t)
      : (t: string) => t.endsWith('-test') && !t.endsWith('-desktop-test');
  return {
    kind,
    channel,
    matchTag,
    notFoundMessage: `No CLI release found for channel "${channel}"`,
  };
}

function extractVersion(tagName: string): string {
  return tagName.match(/\d+\.\d+\.\d+/)?.[0] ?? tagName;
}

@Injectable()
export class DesktopReleaseService implements OnModuleDestroy {
  private readonly redis: IORedis;
  private readonly githubReleasesToken: string | undefined;

  constructor(private readonly configService: ScratchConfigService) {
    this.redis = new IORedis({
      host: this.configService.getRedisHost(),
      port: this.configService.getRedisPort(),
      password: this.configService.getRedisPassword(),
      maxRetriesPerRequest: null,
    });
    this.githubReleasesToken = this.configService.getGithubReleasesToken();
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => {});
  }

  getLatestDesktopRelease(): Promise<DesktopReleaseResponse> {
    return this.getLatest('desktop');
  }

  getLatestCliRelease(): Promise<DesktopReleaseResponse> {
    return this.getLatest('cli');
  }

  private async getLatest(kind: ReleaseKind): Promise<DesktopReleaseResponse> {
    const channel: Channel = this.configService.isProductionEnvironment() ? 'production' : 'test';
    const lookup = lookupFor(kind, channel);

    const freshCacheKey = this.freshCacheKey(kind, channel);
    const lastKnownGoodCacheKey = this.lastKnownGoodCacheKey(kind, channel);
    const negativeCacheKey = this.negativeCacheKey(kind, channel);

    const freshCachedResponse = await this.readCachedResponse(freshCacheKey, kind, channel);
    if (freshCachedResponse) return freshCachedResponse;

    // A recent lookup already failed/came up empty — return 404 without re-hitting GitHub, so a
    // rate-limit or outage isn't re-pinned by a storm of uncached requests.
    if (await this.hasNegativeCacheMarker(negativeCacheKey)) {
      throw new NotFoundException(lookup.notFoundMessage);
    }

    const fetchResult = await this.fetchLatestRelease(kind, lookup.matchTag, channel);

    if (fetchResult.status === 'found') {
      const response = this.toDesktopReleaseResponse(fetchResult.release, channel);
      await this.writeCachedResponse(freshCacheKey, response, FRESH_CACHE_TTL_SECONDS, kind, channel);
      await this.writeCachedResponse(lastKnownGoodCacheKey, response, LAST_KNOWN_GOOD_TTL_SECONDS, kind, channel);
      return response;
    }

    if (fetchResult.status === 'error') {
      // GitHub is unreachable or rate-limited. Prefer serving the last release we successfully
      // resolved over 404ing the (unauthenticated) download page on a transient blip.
      const lastKnownGoodResponse = await this.readCachedResponse(lastKnownGoodCacheKey, kind, channel);
      if (lastKnownGoodResponse) {
        // Re-cache briefly under the fresh key so we keep serving the good release for a short
        // window without calling GitHub on every request while it's down.
        await this.writeCachedResponse(freshCacheKey, lastKnownGoodResponse, SHORT_THROTTLE_TTL_SECONDS, kind, channel);
        WSLogger.warn({
          source: 'DesktopReleaseService',
          message: 'Serving last-known-good release after a GitHub fetch error',
          kind,
          channel,
        });
        return lastKnownGoodResponse;
      }
      WSLogger.warn({
        source: 'DesktopReleaseService',
        message: 'GitHub fetch failed and no last-known-good release is cached',
        kind,
        channel,
      });
    } else {
      // status === 'no-match': we reached GitHub but nothing matched the channel predicate.
      WSLogger.warn({
        source: 'DesktopReleaseService',
        message: 'No matching release found after scanning GitHub releases',
        kind,
        channel,
      });
    }

    await this.writeNegativeCacheMarker(negativeCacheKey, kind, channel);
    throw new NotFoundException(lookup.notFoundMessage);
  }

  private toDesktopReleaseResponse(release: GitHubRelease, channel: Channel): DesktopReleaseResponse {
    return {
      name: release.name,
      tagName: release.tag_name,
      version: extractVersion(release.tag_name),
      htmlUrl: release.html_url,
      publishedAt: release.published_at,
      channel,
      assets: release.assets.map(
        (asset): DesktopReleaseAsset => ({
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size,
        }),
      ),
    };
  }

  private freshCacheKey(kind: ReleaseKind, channel: Channel): string {
    return `${CACHE_KEY_PREFIX}${kind}:${channel}`;
  }

  private lastKnownGoodCacheKey(kind: ReleaseKind, channel: Channel): string {
    return `${CACHE_KEY_PREFIX}${kind}:${channel}:last-good`;
  }

  private negativeCacheKey(kind: ReleaseKind, channel: Channel): string {
    return `${CACHE_KEY_PREFIX}${kind}:${channel}:negative`;
  }

  private async readCachedResponse(
    key: string,
    kind: ReleaseKind,
    channel: Channel,
  ): Promise<DesktopReleaseResponse | null> {
    try {
      const data = await this.redis.get(key);
      return data ? (JSON.parse(data) as DesktopReleaseResponse) : null;
    } catch (err) {
      WSLogger.warn({
        source: 'DesktopReleaseService',
        message: 'Failed to read release from Redis cache',
        kind,
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async writeCachedResponse(
    key: string,
    value: DesktopReleaseResponse,
    ttlSeconds: number,
    kind: ReleaseKind,
    channel: Channel,
  ): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      WSLogger.warn({
        source: 'DesktopReleaseService',
        message: 'Failed to write release to Redis cache',
        kind,
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async hasNegativeCacheMarker(key: string): Promise<boolean> {
    try {
      return (await this.redis.get(key)) !== null;
    } catch {
      // A cache read failure should not block a real lookup — fall through to GitHub.
      return false;
    }
  }

  private async writeNegativeCacheMarker(key: string, kind: ReleaseKind, channel: Channel): Promise<void> {
    try {
      await this.redis.set(key, '1', 'EX', SHORT_THROTTLE_TTL_SECONDS);
    } catch (err) {
      WSLogger.warn({
        source: 'DesktopReleaseService',
        message: 'Failed to write negative cache marker',
        kind,
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async fetchLatestRelease(
    kind: ReleaseKind,
    matchTag: (tag: string) => boolean,
    channel: Channel,
  ): Promise<FetchReleaseResult> {
    try {
      for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
        const res = await fetch(releasesListUrl(kind, page), {
          headers: this.githubRequestHeaders(),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          WSLogger.warn({
            source: 'DesktopReleaseService',
            message: 'GitHub releases API returned non-ok status',
            status: res.status,
            page,
          });
          return { status: 'error' };
        }
        const releases = (await res.json()) as GitHubRelease[];
        const match = releases.find(
          (r) => !r.draft && (channel !== 'production' || !r.prerelease) && matchTag(r.tag_name),
        );
        if (match) return { status: 'found', release: match };
        if (releases.length < RELEASES_PER_PAGE) break;
      }
      return { status: 'no-match' };
    } catch (err) {
      WSLogger.error({
        source: 'DesktopReleaseService',
        message: 'Failed to fetch GitHub releases',
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'error' };
    }
  }

  private githubRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.githubReleasesToken) {
      // Authenticated requests get 5,000 req/hr (vs 60/hr anonymous) and avoid the harsher
      // throttling GitHub applies to unauthenticated traffic from shared cloud egress IPs.
      headers.Authorization = `Bearer ${this.githubReleasesToken}`;
    }
    return headers;
  }
}
