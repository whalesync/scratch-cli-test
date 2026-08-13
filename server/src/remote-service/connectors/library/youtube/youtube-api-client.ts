import { AxiosInstance, isAxiosError } from 'axios';
import { randomUUID } from 'crypto';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { ConnectorAuthTokenOrProvider, toConnectorAuthTokenProvider } from '../../connector-auth-token';
import { createApiClient } from '../../create-api-client';
import {
  YouTubeCaption,
  YouTubeCaptionListResponse,
  YouTubeChannel,
  YouTubeChannelListResponse,
  YouTubeChannelSection,
  YouTubeChannelSectionListResponse,
  YouTubeCommentThreadListResponse,
  YouTubeMemberListResponse,
  YouTubeMembershipsLevelListResponse,
  YouTubePlaylist,
  YouTubePlaylistItem,
  YouTubePlaylistItemListResponse,
  YouTubePlaylistListResponse,
  YouTubeReferenceListResponse,
  YouTubeSubscription,
  YouTubeSubscriptionListResponse,
  YouTubeVideo,
  YouTubeVideoListResponse,
} from './youtube-types';

/** YouTube's documented `maxResults` ceiling for list endpoints. */
const YOUTUBE_MAX_RESULTS = 50;

/** The channel parts the one-row Channel table reads (everything mutable + the read-only context). */
const CHANNEL_FULL_PARTS = [
  'id',
  'snippet',
  'statistics',
  'contentDetails',
  'status',
  'brandingSettings',
  'localizations',
];

/**
 * Base URL for the YouTube Data API v3. The official `@googleapis/youtube` SDK
 * hardcoded `https://youtube.googleapis.com/` as its `rootUrl` and built every
 * method path as `/youtube/v3/<resource>` (read from its generated `build/v3.js`),
 * so we fold the version segment into the base to keep request paths identical.
 */
const YOUTUBE_API_BASE_URL = 'https://youtube.googleapis.com/youtube/v3';

/**
 * Resumable/multipart caption uploads live on a *separate* path the SDK called
 * its `mediaUrl`: `https://youtube.googleapis.com/upload/youtube/v3/captions`
 * (note the `/upload` prefix, not under `/youtube/v3`). We pass this as an
 * absolute URL so axios bypasses {@link YOUTUBE_API_BASE_URL}.
 */
const YOUTUBE_CAPTIONS_UPLOAD_URL = 'https://youtube.googleapis.com/upload/youtube/v3/captions';

/**
 * Retry options for YouTube API calls — 429-only, matching every other house
 * api-client (the SDK's gaxios transport retried 408/429/5xx, but our jobs are
 * idempotent/resumable so 429 with `Retry-After` is sufficient).
 */
const YOUTUBE_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!isAxiosError(error)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const header = error.response?.headers?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

/** Read the HTTP status off an axios error, or undefined for non-axios errors. */
function httpStatusOf(error: unknown): number | undefined {
  return isAxiosError(error) ? error.response?.status : undefined;
}

/**
 * Pull the human-readable detail out of an error. The YouTube API returns error
 * detail in the response body (`{ error: { message } }`), which axios exposes on
 * `error.response.data` rather than on `error.message` (the generic "Request
 * failed with status code N"), so fall back through both plus the error message.
 */
function apiErrorMessageOf(error: unknown): string {
  if (isAxiosError(error)) {
    const data: unknown = error.response?.data;
    if (data && typeof data === 'object' && 'error' in data) {
      const inner: unknown = (data as { error: unknown }).error;
      if (inner && typeof inner === 'object' && 'message' in inner) {
        const message = (inner as { message: unknown }).message;
        if (typeof message === 'string') return message;
      }
    }
  }
  return error instanceof Error ? error.message : '';
}

/**
 * Low-level HTTP client for the YouTube Data API v3.
 *
 * Talks to the API directly over axios (via {@link createApiClient}) rather than
 * the vendored `@googleapis/youtube` SDK, so every URL we hit is visible and the
 * connector can be exercised offline against a fake server. Array query params
 * (`part`, `id`) are serialized as repeated keys — `?part=id&part=snippet` —
 * exactly as the SDK's `qs.stringify(params, { arrayFormat: 'repeat' })` did.
 * Auth is `Authorization: Bearer <accessToken>` (the only header the SDK set).
 */
export class YoutubeApiClient {
  private readonly http: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(accessTokenOrProvider: ConnectorAuthTokenOrProvider, opts?: { rateLimiter?: RateLimiter }) {
    const accessTokenProvider = toConnectorAuthTokenProvider(accessTokenOrProvider);
    this.http = createApiClient(
      {
        baseURL: YOUTUBE_API_BASE_URL,
        // YouTube expects repeated query params (e.g. ?part=id&part=snippet), not
        // the bracketed default axios uses for arrays — matches the SDK's `repeat`
        // array serialization.
        paramsSerializer: { indexes: null },
      },
      { authorizationHeaderValueProvider: async () => `Bearer ${await accessTokenProvider()}` },
    );
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, YOUTUBE_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, YOUTUBE_RETRY_OPTS);
  }

  async getChannels(): Promise<YouTubeChannelListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeChannelListResponse>('/channels', {
        params: { part: ['id', 'snippet'], mine: true, maxResults: YOUTUBE_MAX_RESULTS },
      }),
    );
    return response.data;
  }

  async getChannelsByIds(channelIds: string[]): Promise<YouTubeChannelListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeChannelListResponse>('/channels', {
        params: { part: ['id', 'snippet'], id: channelIds, maxResults: YOUTUBE_MAX_RESULTS },
      }),
    );
    return response.data;
  }

  /**
   * Fetch the full resource for a single channel (every part the Channels table
   * exposes). Used by the Channels-table by-id reconcile after a publish, not by
   * `listTables` (which only needs id+snippet).
   */
  async getChannelById(channelId: string): Promise<YouTubeChannelListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeChannelListResponse>('/channels', {
        params: { part: CHANNEL_FULL_PARTS, id: [channelId], maxResults: YOUTUBE_MAX_RESULTS },
      }),
    );
    return response.data;
  }

  /**
   * Fetch the full resource for several channels in one call (every part the
   * Channels table exposes). Used by the Channels-table pull, which aggregates the
   * owned channel + additional public channels — one batch request per id group
   * (1 quota unit, up to 50 ids). Unlike {@link getChannelsByIds} (id+snippet for
   * `listTables`), this requests all parts. Invalid ids are silently omitted by
   * the API; owner-only parts (brandingSettings/status) come back only for the
   * authorized channel.
   */
  async getChannelsByIdsWithFullParts(channelIds: string[]): Promise<YouTubeChannelListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeChannelListResponse>('/channels', {
        params: { part: CHANNEL_FULL_PARTS, id: channelIds, maxResults: YOUTUBE_MAX_RESULTS },
      }),
    );
    return response.data;
  }

  /**
   * Update a channel's mutable parts. Only `brandingSettings`, `status`, and
   * `localizations` are writable on `channels.update`; everything else is
   * read-only. The caller passes the parts it actually changed.
   */
  async updateChannel(
    channelId: string,
    body: { brandingSettings?: unknown; status?: unknown; localizations?: unknown },
  ): Promise<YouTubeChannel> {
    const parts = ['id', ...Object.keys(body)];
    const response = await this.withRetry(async () =>
      this.http.put<YouTubeChannel>('/channels', { id: channelId, ...body }, { params: { part: parts } }),
    );
    return response.data;
  }

  /**
   * Resolve a channel's uploads playlist id (the special playlist that contains
   * every upload, including private ones). Split out from {@link getVideosPage} so
   * a multi-page pull resolves it once instead of once per page (1u saved/page).
   */
  async getUploadsPlaylistId(channelId: string): Promise<string> {
    const channelResponse = await this.withRetry(async () =>
      this.http.get<YouTubeChannelListResponse>('/channels', {
        params: { part: ['contentDetails'], id: [channelId], maxResults: YOUTUBE_MAX_RESULTS },
      }),
    );
    const uploadsPlaylistId = channelResponse.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      throw new Error(`Could not find uploads playlist for channel ${channelId}`);
    }
    return uploadsPlaylistId;
  }

  /**
   * Fetch one page of a channel's videos. `uploadsPlaylistId` is the channel's
   * uploads playlist id (resolve once via {@link getUploadsPlaylistId}); the page
   * is identified by `nextPageToken` (undefined = first page).
   */
  async getVideosPage(uploadsPlaylistId: string, nextPageToken?: string): Promise<YouTubeVideoListResponse> {
    // Get videos from the uploads playlist (includes private videos)
    const playlistResponse = await this.withRetry(async () =>
      this.http.get<YouTubePlaylistItemListResponse>('/playlistItems', {
        params: {
          part: ['snippet'],
          playlistId: uploadsPlaylistId,
          maxResults: YOUTUBE_MAX_RESULTS,
          pageToken: nextPageToken,
        },
      }),
    );

    if (!playlistResponse.data.items || playlistResponse.data.items.length === 0) {
      return {
        items: [],
        nextPageToken: playlistResponse.data.nextPageToken,
        prevPageToken: playlistResponse.data.prevPageToken,
        pageInfo: playlistResponse.data.pageInfo,
        kind: 'youtube#videoListResponse',
        etag: playlistResponse.data.etag,
      };
    }

    // Get video IDs from playlist items
    const videoIds: string[] = [];
    for (const item of playlistResponse.data.items) {
      const videoId = item.snippet?.resourceId?.videoId;
      if (typeof videoId === 'string') {
        videoIds.push(videoId);
      }
    }

    if (videoIds.length === 0) {
      return {
        items: [],
        nextPageToken: playlistResponse.data.nextPageToken,
        prevPageToken: playlistResponse.data.prevPageToken,
        pageInfo: playlistResponse.data.pageInfo,
        kind: 'youtube#videoListResponse',
        etag: playlistResponse.data.etag,
      };
    }

    // Get full video details including statistics and status
    const videosResponse = await this.withRetry(async () =>
      this.http.get<YouTubeVideoListResponse>('/videos', {
        params: { part: ['snippet', 'id', 'statistics', 'status', 'contentDetails'], id: videoIds },
      }),
    );

    // Return with pagination info from playlist
    return {
      items: videosResponse.data.items || [],
      nextPageToken: playlistResponse.data.nextPageToken,
      prevPageToken: playlistResponse.data.prevPageToken,
      pageInfo: playlistResponse.data.pageInfo,
      kind: 'youtube#videoListResponse',
      etag: playlistResponse.data.etag,
    };
  }

  async getVideo(videoId: string): Promise<YouTubeVideoListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeVideoListResponse>('/videos', {
        params: { part: ['snippet', 'id', 'statistics', 'status', 'contentDetails'], id: [videoId] },
      }),
    );
    return response.data;
  }

  /**
   * Update a video's writable parts. Pass only the parts that changed: `snippet`
   * (YouTube forces both `title` and `categoryId` on every snippet write) and/or
   * `status` (privacyStatus / license / embeddable / publicStatsViewable —
   * DEV-10629). `part` is derived from the parts actually supplied, so a
   * status-only edit doesn't drag in the snippet (and its title/categoryId
   * requirement) and a snippet-only edit doesn't touch status.
   */
  async updateVideo(videoId: string, parts: { snippet?: object; status?: object }): Promise<YouTubeVideo> {
    const partNames = ['id', ...Object.keys(parts)];
    const response = await this.withRetry(async () =>
      this.http.put<YouTubeVideo>('/videos', { id: videoId, ...parts }, { params: { part: partNames } }),
    );
    return response.data;
  }

  /**
   * Fetch one page of comment threads for a video, with the top-level comment and
   * its replies. Read-only — embedded on the video record during the gated
   * `includeComments` deep-fetch (one page is sufficient for v1).
   */
  async getVideoCommentThreadsPage(videoId: string, nextPageToken?: string): Promise<YouTubeCommentThreadListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeCommentThreadListResponse>('/commentThreads', {
        params: { part: ['snippet', 'replies'], videoId, maxResults: YOUTUBE_MAX_RESULTS, pageToken: nextPageToken },
      }),
    );
    return response.data;
  }

  // --- Playlists ------------------------------------------------------------

  /**
   * Fetch one page of a channel's playlists. `mine=true` (owned channel) includes
   * the channel's PRIVATE playlists; for an additional public channel we list by
   * `channelId` (public playlists only).
   */
  async getPlaylistsPage(
    channelId: string,
    options: { mine: boolean; pageToken?: string },
  ): Promise<YouTubePlaylistListResponse> {
    const params: Record<string, unknown> = {
      part: ['snippet', 'status', 'contentDetails'],
      maxResults: YOUTUBE_MAX_RESULTS,
      pageToken: options.pageToken,
    };
    if (options.mine) {
      params.mine = true;
    } else {
      params.channelId = channelId;
    }
    const response = await this.withRetry(async () =>
      this.http.get<YouTubePlaylistListResponse>('/playlists', { params }),
    );
    return response.data;
  }

  /** Fetch a single playlist by id (used on the post-publish by-id re-pull). */
  async getPlaylistById(playlistId: string): Promise<YouTubePlaylistListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubePlaylistListResponse>('/playlists', {
        params: { part: ['snippet', 'status', 'contentDetails'], id: [playlistId], maxResults: YOUTUBE_MAX_RESULTS },
      }),
    );
    return response.data;
  }

  async createPlaylist(body: { snippet?: unknown; status?: unknown }): Promise<YouTubePlaylist> {
    const response = await this.withRetry(async () =>
      this.http.post<YouTubePlaylist>('/playlists', body, { params: { part: ['snippet', 'status'] } }),
    );
    return response.data;
  }

  async updatePlaylist(playlistId: string, body: { snippet?: unknown; status?: unknown }): Promise<YouTubePlaylist> {
    const response = await this.withRetry(async () =>
      this.http.put<YouTubePlaylist>(
        '/playlists',
        { id: playlistId, ...body },
        { params: { part: ['snippet', 'status'] } },
      ),
    );
    return response.data;
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await this.withRetry(async () => this.http.delete('/playlists', { params: { id: playlistId } }));
  }

  // --- Playlist items -------------------------------------------------------

  /** Fetch one page of the items in a single playlist. */
  async getPlaylistItemsPage(playlistId: string, nextPageToken?: string): Promise<YouTubePlaylistItemListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubePlaylistItemListResponse>('/playlistItems', {
        params: {
          part: ['snippet', 'contentDetails'],
          playlistId,
          maxResults: YOUTUBE_MAX_RESULTS,
          pageToken: nextPageToken,
        },
      }),
    );
    return response.data;
  }

  /** Fetch a single playlist item by id (post-publish by-id re-pull). */
  async getPlaylistItemById(playlistItemId: string): Promise<YouTubePlaylistItemListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubePlaylistItemListResponse>('/playlistItems', {
        params: { part: ['snippet', 'contentDetails'], id: [playlistItemId], maxResults: YOUTUBE_MAX_RESULTS },
      }),
    );
    return response.data;
  }

  async createPlaylistItem(body: { snippet?: unknown; contentDetails?: unknown }): Promise<YouTubePlaylistItem> {
    const response = await this.withRetry(async () =>
      this.http.post<YouTubePlaylistItem>('/playlistItems', body, { params: { part: ['snippet', 'contentDetails'] } }),
    );
    return response.data;
  }

  async updatePlaylistItem(
    playlistItemId: string,
    body: { snippet?: unknown; contentDetails?: unknown },
  ): Promise<YouTubePlaylistItem> {
    const response = await this.withRetry(async () =>
      this.http.put<YouTubePlaylistItem>(
        '/playlistItems',
        { id: playlistItemId, ...body },
        { params: { part: ['snippet', 'contentDetails'] } },
      ),
    );
    return response.data;
  }

  async deletePlaylistItem(playlistItemId: string): Promise<void> {
    await this.withRetry(async () => this.http.delete('/playlistItems', { params: { id: playlistItemId } }));
  }

  // --- Channel sections -----------------------------------------------------

  /** List a channel's sections (single unpaginated call — channelSections.list has no paging). */
  async getChannelSections(channelId: string): Promise<YouTubeChannelSectionListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeChannelSectionListResponse>('/channelSections', {
        params: { part: ['snippet', 'contentDetails'], channelId },
      }),
    );
    return response.data;
  }

  async getChannelSectionById(channelSectionId: string): Promise<YouTubeChannelSectionListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeChannelSectionListResponse>('/channelSections', {
        params: { part: ['snippet', 'contentDetails'], id: [channelSectionId] },
      }),
    );
    return response.data;
  }

  async createChannelSection(body: { snippet?: unknown; contentDetails?: unknown }): Promise<YouTubeChannelSection> {
    const response = await this.withRetry(async () =>
      this.http.post<YouTubeChannelSection>('/channelSections', body, {
        params: { part: ['snippet', 'contentDetails'] },
      }),
    );
    return response.data;
  }

  async updateChannelSection(
    channelSectionId: string,
    body: { snippet?: unknown; contentDetails?: unknown },
  ): Promise<YouTubeChannelSection> {
    const response = await this.withRetry(async () =>
      this.http.put<YouTubeChannelSection>(
        '/channelSections',
        { id: channelSectionId, ...body },
        { params: { part: ['snippet', 'contentDetails'] } },
      ),
    );
    return response.data;
  }

  async deleteChannelSection(channelSectionId: string): Promise<void> {
    await this.withRetry(async () => this.http.delete('/channelSections', { params: { id: channelSectionId } }));
  }

  // --- Subscriptions (owner-only) -------------------------------------------

  /** Fetch one page of the authorized channel's own subscriptions. */
  async getSubscriptionsPage(nextPageToken?: string): Promise<YouTubeSubscriptionListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeSubscriptionListResponse>('/subscriptions', {
        params: {
          part: ['snippet', 'contentDetails'],
          mine: true,
          maxResults: YOUTUBE_MAX_RESULTS,
          pageToken: nextPageToken,
        },
      }),
    );
    return response.data;
  }

  async createSubscription(body: { snippet?: unknown }): Promise<YouTubeSubscription> {
    const response = await this.withRetry(async () =>
      this.http.post<YouTubeSubscription>('/subscriptions', body, { params: { part: ['snippet'] } }),
    );
    return response.data;
  }

  async deleteSubscription(subscriptionId: string): Promise<void> {
    await this.withRetry(async () => this.http.delete('/subscriptions', { params: { id: subscriptionId } }));
  }

  // --- Members / membership levels (owner-only; require the channel-memberships scope) ---

  /** List the channel's current members. 403s without the channel-memberships scope. */
  async getMembersPage(nextPageToken?: string): Promise<YouTubeMemberListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeMemberListResponse>('/members', {
        params: { part: ['snippet'], mode: 'all_current', maxResults: YOUTUBE_MAX_RESULTS, pageToken: nextPageToken },
      }),
    );
    return response.data;
  }

  /** List the channel's membership levels. 403s without the channel-memberships scope. */
  async getMembershipsLevels(): Promise<YouTubeMembershipsLevelListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeMembershipsLevelListResponse>('/membershipsLevels', { params: { part: ['snippet'] } }),
    );
    return response.data;
  }

  // --- Reference resources (public, read-only) ------------------------------

  /** List video categories for a region (default US). */
  async getVideoCategories(regionCode = 'US'): Promise<YouTubeReferenceListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeReferenceListResponse>('/videoCategories', { params: { part: ['snippet'], regionCode } }),
    );
    return response.data;
  }

  /** List the languages YouTube supports for its UI / metadata. */
  async getI18nLanguages(): Promise<YouTubeReferenceListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeReferenceListResponse>('/i18nLanguages', { params: { part: ['snippet'] } }),
    );
    return response.data;
  }

  /** List the content regions YouTube supports. */
  async getI18nRegions(): Promise<YouTubeReferenceListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeReferenceListResponse>('/i18nRegions', { params: { part: ['snippet'] } }),
    );
    return response.data;
  }

  async getVideoTranscript(
    videoId: string,
  ): Promise<{ text: string; id: string | null; captionListItems: YouTubeCaption[] | null }> {
    let captionListItems: YouTubeCaption[] | null = null;
    try {
      // List available caption tracks for the video
      const captionListResponse = await this.withRetry(async () =>
        this.http.get<YouTubeCaptionListResponse>('/captions', {
          params: { part: ['snippet'], videoId },
        }),
      );

      // Find the English caption track
      let captionId: string | null = null;
      captionListItems = captionListResponse.data.items ?? null;
      if (captionListItems) {
        for (const item of captionListItems) {
          if (item.snippet?.language === 'en') {
            captionId = item.id || null;
            break;
          }
        }
      }

      if (!captionId) {
        console.debug(`No English transcript found for video ${videoId}`);
        return {
          text: `No English transcript found for video ${videoId}`,
          id: null,
          captionListItems,
        };
      }

      // Download the transcript. The download endpoint lives at /captions/{id}
      // and returns the caption file body directly (here SRT) — no JSON wrapper.
      const transcriptResponse = await this.withRetry(async () =>
        this.http.get<ArrayBuffer>(`/captions/${captionId}`, {
          params: { tfmt: 'srt' },
          responseType: 'arraybuffer',
        }),
      );

      if (!transcriptResponse.data) {
        return {
          text: `No English transcript found for video ${videoId}`,
          id: null,
          captionListItems,
        };
      }

      const transcript = Buffer.from(transcriptResponse.data).toString('utf-8');
      return { text: transcript, id: captionId, captionListItems };
    } catch (error: unknown) {
      // Handle specific error cases
      const status = httpStatusOf(error);
      if (status === 403) {
        return { text: `Access denied for transcript of video ${videoId}`, id: null, captionListItems };
      } else if (status === 404) {
        return { text: `No captions found for video ${videoId}`, id: null, captionListItems };
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        text: `Error fetching transcript for video ${videoId}: ${message}`,
        id: null,
        captionListItems,
      };
    }
  }

  async updateTranscript(videoId: string, transcriptId: string, transcriptText: string): Promise<void> {
    try {
      // First, we need to get the caption track details to update it
      const captionResponse = await this.withRetry(async () =>
        this.http.get<YouTubeCaptionListResponse>('/captions', {
          params: { part: ['snippet'], id: [transcriptId], videoId },
        }),
      );

      if (!captionResponse.data.items || captionResponse.data.items.length === 0) {
        throw new Error(`Transcript with ID ${transcriptId} not found`);
      }

      const caption = captionResponse.data.items[0];
      if (!caption.snippet) {
        throw new Error(`Transcript ${transcriptId} has no snippet data`);
      }

      // Check if this is an auto-generated caption track
      // Auto-generated captions cannot be updated via the API, but we can replace them
      if (caption.snippet.trackKind === 'asr') {
        // Hide the auto-generated caption and create a new one
        await this.hideAutoGeneratedTranscript(videoId, transcriptId);
        const newTranscriptId = await this.createTranscript(videoId, transcriptText, caption.snippet.language || 'en');
        console.log(`Replaced auto-generated caption ${transcriptId} with new caption ${newTranscriptId}`);
        return; // Success - we've replaced the auto-generated caption
      }

      // Check if the caption track is in a state that allows updates
      if (caption.snippet.status === 'serving' || caption.snippet.status === 'failed') {
        throw new Error(
          `Cannot update caption track in '${caption.snippet.status}' status. Only draft captions can be updated.`,
        );
      }

      // Update the caption track with the new content (multipart media upload).
      await this.uploadCaption('put', { id: transcriptId, snippet: { ...caption.snippet } }, transcriptText);
    } catch (error: unknown) {
      const status = httpStatusOf(error);
      if (status === 403) {
        // Check if this is specifically about auto-generated captions
        const message = apiErrorMessageOf(error);
        if (message.includes('auto-generated') || message.includes('ASR')) {
          throw new Error(`Cannot update auto-generated captions. Please upload a new caption track instead.`);
        }
        throw new Error(
          `Access denied for updating transcript ${transcriptId}. This may be an auto-generated caption that cannot be updated.`,
        );
      } else if (status === 404) {
        throw new Error(`Transcript ${transcriptId} not found`);
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Error updating transcript ${transcriptId}: ${message}`);
    }
  }

  /**
   * Create a new caption track for a video
   * This is used to replace auto-generated captions that cannot be updated
   */
  async createTranscript(videoId: string, transcriptText: string, language: string = 'en'): Promise<string> {
    try {
      // Create a new caption track (multipart media upload).
      const created = await this.uploadCaption(
        'post',
        {
          snippet: {
            videoId,
            language,
            name: 'User Uploaded Captions',
            isDraft: false, // Publish immediately
          },
        },
        transcriptText,
      );

      if (!created.id) {
        throw new Error('Failed to create new caption track');
      }

      return created.id;
    } catch (error: unknown) {
      const status = httpStatusOf(error);
      if (status === 403) {
        throw new Error(`Access denied for creating transcript for video ${videoId}`);
      } else if (status === 404) {
        throw new Error(`Video ${videoId} not found`);
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Error creating transcript for video ${videoId}: ${message}`);
    }
  }

  /**
   * Hide an auto-generated caption track by setting it to draft
   * This makes it invisible to viewers without deleting it
   */
  async hideAutoGeneratedTranscript(videoId: string, transcriptId: string): Promise<void> {
    try {
      // First, get the caption track details
      const captionResponse = await this.withRetry(async () =>
        this.http.get<YouTubeCaptionListResponse>('/captions', {
          params: { part: ['snippet'], id: [transcriptId], videoId },
        }),
      );

      if (!captionResponse.data.items || captionResponse.data.items.length === 0) {
        throw new Error(`Transcript with ID ${transcriptId} not found`);
      }

      const caption = captionResponse.data.items[0];
      if (!caption.snippet) {
        throw new Error(`Transcript ${transcriptId} has no snippet data`);
      }

      // Only hide if it's an auto-generated caption
      if (caption.snippet.trackKind !== 'asr') {
        throw new Error(`Cannot hide non-auto-generated caption track`);
      }

      // Set the caption track to draft to hide it (metadata-only PUT, no media).
      await this.withRetry(async () =>
        this.http.put<YouTubeCaption>(
          '/captions',
          {
            id: transcriptId,
            snippet: {
              ...caption.snippet,
              isDraft: true, // Hide the auto-generated caption
            },
          },
          { params: { part: ['snippet'] } },
        ),
      );
    } catch (error: unknown) {
      const status = httpStatusOf(error);
      if (status === 403) {
        throw new Error(`Access denied for hiding transcript ${transcriptId}`);
      } else if (status === 404) {
        throw new Error(`Transcript ${transcriptId} not found`);
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Error hiding transcript ${transcriptId}: ${message}`);
    }
  }

  /**
   * Insert or update a caption track with a media body. Reproduces the SDK's
   * `multipart/related` upload to `/upload/youtube/v3/captions?uploadType=multipart`:
   * part 1 is the JSON resource (`application/json`), part 2 is the caption text
   * (`text/plain`). Returns the API's verbatim caption resource.
   */
  private async uploadCaption(
    method: 'post' | 'put',
    resource: Record<string, unknown>,
    transcriptText: string,
  ): Promise<YouTubeCaption> {
    const boundary = randomUUID();
    const body =
      `--${boundary}\r\n` +
      `content-type: application/json\r\n\r\n` +
      `${JSON.stringify(resource)}\r\n` +
      `--${boundary}\r\n` +
      `content-type: text/plain\r\n\r\n` +
      `${transcriptText}\r\n` +
      `--${boundary}--`;

    const response = await this.withRetry(async () =>
      this.http.request<YouTubeCaption>({
        method,
        url: YOUTUBE_CAPTIONS_UPLOAD_URL,
        params: { part: ['snippet'], uploadType: 'multipart' },
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        data: body,
      }),
    );
    return response.data;
  }
}
