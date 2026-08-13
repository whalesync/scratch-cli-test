import { TObject, TSchema } from '@sinclair/typebox';
import { connectorMetadata, IncrementalPullSupport, isScratchPendingPublishId, TableView } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import _ from 'lodash';
import { ConnectorAssetExtractionInput, ConnectorAssetResult } from 'src/asset/asset.types';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { minifyHtml } from '../../../../wrappers/html-minify';
import {
  defaultResolveFieldValue,
  extractFromAnnotatedSchema,
  extractStandaloneEntity,
} from '../../asset-extraction-helpers';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { ConnectorAuthTokenOrProvider } from '../../connector-auth-token';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
  ReadonlyFieldEditError,
  readonlyFieldEditErrorMessage,
} from '../../error';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  EntityId,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../types';
import { WebflowApiClient } from './webflow-api-client';
import { buildWebflowDefaultView } from './webflow-default-view';
import { webflowEcommerceBasePath } from './webflow-folder-paths';
import { buildWebflowLastUpdatedFilter, webflowIncrementalPullSupport } from './webflow-incremental';
import {
  buildWebflowAssetsJsonTableSpec,
  buildWebflowJsonTableSpec,
  buildWebflowOrdersJsonTableSpec,
  buildWebflowPagesJsonTableSpec,
  WEBFLOW_ASSETS_TABLE_ID_PREFIX,
  WEBFLOW_PAGES_TABLE_ID_PREFIX,
} from './webflow-json-schema';
import { WebflowSchemaParser } from './webflow-schema-parser';
import {
  CollectionItem,
  CollectionItemFieldData,
  CollectionItemListNoPagination,
  CollectionItemWithIdInput,
  CollectionItemWithIdInputFieldData,
  isWebflowEcommerceCollectionSlug,
  Locale,
  OrderUpdate,
  Page,
  PageMetadataWrite,
  Site,
  WEBFLOW_ORDERS_TABLE_ID_PREFIX,
} from './webflow-types';

export const WEBFLOW_DEFAULT_BATCH_SIZE = 100;

/** True for an axios error carrying an HTTP 404 (record not found). */
function isWebflowNotFoundError(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 404;
}

/**
 * True for the Webflow "you can't live-PATCH an item that was never published"
 * error. Webflow returns HTTP 409 with a message containing "Live PATCH updates"
 * when a live update targets an item whose `lastPublished` is null — i.e. an item
 * created via the staged endpoint, or authored as a draft in Webflow and never
 * published. Because the live batch PATCH is atomic under `skipInvalidFiles:
 * false`, a single such item makes Webflow reject the whole batch. See
 * PUBLICATION_STATES.md rule #1 and DEV-10642.
 */
function isWebflowNeverPublishedError(error: unknown): boolean {
  if (!isAxiosError(error) || error.response?.status !== 409) return false;
  const message = (error.response?.data as { message?: unknown } | undefined)?.message;
  // The v2 API puts the human-readable reason under `message`; fall back to the
  // stringified body so a shape change can't silently disable the fallback.
  const haystack = typeof message === 'string' ? message : JSON.stringify(error.response?.data ?? '');
  return haystack.includes('Live PATCH updates');
}

/**
 * Normalize a Webflow page-metadata object into the ConnectorFile shape we
 * commit to disk. Used by both `pullPages` and `updateRecords` (pages branch,
 * applied to the post-write refetch result). Whitelists the same set of fields
 * on both sides. `createdOn`/`lastUpdated` already arrive as canonical ISO
 * strings (WebflowApiClient reproduces the old SDK's date normalization), so the
 * post-publish git blob stays byte-equal to a fresh pull.
 */
function normalizeWebflowPageForFile(page: Page): ConnectorFile {
  return {
    id: page.id,
    title: page.title,
    slug: page.slug,
    publishedPath: page.publishedPath,
    parentId: page.parentId,
    archived: page.archived,
    draft: page.draft,
    seo: page.seo,
    openGraph: page.openGraph,
    createdOn: page.createdOn,
    lastUpdated: page.lastUpdated,
  } as unknown as ConnectorFile;
}

/** The Webflow page fields writable via `updatePageSettings`. */
const WEBFLOW_PAGE_WRITABLE_FIELD_KEYS = new Set(['title', 'slug', 'seo', 'openGraph']);

/** The Webflow order fields writable via `updateOrder` (PATCH …/orders/{id}). */
const WEBFLOW_ORDER_WRITABLE_FIELD_KEYS = new Set([
  'comment',
  'shippingProvider',
  'shippingTracking',
  'shippingTrackingURL',
]);

/**
 * Throw if the user's sparse changed fields touch a read-only Webflow order field
 * (DEV-10729, mirroring the Pages guard for DEV-10597). Only comment + the three
 * shipping-tracking fields are writable; the order update silently ignores
 * everything else, so without this guard an edit to a read-only field (status,
 * customerInfo, totals, …) would vanish while the publish reported success.
 * `orderId` is the identity, ignored.
 */
function assertNoReadonlyWebflowOrderFieldsChanged(changed: Record<string, unknown>): void {
  const readonlyChangedFieldNames = Object.keys(changed).filter(
    (key) => key !== 'orderId' && !WEBFLOW_ORDER_WRITABLE_FIELD_KEYS.has(key),
  );
  if (readonlyChangedFieldNames.length > 0) {
    throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedFieldNames));
  }
}

/**
 * Throw if the user's sparse changed fields touch a read-only Webflow page field
 * (DEV-10597). Only title/slug/seo/openGraph are writable; the page-settings
 * update silently drops everything else (parentId, draft, archived,
 * publishedPath, createdOn, lastUpdated, …), so without this guard an edit to one
 * would vanish while the publish reported success. `id` is the identity, ignored.
 */
function assertNoReadonlyWebflowPageFieldsChanged(changed: Record<string, unknown>): void {
  const readonlyChangedFieldNames = Object.keys(changed).filter(
    (key) => key !== 'id' && !WEBFLOW_PAGE_WRITABLE_FIELD_KEYS.has(key),
  );
  if (readonlyChangedFieldNames.length > 0) {
    throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedFieldNames));
  }
}

export class WebflowConnector extends Connector {
  readonly service = Service.WEBFLOW;
  static readonly displayName = 'Webflow';
  static readonly metadata = connectorMetadata({
    displayName: 'Webflow',
    table: 'collection',
    tables: 'collections',
    record: 'item',
    records: 'items',
    logo: 'https://static.scratch.md/connector-icons/webflow.svg',
    incrementalPull: true,
    incrementalPullInstructions:
      'Incremental pull using Webflow’s last-updated filter. The Assets, Pages, and Ecommerce Orders tables are not supported.',
    credentialFields: {
      user_provided_params: [{ key: 'apiKey', type: 'password', label: 'API Token', required: true }],
    },
  });
  override supportsFileUpload = true;

  private readonly client: WebflowApiClient;
  private readonly schemaParser = new WebflowSchemaParser();

  /**
   * The account's pinned connector structure version (DEV-10302 / DEV-9698).
   * v1 = flat collections (`/<Site>/<Collection>`); v2 = nested
   * (`/<Site>/Collections/<Collection>`). Snapshotted from
   * `ConnectorAccount.version` at instantiation; defaults to 1 for callers that
   * don't supply it (e.g. unit tests).
   */
  private readonly structureVersion: number;

  constructor(
    accessTokenOrProvider: ConnectorAuthTokenOrProvider,
    opts?: { rateLimiter?: RateLimiter; structureVersion?: number },
  ) {
    super();
    this.client = new WebflowApiClient(accessTokenOrProvider, { rateLimiter: opts?.rateLimiter });
    this.structureVersion = opts?.structureVersion ?? 1;
  }

  public async testConnection(): Promise<void> {
    // Test connection by listing sites
    await this.client.testConnection();
  }

  async listTables(): Promise<TablePreview[]> {
    const tables: TablePreview[] = [];

    // Get all sites
    const sitesResponse = await this.client.listSites();
    const sites = sitesResponse.sites || [];

    // For each site, get all collections + an Assets table
    for (const site of sites) {
      const collectionsResponse = await this.client.listCollections(site.id);
      const collections = collectionsResponse.collections || [];

      // Secondary (non-primary) locales are surfaced as additional opt-in tables
      // nested inside each collection (DEV-10529). Resolve them once per site.
      const secondaryLocales = await this.getSecondaryLocales(site);

      // A site is treated as Ecommerce-enabled when it exposes any of Webflow's
      // reserved ecommerce collections (Products/SKUs/Categories). This gates the
      // synthetic Orders table so it never appears on a non-ecommerce site (whose
      // orders endpoint would be empty or error) (DEV-10729).
      let siteHasEcommerce = false;

      for (const collection of collections) {
        // Ecommerce collections (Products/SKUs/Categories) are no longer excluded —
        // `parseTablePreview` groups them under /<Site>/Ecommerce/ (DEV-10729).
        if (isWebflowEcommerceCollectionSlug(collection.slug)) {
          siteHasEcommerce = true;
        }
        tables.push(this.schemaParser.parseTablePreview(site, collection, this.structureVersion));
        // One additional table per secondary locale, nested under the primary
        // collection at /<Site>/Collections/<Collection>/<Locale>.
        for (const locale of secondaryLocales) {
          tables.push(
            this.schemaParser.parseSecondaryLocaleTablePreview(site, collection, locale, this.structureVersion),
          );
        }
      }

      // Add a site-level Assets table
      const assetsTableId = `${WEBFLOW_ASSETS_TABLE_ID_PREFIX}${site.id}`;
      tables.push({
        id: {
          wsId: assetsTableId,
          remoteId: [site.id, assetsTableId],
        },
        displayName: `Assets`,
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
        parentPath: site.displayName,
        metadata: {
          siteId: site.id,
          siteName: site.displayName,
          isAssetsTable: true,
        },
      });

      // Add a site-level Pages table (metadata only — title, slug, SEO, Open Graph)
      const pagesTableId = `${WEBFLOW_PAGES_TABLE_ID_PREFIX}${site.id}`;
      tables.push({
        id: {
          wsId: pagesTableId,
          remoteId: [site.id, pagesTableId],
        },
        displayName: `Pages`,
        disabledCreates: true,
        disabledDeletes: true,
        disabledReason: 'Page metadata only — title, slug, SEO, and Open Graph fields are editable',
        parentPath: site.displayName,
        metadata: {
          siteId: site.id,
          siteName: site.displayName,
          isPagesTable: true,
        },
      });

      // Add a site-level Ecommerce Orders table (DEV-10729) — only for
      // ecommerce-enabled sites — grouped under /<Site>/Ecommerce/ alongside
      // Products/SKUs/Categories. Orders can't be created or deleted via the API;
      // only comment + shipping-tracking fields are editable.
      if (siteHasEcommerce) {
        const ordersTableId = `${WEBFLOW_ORDERS_TABLE_ID_PREFIX}${site.id}`;
        tables.push({
          id: {
            wsId: ordersTableId,
            remoteId: [site.id, ordersTableId],
          },
          displayName: `Orders`,
          disabledCreates: true,
          disabledDeletes: true,
          disabledReason: 'Orders can only be edited (comment + shipping tracking); Webflow has no create/delete API',
          parentPath: webflowEcommerceBasePath(site).join('/'),
          metadata: {
            siteId: site.id,
            siteName: site.displayName,
            isOrdersTable: true,
          },
        });
      }
    }

    return tables;
  }

  /**
   * The site's enabled secondary locales (DEV-10529). `listSites` may return a
   * site without its `locales`, or with a partial `locales` object (e.g.
   * `primary` populated but `secondary` omitted), so fall back to a single
   * authoritative `getSite` fetch whenever `secondary` is not present as an
   * array. An explicit `secondary: []` is the unambiguous "no secondary locales"
   * signal and is trusted as-is (no extra fetch). Only enabled locales carrying a
   * `cmsLocaleId` (the CMS-item locale dimension) can become tables.
   */
  private async getSecondaryLocales(site: Site): Promise<Locale[]> {
    const siteWithLocales = Array.isArray(site.locales?.secondary) ? site : await this.client.getSite(site.id);
    const secondary = siteWithLocales.locales?.secondary ?? [];
    return secondary.filter((locale) => locale.enabled !== false && Boolean(locale.cmsLocaleId));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getNewFile(tableSpec: BaseJsonTableSpec): Promise<Record<string, unknown>> {
    const newFile: Record<string, unknown> = {
      cmsLocaleId: null,
      isArchived: false,
      isDraft: true,
      fieldData: {},
    };

    // Populate fieldData based on schema
    const schema = tableSpec.schema as TObject;
    const fieldDataSchema = schema.properties?.['fieldData'] as TObject | undefined;

    if (fieldDataSchema && fieldDataSchema.type === 'object' && fieldDataSchema.properties) {
      const fieldData: Record<string, unknown> = {};
      const properties = fieldDataSchema.properties as Record<string, TSchema>;

      for (const [key, propSchema] of Object.entries(properties)) {
        fieldData[key] = this.getDefaultValueForSchema(propSchema);
      }

      newFile.fieldData = fieldData;
    }

    return newFile;
  }

  private getDefaultValueForSchema(schema: TSchema): unknown {
    if (schema.default !== undefined) {
      return schema.default;
    }

    // Handle Optional wrapper (TypeBox Union of [Type, Null] or similar structure for Optional)
    // In TypeBox, Type.Optional(X) often creates a Modifier, but when compiled/inspected it might look specific.
    // However, our `webflowFieldToJsonSchema` mostly returns simple types or Type.Optional wrappers.
    // We'll approximate based on `type`.

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const type = schema.type;

    if (type === 'string') {
      if (schema.format === 'date-time') {
        return new Date().toISOString();
      }
      if (schema.format === 'uri') {
        return '';
      }
      return '';
    }

    if (type === 'number' || type === 'integer') {
      return 0;
    }

    if (type === 'boolean') {
      return false;
    }

    if (type === 'array') {
      return [];
    }

    if (type === 'object') {
      // For Image/File objects
      if ('properties' in schema && (schema as TObject).properties?.url) {
        return { url: '', alt: '' };
      }
      return {};
    }

    return null;
  }

  /**
   * Incremental support is decided per table type. CMS collections carry a
   * server-side `lastUpdated` on every item and their List Collection Items
   * endpoint accepts a `lastUpdated[gte]` filter, so they are unconditionally
   * SUPPORTED. The synthetic site-level Assets and Pages tables have no
   * changed-since filter on their list endpoints, so they are NOT_SUPPORTED
   * (always full-pulled). The deciding field is fixed (not user-selectable), so
   * there is no per-folder config to inspect — the answer comes straight from the
   * table's collection remote id. A `null` tableSpec (the REST layer computing the
   * value before a folder's first pull) reports the connector's general
   * capability; the registry's `resolveIncrementalPullSupport` gates precisely
   * from the `tableId` even without a schema.
   */
  override incrementalPullSupport(
    _options: PullRecordFilesOptions,
    tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    if (!tableSpec) return IncrementalPullSupport.SUPPORTED;
    const [, collectionId] = tableSpec.id.remoteId;
    return webflowIncrementalPullSupport(collectionId);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    WSLogger.info({ source: 'WebflowConnector', message: 'pullRecordFiles called', tableId: tableSpec.id.wsId });
    // remoteId[2] (DEV-10529) is the secondary-locale cmsLocaleId, present only
    // for per-locale collection tables; undefined ⇒ the site's primary locale.
    const [siteId, collectionId, cmsLocaleId] = tableSpec.id.remoteId;

    // Handle assets table (full pull only — no changed-since filter)
    if (collectionId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX)) {
      await this.pullAssets(siteId, callback);
      return {};
    }

    // Handle pages table (full pull only — no changed-since filter)
    if (collectionId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX)) {
      await this.pullPages(siteId, callback);
      return {};
    }

    // Handle Ecommerce orders table (full pull only — no changed-since filter)
    if (collectionId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX)) {
      await this.pullOrders(siteId, callback);
      return {};
    }

    // CMS collection items. Incremental pull filters the list by
    // `lastUpdated[gte] = since − skew`; a full pull leaves it unfiltered. Capture
    // the watermark BEFORE the first API call so an item changed mid-pull is
    // re-pulled next run (idempotent commits absorb the overlap). The assets/pages
    // tables returned above, so the filter only applies where Webflow supports it;
    // an incremental request without a `since` (the first pull) falls through to a
    // full scan and issues no watermark.
    let newWatermark: Date | undefined;
    let lastUpdatedSince: string | undefined;
    if (options.pullMode === 'incremental' && options.since instanceof Date) {
      newWatermark = new Date();
      lastUpdatedSince = buildWebflowLastUpdatedFilter(options.since);
    }

    let offset = (progress as { nextOffset?: number })?.nextOffset ?? 0;
    let hasMore = true;

    while (hasMore) {
      // List items with pagination (filtered by lastUpdated when incremental,
      // scoped to a single secondary locale when cmsLocaleId is set).
      const response = await this.client.listCollectionItems(collectionId, {
        offset,
        limit: WEBFLOW_DEFAULT_BATCH_SIZE,
        lastUpdatedSince,
        cmsLocaleId,
      });

      const items = response.items || [];

      if (items.length === 0) {
        hasMore = false;
        break;
      }

      // Check if there are more items
      const pagination = response.pagination;
      if (pagination) {
        const total = pagination.total || 0;
        offset += items.length;
        hasMore = offset < total;
      } else {
        // If no pagination info, assume we're done if we got less than limit
        hasMore = items.length === WEBFLOW_DEFAULT_BATCH_SIZE;
        offset += items.length;
      }

      await callback({ files: items as unknown as ConnectorFile[], connectorProgress: { nextOffset: offset } });
    }
    return newWatermark ? { newWatermark } : {};
  }

  /**
   * Pull all assets for a site via the Webflow Assets API.
   */
  private async pullAssets(
    siteId: string,
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.listAssets(siteId, {
        offset,
        limit: WEBFLOW_DEFAULT_BATCH_SIZE,
      });

      const assets = response.assets || [];

      if (assets.length === 0) {
        hasMore = false;
        break;
      }

      // Asset date fields are already normalized to ISO strings by the client.
      await callback({ files: assets as unknown as ConnectorFile[] });

      const pagination = response.pagination;
      if (pagination) {
        const total = pagination.total || 0;
        offset += assets.length;
        hasMore = offset < total;
      } else {
        hasMore = assets.length === WEBFLOW_DEFAULT_BATCH_SIZE;
        offset += assets.length;
      }
    }
  }

  /**
   * Pull all pages for a site via the Webflow Pages API.
   */
  private async pullPages(
    siteId: string,
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.listPages(siteId, {
        limit: WEBFLOW_DEFAULT_BATCH_SIZE,
        offset,
      });

      const pages = response.pages || [];

      if (pages.length === 0) {
        hasMore = false;
        break;
      }

      const files: ConnectorFile[] = pages.map((page) => normalizeWebflowPageForFile(page));

      await callback({ files });

      const pagination = response.pagination;
      if (pagination) {
        const total = pagination.total || 0;
        offset += pages.length;
        hasMore = offset < total;
      } else {
        hasMore = pages.length === WEBFLOW_DEFAULT_BATCH_SIZE;
        offset += pages.length;
      }
    }
  }

  /**
   * Pull all Ecommerce orders for a site via the Webflow Orders API. Full pull
   * only — the orders list endpoint has no changed-since filter. Orders are stored
   * verbatim (no date normalization: unlike Assets/Pages, there is no old-SDK
   * baseline to reproduce for ecommerce).
   */
  private async pullOrders(
    siteId: string,
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.listOrders(siteId, {
        offset,
        limit: WEBFLOW_DEFAULT_BATCH_SIZE,
      });

      const orders = response.orders || [];

      if (orders.length === 0) {
        hasMore = false;
        break;
      }

      await callback({ files: orders as unknown as ConnectorFile[] });

      const pagination = response.pagination;
      if (pagination) {
        const total = pagination.total || 0;
        offset += orders.length;
        hasMore = offset < total;
      } else {
        hasMore = orders.length === WEBFLOW_DEFAULT_BATCH_SIZE;
        offset += orders.length;
      }
    }
  }

  /**
   * Build the default table view for a Webflow table purely from its spec — the
   * exact view schema-gen used to stamp onto `defaultView`. The entity type is
   * recovered from the collection remote id's prefix, mirroring the dispatch in
   * `fetchJsonTableSpec`: the synthetic Assets/Pages/Orders tables carry a
   * `__…__`-prefixed collection id, and everything else (including a
   * secondary-locale table, whose id is the bare collection id) is a CMS
   * collection.
   */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    const [, collectionId] = spec.id.remoteId;
    if (collectionId === undefined) return undefined;
    let entityType: 'assets' | 'pages' | 'orders' | 'collection_items';
    if (collectionId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX)) {
      entityType = 'assets';
    } else if (collectionId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX)) {
      entityType = 'pages';
    } else if (collectionId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX)) {
      entityType = 'orders';
    } else {
      entityType = 'collection_items';
    }
    return buildWebflowDefaultView(spec.schema, entityType);
  }

  /**
   * Fetch JSON Table Spec directly from the Webflow API for a collection or assets table.
   * Converts Webflow field types to JSON Schema types for AI consumption.
   * Uses field slugs as property keys.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const [siteId, collectionId] = id.remoteId;

    // Handle assets table. Discriminate by tableId prefix, never by name/path —
    // a CMS collection literally named "Assets" must not be treated as the
    // synthetic assets table (DEV-9698, finding #13).
    if (collectionId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX)) {
      const site = await this.client.getSite(siteId);
      return buildWebflowAssetsJsonTableSpec(id, site, this.structureVersion);
    }

    // Handle pages table (discriminated by tableId prefix, same as assets).
    if (collectionId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX)) {
      const site = await this.client.getSite(siteId);
      return buildWebflowPagesJsonTableSpec(id, site, this.structureVersion);
    }

    // Handle Ecommerce orders table (discriminated by tableId prefix, same as assets).
    if (collectionId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX)) {
      const site = await this.client.getSite(siteId);
      return buildWebflowOrdersJsonTableSpec(id, site, this.structureVersion);
    }

    // Fetch site and collection directly from Webflow API
    const [site, collection] = await Promise.all([
      this.client.getSite(siteId),
      this.client.getCollection(collectionId),
    ]);

    return buildWebflowJsonTableSpec(id, site, collection, this.structureVersion);
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const [siteId, collectionId, cmsLocaleId] = tableSpec.id.remoteId;

    // Handle assets table
    if (collectionId.startsWith(WEBFLOW_ASSETS_TABLE_ID_PREFIX)) {
      const buffer: ConnectorFile[] = [];
      for (const assetId of ids) {
        try {
          const asset = await this.client.getAsset(assetId);
          if (asset) {
            // Asset date fields are already normalized to ISO strings by the client.
            buffer.push(asset as unknown as ConnectorFile);
          }
        } catch (error) {
          if (isWebflowNotFoundError(error)) {
            WSLogger.warn({
              source: 'WebflowConnector',
              message: `Asset ${assetId} not found, skipping`,
            });
            continue;
          }
          throw error;
        }
      }
      if (buffer.length > 0) {
        await callback({ files: buffer });
      }
      return;
    }

    // Handle pages table (metadata only)
    if (collectionId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX)) {
      const buffer: ConnectorFile[] = [];
      for (const pageId of ids) {
        try {
          const page = await this.client.getPageMetadata(pageId);
          if (page) {
            buffer.push(normalizeWebflowPageForFile(page));
          }
        } catch (error) {
          if (isWebflowNotFoundError(error)) {
            WSLogger.warn({
              source: 'WebflowConnector',
              message: `Page ${pageId} not found, skipping`,
            });
            continue;
          }
          throw error;
        }
      }
      if (buffer.length > 0) {
        await callback({ files: buffer });
      }
      return;
    }

    // Handle Ecommerce orders table (fetch one order at a time by orderId)
    if (collectionId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX)) {
      const buffer: ConnectorFile[] = [];
      for (const orderId of ids) {
        try {
          const order = await this.client.getOrder(siteId, orderId);
          if (order) {
            buffer.push(order as unknown as ConnectorFile);
          }
        } catch (error) {
          if (isWebflowNotFoundError(error)) {
            WSLogger.warn({
              source: 'WebflowConnector',
              message: `Order ${orderId} not found, skipping`,
            });
            continue;
          }
          throw error;
        }
      }
      if (buffer.length > 0) {
        await callback({ files: buffer });
      }
      return;
    }

    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const itemId of ids) {
      try {
        const item = await this.client.getCollectionItem(collectionId, itemId, cmsLocaleId);
        if (item) {
          buffer.push(item as unknown as ConnectorFile);
        }

        if (buffer.length >= BATCH_SIZE) {
          await callback({ files: buffer.splice(0) });
        }
      } catch (error) {
        if (isWebflowNotFoundError(error)) {
          WSLogger.warn({
            source: 'WebflowConnector',
            message: `Item ${itemId} not found in collection ${collectionId}, skipping`,
          });
          continue;
        }
        throw error;
      }
    }

    if (buffer.length > 0) {
      await callback({ files: buffer });
    }
  }

  getBatchSize(): number {
    // Webflow supports bulk operations up to 100 items
    return WEBFLOW_DEFAULT_BATCH_SIZE;
  }

  /**
   * Create items in Webflow from raw JSON files.
   * Files should contain Webflow fieldData.
   * Returns the created items.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const [, collectionId, cmsLocaleId] = tableSpec.id.remoteId;

    if (collectionId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX)) {
      throw new Error('Creating pages is not supported via the Webflow API');
    }

    if (collectionId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX)) {
      throw new Error('Creating orders is not supported via the Webflow API');
    }

    // Secondary-locale tables disable creates (TablePreview.disabledCreates); this
    // guard surfaces the rule loudly if a create ever reaches here. A localized
    // variant is created together with its primary item — create in the primary.
    if (cmsLocaleId) {
      throw new Error(
        'Creating items in a secondary Webflow locale is not supported — create the item in the primary locale and Webflow will localize it.',
      );
    }

    // Use the Live endpoint so Scratch publish == Webflow live publish in one round-trip.
    // The multi-item body shape preserves per-item isArchived/isDraft, unlike the bulk
    // `createItems` endpoint which only accepts request-level flags.
    const items: CollectionItem[] = [];
    for (const file of files) {
      const fieldData = await this.extractFieldDataForApi(file, tableSpec);
      const item: CollectionItem = {
        fieldData: fieldData as CollectionItemFieldData,
      };
      if (typeof file.isArchived === 'boolean') item.isArchived = file.isArchived;
      if (typeof file.isDraft === 'boolean') item.isDraft = file.isDraft;
      items.push(item);
    }

    const response = await this.client.createItemsLive(collectionId, {
      skipInvalidFiles: false,
      items,
    });

    const createdItems = _.get(response, 'items', []) as CollectionItem[];
    return createdItems as unknown as ConnectorFile[];
  }

  /**
   * Update items in Webflow from raw JSON files.
   * Files should have an 'id' field and fieldData to update.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const [siteId, collectionId, cmsLocaleId] = tableSpec.id.remoteId;

    // Handle Ecommerce orders table — update the limited writable fields one at a
    // time (mirrors the pages branch below). Only comment + the three
    // shipping-tracking fields are writable; everything else is read-only.
    if (collectionId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX)) {
      const orderResults: ConnectorFile[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const changed = changedFields?.[i];
        // A changed field outside the writable set (status, customerInfo, totals, …)
        // is a genuine read-only edit — surface it instead of silently dropping it
        // (DEV-10729). The no-diff fallback (`?? file`) re-sends the full record,
        // where read-only fields are always present and are simply not picked into
        // the update body.
        if (changed) assertNoReadonlyWebflowOrderFieldsChanged(changed);
        const source = changed ?? file;
        const orderId = file.orderId as string;

        const update: OrderUpdate = {};
        if (typeof source.comment === 'string') update.comment = source.comment;
        if (typeof source.shippingProvider === 'string') update.shippingProvider = source.shippingProvider;
        if (typeof source.shippingTracking === 'string') update.shippingTracking = source.shippingTracking;
        if (typeof source.shippingTrackingURL === 'string') update.shippingTrackingURL = source.shippingTrackingURL;

        if (Object.keys(update).length > 0) {
          await this.client.updateOrder(siteId, orderId, update);
          // Refetch via getOrder so the returned ConnectorFile is byte-equal to a
          // fresh pull (same refetch pattern as the pages branch).
          const refetched = await this.client.getOrder(siteId, orderId);
          orderResults.push(refetched as unknown as ConnectorFile);
        } else {
          // No writable field changed — input file is already canonical.
          orderResults.push(file);
        }
      }
      return orderResults;
    }

    // Handle pages table — update page settings one at a time
    if (collectionId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX)) {
      const pageResults: ConnectorFile[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const changed = changedFields?.[i];
        // Only title/slug/seo/openGraph are writable on a Webflow page. A changed
        // field outside that set (parentId, draft, archived, publishedPath, …) is a
        // genuine read-only edit — surface it instead of silently dropping it
        // (DEV-10597). The no-diff fallback (`?? file`) re-sends the full record,
        // where read-only fields are always present and are simply not picked.
        if (changed) assertNoReadonlyWebflowPageFieldsChanged(changed);
        const source = changed ?? file;
        const pageId = file.id as string;

        const update: Record<string, unknown> = {};
        if (source.title !== undefined) update.title = source.title;
        if (source.slug !== undefined) update.slug = source.slug;
        if (source.seo !== undefined) update.seo = source.seo;
        if (source.openGraph !== undefined) update.openGraph = source.openGraph;

        if (Object.keys(update).length > 0) {
          await this.client.updatePageSettings(pageId, update as PageMetadataWrite);
          // Refetch via getPageMetadata and route through the same normalizer as
          // pullPages so the returned ConnectorFile is byte-equal to a fresh
          // pull. updatePageSettings does return a `Page` directly, but going
          // through getPageMetadata + normalizeWebflowPageForFile keeps a single
          // source of truth for the on-disk shape and matches the refetch
          // pattern used by Notion + HubSpot updateRecords.
          const refetched = await this.client.getPageMetadata(pageId);
          pageResults.push(normalizeWebflowPageForFile(refetched));
        } else {
          // No write fired — input file is already canonical.
          pageResults.push(file);
        }
      }
      return pageResults;
    }

    const items: CollectionItemWithIdInput[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const source = changedFields?.[i] ?? file;
      const fieldData = await this.extractFieldDataForApi(source, tableSpec);
      const item: CollectionItemWithIdInput = {
        id: file.id as string,
        fieldData: fieldData as CollectionItemWithIdInputFieldData,
      };
      // Target a secondary locale's variant when this is a per-locale table
      // (DEV-10529). Webflow updates the primary locale unless a per-item
      // cmsLocaleId is supplied; the item id is shared across all locales.
      if (cmsLocaleId) item.cmsLocaleId = cmsLocaleId;
      if (typeof source.isArchived === 'boolean') item.isArchived = source.isArchived;
      if (typeof source.isDraft === 'boolean') item.isDraft = source.isDraft;
      items.push(item);
    }

    const response = await this.updateItemsLiveWithNeverPublishedFallback(collectionId, items);
    // The update returns the persisted items as a list. Map them back to input
    // order by id; missing rows fall back to the input file.
    const responseItems = response?.items;
    if (!Array.isArray(responseItems)) return files;
    const byId = new Map<string, ConnectorFile>();
    for (const item of responseItems) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === 'string') byId.set(id, item as unknown as ConnectorFile);
    }
    return files.map((file) => byId.get(file.id as string) ?? file);
  }

  /**
   * Publish a batch of item updates to Webflow's LIVE endpoint, degrading to a
   * per-record retry when the batch is rejected only because one or more items
   * have never been published.
   *
   * Webflow rejects the *entire* live PATCH batch with a 409 ("Live PATCH updates
   * can't be applied to items that have never been published") if ANY item in it
   * has never been published (the batch is atomic under `skipInvalidFiles:
   * false`). Without this fallback a single never-published draft sinks every
   * other record in the batch — the DEV-10642 report where 30 records "failed"
   * even though the edits were fine. On that specific 409 we retry each item on
   * its own: a live PATCH first, and — for the items that are themselves
   * never-published — a STAGED PATCH instead. The staged update lands the edit on
   * the item's draft without publishing it, matching its current Webflow state;
   * we never auto-publish an item the user hasn't published.
   *
   * Connector Prime Directive: the item body is byte-for-byte identical on either
   * endpoint — only the URL (`/items/live` vs `/items`) differs. No value is
   * reshaped, renamed, or normalized to make the fallback work.
   *
   * Any error other than the never-published 409 propagates untouched, so genuine
   * failures still surface (and are retried per-record by the publish pipeline).
   */
  private async updateItemsLiveWithNeverPublishedFallback(
    collectionId: string,
    items: CollectionItemWithIdInput[],
  ): Promise<CollectionItemListNoPagination> {
    try {
      return await this.client.updateItemsLive(collectionId, { skipInvalidFiles: false, items });
    } catch (error) {
      if (!isWebflowNeverPublishedError(error)) throw error;

      WSLogger.info({
        source: 'WebflowConnector.updateRecords',
        message:
          'Live PATCH batch rejected because at least one item was never published; retrying each item individually with a staged fallback for never-published items',
        tableId: collectionId,
        data: { itemCount: items.length },
      });

      const persistedItems: CollectionItem[] = [];
      for (const item of items) {
        const singleItemRequest = { skipInvalidFiles: false, items: [item] };
        let response: CollectionItemListNoPagination;
        try {
          response = await this.client.updateItemsLive(collectionId, singleItemRequest);
        } catch (perItemError) {
          if (!isWebflowNeverPublishedError(perItemError)) throw perItemError;
          // This is one of the never-published items — update its staged draft
          // instead of the (nonexistent) live version.
          response = await this.client.updateItemsStaged(collectionId, singleItemRequest);
        }
        const returnedItems = response?.items;
        if (Array.isArray(returnedItems)) persistedItems.push(...returnedItems);
      }
      return { items: persistedItems };
    }
  }

  /**
   * Delete items from Webflow.
   * Files should have an 'id' field with the item ID to delete.
   * Returns successfully if items are already deleted (404).
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const [, collectionId, cmsLocaleId] = tableSpec.id.remoteId;

    if (collectionId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX)) {
      throw new Error('Deleting pages is not supported via the Webflow API');
    }

    if (collectionId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX)) {
      throw new Error('Deleting orders is not supported via the Webflow API');
    }

    // Secondary-locale tables disable deletes (TablePreview.disabledDeletes); this
    // guard surfaces the rule loudly if a delete ever reaches here. Deleting an
    // item removes it from every locale (one shared id) — delete in the primary.
    if (cmsLocaleId) {
      throw new Error(
        'Deleting items from a secondary Webflow locale is not supported — delete the item in the primary locale.',
      );
    }

    const items = files.map((file) => ({ id: file.id as string }));

    // Step 1: unpublish from the live site so the records disappear from the rendered
    // pages immediately. Best-effort — items that were never published return 404 and
    // we silently move on to the CMS delete below.
    try {
      await this.client.deleteItemsLive(collectionId, { items });
    } catch (e) {
      if (!isWebflowNotFoundError(e)) throw e;
    }

    // Step 2: remove from the CMS (staging).
    try {
      await this.client.deleteItems(collectionId, { items });
    } catch (e) {
      if (isWebflowNotFoundError(e)) {
        return;
      }
      throw e;
    }
  }

  /**
   * Extracts and processes fieldData for sending to Webflow API.
   * Extracts fieldData from the file and minifies RichText fields.
   */
  private async extractFieldDataForApi(
    file: ConnectorFile,
    tableSpec: BaseJsonTableSpec,
  ): Promise<Record<string, unknown>> {
    // Extract fieldData wrapper - this is the Webflow native JSON format
    const fieldData = (file.fieldData as Record<string, unknown>) || {};
    return this.processFieldDataWithSchema(fieldData, tableSpec);
  }

  /**
   * Process fieldData using JSON schema to identify and minify RichText fields.
   * RichText fields are identified by contentMediaType: 'text/html' in the schema.
   * Only fields that exist in the schema are included - unknown fields are filtered out.
   */
  private async processFieldDataWithSchema(
    fieldData: Record<string, unknown>,
    tableSpec: BaseJsonTableSpec,
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    // Get the fieldData schema properties
    const schema = tableSpec.schema as TObject;
    const fieldDataSchema = schema.properties?.['fieldData'] as TObject | undefined;
    const fieldProperties = fieldDataSchema?.properties as Record<string, TSchema> | undefined;

    for (const [key, value] of Object.entries(fieldData)) {
      if (value === undefined) {
        continue;
      }

      // Only include fields that are defined in the schema
      const fieldSchema = fieldProperties?.[key];
      if (!fieldSchema) {
        // Skip unknown fields - they would cause Webflow API validation errors
        continue;
      }

      // Check if this field is a RichText field (has contentMediaType: 'text/html')
      const isRichText = (fieldSchema as { contentMediaType?: string }).contentMediaType === 'text/html';

      if (isRichText && typeof value === 'string') {
        result[key] = await minifyHtml(value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Upload a file to Webflow as a site asset.
   *
   * The `metadata` object must include `siteId` — the Webflow site to upload to.
   * Optionally, `parentFolder` can specify an asset folder ID.
   */
  async uploadFile(
    buffer: Buffer,
    filename: string,
    _mimeType: string,
    metadata?: Record<string, unknown>,
  ): Promise<ConnectorAssetResult> {
    const siteId = metadata?.siteId as string | undefined;
    if (!siteId) {
      throw new Error('metadata.siteId is required to upload a Webflow asset');
    }

    const parentFolder = metadata?.parentFolder as string | undefined;

    // uploadAsset handles MD5 hashing, metadata creation, and the S3 upload.
    const uploadResult = await this.client.uploadAsset(siteId, {
      file: buffer,
      fileName: filename,
      ...(parentFolder && { parentFolder }),
    });

    const uploadedAssetId = uploadResult.id;
    if (!uploadedAssetId) {
      throw new Error('Webflow asset upload succeeded but no asset ID was returned');
    }

    // Re-fetch the full asset record to get all metadata
    const asset = await this.client.getAsset(uploadedAssetId);

    if (!asset.id) {
      throw new Error('Webflow asset fetch returned no asset ID');
    }

    return {
      remoteAssetId: asset.id,
      url: asset.hostedUrl ?? undefined,
      filename: asset.originalFileName ?? undefined,
      mimeType: asset.contentType ?? undefined,
      size: asset.size ?? undefined,
      altText: asset.altText ?? undefined,
    };
  }

  extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[] {
    // Phase 0: Standalone entity (Webflow Assets table)
    const standalone = extractStandaloneEntity(input);
    if (standalone) return [standalone];

    // Phase 1: Schema-driven (Image/MultiImage fields)
    return extractFromAnnotatedSchema(input, {
      extractUrl: (item) => (typeof item['url'] === 'string' ? item['url'] : undefined),
      resolveFieldValue: defaultResolveFieldValue,
    });
  }

  /**
   * Resolve an `@asset/` reference into the object shape a Webflow Image/File field
   * expects on write. Webflow does not accept a bare URL string (the base
   * implementation's default) — it requires an object that is either `{ fileId }`
   * (reference an asset already on this site) or `{ url }` (re-host from a public URL).
   *
   * Cross-site asset sync (e.g. Sandbox → Prod) flows through here for the
   * `match_asset_by_hash` / `source_asset_to_dest_asset` transformers. The publish
   * `asset-upload` phase runs before the edit phase: it uploads the destination asset
   * to the target site and writes the minted Webflow fileId back onto the Asset row.
   * So by the time we resolve the reference, a successfully-uploaded asset has a real
   * (non-pending) `remoteAssetId` — we reference it by `{ fileId }`, which keeps publish
   * idempotent (Webflow re-ingests nothing on subsequent publishes). Only when the
   * asset is still a pending-publish placeholder (upload skipped or not yet run) do we
   * fall back to handing Webflow a public URL to re-host.
   *
   * The stale source `fileId` that broke cross-site sync is never reproduced here: this
   * resolver only ever sees the destination Asset row.
   */
  override resolveAssetReference(asset: {
    remoteAssetId: string;
    rehostedUrl: string | null;
    url: string | null;
  }): unknown {
    if (!isScratchPendingPublishId(asset.remoteAssetId)) {
      // Pre-uploaded to the destination site by the asset-upload phase. Reference it
      // by fileId — but Webflow REQUIRES the url alongside the fileId (it rejects a
      // bare { fileId } with "Expected value to have a 'url' field"), so include the
      // destination asset's own url (set on the Asset row by the upload write-back).
      const destinationUrl = asset.url ?? asset.rehostedUrl;
      return destinationUrl ? { fileId: asset.remoteAssetId, url: destinationUrl } : { fileId: asset.remoteAssetId };
    }
    // Not yet uploaded: hand Webflow a public URL. Prefer the permanent rehosted (GCS)
    // URL over the possibly-expiring source URL.
    const publicUrl = asset.rehostedUrl ?? asset.url;
    return publicUrl ? { url: publicUrl } : null;
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const [, collectionId] = tableSpec.id.remoteId;

    // For pages, use the slug as the filename
    if (collectionId.startsWith(WEBFLOW_PAGES_TABLE_ID_PREFIX)) {
      return records.map((record) => {
        const slug = record.slug as string | undefined;
        return slug || undefined;
      });
    }

    // For orders, use the orderId as the filename (orders have no slug).
    if (collectionId.startsWith(WEBFLOW_ORDERS_TABLE_ID_PREFIX)) {
      return records.map((record) => {
        const orderId = record.orderId as string | undefined;
        return orderId || undefined;
      });
    }

    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath ?? tableSpec.slugColumnRemoteId);
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (isAxiosError(error)) {
      // CMS item plan-limit (409) gets a dedicated, user-friendly message.
      if (error.response?.status === 409) {
        const message = extractErrorMessageFromAxiosError(this.service, error, ['message']);
        if (message.includes("You've created all the items in your CMS Database allowed on your current plan.")) {
          return {
            userFriendlyMessage: 'You have reached the maximum number of CMS items allowed for your plan.',
          };
        }
      }

      const commonDetails = extractCommonDetailsFromAxiosError(this, error);
      if (commonDetails) {
        return commonDetails;
      }

      // Webflow validation failures return an array of per-field errors (under
      // `errors` historically, `details` in v2). Surface every message joined,
      // matching the pre-migration connector — otherwise the user sees only the
      // single top-level summary and loses the per-field detail.
      const responseBody = error.response?.data as { errors?: unknown; details?: unknown } | undefined;
      const errorEntries: unknown[] | undefined = Array.isArray(responseBody?.errors)
        ? responseBody?.errors
        : Array.isArray(responseBody?.details)
          ? responseBody?.details
          : undefined;
      if (errorEntries) {
        const joinedMessages = errorEntries
          .map((entry) => (entry as { message?: unknown }).message)
          .filter((message): message is string => typeof message === 'string' && message.length > 0)
          .join('; ');
        if (joinedMessages) {
          return { userFriendlyMessage: joinedMessages, description: joinedMessages };
        }
      }

      const message = extractErrorMessageFromAxiosError(this.service, error, ['message']);
      return {
        userFriendlyMessage: message,
        description: message,
      };
    }
    return this.fallbackErrorDetails(error);
  }
}

connectorRegistry.register({
  service: Service.WEBFLOW,
  // v2 nests CMS collections under /<Site>/Collections/ (DEV-9698). New accounts
  // snapshot this onto ConnectorAccount.version and pull nested; existing accounts
  // stay pinned to v1 (flat) until the folder-move migration flips them, so a
  // connection is never half-flat-half-nested.
  version: 2,
  metadata: WebflowConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  rateLimiterSpec: { points: 120, duration: 60 },
  // CMS collections support incremental pull; Assets/Pages tables don't. The
  // table type is encoded in tableId[1] (the collection remote id), so this
  // resolves without a schema read — no incrementalPullAutoDetectsFromSchema.
  resolveIncrementalPullSupport: ({ tableId }) => webflowIncrementalPullSupport(tableId[1] ?? ''),
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Webflow', Service.WEBFLOW);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    // Pin the on-disk folder layout to the version snapshotted on this account
    // (DEV-9698): v2 nests collections, v1 stays flat.
    const structureVersion = ctx.connectorAccount.version;
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const accessTokenProvider = ctx.createOAuthAccessTokenProvider(ctx.connectorAccount.id);
      // Resolve once up front so a connection that can no longer mint a token fails
      // here rather than on the first API call; every later call re-resolves it.
      await accessTokenProvider();
      return new WebflowConnector(accessTokenProvider, { rateLimiter, structureVersion });
    } else {
      if (!ctx.decryptedCredentials?.apiKey) {
        throw new ConnectorInstantiationError('API key is required for Webflow', Service.WEBFLOW);
      }
      return new WebflowConnector(ctx.decryptedCredentials.apiKey, { rateLimiter, structureVersion });
    }
  },
});
