/**
 * Local types for the YouTube Data API v3 connector.
 *
 * These replace the `youtube_v3.Schema$*` shapes that used to come from the
 * `@googleapis/youtube` SDK. We hand-author only the fields the connector and
 * api-client actually read; every response is otherwise passed through verbatim
 * (the product principle: store the raw API response). The index signatures on
 * the persisted shapes (`YouTubeVideo`, `YouTubeCaptionSnippet`) keep unknown
 * keys flowing through unmodified so on-disk records stay byte-identical to what
 * the API returns.
 */

/** Standard pagination summary the list endpoints attach to every response. */
export interface YouTubePageInfo {
  totalResults?: number;
  resultsPerPage?: number;
  [key: string]: unknown;
}

// --- Channels ---

export interface YouTubeChannelSnippet {
  title?: string;
  description?: string;
  publishedAt?: string;
  [key: string]: unknown;
}

export interface YouTubeChannelContentDetails {
  relatedPlaylists?: {
    uploads?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface YouTubeChannel {
  id?: string;
  snippet?: YouTubeChannelSnippet;
  contentDetails?: YouTubeChannelContentDetails;
  [key: string]: unknown;
}

export interface YouTubeChannelListResponse {
  items?: YouTubeChannel[];
  nextPageToken?: string;
  prevPageToken?: string;
  pageInfo?: YouTubePageInfo;
  kind?: string;
  etag?: string;
  [key: string]: unknown;
}

// --- Videos ---

/**
 * A YouTube video resource. The connector persists this verbatim as the record
 * file, so the index signature preserves every key the API returns (snippet,
 * statistics, status, contentDetails, …) without us having to enumerate them.
 */
export interface YouTubeVideo {
  id?: string;
  snippet?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface YouTubeVideoListResponse {
  items?: YouTubeVideo[];
  nextPageToken?: string;
  prevPageToken?: string;
  pageInfo?: YouTubePageInfo;
  kind?: string;
  etag?: string;
  [key: string]: unknown;
}

// --- Playlist items (used to walk a channel's uploads playlist) ---

export interface YouTubePlaylistItem {
  snippet?: {
    resourceId?: {
      videoId?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface YouTubePlaylistItemListResponse {
  items?: YouTubePlaylistItem[];
  nextPageToken?: string;
  prevPageToken?: string;
  pageInfo?: YouTubePageInfo;
  kind?: string;
  etag?: string;
  [key: string]: unknown;
}

// --- Captions ---

export interface YouTubeCaptionSnippet {
  videoId?: string;
  language?: string;
  name?: string;
  trackKind?: string;
  status?: string;
  isDraft?: boolean;
  [key: string]: unknown;
}

export interface YouTubeCaption {
  id?: string;
  snippet?: YouTubeCaptionSnippet;
  [key: string]: unknown;
}

export interface YouTubeCaptionListResponse {
  items?: YouTubeCaption[];
  [key: string]: unknown;
}
