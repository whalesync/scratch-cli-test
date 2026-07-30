import { connectorMetadata, TableView } from '@spinner/shared-types';
import type { DraftPost } from '@wix/auto_sdk_blog_draft-posts';
import { categories, draftPosts, tags } from '@wix/blog';
import { members } from '@wix/members';
import { createClient, OAuthStrategy, TokenRole } from '@wix/sdk';
import { ConnectorAssetExtractionInput, ConnectorAssetResult } from 'src/asset/asset.types';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { assertUnreachable } from 'src/utils/asserts';
import { JsonSafeObject } from 'src/utils/objects';
import { hashUrl } from '../../../asset-extraction-helpers';
import { Connector, suggestFileNamesFromFieldPaths } from '../../../connector';
import { connectorRegistry } from '../../../connector-registry';
import { ConnectorInstantiationError } from '../../../error';
import { Service } from '../../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  EntityId,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../../types';
import { HtmlToWixConverter } from '../rich-content/html-to-ricos';
import { createTurndownService } from '../rich-content/markdown-helpers';
import { WixToHtmlConverter } from '../rich-content/ricos-to-html';
import { buildWixBlogDefaultView } from './wix-blog-default-view';
import { buildWixBlogJsonTableSpec } from './wix-blog-json-schema';
import { resolveWixMediaUriToUrl, wixMediaIdFromUri } from './wix-blog-media';
import { WixBlogSchemaParser } from './wix-blog-schema-parser';
import { WixBlogTableKey, wixBlogTableKeyFromEntityId } from './wix-blog-tables';

/** Shape of error objects returned by the Wix SDK/API */
interface WixErrorData {
  message?: string;
  details?: string | { applicationError?: { description?: string; code?: string } };
}

interface WixErrorShape {
  response?: { status?: number; data?: WixErrorData };
  data?: WixErrorData;
  status?: number;
  statusCode?: number;
}

/** The HTTP status behind a Wix SDK error, wherever the SDK happened to put it. */
function wixErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as WixErrorShape;
  return err.response?.status ?? err.status ?? err.statusCode;
}

const WIX_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => wixErrorStatusCode(error) === 429,
  getRetryAfterS: (error) => {
    if (error && typeof error === 'object') {
      const err = error as { response?: { headers?: Record<string, string> } };
      const header = err.response?.headers?.['retry-after'];
      const seconds = header ? parseInt(String(header), 10) : NaN;
      return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
    }
    return undefined;
  },
};

export const WIX_DEFAULT_BATCH_SIZE = 100; // Wix API supports up to 100

/**
 * Publish batch sizes, one per operation, taken from the `@maxSize` annotations on the pinned
 * `@wix/auto_sdk_blog_draft-posts` bulk endpoints — not guessed (DEV-11129).
 *
 * Creates deliberately stay at **1**. Wix's bulk endpoints are non-atomic (each item carries its own
 * `itemMetadata.success`), and `publish-plan-run.service.ts` marks an entire failed batch
 * `failed-batch` and then retries it record-by-record. Bulking creates would therefore turn one
 * rejected post into N duplicate posts on retry — the DEV-11016 mechanism. Updates and deletes are
 * idempotent, so replaying them is harmless and they get the SDK's real caps.
 */
export const WIX_BULK_UPDATE_MAX_SIZE = 20;
export const WIX_BULK_DELETE_MAX_SIZE = 100;
export const WIX_CREATE_BATCH_SIZE = 1;

export class WixBlogConnector extends Connector {
  readonly service = Service.WIX_BLOG;
  static readonly displayName = 'Wix Blog';
  static readonly metadata = connectorMetadata({
    displayName: 'Wix Blog',
    table: 'site',
    tables: 'sites',
    record: 'post',
    records: 'posts',
    logo: 'https://static.scratch.md/connector-icons/wix.svg',
    oauth: { label: 'OAuth' },
  });

  private readonly htmlToRicosConverter = new HtmlToWixConverter();
  private readonly ricosToHtmlConverter = new WixToHtmlConverter();
  private readonly turndownService = createTurndownService();
  private readonly wixClient: ReturnType<
    typeof createClient<
      undefined,
      ReturnType<typeof OAuthStrategy>,
      {
        draftPosts: typeof draftPosts;
        categories: typeof categories;
        tags: typeof tags;
        members: typeof members;
      }
    >
  >;
  private readonly schemaParser = new WixBlogSchemaParser();
  private readonly rateLimiter?: RateLimiter;

  constructor(accessToken: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.wixClient = createClient({
      auth: OAuthStrategy({
        clientId: '', // Not needed for just using access tokens
        tokens: {
          accessToken: {
            value: accessToken,
            // Wix app (client-credentials) access tokens are valid 4 hours. This is
            // only an SDK-side freshness hint — the host (getValidAccessToken) always
            // hands us a freshly re-minted token, since the SDK can't refresh here
            // (refreshToken role is NONE).
            expiresAt: Date.now() + 4 * 60 * 60 * 1000,
          },
          refreshToken: {
            value: '',
            role: TokenRole.NONE,
          },
        },
      }),
      modules: {
        draftPosts,
        categories,
        tags,
        members,
      },
    });
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, WIX_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, WIX_RETRY_OPTS);
  }

  public async testConnection(): Promise<void> {
    // Test that we have access to the draft posts API and that the creds work.
    await this.withRetry(() =>
      this.wixClient.draftPosts.listDraftPosts({
        paging: { limit: 1, offset: 0 },
      }),
    );
  }

  async listTables(): Promise<TablePreview[]> {
    return this.schemaParser.parseTablePreviews({ membersAreaInstalled: await this.isMembersAreaInstalled() });
  }

  /**
   * Whether this site can actually serve the Members table.
   *
   * Members is NOT part of Wix Blog. It comes from the Wix Members Area, a separate App Market app
   * that Wix Blog merely *offers* to install — Wix's own Members API docs list it as a hard
   * prerequisite ("A site must have the Wix Members Area installed from the App Market"). A
   * single-author blog that declined the prompt is a perfectly normal site, and on it every
   * `listMembers` call fails forever. Offering the table unconditionally meant such a user could map
   * a folder that could never pull, with an error blaming *our* app permissions.
   *
   * So we probe instead of assuming. Only a definitive "you can't have this" answer hides the table;
   * a rate limit or a 5xx leaves it listed, because hiding a table the user really does have is the
   * worse failure — it silently drops data they asked for.
   */
  private async isMembersAreaInstalled(): Promise<boolean> {
    try {
      await this.withRetry(() => this.wixClient.members.listMembers({ paging: { limit: 1, offset: 0 } }));
      return true;
    } catch (error) {
      const status = wixErrorStatusCode(error);
      const isDefinitivelyUnavailable = status === 403 || status === 404 || status === 428;
      if (!isDefinitivelyUnavailable) {
        WSLogger.warn({
          source: 'WixBlogConnector',
          message: 'Members Area probe failed inconclusively; listing the Members table anyway',
          status,
        });
        return true;
      }
      WSLogger.info({
        source: 'WixBlogConnector',
        message: 'Members Area is not installed on this site; omitting the Members table',
        status,
      });
      return false;
    }
  }

  /**
   * Fetch the JSON Table Spec for one of this connector's tables (posts, categories, tags, members).
   * Each schema describes the shape the Wix SDK returns, which is what lands on disk verbatim.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    return buildWixBlogJsonTableSpec(id);
  }

  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    return buildWixBlogDefaultView(spec);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const table = wixBlogTableKeyFromEntityId(tableSpec.id) ?? 'posts';
    WSLogger.info({
      source: 'WixBlogConnector',
      message: 'pullRecordFiles called',
      tableId: tableSpec.id.wsId,
      table,
    });

    if (table === 'posts') {
      await this.pullBlogPostsByCursor(callback, progress);
    } else {
      await this.pullOffsetPagedTable(table, callback, progress);
    }
    return {};
  }

  /**
   * Full scan of Blog Posts using `queryDraftPosts`' cursor paging.
   *
   * Offset paging over a mutable ordering loses records: a post edited mid-scan reorders the result
   * set, and every row after it shifts under the cursor. `listDraftPosts` can only sort by
   * `editedDate`, so the previous implementation could only *mitigate* that by scanning
   * `EDITING_DATE_ASC` — pushing an edited post past the cursor so the worst case was a harmless
   * re-read rather than a skipped record (DEV-11123). `queryDraftPosts` pages by cursor instead, so
   * Wix tracks the position itself and a mid-scan edit can't shift rows out from under us. Sorting by
   * `_id` makes the ordering immutable as well, since a post's id never changes.
   *
   * The cursor is checkpointed in `connectorProgress` so a crashed pull resumes mid-scan. An empty
   * page always terminates the scan, the same guard the offset loop carries: `hasNext()` reflects
   * Wix's own view of the page chain, and trusting it alone would loop forever if it ever disagreed
   * with an empty `items` (DEV-10702).
   */
  private async pullBlogPostsByCursor(
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
  ): Promise<void> {
    const resumeCursor = (progress as { cursor?: unknown }).cursor;
    // Pull the post body too, so the record on disk is complete and round-trips through
    // createRecords/updateRecords (which write the same fieldset).
    const baseQuery = this.wixClient.draftPosts
      .queryDraftPosts({ fieldsets: ['RICH_CONTENT'] })
      .ascending('_id')
      .limit(WIX_DEFAULT_BATCH_SIZE);
    const firstQuery = typeof resumeCursor === 'string' ? baseQuery.skipTo(resumeCursor) : baseQuery;

    let page = await this.withRetry(() => firstQuery.find());

    for (;;) {
      const currentPage = page;
      const nextCursor = currentPage.cursors?.next ?? undefined;
      const hasMore = currentPage.items.length > 0 && currentPage.hasNext() && !!nextCursor;

      // Emit the page verbatim — the raw Wix SDK shape on disk (Connector Prime Directive),
      // keyed by `_id` to match the write path.
      await callback({
        files: currentPage.items as unknown as ConnectorFile[],
        connectorProgress: hasMore ? { cursor: nextCursor } : {},
      });

      if (!hasMore) {
        break;
      }
      page = await this.withRetry(() => currentPage.next());
    }
  }

  /**
   * Offset-paged full scan shared by the three reference tables.
   *
   * Their list endpoints all page the same way (`paging: { limit, offset }` plus a `metaData.total`),
   * so the loop, the resume checkpoint and the termination guard live in one place and each table
   * only supplies "fetch one page". Blog Posts pages by cursor instead — see
   * {@link pullBlogPostsByCursor}.
   *
   * The running `offset` is checkpointed in `connectorProgress` so a crashed pull resumes mid-scan
   * instead of restarting. An empty page always terminates the scan: if Wix's `total` over-reports
   * what it actually paginates (records deleted mid-scan, an eventually-consistent counter, or
   * permission-filtered results), `offset += 0` never advances past `offset < total`, which would
   * otherwise loop forever re-fetching empty pages (DEV-10702).
   */
  private async pullOffsetPagedTable(
    table: Exclude<WixBlogTableKey, 'posts'>,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
  ): Promise<void> {
    const pageSize = WIX_DEFAULT_BATCH_SIZE;
    const resumeOffset = (progress as { offset?: unknown }).offset;
    let offset = typeof resumeOffset === 'number' ? resumeOffset : 0;

    for (;;) {
      const page = await this.withRetry(() => this.fetchPage(table, offset, pageSize));
      offset += page.records.length;

      const hasMore =
        page.records.length > 0 &&
        (typeof page.total === 'number' ? offset < page.total : page.records.length === pageSize);

      // Emit the page verbatim — the raw Wix SDK shape on disk (Connector Prime Directive),
      // keyed by `_id` to match the write path.
      await callback({
        files: page.records as unknown as ConnectorFile[],
        connectorProgress: hasMore ? { offset } : {},
      });

      if (!hasMore) {
        break;
      }
    }
  }

  /** Fetch one page of the given reference table, normalized to `{ records, total }`. */
  private async fetchPage(
    table: Exclude<WixBlogTableKey, 'posts'>,
    offset: number,
    limit: number,
  ): Promise<{ records: unknown[]; total?: number }> {
    switch (table) {
      case 'categories': {
        const response = await this.wixClient.categories.listCategories({ paging: { limit, offset } });
        return { records: response.categories ?? [], total: response.metaData?.total };
      }
      case 'tags': {
        // The tags module exposes only a query builder (there is no `listTags`), so paging is
        // expressed as skip/limit on the query instead of a `paging` argument.
        const response = await this.wixClient.tags.queryTags().skip(offset).limit(limit).find();
        return { records: response.items ?? [], total: response.totalCount ?? undefined };
      }
      case 'members': {
        const response = await this.wixClient.members.listMembers({
          paging: { limit, offset },
          // FULL includes the linked CRM contact (first/last name) and the profile photo, which are
          // the fields that make a Members table useful.
          fieldsets: ['FULL'],
        });
        return { records: response.members ?? [], total: response.metadata?.total ?? undefined };
      }
    }
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  pullRecordFilesByIds(
    _tableSpec: BaseJsonTableSpec,
    _ids: string[],
    _callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    throw new Error('pullRecordFilesByIds is not implemented for Wix Blog');
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  getBatchSize(operation: 'create' | 'update' | 'delete'): number {
    switch (operation) {
      case 'create':
        return WIX_CREATE_BATCH_SIZE;
      case 'update':
        return WIX_BULK_UPDATE_MAX_SIZE;
      case 'delete':
        return WIX_BULK_DELETE_MAX_SIZE;
      default:
        return assertUnreachable(operation);
    }
  }

  /**
   * Fail a bulk call if Wix rejected any item in it.
   *
   * Wix's bulk endpoints are non-atomic: they answer 200 with a per-item `itemMetadata.success`, so a
   * partial failure is invisible unless you look. The publish layer's contract is throw-or-succeed
   * with no per-record error channel, and it recovers by retrying the batch record-by-record — which
   * is safe precisely because we only bulk the idempotent operations. Surfacing the first rejection
   * with its Wix error text is what turns "published, apparently" into an honest failure the retry
   * can then attribute to a specific record.
   */
  private assertBulkItemsSucceeded(
    results: { itemMetadata?: { success?: boolean; _id?: string | null; error?: { description?: string } } }[],
    operation: 'update' | 'delete',
  ): void {
    const firstFailure = results.find((result) => result.itemMetadata?.success === false);
    if (!firstFailure) return;

    const failureCount = results.filter((result) => result.itemMetadata?.success === false).length;
    const reason = firstFailure.itemMetadata?.error?.description ?? 'no reason given';
    throw new Error(
      `Wix rejected ${failureCount} of ${results.length} posts in a bulk ${operation} ` +
        `(first failure: post ${firstFailure.itemMetadata?._id ?? 'unknown'} — ${reason})`,
    );
  }

  /**
   * Blog Posts is the only writable table. Categories, Tags and Members are listed with
   * `disabledCreates`/`disabledUpdates`/`disabledDeletes`, so the platform shouldn't route a write
   * here at all — but fail loudly rather than silently calling a Wix endpoint we never designed for,
   * or worse, appearing to succeed while writing nothing.
   */
  private assertWritableTable(tableSpec: BaseJsonTableSpec, operation: 'create' | 'update' | 'delete'): void {
    const table = wixBlogTableKeyFromEntityId(tableSpec.id) ?? 'posts';
    if (table !== 'posts') {
      throw new Error(
        `Wix Blog cannot ${operation} records in "${tableSpec.name}" — only Blog Posts is writable through this connector.`,
      );
    }
  }

  /**
   * Create draft posts in Wix from raw JSON files.
   * Files should contain Wix draft post data in the raw API format.
   * Returns the created posts.
   *
   * One request per post, deliberately. `bulkCreateDraftPosts` exists and takes 20 at a time, but a
   * partial failure inside it is unrecoverable here: the posts Wix did create leave no local trace
   * (the plan only records them after `createRecords` returns), the whole batch is marked failed, and
   * the retry re-creates every one of them. `getBatchSize('create')` is 1 for the same reason —
   * see {@link WIX_CREATE_BATCH_SIZE}.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    this.assertWritableTable(tableSpec, 'create');
    const results: ConnectorFile[] = [];

    for (const file of files) {
      const draftPostData = file as unknown as DraftPost;

      const response = await this.withRetry(() =>
        this.wixClient.draftPosts.createDraftPost(draftPostData, {
          fieldsets: ['RICH_CONTENT'],
        }),
      );

      if (!response.draftPost?._id) {
        throw new Error('Failed to create draft post: no ID returned');
      }

      results.push(response.draftPost as unknown as ConnectorFile);
    }

    return results;
  }

  /**
   * Update draft posts in Wix from raw JSON files.
   * Files should have an '_id' field and the post data to update.
   */
  async updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    this.assertWritableTable(tableSpec, 'update');

    // Chunked here as well as by `getBatchSize`, so this method is correct on its own rather than
    // only when the publish layer happens to slice it the right way.
    const results: ConnectorFile[] = [];
    for (let start = 0; start < files.length; start += WIX_BULK_UPDATE_MAX_SIZE) {
      const chunk = files.slice(start, start + WIX_BULK_UPDATE_MAX_SIZE);
      const response = await this.withRetry(() =>
        this.wixClient.draftPosts.bulkUpdateDraftPosts({
          // Wix identifies the target by `draftPost._id`, where the single-update call took the id as
          // a separate argument. Records land on disk in the SDK's own shape (`_id`), but keep the
          // `id` fallback the single-update path had so a hand-written file still resolves.
          draftPosts: chunk.map((file) => ({
            draftPost: { ...file, _id: (file._id || file.id) as string } as unknown as DraftPost,
          })),
          returnFullEntity: true,
          fieldsets: ['RICH_CONTENT'],
        }),
      );

      const itemResults = response.results ?? [];
      this.assertBulkItemsSucceeded(itemResults, 'update');

      // `originalIndex` is Wix's own correlation back to the request array, so results stay paired
      // with `files` by index even if Wix reorders them. Fall back to the sent payload for anything
      // Wix didn't echo — `returnFullEntity` is best-effort, and the caller pairs by index.
      const persistedByIndex = new Map<number, ConnectorFile>();
      for (const itemResult of itemResults) {
        const originalIndex = itemResult.itemMetadata?.originalIndex;
        if (typeof originalIndex === 'number' && itemResult.item) {
          persistedByIndex.set(originalIndex, itemResult.item as unknown as ConnectorFile);
        }
      }
      chunk.forEach((file, indexInChunk) => results.push(persistedByIndex.get(indexInChunk) ?? file));
    }
    return results;
  }

  /**
   * Delete draft posts from Wix.
   * Files should have an '_id' or 'id' field with the post ID to delete.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    this.assertWritableTable(tableSpec, 'delete');

    const postIds = files.map((file) => (file._id || file.id) as string);
    for (let start = 0; start < postIds.length; start += WIX_BULK_DELETE_MAX_SIZE) {
      const chunk = postIds.slice(start, start + WIX_BULK_DELETE_MAX_SIZE);
      const response = await this.withRetry(() =>
        this.wixClient.draftPosts.bulkDeleteDraftPosts(chunk, { permanent: true }),
      );
      this.assertBulkItemsSucceeded(response.results ?? [], 'delete');
    }
  }

  extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[] {
    const results: ConnectorAssetResult[] = [];

    // Phase 1: the post's cover image. This used to be driven off an `x-scratch-asset-field`
    // annotation on `heroImage` — a field the DraftPost API never returns, so the phase never fired
    // on real data (DEV-11117). The cover image actually lives at `media.wixMedia.image` as a
    // `wix:image://` URI, which has to be resolved before it's usable (DEV-11122).
    const coverImage = this.extractCoverImage(input.recordContent);
    if (coverImage) results.push(coverImage);

    // Phase 2: images embedded in the Ricos body.
    const richContent = input.recordContent['richContent'] as Record<string, unknown> | undefined;
    const nodes = richContent?.['nodes'] as unknown[] | undefined;
    if (Array.isArray(nodes)) {
      for (const candidate of nodes) {
        const node = candidate as Record<string, unknown> | undefined;
        if (!node || typeof node !== 'object') continue;
        const entry = this.extractFromWixNode(node);
        if (entry) results.push(entry);
      }
    }

    return results;
  }

  private extractCoverImage(recordContent: Record<string, unknown>): ConnectorAssetResult | null {
    const media = recordContent['media'] as Record<string, unknown> | undefined;
    const wixMedia = media?.['wixMedia'] as Record<string, unknown> | undefined;
    const imageUri = wixMedia?.['image'];
    const url = resolveWixMediaUriToUrl(imageUri);
    if (!url) return null;

    return {
      remoteAssetId: wixMediaIdFromUri(imageUri) ?? hashUrl(url),
      url,
      mediaType: 'image',
    };
  }

  /**
   * Extract one embedded image from a Ricos IMAGE node.
   *
   * The real Wix nesting is `imageData.image.src` / `imageData.image.width|height` — matching this
   * repo's own `rich-content/types.ts` and the HTML converter. The previous implementation read
   * `imageData.src` / `imageData.width` (a shape only its own test fixture used), so embedded images
   * were never extracted from live payloads (DEV-11122). `src.url` is a real https URL when Wix
   * supplies one; otherwise fall back to resolving `src.id` as a media id.
   */
  private extractFromWixNode(node: Record<string, unknown>): ConnectorAssetResult | null {
    if (node['type'] !== 'IMAGE') return null;

    const imageData = node['imageData'] as Record<string, unknown> | undefined;
    if (!imageData) return null;

    const image = imageData['image'] as Record<string, unknown> | undefined;
    const src = (image?.['src'] ?? imageData['src']) as Record<string, unknown> | string | undefined;
    const srcObject = typeof src === 'object' && src !== null ? src : undefined;
    const mediaId = typeof srcObject?.['id'] === 'string' ? srcObject['id'] : undefined;

    const url =
      (typeof srcObject?.['url'] === 'string' ? srcObject['url'] : undefined) ??
      (typeof src === 'string' ? (resolveWixMediaUriToUrl(src) ?? src) : undefined) ??
      (mediaId ? `https://static.wixstatic.com/media/${mediaId}` : undefined);
    if (!url) return null;

    const dimensionSource = image ?? imageData;
    return {
      remoteAssetId: mediaId ?? hashUrl(url),
      url,
      altText: typeof imageData['altText'] === 'string' ? imageData['altText'] : undefined,
      width: typeof dimensionSource['width'] === 'number' ? dimensionSource['width'] : undefined,
      height: typeof dimensionSource['height'] === 'number' ? dimensionSource['height'] : undefined,
      mediaType: 'image',
    };
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'title');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    let userFriendlyMessage = this.fallbackErrorDetails(error).userFriendlyMessage;
    let description = error instanceof Error ? error.message : String(error);
    let statusCode: number | undefined;
    // Handle SDK/Fetch errors
    if (error && typeof error === 'object') {
      const err = error as WixErrorShape;

      // Check if it's a Response object or has response info
      if (err.response) {
        statusCode = err.response.status;
        const errorData = err.response.data || err.data;

        if (errorData) {
          if (errorData.message) {
            userFriendlyMessage = errorData.message;
            description = errorData.message;
          } else if (errorData.details) {
            if (typeof errorData.details === 'string') {
              userFriendlyMessage = errorData.details;
              description = errorData.details;
            } else if (errorData.details.applicationError) {
              userFriendlyMessage =
                errorData.details.applicationError.description ?? errorData.details.applicationError.code ?? '';
              description = JSON.stringify(errorData.details.applicationError);
            }
          }
        }
      }

      // Handle status code from error object
      if (err.status || err.statusCode) {
        statusCode = err.status || err.statusCode;
      }

      // Apply status-specific messages
      if (statusCode === 401) {
        userFriendlyMessage = 'Authentication failed. Please reconnect your Wix account.';
      } else if (statusCode === 403) {
        // The likeliest cause on a Members pull isn't our app config at all — it's that the site
        // never installed the Wix Members Area, which Wix Blog only offers rather than requires.
        // Naming both causes beats sending the user to a settings page that may be fine.
        userFriendlyMessage =
          'Permission denied. If this is the Members table, the site may not have the Wix Members Area ' +
          'app installed; otherwise check your Wix app permissions.';
      } else if (statusCode === 404) {
        userFriendlyMessage = 'Resource not found. The post or site may have been deleted.';
      } else if (statusCode === 429) {
        userFriendlyMessage = 'Rate limit exceeded. Please try again in a few minutes.';
      } else if (statusCode === 400) {
        userFriendlyMessage = 'Invalid request. Please check your data and try again.';
      }
    }

    return {
      userFriendlyMessage,
      description,
      additionalContext: statusCode ? { statusCode } : undefined,
    };
  }
}

connectorRegistry.register({
  service: Service.WIX_BLOG,
  metadata: WixBlogConnector.metadata,
  advancedSettings: [],
  rateLimiterSpec: { points: 180, duration: 60 }, // Wix: ~200 req/min
  supportedAuthMethods: ['oauth'],
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Wix', Service.WIX_BLOG);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
      return new WixBlogConnector(accessToken, { rateLimiter });
    } else {
      throw new Error('Wix requires either OAuth or API key authentication');
    }
  },
});
