import type {
  BlockObjectResponse,
  CreateDatabaseParameters,
  CreatePageParameters,
  PageObjectResponse,
  QueryDataSourceParameters,
  UpdateDataSourceParameters,
} from '@notionhq/client';
import {
  connectorMetadata,
  ConnectorSettingDefinition,
  type CreateFieldResult,
  type CreateTableResult,
  IncrementalPullSupport,
  type SchemaCreationCapabilities,
  TableDiscoveryMode,
  type TableView,
} from '@spinner/shared-types';
import _ from 'lodash';
import { ConnectorAssetExtractionInput, ConnectorAssetResult, MediaType } from 'src/asset/asset.types';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { defaultResolveFieldValue, extractFromAnnotatedSchema, stripQueryParams } from '../../asset-extraction-helpers';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  ErrorMessageTemplates,
  ReadonlyFieldEditError,
  readonlyFieldEditErrorMessage,
} from '../../error';
import {
  type NormalizedCreateFieldsPlan,
  type NormalizedCreateTablePlan,
  type ResolvedCreateFieldSpec,
} from '../../schema-creation.types';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  CreateDestination,
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
  DEFAULT_NOTION_API_VERSION,
  isNotionApiResponseError,
  NotionApiClient,
  NotionApiErrorCode,
  NotionError,
  NotionRequestTimeoutError,
} from './notion-api-client';
import {
  buildNotionPropertiesForFields,
  NOTION_SCHEMA_CREATION_CAPABILITIES,
  type NotionForeignKeyResolutions,
  type NotionPropertiesMap,
} from './notion-create-schema';
import { isFullDatabase, isFullDataSource, NotionDataSourceSearchResult } from './notion-data-source-types';
import { buildNotionDefaultView, buildNotionStandalonePagesDefaultView } from './notion-default-view';
import { buildNotionLastEditedFilter, combineNotionFilters } from './notion-incremental';
import { buildNotionJsonTableSpec, NOTION_READ_ONLY_PROPERTY_TYPES } from './notion-json-schema';
import { NotionSchemaParser } from './notion-schema-parser';
import {
  buildNotionStandalonePagesTablePreview,
  buildNotionStandalonePagesTableSpec,
  isDatabaseOwnedNotionPage,
  isNotionStandalonePagesTable,
  NOTION_STANDALONE_PAGES_DISPLAY_NAME,
} from './notion-standalone-pages';
import { extractNotionRejectedPropertyName, splitRichTextSpansToNotionLimit } from './notion-write-validation';

export const PAGE_CONTENT_COLUMN_NAME = 'Page Content';
export const PAGE_CONTENT_COLUMN_ID = 'WS_PAGE_CONTENT';

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
    incrementalPullInstructions:
      'Incremental pull only downloads pages changed since the last pull, using the Notion last-edited time. This works automatically for every database. If you set a filter that combines multiple conditions with and/or, Notion cannot also apply the last-edited filter, so that pull falls back to a full re-download.',
    oauth: { label: 'OAuth' },
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'Internal Integration Secret',
          placeholder: 'ntn_...',
          required: true,
        },
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

  private readonly client: NotionApiClient;
  private readonly schemaParser = new NotionSchemaParser();
  private readonly markdownConverter = new NotionMarkdownConverter();
  /**
   * Per-instance cache mapping databaseId → dataSourceId. Populated lazily by
   * {@link resolveDataSourceId} on the fallback path (folders whose `remoteId`
   * has not yet been backfilled to include the data source id). Removable once
   * the Phase 2 backfill has caught every folder.
   */
  private readonly dataSourceIdCache = new Map<string, string>();

  constructor(apiKey: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new NotionApiClient(apiKey, {
      rateLimiter: opts?.rateLimiter,
      notionVersion: DEFAULT_NOTION_API_VERSION,
    });
  }

  /**
   * Resolve the Notion data source id for a folder's `remoteId`.
   *
   * After Phase 2 of DEV-8910, every Notion DataFolder's `remoteId` is
   * `[databaseId, dataSourceId]`. This helper supplies the fallback for any
   * folder created before the backfill caught it (or any new folder discovered
   * via `listTables` between Phase 2 and Phase 3 shipping) by calling
   * `retrieveDatabase` and picking `data_sources[0]`. Memoized per connector
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

    const database = await this.client.retrieveDatabase({ database_id: databaseId });
    if (!isFullDatabase(database)) {
      throw new Error(`Notion databases.retrieve returned a partial response for ${databaseId}`);
    }
    const first = database.data_sources[0]?.id;
    if (!first) {
      throw new Error(`Notion database ${databaseId} has no data sources`);
    }
    this.dataSourceIdCache.set(databaseId, first);
    return first;
  }

  /**
   * Search the Notion workspace for objects of `object: 'data_source'`.
   * Filters partial-shape search results out so callers can rely on the title
   * and parent fields being present.
   */
  private async searchDataSources(args: {
    query?: string;
    pageSize?: number;
  }): Promise<{ results: NotionDataSourceSearchResult[]; has_more: boolean }> {
    const response = await this.client.search({
      ...(args.query !== undefined ? { query: args.query } : {}),
      filter: { property: 'object', value: 'data_source' },
      ...(args.pageSize !== undefined ? { page_size: args.pageSize } : {}),
    });
    const results = response.results.filter((r): r is NotionDataSourceSearchResult => r.object === 'data_source');
    return { results, has_more: response.has_more };
  }

  get tableDiscoveryMode(): TableDiscoveryMode {
    return TableDiscoveryMode.SEARCH;
  }

  async testConnection(): Promise<void> {
    // Just don't throw. We search for `data_source` rather than `database` so
    // testConnection exercises the same surface (the 2025-09-03 search index)
    // that listTables and searchTables rely on.
    await this.searchDataSources({ pageSize: 1 });
  }

  /**
   * Recursively fetches all blocks from a page, including nested children
   */
  private async fetchBlocksWithChildren(blockId: string): Promise<ConvertedNotionBlock[]> {
    const blocks: ConvertedNotionBlock[] = [];
    let hasMore = true;
    let startCursor: string | undefined = undefined;

    while (hasMore) {
      const response = await this.client.listBlockChildren({
        block_id: blockId,
        start_cursor: startCursor,
        page_size: 100,
      });

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
    const response = await this.searchDataSources({ query: '', pageSize: 10 });
    return [
      // The fixed standalone-pages backup table is always offered, ahead of the
      // searched databases, so it stays discoverable in the initial short list.
      buildNotionStandalonePagesTablePreview(),
      ...response.results.map((ds) => this.schemaParser.parseDataSourceTablePreview(ds)),
    ];
  }

  async searchTables(searchTerm: string): Promise<{ tables: TablePreview[]; hasMore: boolean }> {
    const response = await this.searchDataSources({ query: searchTerm });
    const tables = response.results.map((ds) => this.schemaParser.parseDataSourceTablePreview(ds));
    // The client swaps from listTables to searchTables output as the user
    // types, so the fixed standalone-pages table must be findable here too —
    // included whenever the term matches its display name (an empty term
    // matches, mirroring the initial list).
    const standalonePagesPreview = buildNotionStandalonePagesTablePreview();
    if (standalonePagesPreview.displayName.toLowerCase().includes(searchTerm.trim().toLowerCase())) {
      tables.unshift(standalonePagesPreview);
    }
    return { tables, hasMore: response.has_more };
  }

  /**
   * A new Notion database is created as a child of a page, so the create
   * destinations are the pages the integration can see. We reuse the schema
   * parser's page-title extraction so the labels match the table picker.
   */
  override async listCreateDestinations(): Promise<CreateDestination[]> {
    const response = await this.client.search({
      filter: { property: 'object', value: 'page' },
      page_size: 100,
    });
    return response.results
      .filter((result): result is PageObjectResponse => result.object === 'page' && 'properties' in result)
      .map((page) => ({ id: page.id, name: this.schemaParser.parsePageTablePreview(page).displayName }));
  }

  /**
   * Build the default TableView for a Notion table purely from its spec. The
   * standalone-pages backup table surfaces its `parent` pointer (the page-tree
   * edge) instead of hiding it, so it gets its own view builder; every database
   * table uses the shared database default view. Both derive entirely from
   * `spec.schema`, so this stays a pure `spec → view` transform.
   */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    if (isNotionStandalonePagesTable(spec.id)) {
      return buildNotionStandalonePagesDefaultView(spec.schema);
    }
    return buildNotionDefaultView(spec.schema);
  }

  /**
   * Fetch JSON Table Spec for Notion database pages.
   * Returns a schema describing the raw Notion page API response format.
   *
   * Under 2025-09-03, `properties` lives on the *data source*, not the
   * database. Folders that haven't been backfilled to a 2-element `remoteId`
   * fall through `resolveDataSourceId`.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    if (isNotionStandalonePagesTable(id)) {
      // Fixed backup table — no data source to introspect; curated spec.
      return buildNotionStandalonePagesTableSpec(id);
    }
    const dataSourceId = await this.resolveDataSourceId(id.remoteId);
    const dataSource = await this.client.retrieveDataSource({ data_source_id: dataSourceId });
    if (!isFullDataSource(dataSource)) {
      throw new Error(`Notion dataSources.retrieve returned a partial response for ${dataSourceId}`);
    }
    return buildNotionJsonTableSpec(id, dataSource);
  }

  /**
   * Suggest filenames from the Notion page title property.
   * Notion pages store titles as rich text arrays: { properties: { "Title": { type: "title", title: [{ plain_text }] } } }
   */
  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePropertyName = this.resolveTitlePropertyName(tableSpec);
    if (!titlePropertyName) {
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath ?? tableSpec.slugColumnRemoteId);
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
   * titlePath is now the dot path 'properties.<propertyName>', so split it back
   * into segments and return the property name (the segment after 'properties').
   *
   * Caveat: a Notion property name containing a literal `.` over-splits here and
   * yields a truncated name (see `BaseJsonTableSpec.titlePath`). This only affects
   * the suggested filename — it falls back to the record id — never correctness.
   */
  private resolveTitlePropertyName(tableSpec: BaseJsonTableSpec): string | undefined {
    if (!tableSpec.titlePath) {
      return undefined;
    }

    const titlePathSegments = _.toPath(tableSpec.titlePath);
    // 'properties.<propertyName>' — return the property name directly.
    if (titlePathSegments.length >= 2) {
      return titlePathSegments[1];
    }

    // Fallback for a single-segment path (shouldn't happen with the current schema).
    if (titlePathSegments.length === 1) {
      return titlePathSegments[0];
    }

    return undefined;
  }

  /**
   * Notion database tables support incremental pulls unconditionally: every
   * database page has a server-side `last_edited_time` system field, and
   * `databases.query` can filter on it. There is no per-folder config to
   * inspect (the field is not user-selectable), so database tables always
   * report supported and a run only demotes to full at pull time if the user's
   * own filter is a compound `and`/`or` (Notion's single-level nesting limit —
   * see `pullRecordFiles`).
   *
   * The standalone-pages backup table is the exception: it enumerates via the
   * Search endpoint, which has no modified-since filter, so every pull is a
   * full enumeration. A `null` tableSpec (REST layer with no schema on hand)
   * keeps the optimistic pre-pages answer; the job re-checks with the real
   * spec at pull time.
   */
  override incrementalPullSupport(
    _options: PullRecordFilesOptions,
    tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    if (tableSpec && isNotionStandalonePagesTable(tableSpec.id)) {
      return IncrementalPullSupport.NOT_SUPPORTED;
    }
    return IncrementalPullSupport.SUPPORTED;
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: NotionDownloadProgress }) => Promise<void>,
    progress: NotionDownloadProgress,
    options: NotionPullOptions,
  ): Promise<PullRecordFilesResult> {
    WSLogger.info({ source: 'NotionConnector', message: 'pullRecordFiles called', tableId: tableSpec.id.wsId });

    if (isNotionStandalonePagesTable(tableSpec.id)) {
      return this.pullStandalonePageRecordFiles(callback, progress, options);
    }

    const dataSourceId = await this.resolveDataSourceId(tableSpec.id.remoteId);
    let hasMore = true;
    let nextCursor = progress?.nextCursor;

    let notionFilter: QueryDataSourceParameters['filter'] = undefined;
    if (options.filter) {
      // parse the filter as a Notion Filter object
      try {
        notionFilter = JSON.parse(options.filter) as QueryDataSourceParameters['filter'];
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
      const response = await this.client.queryDataSource({
        data_source_id: dataSourceId,
        start_cursor: nextCursor,
        page_size: options.pageSize ?? 100,
        filter: notionFilter,
      });

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

  /**
   * Pull for the standalone-pages backup table (DEV-10568). Enumerates every
   * page the integration can see via the Search endpoint — no walk of the page
   * tree — then drops database-owned pages (rows of the per-database tables).
   * Each kept page is stored verbatim; page body content rides along under
   * `page_content` exactly like the database pull, honoring the same
   * `excludePageContent` / `childContentMaxDepth` folder settings.
   *
   * Always a full enumeration (Search has no modified-since filter — see
   * `incrementalPullSupport`), checkpointed per Search page through the same
   * `nextCursor` progress the database pull uses, and trivially idempotent: a
   * re-run converges on the same one-file-per-page-id folder.
   */
  private async pullStandalonePageRecordFiles(
    callback: (params: { files: ConnectorFile[]; connectorProgress?: NotionDownloadProgress }) => Promise<void>,
    progress: NotionDownloadProgress,
    options: NotionPullOptions,
  ): Promise<PullRecordFilesResult> {
    if (options.filter) {
      // The database pull's filter option is a `dataSources.query` filter; the
      // Search endpoint accepts no record filter at all. Fail fast rather than
      // silently pulling unfiltered data.
      throw new Error(
        `The Notion "${NOTION_STANDALONE_PAGES_DISPLAY_NAME}" table does not support folder filters — ` +
          'remove the filter from the folder settings.',
      );
    }

    let hasMore = true;
    let nextCursor = progress?.nextCursor;

    while (hasMore) {
      const response = await this.client.search({
        filter: { property: 'object', value: 'page' },
        start_cursor: nextCursor,
        page_size: options.pageSize ?? 100,
      });

      const standalonePages = response.results
        .filter((result): result is PageObjectResponse => result.object === 'page' && 'parent' in result)
        .filter((page) => !isDatabaseOwnedNotionPage(page));

      const files: ConnectorFile[] = [];
      for (const page of standalonePages) {
        const connectorFile = page as unknown as ConnectorFile;

        if (!options.excludePageContent) {
          const maxChildDepth = options.childContentMaxDepth ?? NotionConnector.PAGE_CONTENT_MAX_DEPTH;
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
    return {};
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
        const page = (await this.client.retrievePage({ page_id: pageId })) as PageObjectResponse;
        const connectorFile = this.pageResponseToConnectorFile(page);

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
        if (error instanceof NotionError && error.code === NotionApiErrorCode.ObjectNotFound) {
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
    if (isNotionStandalonePagesTable(tableSpec.id)) {
      return this.createStandalonePages(files);
    }
    const results: ConnectorFile[] = [];
    const dataSourceId = await this.resolveDataSourceId(tableSpec.id.remoteId);

    for (const file of files) {
      const rawProperties = (file.properties as Record<string, unknown>) || {};
      // Transform properties from read format to create format (same rules as update)
      const properties = this.transformPropertiesForUpdate(rawProperties);

      const newPage = await this.client.createPage({
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties: properties as CreatePageParameters['properties'],
      });
      results.push(this.pageResponseToConnectorFile(newPage as PageObjectResponse));
    }

    return results;
  }

  /**
   * Create standalone (non-database) pages. Each new record file names its own
   * create destination through the verbatim `parent.page_id` pointer the table
   * preserves — Notion then inserts the `child_page` block into that parent
   * itself, so no block append is needed. Notion's public API cannot create
   * workspace-level (or block-parented) pages, so a file without a `page_id`
   * parent fails fast with a clear message rather than guessing a destination.
   */
  private async createStandalonePages(files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const results: ConnectorFile[] = [];

    for (const file of files) {
      const parent = file.parent as { type?: string; page_id?: string } | undefined;
      const parentPageId = typeof parent?.page_id === 'string' ? parent.page_id.trim() : '';
      const hasNonPageParentType = parent?.type !== undefined && parent.type !== 'page_id';
      if (!parentPageId || hasNonPageParentType) {
        throw new Error(
          'Creating a standalone Notion page requires the record file to carry a "parent" of type "page_id" ' +
            `naming the page it should live under (got parent ${JSON.stringify(parent ?? null)}). ` +
            "Notion's API cannot create workspace-level pages.",
        );
      }

      const rawProperties = (file.properties as Record<string, unknown>) || {};
      // Same read-format → write-format transform as database-table creates
      // (drops the type/id envelope keys; title is the only writable property).
      const properties = this.transformPropertiesForUpdate(rawProperties);

      const newPage = await this.client.createPage({
        parent: { type: 'page_id', page_id: parentPageId },
        properties: properties as CreatePageParameters['properties'],
      });
      results.push(this.pageResponseToConnectorFile(newPage as PageObjectResponse));
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
    const response = await this.client.retrieveBlock({ block_id: blockId });
    const pageContent = response as unknown as ConvertedNotionBlock;

    if (_.has(response, 'has_children') && (response as BlockObjectResponse).has_children) {
      if (!pageContent.id) {
        throw new Error(`Notion block ${blockId} returned has_children=true but no id`);
      }
      const childrenData = await this.pollRecordPageContentChildren(
        pageContent.id,
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

      const response = await this.client.listBlockChildren({
        block_id: blockId,
        start_cursor: startCursor,
        page_size: NotionConnector.PAGE_CONTENT_PAGE_SIZE,
      });

      for (const result of response.results) {
        const block = result as unknown as ConvertedNotionBlock;

        // Skip unsupported types if necessary

        if ((result as BlockObjectResponse).has_children) {
          if (!block.id) {
            throw new Error(`Notion block under ${rootRecordId} returned has_children=true but no id`);
          }
          const childrenData = await this.pollRecordPageContentChildren(block.id, depthLimit - 1, rootRecordId);
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

      // Notion rejects a write whose rich-text/title span exceeds 2000 chars
      // (DEV: "body.properties.<Field>.rich_text[0].text.content.length should be
      // ≤ 2000"). Split any oversized span across consecutive spans so a long
      // synced value publishes instead of being rejected. Only the outbound
      // payload is reshaped; the record on disk is untouched.
      if ((propType === 'rich_text' || propType === 'title') && Array.isArray(rest[propType])) {
        rest[propType] = splitRichTextSpansToNotionLimit(rest[propType] as unknown[]);
      }

      // Only include if there's actual content to update
      if (Object.keys(rest).length > 0) {
        transformed[key] = rest;
      }
    }

    return transformed;
  }

  /**
   * Convert a single-page response (`pages.retrieve` / `pages.create`) into a
   * ConnectorFile, stripping Notion's per-response `request_id`.
   *
   * `request_id` is Notion's top-level transport-envelope field, echoed on every
   * single-object response body but absent from the per-object records that pull
   * returns via Search / data-source query. Left on the record it makes a
   * created / refetched file differ from what the next pull produces, so every
   * published record picks up a one-time phantom "remote change". Stripping this
   * transport wrapper is the sanctioned exception to the Connector Prime
   * Directive (it is the envelope around the record, not the record's own data).
   */
  private pageResponseToConnectorFile(page: PageObjectResponse): ConnectorFile {
    const connectorFile = page as unknown as ConnectorFile;
    delete connectorFile['request_id'];
    return connectorFile;
  }

  /**
   * Refetch a single page as a ConnectorFile in the same shape `pullRecordFiles`
   * / `pullRecordFilesByIds` would produce: `pages.retrieve` for the page
   * properties + `pollRecordPageContentChildren` for `page_content`. Used by
   * `updateRecords` so the post-publish commit blob is byte-equal to what a
   * fresh pull would return, sidestepping every shape-divergence class —
   * properties Notion server-normalizes (date timezones, select option ids),
   * `last_edited_time` / `last_edited_by` that change on write, FK relations
   * Notion truncates to 25 on response, blocks the update API never touches.
   */
  private async refetchPageAsConnectorFile(pageId: string): Promise<ConnectorFile> {
    const page = (await this.client.retrievePage({ page_id: pageId })) as PageObjectResponse;
    const connectorFile = this.pageResponseToConnectorFile(page);
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
        message: `Failed to fetch content for page ${pageId} during post-update refetch`,
        error,
      });
    }
    return connectorFile;
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
    const results: ConnectorFile[] = new Array<ConnectorFile>(files.length);
    const updatedIndexes: number[] = [];

    // Phase 1: write. Issue the PATCH for each file with writable changes.
    // Files whose changedFields contain only read-only properties (rollup,
    // formula, …) or transform to an empty update body skip the API call
    // and pass through unchanged — they were no-ops, so the input file is
    // already the canonical post-publish view.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const changed = changedFields[i];
      const pageId = file.id as string;

      const fileProperties = (file.properties as Record<string, unknown>) || {};
      const changedProperties = (changed.properties as Record<string, unknown>) || {};

      // A changed property whose type is read-only (rollup, formula, …) is a
      // genuine read-only edit — changedFields lists only what the user changed.
      // Surface it instead of silently dropping the edit (DEV-10597).
      const writableChangedProperties: Record<string, unknown> = {};
      const readonlyChangedPropertyNames: string[] = [];
      for (const [key, value] of Object.entries(changedProperties)) {
        const fileProp = fileProperties[key] as Record<string, unknown> | undefined;
        const propType = fileProp?.type as string | undefined;
        if (propType && NOTION_READ_ONLY_PROPERTY_TYPES.has(propType)) {
          readonlyChangedPropertyNames.push(key);
          continue;
        }
        writableChangedProperties[key] = value;
      }
      if (readonlyChangedPropertyNames.length > 0) {
        throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedPropertyNames));
      }

      const properties = this.transformPropertiesForUpdate(writableChangedProperties);

      if (Object.keys(properties).length > 0) {
        await this.client.updatePage({
          page_id: pageId,
          properties: properties as CreatePageParameters['properties'],
        });
        updatedIndexes.push(i);
      } else {
        results[i] = file;
      }
    }

    // Phase 2: refetch. For each file we actually wrote, GET the page back via
    // the same path as `pullRecordFilesByIds` so the returned ConnectorFile is
    // 100% byte-equal to a fresh pull. Refetch is per-page (Notion has no bulk
    // endpoint) but only fires for indexes that had a real write.
    for (const index of updatedIndexes) {
      const pageId = files[index].id as string;
      results[index] = await this.refetchPageAsConnectorFile(pageId);
    }

    return results;
  }

  /**
   * Delete (move to trash) pages in Notion.
   * Files should have an 'id' field with the page ID to trash.
   *
   * Uses `in_trash: true` (the 2026-03-11 successor to the now-deprecated
   * `archived: true`); both still resolve to the same soft-delete server-side.
   */
  async deleteRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    for (const file of files) {
      const pageId = file.id as string;
      await this.client.updatePage({
        page_id: pageId,
        in_trash: true,
      });
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
    if (error instanceof NotionRequestTimeoutError) {
      return {
        userFriendlyMessage: ErrorMessageTemplates.API_TIMEOUT('Notion'),
        description: error.message,
      };
    }

    if (isNotionApiResponseError(error)) {
      const notionError = error;

      if (notionError.code === NotionApiErrorCode.Unauthorized) {
        return {
          userFriendlyMessage: `The credentials Scratch uses to communicate with Notion are no longer valid. Details: ${notionError.message}`,
          description: notionError.message,
        };
      }

      if (notionError.code === NotionApiErrorCode.RateLimited) {
        return {
          userFriendlyMessage: `${ErrorMessageTemplates.API_QUOTA_EXCEEDED('Notion')} Details: ${notionError.message}`,
          description: notionError.message,
        };
      }

      if (notionError.code === NotionApiErrorCode.ObjectNotFound) {
        return {
          userFriendlyMessage: `Notion object not found: ${notionError.message}`,
          description: notionError.message,
        };
      }

      if (notionError.code === NotionApiErrorCode.InvalidRequest) {
        return {
          userFriendlyMessage: `Notion invalid request: ${notionError.message}`,
          description: notionError.message,
        };
      }

      if (notionError.code === NotionApiErrorCode.InternalServerError) {
        return {
          userFriendlyMessage: `An internal server error occurred while connecting to Notion. Details: ${notionError.message}`,
          description: notionError.message,
        };
      }

      if (notionError.code === NotionApiErrorCode.ServiceUnavailable) {
        return {
          userFriendlyMessage: `The Notion service is unavailable. Details: ${notionError.message}`,
          description: notionError.message,
        };
      }

      // Catch-all for any other Notion API error codes (e.g. ValidationError, ConflictError).
      // Notion phrases validation failures against the request-body JSON path
      // ("body.properties.<Field>.…"); surface the field name up front so the
      // per-record error identifies which field was rejected, not just the table.
      const rejectedPropertyName = extractNotionRejectedPropertyName(notionError.message);
      const fieldPrefix = rejectedPropertyName ? `field "${rejectedPropertyName}" — ` : '';
      return {
        userFriendlyMessage: `Notion API error (${notionError.code}): ${fieldPrefix}${notionError.message}`,
        description: notionError.message,
      };
    }
    return this.fallbackErrorDetails(error);
  }

  supportsFilters(): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // Schema creation (create-schema API — DEV-10382)
  // -------------------------------------------------------------------------

  override supportsSchemaCreation(): boolean {
    return true;
  }

  override getSchemaCreationCapabilities(): SchemaCreationCapabilities {
    return NOTION_SCHEMA_CREATION_CAPABILITIES;
  }

  /**
   * Create one Notion database (and its initial data source) with all of its
   * properties in a single `POST /v1/databases` call. A brand-new "table" must be
   * created this way: a standalone data source can only be *added* to an existing
   * database. The new database needs a parent **page** — taken from
   * `plan.remoteParentId[0]`; without one we fail rather than guessing where to
   * put it. ForeignKey targets are already resolved to existing tables by the
   * server; here we resolve each to its data source id so the relation points at
   * it. Creates are NOT idempotent — re-running creates a second database.
   */
  override async createTable(plan: NormalizedCreateTablePlan): Promise<CreateTableResult> {
    const parentPageId = plan.remoteParentId?.[0];
    if (!parentPageId) {
      return {
        ref: plan.ref,
        name: plan.name,
        status: 'failed',
        fields: plan.fields.map((field) => ({ name: field.name, status: 'failed' as const })),
        error:
          'Notion requires a parent page to create a database. Provide the parent page id as remoteParentId (e.g. ["<pageId>"]).',
      };
    }

    try {
      const foreignKeyResolutions = await this.resolveForeignKeyTargets(plan.fields);
      const skippedFieldReasons = new Map<string, string>();
      const properties = buildNotionPropertiesForFields(
        plan.fields,
        { treatPrimaryAsTitle: true },
        foreignKeyResolutions,
        skippedFieldReasons,
      );

      // Every Notion data source needs exactly one title property. The generic
      // validator enforces an isPrimary field, but guard defensively: if none
      // made it in, inject a "Name" title so the create can't fail for lack of one.
      const autoAddedTitleName = this.ensureTitleProperty(properties);

      const title: CreateDatabaseParameters['title'] = [{ type: 'text', text: { content: plan.name } }];
      const database = await this.client.createDatabase({
        parent: { type: 'page_id', page_id: parentPageId },
        title,
        initial_data_source: { properties },
      });
      if (!isFullDatabase(database)) {
        throw new Error('Notion databases.create returned a partial response');
      }
      const dataSourceId = database.data_sources[0]?.id;
      if (!dataSourceId) {
        throw new Error('Notion databases.create returned a database with no data source');
      }

      const fields = this.buildFieldResults(plan.fields, skippedFieldReasons);
      if (autoAddedTitleName) {
        fields.unshift({
          name: autoAddedTitleName,
          status: 'created',
          remoteFieldId: autoAddedTitleName,
          autoAdded: true,
        });
      }
      return {
        ref: plan.ref,
        name: plan.name,
        status: skippedFieldReasons.size > 0 ? 'partial' : 'created',
        remoteTableId: [database.id, dataSourceId],
        fields,
      };
    } catch (error) {
      return {
        ref: plan.ref,
        name: plan.name,
        status: 'failed',
        fields: plan.fields.map((field) => ({ name: field.name, status: 'failed' as const })),
        error: this.extractConnectorErrorDetails(error).userFriendlyMessage,
      };
    }
  }

  /**
   * Add properties (fields) to an existing data source — one
   * `PATCH /v1/data_sources/{id}` per field so a single bad field fails in
   * isolation rather than taking the rest down. Also used by the server to add
   * deferred cyclic/self foreignKey fields after every table in a multi-table
   * create exists. A field whose name already exists on the data source is
   * skipped (not overwritten), keeping the operation non-destructive.
   */
  override async createFields(plan: NormalizedCreateFieldsPlan): Promise<CreateFieldResult[]> {
    const dataSourceId = await this.resolveDataSourceId(plan.remoteTableId);
    const foreignKeyResolutions = await this.resolveForeignKeyTargets(plan.fields);
    const existingPropertyNames = await this.fetchExistingPropertyNames(dataSourceId);

    const results: CreateFieldResult[] = [];
    for (const field of plan.fields) {
      if (existingPropertyNames.has(field.name.trim().toLowerCase())) {
        results.push({
          name: field.name,
          status: 'skipped',
          error: `a property named "${field.name}" already exists on the data source`,
        });
        continue;
      }

      const skippedFieldReasons = new Map<string, string>();
      const properties = buildNotionPropertiesForFields(
        [field],
        { treatPrimaryAsTitle: false },
        foreignKeyResolutions,
        skippedFieldReasons,
      );
      const skipReason = skippedFieldReasons.get(field.name);
      if (skipReason !== undefined) {
        results.push({ name: field.name, status: 'skipped', error: skipReason });
        continue;
      }

      try {
        await this.client.updateDataSource({
          data_source_id: dataSourceId,
          properties: properties as UpdateDataSourceParameters['properties'],
        });
        results.push({ name: field.name, status: 'created', remoteFieldId: field.name });
      } catch (error) {
        results.push({
          name: field.name,
          status: 'failed',
          error: this.extractConnectorErrorDetails(error).userFriendlyMessage,
        });
      }
    }
    return results;
  }

  /**
   * Resolve every foreignKey field's (server-resolved) target table to a Notion
   * data source id. The target remoteId is `[databaseId, dataSourceId]`; older
   * targets carry only `[databaseId]` and are looked up via `resolveDataSourceId`.
   * A target that can't be resolved yields an `unresolvable` reason the mapper
   * turns into a per-field skip.
   */
  private async resolveForeignKeyTargets(fields: ResolvedCreateFieldSpec[]): Promise<NotionForeignKeyResolutions> {
    const resolutions: NotionForeignKeyResolutions = new Map();
    for (const field of fields) {
      const fieldType = field.fieldType;
      if (fieldType.kind !== 'foreignKey') {
        continue;
      }
      if (!('existingRemoteTableId' in fieldType.target)) {
        // The server resolves every {ref} target before dispatch; a lingering ref is a bug.
        resolutions.set(field.name, {
          kind: 'unresolvable',
          reason: `foreign key "${field.name}" target was not resolved to an existing table`,
        });
        continue;
      }
      try {
        const targetDataSourceId = await this.resolveDataSourceId(fieldType.target.existingRemoteTableId);
        resolutions.set(field.name, { kind: 'resolved', targetDataSourceId });
      } catch (error) {
        resolutions.set(field.name, {
          kind: 'unresolvable',
          reason: `couldn't resolve the data source for foreign key "${field.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    return resolutions;
  }

  /**
   * Guarantee the properties map has a Notion `title` property. Returns the
   * injected property name when it had to add one (so the caller can report it as
   * auto-added), or undefined when a title was already present.
   */
  private ensureTitleProperty(properties: NotionPropertiesMap): string | undefined {
    const hasTitle = Object.values(properties).some((config) => 'title' in config);
    if (hasTitle) {
      return undefined;
    }
    let name = 'Name';
    let suffix = 2;
    while (name in properties) {
      name = `Name ${suffix}`;
      suffix += 1;
    }
    properties[name] = { title: {} };
    return name;
  }

  /** Lowercased set of property names currently on a data source (for the non-destructive add guard). */
  private async fetchExistingPropertyNames(dataSourceId: string): Promise<Set<string>> {
    const dataSource = await this.client.retrieveDataSource({ data_source_id: dataSourceId });
    if (!isFullDataSource(dataSource)) {
      return new Set();
    }
    return new Set(Object.keys(dataSource.properties).map((name) => name.trim().toLowerCase()));
  }

  /**
   * Per-field result list for a created table: each requested field is `created`
   * (its property name is the stable remote field id) unless it was skipped (an
   * unresolvable foreign key), in which case the reason is surfaced.
   */
  private buildFieldResults(
    fields: ResolvedCreateFieldSpec[],
    skippedFieldReasons: Map<string, string>,
  ): CreateFieldResult[] {
    return fields.map((field) => {
      const skipReason = skippedFieldReasons.get(field.name);
      if (skipReason !== undefined) {
        return { name: field.name, status: 'skipped', error: skipReason };
      }
      return { name: field.name, status: 'created', remoteFieldId: field.name };
    });
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
