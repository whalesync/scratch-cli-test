import { AxiosInstance, isAxiosError } from 'axios';
import { createHash } from 'node:crypto';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  Asset,
  AssetList,
  AssetUpload,
  Collection,
  CollectionItem,
  CollectionItemList,
  CollectionItemListNoPagination,
  CollectionItemWithIdInput,
  CollectionList,
  Order,
  OrderList,
  OrderUpdate,
  Page,
  PageList,
  PageMetadataWrite,
  Site,
  SiteList,
} from './webflow-types';

const BASE_URL = 'https://api.webflow.com/v2';

/**
 * Custom error for Webflow API failures surfaced by the client. Mirrors the
 * shape of the other house api-client errors (`{ message, statusCode,
 * responseData }`). Most call sites let raw axios errors propagate (the
 * connector branches on `isAxiosError`); this is thrown only where a friendlier,
 * classified error is useful (e.g. `testConnection` auth failures).
 */
export class WebflowError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'WebflowError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Retry options for Webflow API calls — detect 429 from axios errors and honour
 * the `retry-after` header. Lives here (not on the connector) so retry/backoff
 * is owned by the HTTP layer, matching the house api-client pattern.
 */
const WEBFLOW_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!isAxiosError(error)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const header = error.response?.headers?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

/**
 * Reproduce the SDK's `new Date(x).toISOString()` coercion for a single ISO
 * string. `Asset`/`Page` `createdOn`/`lastUpdated` were `date()`-typed in the old
 * SDK, so they were stored on disk as canonical ISO. We reproduce that here so
 * records stay byte-identical regardless of the exact ISO spelling Webflow sends.
 * `CollectionItem` date fields were plain strings in the SDK (never coerced), so
 * they are deliberately left untouched. A non-ISO value passes through unchanged.
 */
function toCanonicalIsoDateString(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * Return a copy of `asset` with `createdOn`/`lastUpdated` normalized to canonical
 * ISO strings. Absent date fields stay absent; key order is preserved.
 */
function normalizeAssetDates(asset: Asset): Asset {
  return {
    ...asset,
    ...(typeof asset.createdOn === 'string' ? { createdOn: toCanonicalIsoDateString(asset.createdOn) } : {}),
    ...(typeof asset.lastUpdated === 'string' ? { lastUpdated: toCanonicalIsoDateString(asset.lastUpdated) } : {}),
  };
}

/** Return a copy of `page` with `createdOn`/`lastUpdated` normalized to canonical ISO strings. */
function normalizePageDates(page: Page): Page {
  return {
    ...page,
    ...(typeof page.createdOn === 'string' ? { createdOn: toCanonicalIsoDateString(page.createdOn) } : {}),
    ...(typeof page.lastUpdated === 'string' ? { lastUpdated: toCanonicalIsoDateString(page.lastUpdated) } : {}),
  };
}

/**
 * Low-level HTTP client for the Webflow Data API v2.
 *
 * Returns the raw `response.data` for every method (byte-identical to the
 * vendored `webflow-api` SDK, which applied no key renames and preserved unknown
 * keys), with the single exception of the `Asset`/`Page` `createdOn`/`lastUpdated`
 * fields, which are normalized to canonical ISO strings to match the SDK's old
 * `Date` coercion. The API version is encoded in the `/v2` base path — Webflow
 * does not use an `accept-version` header.
 */
export class WebflowApiClient {
  private readonly http: AxiosInstance;
  /**
   * A second, auth-free axios instance used only for the S3 presigned-POST asset
   * upload. The upload URL is self-authenticating via the policy fields, so it
   * must NOT carry the Webflow `Authorization` header.
   */
  private readonly s3UploadHttp: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(accessToken: string, opts?: { rateLimiter?: RateLimiter }) {
    this.http = createApiClient({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    this.s3UploadHttp = createApiClient();
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, WEBFLOW_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, WEBFLOW_RETRY_OPTS);
  }

  // --- Connection test ---

  async testConnection(): Promise<void> {
    try {
      await this.withRetry(() => this.http.get<SiteList>('/sites'));
    } catch (error) {
      if (isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
        throw new WebflowError('Invalid Webflow access token', error.response.status, error.response.data);
      }
      throw error;
    }
  }

  // --- Sites ---

  async listSites(): Promise<SiteList> {
    const response = await this.withRetry(() => this.http.get<SiteList>('/sites'));
    return response.data;
  }

  async getSite(siteId: string): Promise<Site> {
    const response = await this.withRetry(() => this.http.get<Site>(`/sites/${encodeURIComponent(siteId)}`));
    return response.data;
  }

  // --- Collections ---

  async listCollections(siteId: string): Promise<CollectionList> {
    const response = await this.withRetry(() =>
      this.http.get<CollectionList>(`/sites/${encodeURIComponent(siteId)}/collections`),
    );
    return response.data;
  }

  async getCollection(collectionId: string): Promise<Collection> {
    const response = await this.withRetry(() =>
      this.http.get<Collection>(`/collections/${encodeURIComponent(collectionId)}`),
    );
    return response.data;
  }

  // --- Collection items ---

  /**
   * List a collection's staged items, page by page.
   *
   * `lastUpdatedSince` (incremental pull) is an ISO-8601 UTC timestamp; when
   * present it becomes Webflow's v2 `lastUpdated[gte]` range filter (items
   * updated on-or-after the watermark), and the page is additionally sorted by
   * `lastUpdated` ascending so that, under offset pagination, an item updated
   * mid-pull migrates to the tail — at worst re-pulled on the next page, never
   * skipped. Full pulls pass it `undefined` and the request is byte-identical to
   * the pre-incremental call (offset + limit only).
   *
   * `cmsLocaleId` (DEV-10529) targets a single secondary locale; the returned
   * items carry that locale's localized field values (and that `cmsLocaleId`),
   * still sharing the primary item's `id`. Omitted ⇒ Webflow defaults to the
   * site's primary locale, byte-identical to the pre-localization request.
   */
  async listCollectionItems(
    collectionId: string,
    params: { offset: number; limit: number; lastUpdatedSince?: string; cmsLocaleId?: string },
  ): Promise<CollectionItemList> {
    const { offset, limit, lastUpdatedSince, cmsLocaleId } = params;
    const query: Record<string, string | number> = { offset, limit };
    if (cmsLocaleId !== undefined) {
      query.cmsLocaleId = cmsLocaleId;
    }
    if (lastUpdatedSince !== undefined) {
      query['lastUpdated[gte]'] = lastUpdatedSince;
      query.sortBy = 'lastUpdated';
      query.sortOrder = 'asc';
    }
    const response = await this.withRetry(() =>
      this.http.get<CollectionItemList>(`/collections/${encodeURIComponent(collectionId)}/items`, { params: query }),
    );
    return response.data;
  }

  /**
   * Fetch one collection item. `cmsLocaleId` (DEV-10529) selects a secondary
   * locale's localized variant; omitted ⇒ the site's primary locale.
   */
  async getCollectionItem(collectionId: string, itemId: string, cmsLocaleId?: string): Promise<CollectionItem> {
    const url = `/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`;
    // Keep the primary-locale request byte-identical (single-arg) to the
    // pre-localization call; only attach the locale query param when present.
    const response = await this.withRetry(() =>
      cmsLocaleId !== undefined
        ? this.http.get<CollectionItem>(url, { params: { cmsLocaleId } })
        : this.http.get<CollectionItem>(url),
    );
    return response.data;
  }

  /**
   * Create items on the live site. `skipInvalidFiles` is a query param; the body
   * is `{ items: [...] }`. Returns the raw response (`{ items: [...] }`).
   */
  async createItemsLive(
    collectionId: string,
    request: { skipInvalidFiles: boolean; items: CollectionItem[] },
  ): Promise<CollectionItemListNoPagination> {
    const { skipInvalidFiles, items } = request;
    const response = await this.withRetry(() =>
      this.http.post<CollectionItemListNoPagination>(
        `/collections/${encodeURIComponent(collectionId)}/items/live`,
        { items },
        { params: { skipInvalidFiles } },
      ),
    );
    return response.data;
  }

  /**
   * Create items in the STAGED collection — `POST /collections/{id}/items`, with
   * no `/live`. The items are created as unpublished (`lastPublished: null`), i.e.
   * never published. Counterpart to `createItemsLive`; used to seed the
   * never-published precondition in tests, and available for any future
   * staged-create flow.
   */
  async createItemsStaged(
    collectionId: string,
    request: { skipInvalidFiles: boolean; items: CollectionItem[] },
  ): Promise<CollectionItemListNoPagination> {
    const { skipInvalidFiles, items } = request;
    const response = await this.withRetry(() =>
      this.http.post<CollectionItemListNoPagination>(
        `/collections/${encodeURIComponent(collectionId)}/items`,
        { items },
        { params: { skipInvalidFiles } },
      ),
    );
    return response.data;
  }

  async updateItemsLive(
    collectionId: string,
    request: { skipInvalidFiles: boolean; items: CollectionItemWithIdInput[] },
  ): Promise<CollectionItemListNoPagination> {
    const { skipInvalidFiles, items } = request;
    const response = await this.withRetry(() =>
      this.http.patch<CollectionItemListNoPagination>(
        `/collections/${encodeURIComponent(collectionId)}/items/live`,
        { items },
        { params: { skipInvalidFiles } },
      ),
    );
    return response.data;
  }

  /**
   * Update items on the STAGED collection — `PATCH /collections/{id}/items`, with
   * no `/live`. This is the fallback for items that have never been published:
   * Webflow rejects a live PATCH of such an item with a 409 ("Live PATCH updates
   * can't be applied to items that have never been published"), so we land the
   * edit on the staged draft instead. The item stays a draft — matching its
   * current Webflow state — because a staged update never publishes. The request
   * body is byte-for-byte identical to `updateItemsLive`; only the URL differs.
   */
  async updateItemsStaged(
    collectionId: string,
    request: { skipInvalidFiles: boolean; items: CollectionItemWithIdInput[] },
  ): Promise<CollectionItemListNoPagination> {
    const { skipInvalidFiles, items } = request;
    const response = await this.withRetry(() =>
      this.http.patch<CollectionItemListNoPagination>(
        `/collections/${encodeURIComponent(collectionId)}/items`,
        { items },
        { params: { skipInvalidFiles } },
      ),
    );
    return response.data;
  }

  async deleteItemsLive(collectionId: string, request: { items: { id: string }[] }): Promise<void> {
    await this.withRetry(() =>
      this.http.delete(`/collections/${encodeURIComponent(collectionId)}/items/live`, { data: request }),
    );
  }

  async deleteItems(collectionId: string, request: { items: { id: string }[] }): Promise<void> {
    await this.withRetry(() =>
      this.http.delete(`/collections/${encodeURIComponent(collectionId)}/items`, { data: request }),
    );
  }

  // --- Assets ---

  async listAssets(siteId: string, params: { offset: number; limit: number }): Promise<AssetList> {
    const response = await this.withRetry(() =>
      this.http.get<AssetList>(`/sites/${encodeURIComponent(siteId)}/assets`, { params }),
    );
    const data = response.data;
    return {
      ...data,
      assets: data.assets?.map((asset) => normalizeAssetDates(asset)),
    };
  }

  async getAsset(assetId: string): Promise<Asset> {
    const response = await this.withRetry(() => this.http.get<Asset>(`/assets/${encodeURIComponent(assetId)}`));
    return normalizeAssetDates(response.data);
  }

  // --- Pages ---

  async listPages(siteId: string, params: { limit: number; offset: number }): Promise<PageList> {
    const response = await this.withRetry(() =>
      this.http.get<PageList>(`/sites/${encodeURIComponent(siteId)}/pages`, { params }),
    );
    const data = response.data;
    return {
      ...data,
      pages: data.pages?.map((page) => normalizePageDates(page)),
    };
  }

  async getPageMetadata(pageId: string): Promise<Page> {
    const response = await this.withRetry(() => this.http.get<Page>(`/pages/${encodeURIComponent(pageId)}`));
    return normalizePageDates(response.data);
  }

  async updatePageSettings(pageId: string, body: PageMetadataWrite): Promise<Page> {
    const response = await this.withRetry(() => this.http.put<Page>(`/pages/${encodeURIComponent(pageId)}`, body));
    return normalizePageDates(response.data);
  }

  // --- Ecommerce: Orders ---

  /**
   * List a site's Ecommerce orders, page by page. Returns the raw response
   * (`{ orders, pagination }`) verbatim. `status` optionally filters by order
   * status. Orders have no changed-since filter, so this only supports offset
   * pagination (the connector always full-pulls Orders).
   */
  async listOrders(siteId: string, params: { offset: number; limit: number; status?: string }): Promise<OrderList> {
    const { offset, limit, status } = params;
    const query: Record<string, string | number> = { offset, limit };
    if (status !== undefined) {
      query.status = status;
    }
    const response = await this.withRetry(() =>
      this.http.get<OrderList>(`/sites/${encodeURIComponent(siteId)}/orders`, { params: query }),
    );
    return response.data;
  }

  /** Fetch one Ecommerce order by its `orderId`. Returned verbatim. */
  async getOrder(siteId: string, orderId: string): Promise<Order> {
    const response = await this.withRetry(() =>
      this.http.get<Order>(`/sites/${encodeURIComponent(siteId)}/orders/${encodeURIComponent(orderId)}`),
    );
    return response.data;
  }

  /**
   * Update the writable fields of an Ecommerce order (comment + shipping
   * tracking). Webflow accepts only the {@link OrderUpdate} fields; the connector
   * guards against read-only edits before calling this. Returns the updated order
   * verbatim.
   */
  async updateOrder(siteId: string, orderId: string, body: OrderUpdate): Promise<Order> {
    const response = await this.withRetry(() =>
      this.http.patch<Order>(`/sites/${encodeURIComponent(siteId)}/orders/${encodeURIComponent(orderId)}`, body),
    );
    return response.data;
  }

  // --- Asset upload ---

  /**
   * Two-step Webflow asset upload, hand-rolled to drop the SDK's
   * `assets.utilities.createAndUpload` (and its `form-data`/`node-fetch` deps):
   *
   *   1. `POST /sites/{siteId}/assets` with `{ fileName, fileHash, parentFolder? }`
   *      (MD5 hex of the file bytes) → S3 presigned-POST metadata.
   *   2. POST a multipart form to the returned `uploadUrl`, appending every
   *      `uploadDetails` policy field FIRST (verbatim, under their wire S3 key
   *      names) and the `file` part LAST — S3 presigned POST requires the file
   *      field last. The S3 POST carries no Webflow auth header.
   *
   * Returns the create-step metadata (which includes the new asset `id`).
   */
  async uploadAsset(
    siteId: string,
    request: { file: Buffer; fileName: string; parentFolder?: string },
  ): Promise<AssetUpload> {
    const { file, fileName, parentFolder } = request;

    const fileHash = createHash('md5').update(file).digest('hex');
    const createBody: Record<string, string> = { fileName, fileHash };
    if (parentFolder) {
      createBody.parentFolder = parentFolder;
    }

    const createResponse = await this.withRetry(() =>
      this.http.post<AssetUpload>(`/sites/${encodeURIComponent(siteId)}/assets`, createBody),
    );
    const assetUpload = createResponse.data;
    const uploadDetails = assetUpload.uploadDetails;
    const uploadUrl = assetUpload.uploadUrl;
    if (!uploadDetails || !uploadUrl) {
      throw new WebflowError('Webflow asset upload failed: no S3 upload details were returned');
    }

    const uploadForm = new FormData();
    // S3 policy fields first, under their exact wire key names.
    for (const [fieldName, fieldValue] of Object.entries(uploadDetails)) {
      if (fieldValue != null) {
        uploadForm.append(fieldName, String(fieldValue));
      }
    }
    // The file part must be appended LAST. Wrap in a fresh Uint8Array so the
    // Blob part is backed by a plain ArrayBuffer (Node's Buffer types its
    // backing buffer as ArrayBufferLike, which isn't a valid BlobPart).
    uploadForm.append(
      'file',
      new Blob([new Uint8Array(file)], { type: assetUpload.contentType || 'application/octet-stream' }),
      fileName,
    );

    await this.s3UploadHttp.post(uploadUrl, uploadForm);

    return assetUpload;
  }
}
