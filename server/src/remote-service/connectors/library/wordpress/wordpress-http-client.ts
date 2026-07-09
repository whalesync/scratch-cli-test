import axios, { AxiosInstance, AxiosResponse, RawAxiosRequestHeaders } from 'axios';
import _ from 'lodash';
import { WSLogger } from 'src/logger';
import { createApiClient } from '../../create-api-client';
import { ConnectorAuthError } from '../../error';
import { Service } from '../../service-constants';
import { WORDPRESS_ORG_V2_PATH, WORDPRESS_UPLOAD_TIMEOUT_MS } from './wordpress-constants';
import {
  WordPressBatchRequestItem,
  WordPressBatchResponse,
  WordPressEndpointOptionsResponse,
  WordPressGetDiscoveryApiResponse,
  WordPressGetTaxonomiesApiResponse,
  WordPressGetTypesApiResponse,
  WordPressMediaUploadResponse,
  WordPressPollRecordsResult,
  WordPressRecord,
  WordPressSiteTimezone,
} from './wordpress-types';

/**
 * Parse a WordPress count header (`X-WP-Total` / `X-WP-TotalPages`) into a
 * non-negative integer, or `undefined` when the header is absent or malformed.
 * Axios exposes header values as strings, but we accept `number`/`unknown`
 * defensively so a mocked or proxied response can't throw here.
 */
export function parseWordPressCountHeader(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Client for making HTTP requests to WordPress REST API.
 */
export class WordPressHttpClient {
  private readonly client: AxiosInstance;
  /** Memoized site-timezone lookup (one REST-index fetch per client instance). */
  private siteTimezonePromise?: Promise<WordPressSiteTimezone>;

  constructor(
    private readonly endpoint: string,
    private readonly username: string,
    private readonly password: string,
  ) {
    const usernamePassword = `${username}:${password}`;
    const base64Credentials = Buffer.from(usernamePassword).toString('base64');
    this.client = createApiClient({
      headers: {
        Authorization: `Basic ${base64Credentials}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  private generateUrl(
    endpoint: string,
    remoteCollectionId: string,
    remoteRecordId: string | null,
    searchParams: { name: string; value: string }[],
  ): string {
    let addToPath = `${WORDPRESS_ORG_V2_PATH}${remoteCollectionId}`;
    if (remoteRecordId !== null && remoteRecordId !== 'unknown') {
      addToPath = addToPath.concat(`/${remoteRecordId}`);
    }
    const endpointUrl = new URL(endpoint);
    const restRoute = endpointUrl.searchParams.get('rest_route');
    if (restRoute === null) {
      endpointUrl.pathname = `${endpointUrl.pathname}${addToPath}`;
    } else {
      endpointUrl.searchParams.delete('rest_route');
      endpointUrl.searchParams.append('rest_route', `/${addToPath}`);
    }
    for (const param of searchParams) {
      const found = endpointUrl.searchParams.get(param.name);
      if (found !== null) {
        endpointUrl.searchParams.delete(param.name);
      }
      endpointUrl.searchParams.append(param.name, param.value);
    }
    return endpointUrl.toString();
  }

  /**
   * Generate a URL for a raw API path (without the wp/v2/ prefix).
   * Used for endpoints like batch/v1 that live outside the wp/v2 namespace.
   */
  private generateRawUrl(endpoint: string, rawPath: string): string {
    const endpointUrl = new URL(endpoint);
    const restRoute = endpointUrl.searchParams.get('rest_route');
    if (restRoute === null) {
      endpointUrl.pathname = `${endpointUrl.pathname}${rawPath}`;
    } else {
      endpointUrl.searchParams.delete('rest_route');
      endpointUrl.searchParams.append('rest_route', `/${rawPath}`);
    }
    return endpointUrl.toString();
  }

  async testEndpoint(endpoint: string = this.endpoint): Promise<void> {
    const url = this.generateUrl(endpoint, 'posts', null, [
      { name: 'per_page', value: '5' },
      { name: 'context', value: 'edit' },
    ]);
    let wordpressPollResponse: AxiosResponse<WordPressRecord[]>;
    try {
      wordpressPollResponse = await this.client.get<WordPressRecord[]>(url);
    } catch (error) {
      throw new Error('Failed to test connection: ' + (error instanceof Error ? error.message : String(error)));
    }
    if (wordpressPollResponse.data === undefined || typeof wordpressPollResponse.data === 'string') {
      throw new Error('Failed to test connection: Invalid response format');
    }
  }

  /**
   * Discover the WordPress site and get basic info
   * https://developer.wordpress.org/rest-api/using-the-rest-api/discovery/
   */
  async getDiscoveryInfo(): Promise<WordPressGetDiscoveryApiResponse> {
    const response = await this.client.get<WordPressGetDiscoveryApiResponse>(this.endpoint);
    return response.data;
  }

  /**
   * Resolve the site's configured timezone from the REST API index
   * (`timezone_string` / `gmt_offset`). Memoized for the lifetime of this
   * client instance — incremental pulls across folders share one index fetch.
   * Any failure resolves to `{}`, which callers treat as UTC: a flaky index
   * degrades watermark precision (the periodic full pull reconciles), it never
   * fails the pull.
   */
  async getSiteTimezone(): Promise<WordPressSiteTimezone> {
    this.siteTimezonePromise ??= this.fetchSiteTimezone();
    return this.siteTimezonePromise;
  }

  private async fetchSiteTimezone(): Promise<WordPressSiteTimezone> {
    try {
      const info = await this.getDiscoveryInfo();
      if (!info || typeof info !== 'object') {
        return {};
      }
      const timezoneString =
        typeof info.timezone_string === 'string' && info.timezone_string.trim() !== ''
          ? info.timezone_string.trim()
          : undefined;
      const gmtOffsetHours =
        typeof info.gmt_offset === 'number' && Number.isFinite(info.gmt_offset) ? info.gmt_offset : undefined;
      return { timezoneString, gmtOffsetHours };
    } catch (error) {
      WSLogger.warn({
        source: 'WordpressHttpClient',
        message: 'Failed to resolve site timezone from REST index; incremental pull will fall back to UTC',
        error,
      });
      return {};
    }
  }

  /**
   * Poll records from a WordPress table.
   *
   * When `modifiedAfter` is supplied (incremental pull), adds it verbatim as
   * the `modified_after` query param so WordPress server-side filters the
   * collection to records changed since then. The connector renders this value
   * as the site's local wall-clock time (WordPress compares it against
   * `post_modified`, stored in site-local time), so the client passes the
   * string through untouched. Only post-type and media collections support
   * `modified_after`; taxonomy collections never reach this path (the connector
   * demotes them to a full scan). Offset pagination and the `status=any` /
   * `context=edit` params are unchanged.
   *
   * Returns the page of records alongside the collection-wide `X-WP-Total` /
   * `X-WP-TotalPages` counts (parsed, or `undefined` when the site omits them)
   * so the connector can stop paginating once it has seen every record — a
   * short-page check alone loops forever against a site that ignores `offset`.
   */
  async pollRecords(
    tableId: string,
    offset: number,
    pageSize: number,
    modifiedAfter?: string,
  ): Promise<WordPressPollRecordsResult> {
    const searchParams: { name: string; value: string }[] = [];
    searchParams.push({ name: 'per_page', value: String(pageSize) });
    if (offset > 0) {
      searchParams.push({ name: 'offset', value: String(offset) });
    }
    if (tableId !== 'media') {
      searchParams.push({ name: 'status', value: 'any' }); // This is to ensure that we get all posts, including draft and trashed ones
    }
    if (modifiedAfter) {
      searchParams.push({ name: 'modified_after', value: modifiedAfter });
    }
    searchParams.push({ name: 'context', value: 'edit' }); // Return raw content and all fields
    const url = this.generateUrl(this.endpoint, tableId, null, searchParams);
    const response = await this.client.get<WordPressRecord[]>(url);
    // Axios lowercases header keys. Headers may be absent (proxy/plugin stripped
    // them, or a mocked response) — optional-chain so we never throw here.
    return {
      records: response.data,
      total: parseWordPressCountHeader(response.headers?.['x-wp-total']),
      totalPages: parseWordPressCountHeader(response.headers?.['x-wp-totalpages']),
    };
  }

  /**
   * Get available post types from WordPress
   * https://developer.wordpress.org/rest-api/reference/post-types/
   */
  async getTypes(): Promise<WordPressGetTypesApiResponse> {
    const url = this.generateUrl(this.endpoint, 'types', null, []);
    const response = await this.client.get<WordPressGetTypesApiResponse>(url);
    return response.data;
  }

  /**
   * Get available taxonomies from WordPress
   * https://developer.wordpress.org/rest-api/reference/taxonomies/
   */
  async getTaxonomies(): Promise<WordPressGetTaxonomiesApiResponse> {
    const url = this.generateUrl(this.endpoint, 'taxonomies', null, []);
    const response = await this.client.get<WordPressGetTaxonomiesApiResponse>(url);
    return response.data;
  }

  /**
   * Get endpoint schema via OPTIONS request
   */
  async getEndpointOptions(tableId: string): Promise<WordPressEndpointOptionsResponse> {
    const url = this.generateUrl(this.endpoint, tableId, null, []);
    const response = await this.client.request<WordPressEndpointOptionsResponse>({
      method: 'OPTIONS',
      url,
    });
    return response.data;
  }

  /**
   * Get a single record by ID. Returns null if not found (404).
   */
  async getRecord(tableId: string, recordId: string): Promise<WordPressRecord | null> {
    const url = this.generateUrl(this.endpoint, tableId, recordId, [{ name: 'context', value: 'edit' }]);
    try {
      const response = await this.client.get<WordPressRecord>(url);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new record in WordPress
   */
  async createRecord(tableId: string, record: WordPressRecord): Promise<WordPressRecord> {
    const url = this.generateUrl(this.endpoint, tableId, null, []);
    const response = await this.client.post<WordPressRecord>(url, record);
    return response.data;
  }

  /**
   * Update an existing record in WordPress
   */
  async updateRecord(tableId: string, recordId: string, record: WordPressRecord): Promise<WordPressRecord> {
    const url = this.generateUrl(this.endpoint, tableId, recordId, []);
    const response = await this.client.patch<WordPressRecord>(url, record);
    return response.data;
  }

  /**
   * Delete a record from WordPress
   */
  async deleteRecord(tableId: string, recordId: string): Promise<void> {
    const url = this.generateUrl(this.endpoint, tableId, recordId, [{ name: 'force', value: 'true' }]);
    await this.client.delete(url);
  }

  /**
   * Upload a media file to WordPress (POST /wp/v2/media).
   * Sends the raw file buffer with Content-Type and Content-Disposition headers.
   */
  async uploadMedia(buffer: Buffer, filename: string, mimeType: string): Promise<WordPressMediaUploadResponse> {
    const url = this.generateUrl(this.endpoint, 'media', null, []);
    // Sanitize filename for Content-Disposition header (must be ASCII-safe).
    // NFD decomposition splits accented chars (é → e + combining accent), then we strip the combining marks.
    const safeFilename = filename
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/"/g, '\\"');
    const headers: RawAxiosRequestHeaders = {
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
    };
    const response = await this.client.post<WordPressMediaUploadResponse>(url, buffer, {
      headers,
      timeout: WORDPRESS_UPLOAD_TIMEOUT_MS,
    });
    return response.data;
  }

  /**
   * Send a batch request to the WordPress REST API (POST /batch/v1).
   * Uses "require-all-validate" so WordPress validates all requests upfront and
   * rejects the entire batch if any fail validation. Always returns HTTP 207.
   */
  async batchRequest(requests: WordPressBatchRequestItem[]): Promise<WordPressBatchResponse> {
    const url = this.generateRawUrl(this.endpoint, 'batch/v1');
    const response = await this.client.post<WordPressBatchResponse>(url, {
      validation: 'require-all-validate',
      requests,
    });
    return response.data;
  }

  /**
   * Validate and discover the correct endpoint URL for a WordPress site
   */
  async discoverAndValidateEndpoint(): Promise<string> {
    let endpoint: string;
    try {
      const url = new URL(this.endpoint);
      endpoint = this.endpoint;

      // Option 1: If a specific path or query param is provided, test as-is
      if (url.pathname !== '/' || url.searchParams.toString() !== '') {
        try {
          await this.testEndpoint(endpoint);
          return endpoint;
        } catch (error) {
          // Continue to try other options
          WSLogger.info({
            source: 'WordpressHttpClient',
            message: 'Result of testing specific endpoint',
            error: error,
          });
        }
      }

      // Option 2: Try endpoint discovery from Link header
      try {
        const headResponse = await this.client.head(`https://${url.hostname}`);
        const link = headResponse?.headers?.link as string | undefined;
        if (link && typeof link === 'string') {
          const linkParts = link.split('>;').flatMap((s) => s.split('<'));
          const discoveredEndpoint = linkParts.find((d) => d.includes(url.hostname));
          if (discoveredEndpoint) {
            try {
              await this.testEndpoint(discoveredEndpoint);
              return discoveredEndpoint;
            } catch (error) {
              // Continue to try other options
              WSLogger.info({
                source: 'WordpressHttpClient',
                message: 'Result of testing endpoint discovery',
                error: error,
                link: link,
                url: discoveredEndpoint,
              });
            }
          }
        }
      } catch (error) {
        // Continue to try other options
        WSLogger.info({
          source: 'WordpressHttpClient',
          message: 'Result of testing endpoint discovery',
          error: error,
        });
      }

      // Option 3: Try common WordPress REST API paths
      const variations = ['/wp-json/', '/index.php?rest_route=/'];
      for (const variation of variations) {
        endpoint = `https://${url.hostname}${variation}`;
        const client = new WordPressHttpClient(endpoint, this.username, this.password);
        try {
          await client.testEndpoint(endpoint);
          return endpoint;
        } catch (error) {
          // Continue to next variation
          WSLogger.info({
            source: 'WordpressHttpClient',
            message: 'Result of testing common endpoint prefixes',
            error: error,
            url: endpoint,
          });
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new ConnectorAuthError(
          `Unexpected error in discoverAndValidateEndpoint: ${_.toString(error)}`,
          'Unexpected error when communicating with Wordpress',
          Service.WORDPRESS,
        );
      }

      if (error.message.includes('Invalid URL')) {
        throw new ConnectorAuthError(
          error.message,
          'The WordPress URL you entered is not valid. Please provide the full address of your WordPress site including "https://"',
          Service.WORDPRESS,
          error,
        );
      }

      throw new ConnectorAuthError(
        error.message,
        'There was an error communicating with Wordpress',
        Service.WORDPRESS,
        error,
      );
    }

    throw new ConnectorAuthError(
      'Could not find a valid WordPress REST API endpoint.',
      `Could not find a valid WordPress REST API endpoint. Please verify your WordPress URL and credentials.`,
      Service.WORDPRESS,
    );
  }
}
