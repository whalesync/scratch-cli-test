import { AxiosInstance, isAxiosError } from 'axios';
import { randomUUID } from 'crypto';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  YouTubeCaption,
  YouTubeCaptionListResponse,
  YouTubeChannelListResponse,
  YouTubePlaylistItemListResponse,
  YouTubeVideo,
  YouTubeVideoListResponse,
} from './youtube-types';

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

  constructor(
    private readonly accessToken: string,
    opts?: { rateLimiter?: RateLimiter },
  ) {
    this.http = createApiClient({
      baseURL: YOUTUBE_API_BASE_URL,
      headers: { Authorization: `Bearer ${this.accessToken}` },
      // YouTube expects repeated query params (e.g. ?part=id&part=snippet), not
      // the bracketed default axios uses for arrays — matches the SDK's `repeat`
      // array serialization.
      paramsSerializer: { indexes: null },
    });
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
        params: { part: ['id', 'snippet'], mine: true, maxResults: 100 },
      }),
    );
    return response.data;
  }

  async getChannelsByIds(channelIds: string[]): Promise<YouTubeChannelListResponse> {
    const response = await this.withRetry(async () =>
      this.http.get<YouTubeChannelListResponse>('/channels', {
        params: { part: ['id', 'snippet'], id: channelIds, maxResults: 100 },
      }),
    );
    return response.data;
  }

  async getVideos(channelId: string, nextPageToken?: string): Promise<YouTubeVideoListResponse> {
    // Get videos from the specified channel (user's channel or brand channel they manage)
    // First, get the channel's uploads playlist ID
    const channelResponse = await this.withRetry(async () =>
      this.http.get<YouTubeChannelListResponse>('/channels', {
        params: { part: ['contentDetails'], id: [channelId] },
      }),
    );

    const uploadsPlaylistId = channelResponse.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

    if (!uploadsPlaylistId) {
      throw new Error(`Could not find uploads playlist for channel ${channelId}`);
    }

    // Get videos from the uploads playlist (includes private videos)
    const playlistResponse = await this.withRetry(async () =>
      this.http.get<YouTubePlaylistItemListResponse>('/playlistItems', {
        params: { part: ['snippet'], playlistId: uploadsPlaylistId, maxResults: 100, pageToken: nextPageToken },
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
        params: { part: ['snippet', 'id', 'statistics', 'status'], id: videoIds },
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
        params: { part: ['snippet', 'id', 'statistics', 'status'], id: [videoId] },
      }),
    );
    return response.data;
  }

  // Somehow youtube forces you to send the category of the video to update it.
  async updateVideo(videoId: string, snippet: object): Promise<YouTubeVideo> {
    const response = await this.withRetry(async () =>
      this.http.put<YouTubeVideo>('/videos', { id: videoId, snippet }, { params: { part: ['snippet', 'id'] } }),
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
