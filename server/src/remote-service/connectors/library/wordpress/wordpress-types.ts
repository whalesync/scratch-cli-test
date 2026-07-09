// WordPress API types

export type WordPressRecord = { [Key in string]?: unknown } & { id?: number };

/**
 * Result of a single {@link WordPressHttpClient.pollRecords} page fetch: the
 * page of records plus the collection-wide counts WordPress reports in the
 * `X-WP-Total` / `X-WP-TotalPages` response headers. Both counts are optional
 * because a site (or a proxy/plugin) can omit the headers; the connector's
 * pagination loop treats an absent `total` as "unknown" and falls back to its
 * short-page / offset-ignoring guards.
 */
export interface WordPressPollRecordsResult {
  records: WordPressRecord[];
  /** Parsed `X-WP-Total` — total records matching the query, or `undefined`. */
  total?: number;
  /** Parsed `X-WP-TotalPages` — total pages for the current page size, or `undefined`. */
  totalPages?: number;
}

export type WordPressDownloadProgress = {
  nextOffset: number | undefined;
};

/**
 * Response to a WordPress discovery request.
 * https://developer.wordpress.org/rest-api/using-the-rest-api/discovery/
 * Includes only relevant properties.
 */
export interface WordPressGetDiscoveryApiResponse {
  name: string;
  url: string;
  /**
   * Site offset from UTC in hours, e.g. `-5` or `5.5`. Exposed on the REST API
   * index. A static number — does NOT account for DST at a given instant, so
   * `timezone_string` is preferred when present.
   */
  gmt_offset?: number;
  /**
   * IANA timezone name the site is configured with, e.g. `"America/New_York"`.
   * Empty string when the admin configured a manual UTC offset instead (use
   * `gmt_offset` in that case).
   */
  timezone_string?: string;
  routes: { [Key in string]?: WordPressRoute };
}

/**
 * The site's configured timezone, resolved from the REST API index. Used to
 * render our UTC watermark as the site's local wall-clock time for the
 * `modified_after` filter (WordPress compares it against `post_modified`, which
 * is stored in site-local time). Both fields absent ⇒ treat as UTC.
 */
export interface WordPressSiteTimezone {
  /** IANA name (DST-aware). Preferred when present. */
  timezoneString?: string;
  /** Fixed hour offset fallback when no IANA name is configured. */
  gmtOffsetHours?: number;
}

/** Includes only relevant properties. */
export interface WordPressRoute {
  endpoints: WordPressEndpoint[];
}

/** Includes only relevant properties. */
export interface WordPressEndpoint {
  args: { [Key in string]?: WordPressArgument };
}

/** Includes only relevant properties. */
export interface WordPressArgument {
  type: string | string[];
  // Optional:
  required?: boolean;
  writeOnly?: boolean;
  readonly?: boolean;
  writeOnce?: boolean;
  properties?: { [Key in string]?: WordPressArgument };
  format?: string;
  enum?: string[];
  context?: string[];
}

/** Includes only relevant properties. */
export interface WordPressRendered {
  rendered: string;
}

/**
 * Response to a WordPress schema request.
 * Includes only relevant properties.
 */
export interface WordPressEndpointOptionsResponse {
  endpoints: WordPressEndpoint[];
  schema: {
    properties: { [Key in string]?: WordPressArgument } & {
      acf?: {
        properties?: { [Key in string]?: WordPressArgument };
      };
    };
  };
}

/**
 * Response to a WordPress types request.
 * https://developer.wordpress.org/rest-api/reference/post-types/
 * Includes only relevant properties.
 */
export interface WordPressGetTypesApiResponse {
  [typeName: string]: WordPressPostType;
}

/** Includes only relevant properties. */
export interface WordPressPostType {
  name: string;
  rest_base: string;
  rest_namespace?: string;
  slug?: string;
  description?: string;
  hierarchical?: boolean;
}

/**
 * Response to a WordPress taxonomies request.
 * https://developer.wordpress.org/rest-api/reference/taxonomies/
 * Includes only relevant properties.
 */
export interface WordPressGetTaxonomiesApiResponse {
  [taxonomySlug: string]: WordPressTaxonomy;
}

/** Includes only relevant properties. */
export interface WordPressTaxonomy {
  name: string;
  slug: string;
  rest_base: string;
  rest_namespace?: string;
  description?: string;
  hierarchical?: boolean;
  types: string[];
}

/**
 * A single request within a WordPress batch operation.
 * https://developer.wordpress.org/rest-api/using-the-rest-api/global-parameters/#_method-or-x-http-method-override
 */
export interface WordPressBatchRequestItem {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
}

/**
 * Response from the WordPress batch endpoint (POST /batch/v1).
 * Returns HTTP 207 Multi-Status.
 */
export interface WordPressBatchResponse {
  failed: 'none' | 'validation';
  responses: WordPressBatchResponseItem[];
}

export interface WordPressBatchResponseItem {
  body: WordPressRecord | { code: string; message: string; data: { status: number } };
  status: number;
  headers: Record<string, string>;
}

/**
 * Response from the WordPress media upload endpoint (POST /wp/v2/media).
 * Returns the created media record with additional media-specific fields.
 */
export type WordPressMediaUploadResponse = WordPressRecord & {
  source_url?: string;
  media_type?: string;
  mime_type?: string;
};

export enum WordPressDataType {
  STRING = 'wordpress/string',
  EMAIL = 'wordpress/email',
  URI = 'wordpress/uri',
  ENUM = 'wordpress/enum',
  INTEGER = 'wordpress/integer',
  NUMBER = 'wordpress/number',
  BOOLEAN = 'wordpress/boolean',
  DATE = 'wordpress/date',
  DATETIME = 'wordpress/datetime',
  ARRAY = 'wordpress/array',
  OBJECT = 'wordpress/object',
  RENDERED = 'wordpress/rendered',
  RENDERED_INLINE = 'wordpress/renderedinline',
  FOREIGN_KEY = 'wordpress/foreignkey',
  // None of the above.
  UNKNOWN = 'wordpress/unknown',
}
