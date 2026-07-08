import { connectorMetadata } from '@spinner/shared-types';
import type { DraftPost } from '@wix/auto_sdk_blog_draft-posts';
import { draftPosts } from '@wix/blog';
import { members } from '@wix/members';
import { createClient, OAuthStrategy, TokenRole } from '@wix/sdk';
import { ConnectorAssetExtractionInput, ConnectorAssetResult } from 'src/asset/asset.types';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { defaultResolveFieldValue, extractFromAnnotatedSchema, hashUrl } from '../../../asset-extraction-helpers';
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
import { buildWixBlogJsonTableSpec } from './wix-blog-json-schema';
import { WixBlogSchemaParser } from './wix-blog-schema-parser';

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

const WIX_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => {
    if (error && typeof error === 'object') {
      const err = error as WixErrorShape;
      const status = err.response?.status ?? err.status ?? err.statusCode;
      return status === 429;
    }
    return false;
  },
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
      { draftPosts: typeof draftPosts; members: typeof members }
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
    return Promise.resolve([this.schemaParser.parseTablePreview()]);
  }

  /**
   * Fetch JSON Table Spec for Wix Blog draft posts.
   * Returns a schema describing the raw Wix DraftPost API response format.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(_id: EntityId): Promise<BaseJsonTableSpec> {
    void _id; // Wix Blog has only one table, so id is unused
    const id = this.schemaParser.parseTablePreview().id;
    return buildWixBlogJsonTableSpec(id);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    WSLogger.info({ source: 'WixBlogConnector', message: 'pullRecordFiles called', tableId: tableSpec.id.wsId });

    // Full scan of the site's draft posts. A published post keeps its editable
    // draft, and omitting `status` returns draft posts of all statuses, so this
    // covers published + unpublished. Offset-paged (Wix caps a page at 100); the
    // running offset is checkpointed in `connectorProgress` so a crashed pull
    // resumes mid-scan instead of restarting.
    const pageSize = WIX_DEFAULT_BATCH_SIZE;
    const resumeOffset = (progress as { offset?: unknown }).offset;
    let offset = typeof resumeOffset === 'number' ? resumeOffset : 0;

    for (;;) {
      const response = await this.withRetry(() =>
        this.wixClient.draftPosts.listDraftPosts({
          paging: { limit: pageSize, offset },
          // Pull the post body too, so the record on disk is complete and round-trips
          // through createRecords/updateRecords (which write the same fieldset).
          fieldsets: ['RICH_CONTENT'],
        }),
      );

      const draftPosts = response.draftPosts ?? [];
      offset += draftPosts.length;

      // Prefer the reported total to decide when to stop; fall back to a short page.
      // An empty page always terminates the scan: if Wix's `total` over-reports what
      // it actually paginates (posts deleted mid-scan, an eventually-consistent
      // counter, or permission-filtered results), `offset += 0` never advances past
      // `offset < total`, which would otherwise loop forever re-fetching empty pages.
      const total = response.metaData?.total;
      const hasMore =
        draftPosts.length > 0 && (typeof total === 'number' ? offset < total : draftPosts.length === pageSize);

      // Emit the page verbatim — the raw Wix DraftPost shape on disk (Connector
      // Prime Directive), keyed by `_id` to match the write path.
      await callback({
        files: draftPosts as unknown as ConnectorFile[],
        connectorProgress: hasMore ? { offset } : {},
      });

      if (!hasMore) {
        break;
      }
    }

    return {};
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

  getBatchSize(): number {
    return 1;
  }

  /**
   * Create draft posts in Wix from raw JSON files.
   * Files should contain Wix draft post data in the raw API format.
   * Returns the created posts.
   */
  async createRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const results: ConnectorFile[] = [];

    // Wix doesn't support bulk create for posts, so we create one at a time
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
  async updateRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    // Wix doesn't support bulk update, so we update one at a time
    const results: ConnectorFile[] = [];
    for (const file of files) {
      const postId = (file._id || file.id) as string;
      const postData = file as unknown as DraftPost;

      const response = await this.withRetry(() =>
        this.wixClient.draftPosts.updateDraftPost(postId, postData, {
          fieldsets: ['RICH_CONTENT'],
        }),
      );
      // `updateDraftPost` returns `UpdateDraftPostResponse { draftPost: DraftPost }`.
      // Fall back to the input file when the response is missing `draftPost`.
      const persisted = (response as { draftPost?: unknown })?.draftPost;
      results.push((persisted as ConnectorFile) ?? file);
    }
    return results;
  }

  /**
   * Delete draft posts from Wix.
   * Files should have an '_id' or 'id' field with the post ID to delete.
   */
  async deleteRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    // Wix doesn't support bulk delete, so we delete one at a time
    for (const file of files) {
      const postId = (file._id || file.id) as string;
      await this.withRetry(() =>
        this.wixClient.draftPosts.deleteDraftPost(postId, {
          permanent: true,
        }),
      );
    }
  }

  extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[] {
    const results: ConnectorAssetResult[] = [];

    // Phase 1: Schema-driven extraction (heroImage)
    const schemaResults = extractFromAnnotatedSchema(input, {
      extractUrl: (item) => (typeof item['url'] === 'string' ? item['url'] : undefined),
      resolveFieldValue: defaultResolveFieldValue,
    });
    results.push(...schemaResults);

    // Phase 2: richContent nodes
    const richContent = input.recordContent['richContent'] as Record<string, unknown> | undefined;
    const nodes = richContent?.['nodes'] as unknown[] | undefined;
    if (Array.isArray(nodes)) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i] as Record<string, unknown> | undefined;
        if (!node || typeof node !== 'object') continue;
        const entry = this.extractFromWixNode(node);
        if (entry) results.push(entry);
      }
    }

    return results;
  }

  private extractFromWixNode(node: Record<string, unknown>): ConnectorAssetResult | null {
    const type = node['type'] as string | undefined;
    if (type !== 'IMAGE') return null;

    const imageData = node['imageData'] as Record<string, unknown> | undefined;
    if (!imageData) return null;

    const src = imageData['src'] as Record<string, unknown> | undefined;
    const url = (src?.['url'] as string) || (imageData['src'] as string | undefined);

    if (!url || typeof url !== 'string') return null;

    const id = src?.['id'] as string | undefined;

    return {
      remoteAssetId: id || hashUrl(url),
      url,
      altText: imageData['altText'] as string | undefined,
      width: typeof imageData['width'] === 'number' ? imageData['width'] : undefined,
      height: typeof imageData['height'] === 'number' ? imageData['height'] : undefined,
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
        userFriendlyMessage = 'Permission denied. Please check your Wix app permissions.';
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
