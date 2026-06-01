import { APIErrorCode, APIResponseError, Client, PageObjectResponse, RequestTimeoutError } from '@notionhq/client';
import {
  BlockObjectResponse,
  CreatePageParameters,
  QueryDatabaseParameters,
} from '@notionhq/client/build/src/api-endpoints';
import { connectorMetadata, ConnectorSettingDefinition, TableDiscoveryMode } from '@spinner/shared-types';
import _ from 'lodash';
import { ConnectorAssetExtractionInput, ConnectorAssetResult, MediaType } from 'src/asset/asset.types';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { defaultResolveFieldValue, extractFromAnnotatedSchema, stripQueryParams } from '../../asset-extraction-helpers';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError, ErrorMessageTemplates } from '../../error';
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
import { createNotionBlockDiff } from './conversion/notion-block-diff';
import { NotionBlockDiffExecutor } from './conversion/notion-block-diff-executor';
import { NotionMarkdownConverter } from './conversion/notion-markdown-converter';
import { convertToNotionBlocks } from './conversion/notion-rich-text-push';
import { ConvertedNotionBlock } from './conversion/notion-rich-text-push-types';
import {
  NotionDataSourceObjectResponse,
  NotionDataSourceSearchResult,
  NotionQueryDataSourceResponse,
} from './notion-data-source-types';
import { buildNotionLastEditedFilter, combineNotionFilters } from './notion-incremental';
import { buildNotionJsonTableSpec, NOTION_READ_ONLY_PROPERTY_TYPES } from './notion-json-schema';
import { NotionSchemaParser } from './notion-schema-parser';

const NOTION_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => APIResponseError.isAPIResponseError(error) && error.code === APIErrorCode.RateLimited,
  getRetryAfterS: (error) => {
    if (!APIResponseError.isAPIResponseError(error)) return undefined;
    const header = (error.headers as Record<string, string> | undefined)?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

export const PAGE_CONTENT_COLUMN_NAME = 'Page Content';
export const PAGE_CONTENT_COLUMN_ID = 'WS_PAGE_CONTENT';

/**
 * Notion API version that exposes the data-source endpoints used by the
 * connector. Pinned explicitly so a future SDK bump (Phase 4) doesn't silently
 * change the active version under us. The SDK v3 doesn't validate response
 * shapes strictly, so other typed calls (`pages.*`, `blocks.*`, `search`)
 * continue to work under this newer version.
 */
const NOTION_API_VERSION = '2025-09-03';

type NotionDownloadProgress = {
  nextCursor: string | undefined;
};

interface NotionPullOptions extends PullRecordFilesOptions {
  filter?: string | undefined;
  excludePageContent?: boolean | undefined;
  childContentMaxDepth?: number | undefined;
  pageSize?: number | undefined;
}

/**
 * Unwrap a Notion property wrapper object.
 * Notion stores property values as `{id: "...", type: "files", files: [...]}`.
 * This extracts the inner value (e.g. the files array) using the `type` key.
 */
function unwrapNotionProperty(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  const type = obj['type'];
  if (typeof type === 'string' && 'id' in obj && type in obj) {
    return obj[type];
  }
  return value;
}

export class NotionConnector extends Connector<string, NotionDownloadProgress> {
  readonly service = Service.NOTION;
  static displayName = 'Notion';
  static readonly metadata = connectorMetadata({
    displayName: 'Notion',
    table: 'database',
    tables: 'databases',
    record: 'page',
    records: 'pages',
    logo: 'https://static.scratch.md/connector-icons/notion.svg',
    incrementalPull: true,
    oauth: { label: 'OAuth' },
    credentialFields: {
      user_provided_params: [
        { key: 'apiKey', type: 'password', label: 'API Key', placeholder: 'Enter API Key', required: true },
      ],
    },
  });
  static readonly advancedSettings: ConnectorSettingDefinition[] = [
    {
      key: 'excludePageContent',
      type: 'boolean',
      label: 'Exclude page content',
      description: 'Skip downloading the body content of Notion pages. This will increase download speed.',
    },
    {
      key: 'childContentMaxDepth',
      type: 'number',
      label: 'Child content max depth',
      description: 'Maximum depth of nested child blocks to include. Leave empty for default behavior.',
      min: 0,
      max: 10,
    },
    {
      key: 'pageSize',
      type: 'number',
      label: 'Records per request',
      description:
        'Number of records to fetch per request. Reduce this if you have many columns and experience timeouts.',
      min: 1,
      max: 100,
    },
  ];

  private readonly client: Client;
  private readonly schemaParser = new NotionSchemaParser();
  private readonly markdownConverter = new NotionMarkdownConverter();
  private readonly rateLimiter?: RateLimiter;
  /**
   * Per-instance cache mapping databaseId → dataSourceId. Populated lazily by
   * {@link resolveDataSourceId} on the fallback path (folders whose `remoteId`
   * has not yet been backfilled to include the data source id). Removable once
   * the Phase 2 backfill has caught every folder.
   */
  private readonly dataSourceIdCache = new Map<string, string>();

  constructor(apiKey: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new Client({ auth: apiKey, notionVersion: NOTION_API_VERSION });
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, NOTION_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, NOTION_RETRY_OPTS);
  }

  /**
   * Resolve the Notion data source id for a folder's `remoteId`.
   *
   * After Phase 2 of DEV-8910, every Notion DataFolder's `remoteId` is
   * `[databaseId, dataSourceId]`. This helper supplies the fallback for any
   * folder created before the backfill caught it (or any new folder discovered
   * via `listTables` between Phase 2 and Phase 3 shipping) by calling
   * `databases.retrieve` and picking `data_sources[0]`. Memoized per Client
   * instance so a single multi-page pull doesn't trigger N extra retrievals.
   */
  private async resolveDataSourceId(remoteId: string[]): Promise<string> {
    if (remoteId[1]) {
      return remoteId[1];
    }
    const databaseId = remoteId[0];
    if (!databaseId) {
      throw new Error('Notion remoteId is empty — cannot resolve data source id');
    }
    const cached = this.dataSourceIdCache.get(databaseId);
    if (cached) return cached;

    const database = (await this.withRetry(() => this.client.databases.retrieve({ database_id: databaseId }))) as {
      data_sources?: Array<{ id: string; name: string }>;
    };
    const first = database.data_sources?.[0]?.id;
    if (!first) {
      throw new Error(`Notion database ${databaseId} has no data sources`);
    }
    this.dataSourceIdCache.set(databaseId, first);
    return first;
  }

  /**
   * Raw GET /v1/data_sources/{id}. The SDK v3 has no typed method for this
   * endpoint, so we use the public `Client.request` escape hatch. Replaced by
   * `client.dataSources.retrieve` in Phase 4.
   */
  private async requestDataSource(dataSourceId: string): Promise<NotionDataSourceObjectResponse> {
    const response = await this.client.request({
      method: 'get',
      path: `data_sources/${dataSourceId}`,
    });
    return response as NotionDataSourceObjectResponse;
  }

  /**
   * Raw POST /v1/data_sources/{id}/query. Replaces `client.databases.query`,
   * which is removed in the v5 SDK. Replaced by `client.dataSources.query` in
   * Phase 4.
   */
  private async requestDataSourceQuery(
    dataSourceId: string,
    body: {
      start_cursor?: string;
      page_size?: number;
      filter?: QueryDatabaseParameters['filter'];
    },
  ): Promise<NotionQueryDataSourceResponse> {
    const response = await this.client.request({
      method: 'post',
      path: `data_sources/${dataSourceId}/query`,
      body,
    });
    return response as NotionQueryDataSourceResponse;
  }

  get tableDiscoveryMode(): TableDiscoveryMode {
    return TableDiscoveryMode.SEARCH;
  }

  /**
   * Search the Notion workspace for objects of `object: 'data_source'`.
   *
   * The SDK v3's `search` filter is typed against the 2022-06-28 vocabulary
   * (`'database' | 'page'`), so we route through `client.request` to ship the
   * new 2025-09-03 filter value `'data_source'` without an `as` cast. Replaced
   * by a typed `client.search({ filter: { value: 'data_source' } })` call in
   * Phase 4 after the SDK bump.
   */
  private async searchDataSources(args: {
    query?: string;
    pageSize?: number;
  }): Promise<{ results: NotionDataSourceSearchResult[]; has_more: boolean }> {
    const response = await this.client.request({
      method: 'post',
      path: 'search',
      body: {
        ...(args.query !== undefined ? { query: args.query } : {}),
        filter: { property: 'object', value: 'data_source' },
        ...(args.pageSize !== undefined ? { page_size: args.pageSize } : {}),
      },
    });
    const raw = response as { results: Array<{ object?: string }>; has_more: boolean };
    const results = raw.results.filter((r): r is NotionDataSourceSearchResult => r.object === 'data_source');
    return { results, has_more: raw.has_more };
  }

  async testConnection(): Promise<void> {
    // Just don't throw. We search for `data_source` rather than `database` so
    // testConnection exercises the same surface (the 2025-09-03 search index)
    // that listTables and searchTables rely on.
    await this.withRetry(() => this.searchDataSources({ pageSize: 1 }));
  }

  /**
   * Recursively fetches all blocks from a page, including nested children
   */
  private async fetchBlocksWithChildren(blockId: string): Promise<ConvertedNotionBlock[]> {
    const blocks: ConvertedNotionBlock[] = [];
    let hasMore = true;
    let startCursor: string | undefined = undefined;

    while (hasMore) {
      const response = await this.withRetry(() =>
        this.client.blocks.children.list({
          block_id: blockId,
          start_cursor: startCursor,
          page_size: 100,
        }),
      );

      for (const block of response.results) {
        // Add children property to match ConvertedNotionBlock type
        const blockWithChildren = {
          ...block,
          children: [] as ConvertedNotionBlock[],
        } as ConvertedNotionBlock;

        if (_.has(block, 'has_children') && (block as BlockObjectResponse).has_children) {
          blockWithChildren.children = await this.fetchBlocksWithChildren(block.id);
        }

        blocks.push(blockWithChildren);
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor || undefined;
    }

    return blocks;
  }

  async listTables(): Promise<TablePreview[]> {
    const response = await this.withRetry(() => this.searchDataSources({ query: '', pageSize: 10 }));
    return response.results.map((ds) => this.schemaParser.parseDataSourceTablePreview(ds));
  }

  async searchTables(searchTerm: string): Promise<{ tables: TablePreview[]; hasMore: boolean }> {
    const response = await this.withRetry(() => this.searchDataSources({ query: searchTerm }));
    const tables = response.results.map((ds) => this.schemaParser.parseDataSourceTablePreview(ds));
    return { tables, hasMore: response.has_more };
  }

  /**
   * Fetch JSON Table Spec for Notion database pages.
   * Returns a schema describing the raw Notion page API response format.
   *
   * Under 2025-09-03, `properties` lives on the *data source*, not the
   * database — so we fetch the data source object directly via the raw
   * endpoint (the SDK v3 has no typed `dataSources.retrieve`). Folders that
   * haven't been backfilled to a 2-element `remoteId` fall through
   * `resolveDataSourceId`.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const dataSourceId = await this.resolveDataSourceId(id.remoteId);
    const dataSource = await this.withRetry(() => this.requestDataSource(dataSourceId));
    return buildNotionJsonTableSpec(id, dataSource);
  }

  /**
   * Suggest filenames from the Notion page title property.
   * Notion pages store titles as rich text arrays: { properties: { "Title": { type: "title", title: [{ plain_text }] } } }
   */
  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePropertyName = this.resolveTitlePropertyName(tableSpec);
    if (!titlePropertyName) {
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath ?? tableSpec.slugColumnRemoteId);
    }
    return records.map((record) => {
      const titleProp = _.get(record, ['properties', titlePropertyName]) as unknown;
      if (!titleProp || typeof titleProp !== 'object') return undefined;
      // Notion wraps the title array: { id, type: "title", title: [{ plain_text }] }
      const obj = titleProp as Record<string, unknown>;
      const titleArray = Array.isArray(titleProp) ? titleProp : obj.title;
      if (!Array.isArray(titleArray)) return undefined;
      const text = (titleArray as Record<string, unknown>[]).map((t) => (t.plain_text as string) ?? '').join('');
      return text.trim() || undefined;
    });
  }

  /**
   * Resolve the title property name for filename extraction.
   * titleColumnRemoteId is now ['properties', propertyName], so just return the property name directly.
   */
  private resolveTitlePropertyName(tableSpec: BaseJsonTableSpec): string | undefined {
    if (!tableSpec.titleColumnRemoteId || tableSpec.titleColumnRemoteId.length === 0) {
      return undefined;
    }

    // titleColumnRemoteId is ['properties', propertyName] — return the property name directly
    if (tableSpec.titleColumnRemoteId.length >= 2) {
      return tableSpec.titleColumnRemoteId[1];
    }

    // Fallback for single-element array (shouldn't happen with new schema)
    if (tableSpec.titleColumnRemoteId.length === 1) {
      return tableSpec.titleColumnRemoteId[0];
    }

    return undefined;
  }

  /**
   * Notion supports incremental pulls unconditionally: every database page has
   * a server-side `last_edited_time` system field, and `databases.query` can
   * filter on it. There is no per-folder config to inspect (the field is not
   * user-selectable), so this always returns `true` and a run only demotes to
   * full at pull time if the user's own filter is a compound `and`/`or`
   * (Notion's single-level nesting limit — see `pullRecordFiles`).
   */
  override supportsIncrementalPull(): boolean {
    return true;
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: NotionDownloadProgress }) => Promise<void>,
    progress: NotionDownloadProgress,
    options: NotionPullOptions,
  ): Promise<PullRecordFilesResult> {
    WSLogger.info({ source: 'NotionConnector', message: 'pullRecordFiles called', tableId: tableSpec.id.wsId });

    const dataSourceId = await this.resolveDataSourceId(tableSpec.id.remoteId);
    let hasMore = true;
    let nextCursor = progress?.nextCursor;

    let notionFilter: QueryDatabaseParameters['filter'] = undefined;
    if (options.filter) {
      // parse the filter as a Notion Filter object
      try {
        notionFilter = JSON.parse(options.filter) as QueryDatabaseParameters['filter'];
      } catch (error) {
        WSLogger.error({
          source: 'NotionConnector',
          message: `Failed to parse filter ${options.filter}`,
          error,
        });
        throw new Error(`Failed to parse Notion filter ${options.filter}`);
      }
    }

    let newWatermark: Date | undefined;
    if (options.pullMode === 'incremental' && options.since instanceof Date) {
      const timestampFilter = buildNotionLastEditedFilter(options.since);
      const combined = combineNotionFilters(notionFilter ?? undefined, timestampFilter);
      if (combined.demoteToFull) {
        // Notion allows only one level of compound nesting. Wrapping a
        // compound user filter in another `and` would 400, so we skip the
        // incremental filter and full-scan instead (keeping the user filter).
        WSLogger.warn({
          source: 'NotionConnector',
          message:
            'Incremental pull demoted to full: the user filter is a compound and/or, so nesting the ' +
            "last_edited_time filter would exceed Notion's single-level compound-filter limit",
          tableId: tableSpec.id.wsId,
        });
      } else {
        // Capture the start-of-pull timestamp BEFORE the first API call so we
        // don't lose changes that happen mid-pull. `on_or_after` is inclusive,
        // so the boundary record is re-pulled and absorbed by idempotent
        // commits (NOTION_INCREMENTAL_CLOCK_SKEW_MS = 0).
        newWatermark = new Date();
        notionFilter = combined.filter;
      }
    }

    while (hasMore) {
      const response = await this.withRetry(() =>
        this.requestDataSourceQuery(dataSourceId, {
          start_cursor: nextCursor,
          page_size: options.pageSize ?? 100,
          filter: notionFilter,
        }),
      );

      // Return raw page objects as ConnectorFiles
      const files: ConnectorFile[] = [];
      const pageResults = response.results.filter((r): r is PageObjectResponse => r.object === 'page');

      for (const page of pageResults) {
        const connectorFile = page as unknown as ConnectorFile;

        if (!options.excludePageContent) {
          const maxChildDepth = options.childContentMaxDepth ?? NotionConnector.PAGE_CONTENT_MAX_DEPTH;
          // Fetch children recursively for this page
          try {
            const childrenData = await this.pollRecordPageContentChildren(page.id, maxChildDepth, page.id);
            connectorFile['page_content'] = childrenData.children;
          } catch (error) {
            WSLogger.error({
              source: 'NotionConnector',
              message: `Failed to fetch content for page ${page.id}`,
              error,
            });
          }
        }
        files.push(connectorFile);
      }

      hasMore = response.has_more;
      nextCursor = response.next_cursor ?? undefined;

      await callback({
        files,
        connectorProgress: { nextCursor },
      });
    }
    return newWatermark ? { newWatermark } : {};
  }

  async pullRecordFilesByIds(
    _tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const BATCH_SIZE = 10;
    const buffer: ConnectorFile[] = [];

    for (const pageId of ids) {
      try {
        const page = (await this.withRetry(() =>
          this.client.pages.retrieve({ page_id: pageId }),
        )) as PageObjectResponse;
        const connectorFile = page as unknown as ConnectorFile;

        try {
          const childrenData = await this.pollRecordPageContentChildren(
            page.id,
            NotionConnector.PAGE_CONTENT_MAX_DEPTH,
            page.id,
          );
          connectorFile['page_content'] = childrenData.children;
        } catch (error) {
          WSLogger.error({
            source: 'NotionConnector',
            message: `Failed to fetch content for page ${pageId}`,
            error,
          });
        }

        buffer.push(connectorFile);

        if (buffer.length >= BATCH_SIZE) {
          await callback({ files: buffer.splice(0) });
        }
      } catch (error) {
        if (APIResponseError.isAPIResponseError(error) && error.code === APIErrorCode.ObjectNotFound) {
          WSLogger.warn({
            source: 'NotionConnector',
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
  }

  getBatchSize(): number {
    return 1;
  }

  /**
   * Create pages in Notion from raw JSON files.
   * Files should contain Notion properties in the raw API format.
   * Returns the created pages.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const results: ConnectorFile[] = [];
    const dataSourceId = await this.resolveDataSourceId(tableSpec.id.remoteId);

    for (const file of files) {
      const rawProperties = (file.properties as Record<string, unknown>) || {};
      // Transform properties from read format to create format (same rules as update)
      const properties = this.transformPropertiesForUpdate(rawProperties);

      // The SDK v3 `CreatePageParameters` parent type is the 2022-06-28 union
      // (`database_id | page_id | workspace`). Notion accepts the new
      // `data_source_id` parent on the wire under both old and new API
      // versions, but the typed shape doesn't include it yet — cast through
      // unknown until the Phase 4 SDK bump.
      const newPage = await this.withRetry(() =>
        this.client.pages.create({
          parent: { type: 'data_source_id', data_source_id: dataSourceId } as unknown as CreatePageParameters['parent'],
          properties: properties as CreatePageParameters['properties'],
        }),
      );
      results.push(newPage as unknown as ConnectorFile);
    }

    return results;
  }

  // ==========================================
  // Recursive Fetching Logic
  // ==========================================

  private static readonly PAGE_CONTENT_MAX_DEPTH = 10;
  private static readonly PAGE_CONTENT_MAX_BREADTH = 500;
  private static readonly PAGE_CONTENT_PAGE_SIZE = 100;

  /**
   * Fetches the full content of a block (including recursive children).
   * Acts as the entry point for recursive fetching.
   */
  async pollRecordPageContent(blockId: string): Promise<{
    pageContent: ConvertedNotionBlock;
    statistics: { maxDepth: number; maxBreadth: number; totalCalls: number };
  }> {
    const response = await this.withRetry(() => this.client.blocks.retrieve({ block_id: blockId }));
    const pageContent = response as unknown as ConvertedNotionBlock;

    if (_.has(response, 'has_children') && (response as BlockObjectResponse).has_children) {
      const childrenData = await this.pollRecordPageContentChildren(
        pageContent.id!,
        NotionConnector.PAGE_CONTENT_MAX_DEPTH,
        blockId,
      );

      pageContent.children = childrenData.children;
      return {
        pageContent,
        statistics: {
          maxDepth: childrenData.statistics.maxDepth + 1,
          maxBreadth: Math.max(childrenData.statistics.maxBreadth, 1),
          totalCalls: childrenData.statistics.totalCalls + 1,
        },
      };
    }

    return { pageContent, statistics: { maxDepth: 1, maxBreadth: 1, totalCalls: 1 } };
  }

  /**
   * Recursively fetches children of a block, respecting depth and breadth limits.
   */
  async pollRecordPageContentChildren(
    blockId: string,
    depthLimit: number,
    rootRecordId: string,
  ): Promise<{
    children: ConvertedNotionBlock[];
    statistics: { maxDepth: number; maxBreadth: number; totalCalls: number };
  }> {
    if (depthLimit === 0) {
      WSLogger.warn({
        source: 'NotionConnector',
        message: `Max depth reached for record ${rootRecordId}`,
      });
      return { children: [], statistics: { maxDepth: 0, maxBreadth: 0, totalCalls: 0 } };
    }

    const blocks: ConvertedNotionBlock[] = [];
    let hasMore = true;
    let startCursor: string | undefined = undefined;
    let childMaxDepth = 0;
    let childMaxBreadth = 0;
    let totalCalls = 0;

    while (hasMore) {
      totalCalls++;

      // Stop if breadth limit reached
      if (blocks.length >= NotionConnector.PAGE_CONTENT_MAX_BREADTH) {
        WSLogger.warn({
          source: 'NotionConnector',
          message: `Max breadth reached for record ${rootRecordId}`,
        });
        break;
      }

      const response = await this.withRetry(() =>
        this.client.blocks.children.list({
          block_id: blockId,
          start_cursor: startCursor,
          page_size: NotionConnector.PAGE_CONTENT_PAGE_SIZE,
        }),
      );

      for (const result of response.results) {
        const block = result as unknown as ConvertedNotionBlock;

        // Skip unsupported types if necessary

        if ((result as BlockObjectResponse).has_children) {
          const childrenData = await this.pollRecordPageContentChildren(block.id!, depthLimit - 1, rootRecordId);
          block.children = childrenData.children;
          childMaxDepth = Math.max(childrenData.statistics.maxDepth, childMaxDepth);
          childMaxBreadth = Math.max(childrenData.statistics.maxBreadth, childMaxBreadth);
          totalCalls += childrenData.statistics.totalCalls;
        }

        blocks.push(block);
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor || undefined;
    }

    return {
      children: blocks,
      statistics: {
        maxDepth: childMaxDepth + 1,
        maxBreadth: Math.max(childMaxBreadth, blocks.length),
        totalCalls,
      },
    };
  }

  /**
   * Transform properties from Notion's read format to update format.
   * - Removes read-only properties (rollup, formula, etc.)
   * - Removes the 'type' field from each property (required for update API)
   */
  private transformPropertiesForUpdate(properties: Record<string, unknown>): Record<string, unknown> {
    const transformed: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(properties)) {
      if (!value || typeof value !== 'object') {
        continue;
      }

      const prop = value as Record<string, unknown>;
      const propType = prop.type as string;

      // Skip read-only properties
      if (NOTION_READ_ONLY_PROPERTY_TYPES.has(propType)) {
        continue;
      }

      // Create a copy without the 'type' and 'id' fields
      // The Notion update API expects just the property value, not the type wrapper
      const rest = Object.fromEntries(Object.entries(prop).filter(([k]) => k !== 'type' && k !== 'id'));

      // Only include if there's actual content to update
      if (Object.keys(rest).length > 0) {
        transformed[key] = rest;
      }
    }

    return transformed;
  }

  /**
   * Update pages in Notion from raw JSON files.
   * Files should have an 'id' field and the properties to update.
   */
  async updateRecords(
    _tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const changed = changedFields[i];
      const pageId = file.id as string;

      const fileProperties = (file.properties as Record<string, unknown>) || {};
      const changedProperties = (changed.properties as Record<string, unknown>) || {};

      // The sparse partial lacks each property's `type` wrapper, so we can't filter
      // read-only props from `changedProperties` alone — look up types from the full file.
      const writableChangedProperties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(changedProperties)) {
        const fileProp = fileProperties[key] as Record<string, unknown> | undefined;
        const propType = fileProp?.type as string | undefined;
        if (propType && NOTION_READ_ONLY_PROPERTY_TYPES.has(propType)) continue;
        writableChangedProperties[key] = value;
      }

      // Transform properties from read format to update format
      const properties = this.transformPropertiesForUpdate(writableChangedProperties);

      if (Object.keys(properties).length > 0) {
        await this.withRetry(() =>
          this.client.pages.update({
            page_id: pageId,
            properties: properties as CreatePageParameters['properties'],
          }),
        );
      }
    }
    return files;
  }

  /**
   * Delete (archive) pages in Notion.
   * Files should have an 'id' field with the page ID to archive.
   */
  async deleteRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    for (const file of files) {
      const pageId = file.id as string;
      await this.withRetry(() =>
        this.client.pages.update({
          page_id: pageId,
          archived: true,
        }),
      );
    }
  }

  private async updatePageContent(pageId: string, content: string, isMarkdown: boolean): Promise<void> {
    // Fetch existing blocks from the page
    const existingBlocksArray = await this.fetchBlocksWithChildren(pageId);

    // Wrap blocks in a NotionBlockObject structure for the diff function
    const existingBlocks = {
      id: pageId,
      type: 'page',
      object: 'block',
      children: existingBlocksArray,
    };

    // Convert new content (markdown/HTML) to Notion blocks
    const newBlocks = isMarkdown
      ? this.markdownConverter.markdownToNotion(content)
      : convertToNotionBlocks(content, false);

    // Create a diff between old and new blocks
    const diff = createNotionBlockDiff(existingBlocks, newBlocks, pageId);

    // Execute the diff operations using the executor
    const executor = new NotionBlockDiffExecutor(this.client);
    const idMappings = new Map<string, string>(diff.idMappings || []);
    await executor.executeOperations(pageId, diff.operations, idMappings);
  }

  /**
   * Notion needs assets as external URL objects: { type: 'external', external: { url } }
   */
  override resolveAssetReference(asset: {
    remoteAssetId: string;
    rehostedUrl: string | null;
    url: string | null;
  }): unknown {
    const url = asset.rehostedUrl ?? asset.url;
    return url ? { type: 'external', external: { url } } : null;
  }

  extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[] {
    const results: ConnectorAssetResult[] = [];

    // Phase 1: Schema-driven extraction (files property, cover, icon)
    const notionFileTypes = new Set(['external', 'file']);
    const schemaResults = extractFromAnnotatedSchema(input, {
      extractUrl: (item) => {
        if (typeof item['url'] === 'string') return item['url'];
        const external = item['external'] as Record<string, unknown> | undefined;
        if (typeof external?.['url'] === 'string') return external['url'];
        const file = item['file'] as Record<string, unknown> | undefined;
        if (typeof file?.['url'] === 'string') return file['url'];
        return undefined;
      },
      resolveFieldValue: (content, fieldName, schema) => {
        const raw = defaultResolveFieldValue(content, fieldName, schema);
        return unwrapNotionProperty(raw);
      },
      extractMimeType: (item) => {
        const raw = (item['type'] ?? item['mime_type'] ?? item['contentType']) as string | undefined;
        return raw && !notionFileTypes.has(raw) ? raw : undefined;
      },
      inferMediaType: (item, fieldPath) => {
        const mime = (item['type'] ?? item['mime_type'] ?? item['contentType'] ?? item['mimeType']) as
          | string
          | undefined;
        if (mime && !notionFileTypes.has(mime)) {
          if (mime.startsWith('image/')) return 'image';
          if (mime.startsWith('video/')) return 'video';
          if (mime.startsWith('audio/')) return 'audio';
          if (mime === 'application/pdf') return 'document';
          return 'file';
        }
        const filename = (item['filename'] ?? item['name']) as string | undefined;
        if (filename) {
          const ext = filename.split('.').pop()?.toLowerCase();
          if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext ?? '')) return 'image';
          if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext ?? '')) return 'video';
          if (['mp3', 'wav', 'ogg', 'flac', 'aac'].includes(ext ?? '')) return 'audio';
          if (ext === 'pdf') return 'document';
        }
        if (['cover', 'icon'].includes(fieldPath)) return 'image';
        return undefined;
      },
      inferExpiryDate: (item) => {
        const file = item['file'] as Record<string, unknown> | undefined;
        const expiryTime = file?.['expiry_time'] as string | undefined;
        if (expiryTime) {
          const d = new Date(expiryTime);
          if (!isNaN(d.getTime())) return d;
        }
        return new Date(Date.now() + 2 * 60 * 60 * 1000);
      },
      generateAssetId: (url) => stripQueryParams(url),
    });
    results.push(...schemaResults);

    // Phase 2: Content blocks (page_content)
    const pageContent = input.recordContent['page_content'] as unknown[] | undefined;
    if (Array.isArray(pageContent)) {
      for (let i = 0; i < pageContent.length; i++) {
        const block = pageContent[i] as Record<string, unknown> | undefined;
        if (!block || typeof block !== 'object') continue;
        const entry = this.extractFromNotionBlock(block);
        if (entry) results.push(entry);
      }
    }

    return results;
  }

  private extractFromNotionBlock(block: Record<string, unknown>): ConnectorAssetResult | null {
    const type = block['type'] as string | undefined;
    if (!type) return null;

    const mediaTypes: Record<string, MediaType> = {
      image: 'image',
      video: 'video',
      audio: 'audio',
      file: 'file',
      pdf: 'document',
    };

    const mediaType = mediaTypes[type];
    if (!mediaType) return null;

    const blockData = block[type] as Record<string, unknown> | undefined;
    if (!blockData) return null;

    const fileType = blockData['type'] as string | undefined;
    let url: string | undefined;
    let urlExpires = false;

    if (fileType === 'external') {
      const external = blockData['external'] as Record<string, unknown> | undefined;
      url = external?.['url'] as string | undefined;
    } else if (fileType === 'file') {
      const file = blockData['file'] as Record<string, unknown> | undefined;
      url = file?.['url'] as string | undefined;
      urlExpires = true;
    }

    if (!url) return null;

    const caption = blockData['caption'] as Array<Record<string, unknown>> | undefined;
    const altText = caption?.map((c) => c['plain_text']).join('') || undefined;

    let urlExpiresAt: Date | undefined;
    if (urlExpires) {
      const file = blockData['file'] as Record<string, unknown> | undefined;
      const expiryTime = file?.['expiry_time'] as string | undefined;
      if (expiryTime) {
        const d = new Date(expiryTime);
        if (!isNaN(d.getTime())) urlExpiresAt = d;
      }
    }

    return {
      remoteAssetId: stripQueryParams(url),
      url,
      altText,
      mediaType,
      urlExpiresAt,
    };
  }

  /**
   * Evalutes the specific the error from the Notion client and return a ConnectorErrorDetails object.
   * @param error - The error to evaluate.
   * @returns A common object describing the error for the user.
   */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (RequestTimeoutError.isRequestTimeoutError(error)) {
      return {
        userFriendlyMessage: ErrorMessageTemplates.API_TIMEOUT('Notion'),
        description: error instanceof Error ? error.message : String(error),
      };
    }

    if (APIResponseError.isAPIResponseError(error)) {
      const notionError = error;

      if (notionError.code === APIErrorCode.Unauthorized) {
        return {
          userFriendlyMessage: `The credentials Scratch uses to communicate with Notion are no longer valid. Details: ${notionError.message}`,
          description: notionError.message,
        };
      }

      if (notionError.code === APIErrorCode.RateLimited) {
        return {
          userFriendlyMessage: `${ErrorMessageTemplates.API_QUOTA_EXCEEDED('Notion')} Details: ${notionError.message}`,
          description: notionError.message,
        };
      }

      if (notionError.code === APIErrorCode.ObjectNotFound) {
        return {
          userFriendlyMessage: `Notion object not found: ${notionError.message}`,
          description: notionError.message,
        };
      }

      if (notionError.code === APIErrorCode.InvalidRequest) {
        return {
          userFriendlyMessage: `Notion invalid request: ${notionError.message}`,
          description: notionError.message,
        };
      }

      if (notionError.code === APIErrorCode.InternalServerError) {
        return {
          userFriendlyMessage: `An internal server error occurred while connecting to Notion. Details: ${notionError.message}`,
          description: notionError.message,
        };
      }

      if (notionError.code === APIErrorCode.ServiceUnavailable) {
        return {
          userFriendlyMessage: `The Notion service is unavailable. Details: ${notionError.message}`,
          description: notionError.message,
        };
      }

      // Catch-all for any other Notion API error codes (e.g. ValidationError, ConflictError)
      return {
        userFriendlyMessage: `Notion API error (${notionError.code}): ${notionError.message}`,
        description: notionError.message,
      };
    }
    return this.fallbackErrorDetails(error);
  }

  supportsFilters(): boolean {
    return true;
  }
}

connectorRegistry.register({
  service: Service.NOTION,
  metadata: NotionConnector.metadata,
  advancedSettings: NotionConnector.advancedSettings,
  supportedAuthMethods: ['oauth', 'user_provided_params'],
  rateLimiterSpec: { points: 3, duration: 1 }, // Notion: 3 req/s per integration
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Notion', Service.NOTION);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
      return new NotionConnector(accessToken, { rateLimiter });
    } else {
      if (!ctx.decryptedCredentials?.apiKey) {
        throw new ConnectorInstantiationError('API key is required for Notion', Service.NOTION);
      }
      return new NotionConnector(ctx.decryptedCredentials.apiKey, { rateLimiter });
    }
  },
});
