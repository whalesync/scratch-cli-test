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
  type DataFolderOptions,
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
import { ConnectorAuthTokenOrProvider } from '../../connector-auth-token';
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
import { buildNotionJsonTableSpec, buildNotionPageWebUrl, NOTION_READ_ONLY_PROPERTY_TYPES } from './notion-json-schema';
import { combineNotionFilterWithCreatedTimeContinuation } from './notion-query-continuation';
import { NotionSchemaParser } from './notion-schema-parser';
import {
  buildNotionStandalonePagesTablePreview,
  buildNotionStandalonePagesTableSpec,
  isDatabaseOwnedNotionPage,
  isNotionStandalonePagesTable,
  NOTION_STANDALONE_PAGES_DISPLAY_NAME,
} from './notion-standalone-pages';
import {
  extractNotionRejectedPropertyName,
  findUnwritableNotionDateBoundary,
  splitRichTextSpansToNotionLimit,
} from './notion-write-validation';

export const PAGE_CONTENT_COLUMN_NAME = 'Page Content';

/**
 * Page size for the create-destination list and search — the pages a new Notion
 * database can be created under. `has_more` from the same response drives the
 * `hasMore` truncation flag.
 */
const NOTION_CREATE_DESTINATION_PAGE_SIZE = 100;
export const PAGE_CONTENT_COLUMN_ID = 'WS_PAGE_CONTENT';

type NotionDownloadProgress = {
  nextCursor: string | undefined;
  /**
   * ISO `created_time` lower bound (inclusive) of the current query window.
   * Set once a query has ended incomplete at Notion's 10,000-result per-query
   * limit and the pull rolled to a new query starting at the last returned
   * row's `created_time` (DEV-11267). Undefined until the first roll.
   */
  createdOnOrAfter?: string | undefined;
  /**
   * True when `nextCursor` was issued by a query sorted ascending by
   * `created_time`. Progress checkpointed by pre-DEV-11267 builds lacks this
   * flag; those cursors belong to UNSORTED queries and cannot be reused once
   * the sort is applied, so the pull restarts from scratch instead (safe —
   * pull commits are idempotent).
   */
  sortedByCreatedTime?: boolean | undefined;
  /**
   * Which of the standalone-pages pull's two Search sweeps `nextCursor` belongs
   * to (DEV-11267). Search has the same 10,000-result per-query limit but no
   * timestamp filter to continue past it, so the pull instead runs the SAME
   * search twice with opposite `last_edited_time` sort directions — a distinct
   * (filter, sort) pair, hence a fresh 10,000-result budget — and stops when
   * the two sweeps meet. Absent on progress checkpointed by builds whose Search
   * carried no sort at all; such a cursor belongs to a different query and is
   * discarded.
   */
  standalonePagesSearchDirection?: 'ascending' | 'descending' | undefined;
  /**
   * The newest `last_edited_time` the ascending Search sweep delivered. The
   * descending sweep walks back toward it and is provably complete the moment
   * it reaches it — every page between the two is already pulled. Checkpointed
   * so the proof survives a job restart mid-sweep.
   */
  standalonePagesAscendingSweepNewestLastEditedTime?: string | undefined;
};

interface NotionPullOptions extends PullRecordFilesOptions {
  filter?: string | undefined;
  excludePageContent?: boolean | undefined;
  childContentMaxDepth?: number | undefined;
  pageSize?: number | undefined;
}

/**
 * How much of a page's body (`page_content`) to fetch alongside its properties —
 * the folder's `excludePageContent` / `childContentMaxDepth` advanced settings.
 * Every path that builds a ConnectorFile (the full-table pull, targeted pulls,
 * the post-update refetch) reads them off the folder options its caller passes,
 * via {@link pageContentSettingsFrom}, so they all shape `page_content` the same
 * way (DEV-11258).
 */
interface NotionPageContentSettings {
  excludePageContent: boolean;
  childContentMaxDepth: number;
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

/**
 * The three (cross-version) boolean flags that mark a Notion page as archived or
 * trashed: legacy `archived` (2025-09-03), `in_trash` (the 2026-03-11 rename of
 * the soft-delete), and the distinct 2026-03-11 `is_archived`. A page pulled
 * under either API version carries whichever spelling(s) its version emits.
 */
const NOTION_ARCHIVE_FLAG_FIELDS = ['archived', 'in_trash', 'is_archived'] as const;
type NotionArchiveFlagField = (typeof NOTION_ARCHIVE_FLAG_FIELDS)[number];

/**
 * True when a Notion page is currently archived or trashed — any of the
 * {@link NOTION_ARCHIVE_FLAG_FIELDS} is `true`.
 *
 * Archived pages are pulled verbatim (they stay paired with their source record
 * on sync), so a synced edit lands on an archived page. Notion rejects editing
 * an archived page ("Can't edit block that is archived. You must unarchive the
 * block before editing."), so `updateRecords` clears these flags in the same
 * `pages.update` that writes the properties — unarchiving and updating in one
 * call, which restores the mirror without a delete/recreate (DEV-10957).
 */
export function isArchivedOrTrashedNotionPage(page: Record<string, unknown>): boolean {
  return NOTION_ARCHIVE_FLAG_FIELDS.some((field) => page[field] === true);
}

/**
 * Build the `pages.update` fields that unarchive a page. Only emits the flags
 * the page actually carries (set to `false`), so we don't send a spelling the
 * pinned API version doesn't understand. Empty when the page isn't archived.
 *
 * We clear whichever of `archived` / `in_trash` / `is_archived` are `true`:
 * across API versions a user may see either the legacy `archived` or the newer
 * `is_archived`, and we can't be sure which, so we handle both.
 */
function buildNotionUnarchiveFields(page: Record<string, unknown>): Partial<Record<NotionArchiveFlagField, false>> {
  const unarchiveFields: Partial<Record<NotionArchiveFlagField, false>> = {};
  for (const field of NOTION_ARCHIVE_FLAG_FIELDS) {
    if (page[field] === true) {
      unarchiveFields[field] = false;
    }
  }
  return unarchiveFields;
}

/**
 * Archive flags the publish diff cleared at the record's TOP LEVEL
 * (`archived` / `in_trash` / `is_archived` → `false`). This is the DEV-11013
 * signal: Live Export reconciliation wrote `is_archived: false` onto a matched
 * destination record to repair an archived page whose source row still exists —
 * possibly with NO other field drift — so the publish diff carries the cleared
 * flag even though the file no longer reports the page as archived. `updateRecords`
 * folds these into the same `pages.update` to actually unarchive the page.
 */
function unarchiveFieldsFromChangedDiff(
  changed: Record<string, unknown>,
): Partial<Record<NotionArchiveFlagField, false>> {
  const unarchiveFields: Partial<Record<NotionArchiveFlagField, false>> = {};
  for (const field of NOTION_ARCHIVE_FLAG_FIELDS) {
    if (changed[field] === false) {
      unarchiveFields[field] = false;
    }
  }
  return unarchiveFields;
}

/**
 * Registry hook (`resolveMatchedRecordArchiveRepairFields`): the field overlay
 * that unarchives a matched destination page whose source row still exists, or
 * `null` when the page isn't archived. Live Export reconciliation (sync Pass 2)
 * overlays these so an archived-but-otherwise-identical mirror is restored on the
 * next run with no field drift required (DEV-11013). The overlay is exactly the
 * flags {@link buildNotionUnarchiveFields} would clear — top-level `is_archived`
 * / `in_trash` / `archived` set to `false` — which the publish diff then carries
 * into `updateRecords` (see {@link unarchiveFieldsFromChangedDiff}).
 */
export function resolveNotionMatchedRecordArchiveRepairFields(
  recordFields: Record<string, unknown>,
): Record<string, unknown> | null {
  const unarchiveFields = buildNotionUnarchiveFields(recordFields);
  return Object.keys(unarchiveFields).length > 0 ? unarchiveFields : null;
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

  constructor(apiKeyOrAccessTokenProvider: ConnectorAuthTokenOrProvider, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new NotionApiClient(apiKeyOrAccessTokenProvider, {
      rateLimiter: opts?.rateLimiter,
      notionVersion: DEFAULT_NOTION_API_VERSION,
    });
  }

  /**
   * The page-content settings carried by a folder's options. Absent options (a
   * caller with no folder at hand) mean full page content — the historical
   * behavior of the per-page paths, which until DEV-11258 ignored these settings
   * altogether: a sync that only writes Notion properties still had every
   * updated page's block tree walked by the post-update refetch, and every
   * targeted pull did the same, while the one setting meant to switch that off
   * only reached the full-table pull.
   */
  private static pageContentSettingsFrom(options: DataFolderOptions | undefined): NotionPageContentSettings {
    const notionOptions = options as NotionPullOptions | undefined;
    // Same truthiness the full-table pull applies to its `options.excludePageContent`.
    return {
      excludePageContent: Boolean(notionOptions?.excludePageContent),
      childContentMaxDepth: notionOptions?.childContentMaxDepth ?? NotionConnector.PAGE_CONTENT_MAX_DEPTH,
    };
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
      page_size: NOTION_CREATE_DESTINATION_PAGE_SIZE,
    });
    return response.results
      .filter((result): result is PageObjectResponse => result.object === 'page' && 'properties' in result)
      .map((page) => ({ id: page.id, name: this.schemaParser.parsePageTablePreview(page).displayName, created: true }));
  }

  /**
   * Search the pages a new Notion database can be created under. Hits
   * `POST /v1/search` with the term so results reach pages beyond the
   * {@link listCreateDestinations} cap — the whole point of the search endpoint,
   * since a workspace can share far more pages than one page of results. An
   * empty/whitespace term returns the first page, mirroring the list endpoint.
   */
  override async searchCreateDestinations(
    searchTerm: string,
  ): Promise<{ destinations: CreateDestination[]; hasMore: boolean }> {
    const response = await this.client.search({
      ...(searchTerm.trim() ? { query: searchTerm } : {}),
      filter: { property: 'object', value: 'page' },
      page_size: NOTION_CREATE_DESTINATION_PAGE_SIZE,
    });
    const destinations = response.results
      .filter((result): result is PageObjectResponse => result.object === 'page' && 'properties' in result)
      .map((page) => ({ id: page.id, name: this.schemaParser.parsePageTablePreview(page).displayName, created: true }));
    return { destinations, hasMore: response.has_more };
  }

  /**
   * Resolve one Notion page by id via `GET /v1/pages/:id`. A page the integration
   * cannot see — deleted, or the connection reauthorized into a different
   * workspace — comes back as a Notion `object_not_found` / `restricted_resource`
   * error, which maps to `null` (a definitive "stale selection"). Any other error
   * (transport, rate limit, server) propagates so the caller keeps the saved id.
   */
  override async lookupCreateDestination(destinationId: string): Promise<CreateDestination | null> {
    try {
      const page = (await this.client.retrievePage({ page_id: destinationId })) as PageObjectResponse;
      return { id: page.id, name: this.schemaParser.parsePageTablePreview(page).displayName, created: true };
    } catch (error) {
      if (
        error instanceof NotionError &&
        (error.code === NotionApiErrorCode.ObjectNotFound || error.code === NotionApiErrorCode.RestrictedResource)
      ) {
        return null;
      }
      throw error;
    }
  }

  /** A create destination is a parent page id, which notion.so addresses directly. */
  override buildCreateDestinationRemoteWebUrl(destinationId: string): string {
    return buildNotionPageWebUrl(destinationId);
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
   * report supported. A run only demotes to full at pull time in the one shape
   * Notion cannot express: a user filter whose top-level `or` already contains a
   * nested compound, where adding the `last_edited_time` filter would exceed
   * Notion's two-level nesting limit (see `addRequiredMemberToNotionFilter`).
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
    let createdOnOrAfterContinuationBoundary = progress?.createdOnOrAfter;

    if (nextCursor !== undefined && progress?.sortedByCreatedTime !== true) {
      // Progress checkpointed by a pre-DEV-11267 build, whose queries carried
      // no sort. A Notion cursor is only valid for the exact query that issued
      // it, so it cannot be reused now that every query sorts ascending by
      // created_time — restart the pull from scratch instead (safe: pull
      // commits are idempotent, so re-pulled pages converge).
      WSLogger.info({
        source: 'NotionConnector',
        message: 'Discarding a pull cursor from an unsorted query; restarting the pull with the created_time sort',
        tableId: tableSpec.id.wsId,
      });
      nextCursor = undefined;
      createdOnOrAfterContinuationBoundary = undefined;
    }

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
        // The user filter's top-level `or` already contains a nested compound,
        // so wrapping it in another `and` would need a third nesting level and
        // 400. Skip the incremental filter and full-scan instead (keeping the
        // user filter).
        WSLogger.warn({
          source: 'NotionConnector',
          message:
            "Incremental pull demoted to full: the user filter's top-level `or` already contains a nested " +
            "compound, so nesting the last_edited_time filter would exceed Notion's two-level compound-filter " +
            'limit',
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

    // Delivery dedup for the inclusive 10k-continuation boundary (DEV-11267):
    // a rolled query window starts `on_or_after` the previous window's last
    // created_time, so it re-returns pages sharing that (minute-granular)
    // timestamp. Only pages at the CURRENT latest created_time can ever be
    // re-returned this way — the ascending sort means earlier timestamps are
    // done — so remembering just those ids, and resetting whenever
    // created_time advances, is enough to skip re-delivered pages without
    // holding every pulled page id in memory. Skipping also avoids
    // re-fetching page_content for the whole boundary minute. The set is lost
    // on a job restart; pages re-delivered across runs are absorbed by the
    // idempotent commit path instead.
    let createdTimeCoveredByDeliveredPageIds: string | undefined;
    const pageIdsAlreadyDeliveredAtCoveredCreatedTime = new Set<string>();

    // The newest `created_time` seen anywhere in the CURRENT query window, not
    // just in the batch that reported the limit. Notion can report a window
    // incomplete on a batch that carries no page objects, and in that case the
    // last row of an earlier batch is still a perfectly good resume boundary —
    // reading it only from the final batch would abandon a resumable pull.
    // Reset on every roll, since the boundary must come from the window that
    // actually hit the limit.
    let latestCreatedTimeSeenInCurrentWindow: string | undefined;

    while (hasMore) {
      // Re-apply the 10k-continuation boundary to the base filter on every
      // query (never accumulating): each rolled window replaces the previous
      // boundary rather than nesting filters deeper.
      let filterForThisQuery = notionFilter;
      if (createdOnOrAfterContinuationBoundary !== undefined) {
        const combinedWithContinuation = combineNotionFilterWithCreatedTimeContinuation(
          notionFilter,
          createdOnOrAfterContinuationBoundary,
        );
        if (combinedWithContinuation === null) {
          // Only reachable when a boundary was checkpointed and the folder
          // filter has since been changed to a nested `or` compound (a boundary
          // is never set while the filter is un-combinable — see below).
          throw new Error(
            "Cannot resume this Notion pull past the 10,000-result query limit: the folder filter's top-level " +
              '`or` already contains a nested compound, so adding the created_time continuation filter would ' +
              "exceed Notion's two-level compound-nesting limit. Flatten the folder filter and pull again.",
          );
        }
        filterForThisQuery = combinedWithContinuation;
      }

      const response = await this.client.queryDataSource({
        data_source_id: dataSourceId,
        start_cursor: nextCursor,
        page_size: options.pageSize ?? 100,
        filter: filterForThisQuery,
        // Ascending created_time sort — makes the last returned row a stable
        // resume boundary when a query ends incomplete at Notion's
        // 10,000-result per-query limit (DEV-11267).
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      });

      // Return raw page objects as ConnectorFiles
      const files: ConnectorFile[] = [];
      const pageResults = response.results.filter((r): r is PageObjectResponse => r.object === 'page');

      for (const page of pageResults) {
        // Tracked for every page, including ones skipped as boundary-minute
        // duplicates below: the resume boundary is a property of what Notion
        // returned, not of what we chose to deliver.
        latestCreatedTimeSeenInCurrentWindow = page.created_time;

        if (page.created_time !== createdTimeCoveredByDeliveredPageIds) {
          // Ascending sort: a new created_time means the previous timestamp's
          // pages can never be returned again, so the dedup set resets.
          createdTimeCoveredByDeliveredPageIds = page.created_time;
          pageIdsAlreadyDeliveredAtCoveredCreatedTime.clear();
        }
        if (pageIdsAlreadyDeliveredAtCoveredCreatedTime.has(page.id)) {
          // Re-returned by the inclusive on_or_after boundary of a rolled
          // window — already delivered earlier in this pull. Skip before the
          // page_content fetch so the boundary minute isn't re-fetched.
          continue;
        }
        pageIdsAlreadyDeliveredAtCoveredCreatedTime.add(page.id);

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

      if (!hasMore && response.request_status?.type === 'incomplete') {
        // The query hit Notion's 10,000-result per-query limit: pagination
        // stopped (`has_more: false`) with results remaining. Roll to a new
        // query window starting at the last returned row's created_time — the
        // ascending created_time sort makes that a valid resume boundary. The
        // inclusive on_or_after boundary re-returns pages sharing the boundary
        // minute; the delivery dedup set above skips them (DEV-11267).
        const lastPageCreatedTime = latestCreatedTimeSeenInCurrentWindow;
        if (lastPageCreatedTime === undefined) {
          throw new Error(
            'Notion reported the data source query incomplete (10,000-result limit) but returned no page ' +
              'to resume from',
          );
        }
        if (lastPageCreatedTime === createdOnOrAfterContinuationBoundary) {
          // The entire 10k window shares one created_time (Notion timestamps
          // are minute-granular), so a new on_or_after query would return the
          // same window forever. Fail explicitly rather than loop.
          throw new Error(
            `Cannot pull past Notion's 10,000-result query limit: more than 10,000 pages share the ` +
              `created_time ${lastPageCreatedTime}, so the created_time continuation cannot advance`,
          );
        }
        if (combineNotionFilterWithCreatedTimeContinuation(notionFilter, lastPageCreatedTime) === null) {
          // The folder filter's top-level `or` already contains a nested
          // compound, so adding the continuation filter would need a third
          // nesting level, which Notion rejects. Surface the truncation instead
          // of silently pulling only the first 10,000 rows.
          throw new Error(
            "This Notion query returned more than 10,000 results, but the folder filter's top-level `or` " +
              'already contains a nested compound, so the created_time continuation filter needed to pull the ' +
              "rest would exceed Notion's two-level compound-nesting limit. Flatten the folder filter's `or` " +
              'so its members are all simple conditions, or narrow it so it matches at most 10,000 pages.',
          );
        }
        WSLogger.info({
          source: 'NotionConnector',
          message: `Notion query hit the 10,000-result limit; continuing with created_time >= ${lastPageCreatedTime}`,
          tableId: tableSpec.id.wsId,
        });
        createdOnOrAfterContinuationBoundary = lastPageCreatedTime;
        // The boundary must come from the window that hit the limit, so the
        // next window starts its own observation.
        latestCreatedTimeSeenInCurrentWindow = undefined;
        nextCursor = undefined;
        hasMore = true;
      }

      await callback({
        files,
        connectorProgress: {
          nextCursor,
          createdOnOrAfter: createdOnOrAfterContinuationBoundary,
          sortedByCreatedTime: true,
        },
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
   *
   * Search carries the same 10,000-result per-query limit as `dataSources.query`
   * (DEV-11267), but it accepts no timestamp *filter*, so the database pull's
   * `created_time` continuation has nothing to bite on. What Search does accept
   * is a `last_edited_time` **sort direction**, and a Notion query's result
   * budget is per (filter, sort) pair — so the pull sweeps the same search twice
   * from opposite ends:
   *
   *   1. ascending  — the 10,000 least-recently-edited pages,
   *   2. descending — the 10,000 most-recently-edited pages, but only if sweep 1
   *      came back incomplete, so ordinary workspaces never pay for it.
   *
   * The sweeps are provably exhaustive the moment the descending one reaches a
   * page at or older than the newest `last_edited_time` sweep 1 delivered: the
   * two windows now overlap, so nothing sits between them. That raises the
   * ceiling from 10,000 to 20,000 pages *and* — unlike a bare page count — tells
   * us whether the enumeration was actually complete. Past 20,000 it still warns,
   * because Search offers no third ordering to sweep from.
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

    let sweepDirection: 'ascending' | 'descending' = progress?.standalonePagesSearchDirection ?? 'ascending';
    let nextCursor = progress?.nextCursor;
    let newestLastEditedTimeDeliveredByAscendingSweep = progress?.standalonePagesAscendingSweepNewestLastEditedTime;

    if (nextCursor !== undefined && progress?.standalonePagesSearchDirection === undefined) {
      // Progress checkpointed before the sort was applied. A Notion cursor is
      // only valid for the exact query that issued it, so it cannot be reused
      // now that the search is sorted — restart the sweep instead (safe: pull
      // commits are idempotent, so re-pulled pages converge).
      WSLogger.info({
        source: 'NotionConnector',
        message: 'Discarding a standalone-pages Search cursor from an unsorted query; restarting the sweep',
      });
      nextCursor = undefined;
      sweepDirection = 'ascending';
      newestLastEditedTimeDeliveredByAscendingSweep = undefined;
    }

    // Pages the ascending sweep delivered, so the descending sweep can skip
    // them before paying for their `page_content`. Bounded by that sweep's own
    // 10,000-result limit, and only populated once a second sweep is needed.
    const pageIdsDeliveredByAscendingSweep = new Set<string>();
    let reachedTheAscendingSweepsNewestPage = false;
    let hasMore = true;

    while (hasMore) {
      const response = await this.client.search({
        filter: { property: 'object', value: 'page' },
        start_cursor: nextCursor,
        page_size: options.pageSize ?? 100,
        // Sorting is what gives the two sweeps distinct 10,000-result budgets,
        // and what makes "the sweeps have met" a decidable question.
        sort: { timestamp: 'last_edited_time', direction: sweepDirection },
      });

      const standalonePages = response.results
        .filter((result): result is PageObjectResponse => result.object === 'page' && 'parent' in result)
        .filter((page) => !isDatabaseOwnedNotionPage(page));

      const files: ConnectorFile[] = [];
      for (const page of standalonePages) {
        if (sweepDirection === 'ascending') {
          newestLastEditedTimeDeliveredByAscendingSweep = page.last_edited_time;
        } else {
          if (
            newestLastEditedTimeDeliveredByAscendingSweep !== undefined &&
            page.last_edited_time <= newestLastEditedTimeDeliveredByAscendingSweep
          ) {
            // Walking backwards, we've reached edit times the ascending sweep
            // already covered. The two windows overlap, so every standalone
            // page has been delivered — stop rather than re-walk the workspace.
            // Checked BEFORE the id skip below: the pages that prove the overlap
            // are precisely the ones the ascending sweep delivered, so skipping
            // them first would walk straight past the proof.
            reachedTheAscendingSweepsNewestPage = true;
            break;
          }
          if (pageIdsDeliveredByAscendingSweep.has(page.id)) {
            // Edited during the pull, so it sorts newer than the watermark yet
            // is already on disk. Skip before paying for its `page_content`.
            continue;
          }
        }

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
        if (sweepDirection === 'ascending') {
          pageIdsDeliveredByAscendingSweep.add(page.id);
        }
      }

      hasMore = response.has_more && !reachedTheAscendingSweepsNewestPage;
      nextCursor = response.next_cursor ?? undefined;

      if (reachedTheAscendingSweepsNewestPage) {
        WSLogger.info({
          source: 'NotionConnector',
          message:
            'Notion standalone-pages Search sweeps met: the descending sweep reached the ascending sweep’s ' +
            'newest page, so the enumeration is complete',
        });
        nextCursor = undefined;
      } else if (!hasMore && response.request_status?.type === 'incomplete') {
        if (sweepDirection === 'ascending') {
          // Sweep 1 hit the 10,000-result limit. Re-run the same search sorted
          // the other way for a fresh budget, covering the workspace from its
          // most-recently-edited end.
          WSLogger.info({
            source: 'NotionConnector',
            message:
              'Notion standalone-pages Search hit its 10,000-result limit; sweeping again by descending ' +
              'last_edited_time to cover the rest',
          });
          sweepDirection = 'descending';
          nextCursor = undefined;
          hasMore = true;
        } else {
          // Both sweeps are exhausted and they never met, so pages in the middle
          // of the edit-time range were never enumerated. Search offers no third
          // ordering, so surface the truncation rather than reporting a complete
          // pull.
          WSLogger.warn({
            source: 'NotionConnector',
            message:
              'Notion Search hit its 10,000-result limit in BOTH sort directions without the sweeps meeting: ' +
              'this workspace has more than 20,000 standalone pages and the pull is incomplete. Search ' +
              'accepts no record filter, so there is no further ordering to continue from.',
          });
        }
      }

      await callback({
        files,
        connectorProgress: {
          nextCursor,
          standalonePagesSearchDirection: sweepDirection,
          standalonePagesAscendingSweepNewestLastEditedTime: newestLastEditedTimeDeliveredByAscendingSweep,
        },
      });
    }
    return {};
  }

  async pullRecordFilesByIds(
    _tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
    options?: DataFolderOptions,
  ): Promise<void> {
    const BATCH_SIZE = 10;
    const buffer: ConnectorFile[] = [];
    const pageContentSettings = NotionConnector.pageContentSettingsFrom(options);

    for (const pageId of ids) {
      try {
        const page = (await this.client.retrievePage({ page_id: pageId })) as PageObjectResponse;
        const connectorFile = this.pageResponseToConnectorFile(page);
        await this.attachPageContent(connectorFile, page.id, pageContentSettings);
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
      //
      // Key the split off the value-bearing property (`rich_text` / `title`),
      // not off `prop.type`: the update path feeds a sparse changed-fields diff
      // (`computeChangedFields` → `pickByShape`) that drops the unchanged `type`
      // envelope key, so `propType` is undefined for an edited long-text field.
      // Reading `prop.type` here would skip the split on every edit and refail
      // the record forever (DEV-10955). The value key is present on both the
      // create path (full read-format record) and the update path (the diff).
      for (const spanArrayPropertyKey of ['rich_text', 'title'] as const) {
        if (Array.isArray(rest[spanArrayPropertyKey])) {
          rest[spanArrayPropertyKey] = splitRichTextSpansToNotionLimit(rest[spanArrayPropertyKey] as unknown[]);
        }
      }

      // Notion *accepts* an out-of-range date (year outside 0001–9999, e.g. an
      // extended-year "+010000-…" from a Postgres 9999-12-31 timestamp rolled
      // across a UTC offset) but stores it as its invalid sentinel, so the
      // property becomes `{ start: "Invalid DateTime" }` — garbage that breaks
      // Notion-side filters/sorts (DEV-10960). Skip the property with a per-field
      // warning so the field is left unchanged rather than corrupted.
      //
      // Key the check off the value-bearing `date` key, not off `prop.type`, for
      // exactly the reason the rich-text split above does: the update path feeds a
      // sparse changed-fields diff (`computeChangedFields` → `pickByShape`) that
      // drops the unchanged `type` envelope key, so `propType` is undefined for an
      // edited date field. Reading `prop.type` here skipped the check on every
      // edit, shipping the corrupt value on the update path while catching it only
      // on create (DEV-11082). The `date` key is present on both the create path
      // (full read-format record) and the update path (the diff).
      if ('date' in rest) {
        const unwritableDateBoundary = findUnwritableNotionDateBoundary(rest.date);
        if (unwritableDateBoundary !== undefined) {
          WSLogger.warn({
            source: 'NotionConnector',
            message: `Skipping out-of-range date value for property "${key}"; Notion accepts only four-digit years (0001–9999). Field left unchanged.`,
            propertyName: key,
            value: unwritableDateBoundary,
          });
          continue;
        }
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
   * Populate `connectorFile.page_content` with the page's block tree, per the
   * folder's page-content settings: skipped entirely when the folder excludes
   * page content, otherwise walked to `childContentMaxDepth`. A failed walk is
   * logged and leaves the file without `page_content` (the page's properties are
   * still worth returning). Shared by every per-page path so they shape
   * `page_content` exactly like the full-table pull.
   */
  private async attachPageContent(
    connectorFile: ConnectorFile,
    pageId: string,
    settings: NotionPageContentSettings,
  ): Promise<void> {
    if (settings.excludePageContent) {
      return;
    }
    try {
      const childrenData = await this.pollRecordPageContentChildren(pageId, settings.childContentMaxDepth, pageId);
      connectorFile['page_content'] = childrenData.children;
    } catch (error) {
      WSLogger.error({
        source: 'NotionConnector',
        message: `Failed to fetch content for page ${pageId}`,
        error,
      });
    }
  }

  /**
   * Refetch a single page as a ConnectorFile in the same shape `pullRecordFiles`
   * / `pullRecordFilesByIds` would produce: `pages.retrieve` for the page
   * properties + the folder's page-content settings for `page_content`. Used by
   * `updateRecords` so the post-publish commit blob is byte-equal to what a
   * fresh pull would return, sidestepping every shape-divergence class —
   * properties Notion server-normalizes (date timezones, select option ids),
   * `last_edited_time` / `last_edited_by` that change on write, FK relations
   * Notion truncates to 25 on response, blocks the update API never touches.
   * Byte-equality includes `page_content`: a folder that excludes it pulls
   * without it, so the refetch must leave it out too (and not pay for it).
   */
  private async refetchPageAsConnectorFile(
    pageId: string,
    pageContentSettings: NotionPageContentSettings,
  ): Promise<ConnectorFile> {
    const page = (await this.client.retrievePage({ page_id: pageId })) as PageObjectResponse;
    const connectorFile = this.pageResponseToConnectorFile(page);
    await this.attachPageContent(connectorFile, page.id, pageContentSettings);
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
    options?: DataFolderOptions,
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

      // Clear the archive flag(s) as part of this PATCH when either signal fires:
      //   - the pulled file still reports the page as archived (DEV-10957): a
      //     property edit landing on an archived page would fail forever ("Can't
      //     edit block that is archived. You must unarchive the block before
      //     editing."), so we clear whichever flag(s) the record carries in the
      //     SAME request — unarchiving and updating in one call, restoring the
      //     mirror without a delete/recreate. A page archived in the sub-second
      //     window between the destination pull and this write still looks live
      //     here; that run's edit fails, but the next pull surfaces the flag and
      //     the following run unarchives it (self-healing).
      //   - the publish diff itself cleared an archive flag (DEV-11013): Live
      //     Export reconciliation wrote `is_archived: false` onto a matched
      //     destination record to repair an archived page whose source row still
      //     exists — possibly with NO other property drift, so `properties` is
      //     empty. `pages.update` accepts the archive flags on their own, so we
      //     still issue the PATCH to restore the page.
      // Union both signals; either alone is enough to fire the write.
      const unarchiveFields = { ...buildNotionUnarchiveFields(file), ...unarchiveFieldsFromChangedDiff(changed) };
      const hasPropertyUpdate = Object.keys(properties).length > 0;
      const hasUnarchive = Object.keys(unarchiveFields).length > 0;

      if (hasPropertyUpdate || hasUnarchive) {
        await this.client.updatePage({
          page_id: pageId,
          ...unarchiveFields,
          ...(hasPropertyUpdate ? { properties: properties as CreatePageParameters['properties'] } : {}),
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
    const pageContentSettings = NotionConnector.pageContentSettingsFrom(options);
    for (const index of updatedIndexes) {
      const pageId = files[index].id as string;
      results[index] = await this.refetchPageAsConnectorFile(pageId, pageContentSettings);
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
  resolveMatchedRecordArchiveRepairFields: resolveNotionMatchedRecordArchiveRepairFields,
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Notion', Service.NOTION);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const accessTokenProvider = ctx.createOAuthAccessTokenProvider(ctx.connectorAccount.id);
      // Resolve once up front so a connection that can no longer mint a token fails
      // here rather than on the first API call; every later call re-resolves it.
      await accessTokenProvider();
      return new NotionConnector(accessTokenProvider, { rateLimiter });
    } else {
      if (!ctx.decryptedCredentials?.apiKey) {
        throw new ConnectorInstantiationError('API key is required for Notion', Service.NOTION);
      }
      return new NotionConnector(ctx.decryptedCredentials.apiKey, { rateLimiter });
    }
  },
});
