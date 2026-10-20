import {
  connectorMetadata,
  ConnectorSettingDefinition,
  IncrementalPullSupport,
  PulledRecordWarning,
  TableView,
} from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
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
import {
  INTERCOM_MAX_CONTACTS_PAGE_SIZE,
  INTERCOM_MAX_CONVERSATIONS_PAGE_SIZE,
  INTERCOM_MAX_PAGE_SIZE,
  IntercomApiClient,
  IntercomConversationFullFetchFailure,
  IntercomError,
} from './intercom-api-client';
import { buildIntercomDefaultView } from './intercom-default-view';
import { buildIntercomUpdatedSinceQuery, IntercomUpdatedSinceQuery } from './intercom-incremental';
import {
  buildIntercomArticlesJsonTableSpec,
  buildIntercomCollectionsJsonTableSpec,
  buildIntercomCompaniesJsonTableSpec,
  buildIntercomContactsJsonTableSpec,
  buildIntercomConversationsJsonTableSpec,
} from './intercom-json-schema';
import {
  IntercomCreateArticleRequest,
  IntercomCreateCollectionRequest,
  IntercomUpdateArticleRequest,
  IntercomUpdateCollectionRequest,
} from './intercom-types';

interface IntercomPullOptions extends PullRecordFilesOptions {
  excludeConversationParts?: boolean | undefined;
}

/**
 * The pull warning for a conversation Intercom listed but could not return in full (a 403, or a 5xx that outlasted
 * the retries), so it was pulled as the list endpoint returned it — everything but its `conversation_parts`. Names
 * the conversation, the status and Intercom's own reason; for a 403, points at the likely fix (the token's teammate
 * can't see it) without claiming that as certain.
 */
export function buildPullWarningForConversationIntercomCouldNotReturnInFull(
  failure: IntercomConversationFullFetchFailure,
): PulledRecordWarning {
  const intercomReasonSuffix = failure.intercomErrorMessage ? ` ("${failure.intercomErrorMessage}")` : '';
  const pulledWithoutConversationParts = `Pulled conversation ${failure.conversationId} without its conversation parts (message history)`;
  return {
    remoteId: failure.conversationId,
    warning:
      failure.httpStatus === 403
        ? `${pulledWithoutConversationParts}: Intercom returned 403 Forbidden for the full conversation` +
          `${intercomReasonSuffix}. This usually means the Intercom teammate behind this connection's access token ` +
          `isn't allowed to see this conversation.`
        : `${pulledWithoutConversationParts}: Intercom kept failing with HTTP ${failure.httpStatus} for the full ` +
          `conversation${intercomReasonSuffix}, even after retries.`,
  };
}

/**
 * Three-state incremental-pull capability for Intercom, keyed on the table.
 * Only Conversations supports a server-side incremental pull
 * (`POST /conversations/search` filters on `updated_at`). Articles and
 * Collections have no modified-since filter; Contacts and Companies deliberately
 * have no incremental pull (DEV-12350 — the contacts search walk lists every
 * contact in creation order and never filters by update time, and the companies
 * scroll has no filter at all). There is no per-folder config that
 * would change any of that — so they are `NOT_SUPPORTED` (never
 * `NEEDS_CONFIGURATION`). `tableKey` is the table's wsId (equivalently
 * `DataFolder.tableId[0]`).
 */
export function intercomIncrementalPullSupport(tableKey: string): IncrementalPullSupport {
  return tableKey === 'conversations' ? IncrementalPullSupport.SUPPORTED : IncrementalPullSupport.NOT_SUPPORTED;
}

/**
 * Read-only tables whose write methods REJECT a write rather than skipping it. A skipped write
 * looks like success to the caller, so a table added as read-only belongs here. (Conversations
 * predates this and still skips; it is listed with `disabled*` flags so publish never sends it
 * writes in the first place.)
 */
const INTERCOM_TABLES_THAT_REJECT_WRITES = new Set(['contacts', 'companies']);

function assertIntercomTableAcceptsWrites(tableSpec: BaseJsonTableSpec): void {
  if (INTERCOM_TABLES_THAT_REJECT_WRITES.has(tableSpec.id.wsId)) {
    throw new IntercomError(
      `Intercom ${tableSpec.name} are read-only in Scratch and cannot be created, updated or deleted.`,
      400,
    );
  }
}

/**
 * An article's `parent_id` as Intercom's write API wants it: an integer.
 *
 * The field is a declared foreign key to Collections (DEV-11285), so a sync writing INTO Intercom
 * hands us whatever the link resolved to — and a resolved record id arrives as a STRING even when
 * the target service numbers its ids. Sending `"19716322"` where the API documents an integer is a
 * needless rejection, so a numeric string is converted. Anything else (including a `@/…` reference
 * that reached this far unresolved) is passed through untouched so the service rejects it loudly
 * rather than us silently dropping the user's link.
 */
function asArticleParentId(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return value as number;
}

/**
 * Connector for the Intercom customer messaging platform.
 *
 * Syncs Help Center articles and collections (full CRUD), plus read-only
 * Conversations, Contacts (users and leads) and Companies, via the Intercom REST API.
 *
 * API docs: https://developers.intercom.com/docs/references/rest-api/api.intercom.io/
 */
export class IntercomConnector extends Connector {
  readonly service = Service.INTERCOM;
  static readonly displayName = 'Intercom';
  static readonly metadata = connectorMetadata({
    displayName: 'Intercom',
    table: 'resource',
    tables: 'resources',
    record: 'record',
    records: 'records',
    logo: 'https://static.scratch.md/connector-icons/intercom.svg',
    incrementalPull: true,
    incrementalPullInstructions:
      'Incremental pull only downloads records changed since the last pull. Only Conversations support this, because Intercom can filter conversations by their updated-at time. Articles, Collections, Contacts and Companies do not support incremental pull and always re-download in full.',
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'Access Token',
          placeholder: 'dG9rOjEyM...',
          description: 'Create an access token in your Intercom Developer Hub app settings',
          required: true,
        },
      ],
    },
  });

  static readonly advancedSettings: ConnectorSettingDefinition[] = [
    {
      key: 'excludeConversationParts',
      type: 'boolean',
      label: 'Exclude conversation replies',
      description:
        'Skip downloading threaded replies and notes for conversations. Significantly increases download speed for large workspaces.',
      forTableWsIds: ['conversations'],
    },
  ];

  private readonly client: IntercomApiClient;

  constructor(accessToken: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new IntercomApiClient(accessToken, { rateLimiter: opts?.rateLimiter });
  }

  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return [
      {
        id: { wsId: 'articles', remoteId: ['articles'] },
        displayName: 'Articles',
        metadata: { description: 'Help Center articles in your Intercom workspace' },
      },
      {
        id: { wsId: 'collections', remoteId: ['collections'] },
        displayName: 'Collections',
        metadata: { description: 'Help Center collections in your Intercom workspace' },
      },
      {
        id: { wsId: 'conversations', remoteId: ['conversations'] },
        displayName: 'Conversations',
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
        metadata: { description: 'Conversations in your Intercom workspace (read-only)' },
      },
      {
        id: { wsId: 'contacts', remoteId: ['contacts'] },
        displayName: 'Contacts',
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
        disabledReason: 'Intercom contacts are read-only in Scratch.',
        infoNote:
          'Includes every user and lead in your Intercom workspace. Each pull downloads all of them, so this table can be large.',
        metadata: { description: 'Users and leads in your Intercom workspace (read-only)' },
      },
      {
        id: { wsId: 'companies', remoteId: ['companies'] },
        displayName: 'Companies',
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
        disabledReason: 'Intercom companies are read-only in Scratch.',
        infoNote:
          "Includes companies that have at least one user or lead. Intercom's API doesn't list companies without any, so a company that loses its last contact is removed on the next pull.",
        metadata: { description: 'Companies with at least one contact in your Intercom workspace (read-only)' },
      },
    ];
  }

  /**
   * Reproduce, purely from the spec, the default TableView that schema
   * generation used to bake into each table spec. `spec.id.wsId` is the entity
   * type (an `IntercomTableType`) — the exact string literal the old schema-gen
   * `defaultView` setter passed to the builder.
   */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    return buildIntercomDefaultView(spec.schema, spec.id.wsId);
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    switch (id.wsId) {
      case 'articles':
        return buildIntercomArticlesJsonTableSpec(id);
      case 'collections':
        return buildIntercomCollectionsJsonTableSpec(id);
      case 'conversations':
        return buildIntercomConversationsJsonTableSpec(id);
      case 'contacts':
        // Custom attributes are the workspace's own — discovered, never hardcoded.
        return buildIntercomContactsJsonTableSpec(id, await this.client.listDataAttributes('contact'));
      case 'companies':
        return buildIntercomCompaniesJsonTableSpec(id, await this.client.listDataAttributes('company'));
      default:
        throw new IntercomError(`Unknown table '${id.wsId}'.`, 404);
    }
  }

  /**
   * Only the Conversations table supports a server-side incremental pull
   * (`POST /conversations/search` filters on `updated_at`). Articles and
   * Collections have no modified-since filter on their list endpoints, so the
   * job demotes those folders to a full scan. The capability gate is the table
   * itself — `updated_at` is a fixed conversations system field, not
   * user-selectable, so there is no per-folder config to inspect.
   */
  override incrementalPullSupport(
    _options: PullRecordFilesOptions,
    tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    return tableSpec ? intercomIncrementalPullSupport(tableSpec.id.wsId) : IncrementalPullSupport.NOT_SUPPORTED;
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: {
      files: ConnectorFile[];
      connectorProgress?: JsonSafeObject;
      recordWarnings?: PulledRecordWarning[];
    }) => Promise<void>,
    progress: JsonSafeObject,
    options: IntercomPullOptions,
  ): Promise<PullRecordFilesResult> {
    const resumeProgress = progress as { nextPage?: number; startingAfter?: string };

    switch (tableSpec.id.wsId) {
      // Articles and collections use page-number pagination over an unstable
      // `updated_at` DESC sort, so the client walks them with dedup +
      // total_count verification to keep the snapshot faithful (DEV-11283).
      // `resumeFromPage` is the client's crash-resume checkpoint into the
      // primary walk; a resumed listing re-verifies coverage itself.
      case 'articles': {
        const startPage = resumeProgress?.nextPage ?? 1;
        for await (const { records, resumeFromPage } of this.client.listArticles(INTERCOM_MAX_PAGE_SIZE, startPage)) {
          await callback({
            files: records as unknown as ConnectorFile[],
            connectorProgress: { nextPage: resumeFromPage },
          });
        }
        break;
      }

      case 'collections': {
        const startPage = resumeProgress?.nextPage ?? 1;
        for await (const { records, resumeFromPage } of this.client.listCollections(
          INTERCOM_MAX_PAGE_SIZE,
          startPage,
        )) {
          await callback({
            files: records as unknown as ConnectorFile[],
            connectorProgress: { nextPage: resumeFromPage },
          });
        }
        break;
      }

      case 'conversations': {
        const hydrate = !options.excludeConversationParts;

        // Incremental: only conversations supports a server-side updated_at
        // search. Capture the watermark BEFORE the first API call so changes
        // made mid-pull are re-pulled next run, not skipped. Intercom's search
        // `>` is exclusive and `updated_at` is server-side (Unix seconds) while
        // the watermark is client-side, so the helper subtracts a clock-skew
        // margin; idempotent commits absorb the small re-pulled window. Gated
        // inside this case so a stray incremental request for the other tables
        // still returns {} (no watermark).
        let newWatermark: Date | undefined;
        let updatedSinceQuery: IntercomUpdatedSinceQuery | undefined;
        if (options.pullMode === 'incremental' && options.since instanceof Date) {
          newWatermark = new Date();
          updatedSinceQuery = buildIntercomUpdatedSinceQuery(options.since);
        }

        // Listed at Intercom's max page whether or not each conversation is then fetched in full (see
        // INTERCOM_MAX_CONVERSATIONS_PAGE_SIZE for why that holds for the full fetches too).
        const conversationPages = updatedSinceQuery
          ? this.client.searchConversationsUpdatedSince(
              updatedSinceQuery,
              INTERCOM_MAX_CONVERSATIONS_PAGE_SIZE,
              hydrate,
              resumeProgress?.startingAfter,
            )
          : this.client.listConversations(INTERCOM_MAX_CONVERSATIONS_PAGE_SIZE, hydrate, resumeProgress?.startingAfter);

        // Persist the Intercom-provided cursor (`pages.next.starting_after`),
        // never a conversation id — Intercom rejects ids with "Invalid
        // starting_after param". `nextCursor` is undefined on the final page.
        // A conversation Intercom could not return in full is in `conversations`
        // as listed; report it on the same page so the pull completes with a warning.
        for await (const {
          items: conversations,
          nextCursor,
          conversationsIntercomCouldNotReturnInFull,
        } of conversationPages) {
          await callback({
            files: conversations as unknown as ConnectorFile[],
            connectorProgress: nextCursor ? { startingAfter: nextCursor } : {},
            recordWarnings: conversationsIntercomCouldNotReturnInFull.map(
              buildPullWarningForConversationIntercomCouldNotReturnInFull,
            ),
          });
        }
        return newWatermark ? { newWatermark } : {};
      }

      // Every contact, in creation order (see `listAllContactsInCreationOrder` for why the search
      // endpoint and not `GET /contacts`). Always a full walk — Contacts has no incremental pull — so
      // a stray incremental request is served by the same walk and returns {} (no watermark). The
      // checkpoint is Intercom's opaque cursor, exactly like conversations.
      case 'contacts': {
        for await (const { items: contacts, nextCursor } of this.client.listAllContactsInCreationOrder(
          INTERCOM_MAX_CONTACTS_PAGE_SIZE,
          resumeProgress?.startingAfter,
        )) {
          await callback({
            files: contacts as unknown as ConnectorFile[],
            connectorProgress: nextCursor ? { startingAfter: nextCursor } : {},
          });
        }
        break;
      }

      // Every company with at least one contact, via the scroll (see `listAllCompaniesViaScroll`). A
      // scroll can't be resumed part-way, so the checkpoint is always {} — a crashed walk starts over
      // (and the job only runs delete-detection after a walk completes). Always a full walk.
      case 'companies': {
        for await (const { items: companies } of this.client.listAllCompaniesViaScroll()) {
          await callback({ files: companies as unknown as ConnectorFile[], connectorProgress: {} });
        }
        break;
      }

      default:
        throw new IntercomError(`Unknown table '${tableSpec.id.wsId}'`, 404);
    }
    return {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      let record: unknown = null;
      if (tableSpec.id.wsId === 'articles') {
        record = await this.client.getArticle(id);
      } else if (tableSpec.id.wsId === 'collections') {
        record = await this.client.getCollection(id);
      } else if (tableSpec.id.wsId === 'conversations') {
        record = await this.client.getConversation(id);
      } else if (tableSpec.id.wsId === 'contacts') {
        record = await this.client.getContact(id);
      } else if (tableSpec.id.wsId === 'companies') {
        record = await this.client.getCompany(id);
      }

      if (record) {
        buffer.push(record as ConnectorFile);
      }

      if (buffer.length >= BATCH_SIZE) {
        await callback({ files: buffer.splice(0) });
      }
    }

    if (buffer.length > 0) {
      await callback({ files: buffer });
    }
  }

  getBatchSize(): number {
    return 10;
  }

  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    assertIntercomTableAcceptsWrites(tableSpec);
    const results: ConnectorFile[] = [];

    for (const file of files) {
      if (tableSpec.id.wsId === 'articles') {
        const data: IntercomCreateArticleRequest = {
          title: file.title as string,
          author_id: file.author_id as number,
          description: file.description as string | undefined,
          body: file.body as string | undefined,
          state: file.state as 'published' | 'draft' | undefined,
          parent_id: asArticleParentId(file.parent_id),
          parent_type: file.parent_type as 'collection' | 'section' | undefined,
          translated_content: file.translated_content as Record<string, unknown> | undefined,
        };
        const created = await this.client.createArticle(data);
        results.push(created as unknown as ConnectorFile);
      } else if (tableSpec.id.wsId === 'collections') {
        const data: IntercomCreateCollectionRequest = {
          name: file.name as string,
          description: file.description as string | undefined,
          translated_content: file.translated_content as Record<string, unknown> | undefined,
          icon: file.icon as string | undefined,
          parent_id: file.parent_id as string | undefined,
          help_center_id: file.help_center_id as number | undefined,
        };
        const created = await this.client.createCollection(data);
        results.push(created as unknown as ConnectorFile);
      }
    }

    return results;
  }

  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    assertIntercomTableAcceptsWrites(tableSpec);
    const results: ConnectorFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const changed = changedFields[i];
      if (tableSpec.id.wsId === 'articles') {
        const articleId = file.id as string;
        const data: IntercomUpdateArticleRequest = {
          title: changed.title as string | undefined,
          description: changed.description as string | undefined,
          body: changed.body as string | undefined,
          author_id: changed.author_id as number | undefined,
          state: changed.state as 'published' | 'draft' | undefined,
          parent_id: asArticleParentId(changed.parent_id),
          parent_type: changed.parent_type as 'collection' | 'section' | undefined,
          translated_content: changed.translated_content as Record<string, unknown> | undefined,
        };
        const updated = await this.client.updateArticle(articleId, data);
        results.push(updated as unknown as ConnectorFile);
      } else if (tableSpec.id.wsId === 'collections') {
        const collectionId = file.id as string;
        const data: IntercomUpdateCollectionRequest = {
          name: changed.name as string | undefined,
          description: changed.description as string | undefined,
          translated_content: changed.translated_content as Record<string, unknown> | undefined,
          icon: changed.icon as string | undefined,
          parent_id: changed.parent_id as string | undefined,
          help_center_id: changed.help_center_id as number | undefined,
        };
        const updated = await this.client.updateCollection(collectionId, data);
        results.push(updated as unknown as ConnectorFile);
      } else {
        results.push(file);
      }
    }
    return results;
  }

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    assertIntercomTableAcceptsWrites(tableSpec);
    for (const file of files) {
      const recordId = file.id as string;
      if (!recordId) continue;

      if (tableSpec.id.wsId === 'articles') {
        await this.client.deleteArticle(recordId);
      } else if (tableSpec.id.wsId === 'collections') {
        await this.client.deleteCollection(recordId);
      }
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    if (tableSpec.id.wsId === 'articles') {
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'title');
    }
    if (tableSpec.id.wsId === 'conversations') {
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'source.subject', 'title');
    }
    if (tableSpec.id.wsId === 'contacts') {
      // `email` is set on all but a handful of contacts; `name` is the fallback, then the id.
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'email', 'name');
    }
    if (tableSpec.id.wsId === 'companies') {
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'name', 'company_id');
    }
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'name');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof IntercomError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          status: error.statusCode,
          responseData: error.responseData,
        },
      };
    }

    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, [
          'message',
          'errors',
          'error_code',
        ]),
        description: error.message,
        additionalContext: {
          status: error.response?.status,
        },
      };
    }

    return this.fallbackErrorDetails(error);
  }
}

connectorRegistry.register({
  service: Service.INTERCOM,
  metadata: IntercomConnector.metadata,
  advancedSettings: IntercomConnector.advancedSettings,
  supportedAuthMethods: ['user_provided_params'],
  // Intercom allows 10,000 requests/minute per app, but enforces it in 10-second
  // buckets of one sixth that — so a per-second spec is the right shape. 150/s
  // (9,000/min) stays inside the app budget while leaving room under the
  // 25,000/min WORKSPACE ceiling that every app installed on the workspace shares.
  // https://developers.intercom.com/docs/references/rest-api/errors/rate-limiting
  rateLimiterSpec: { points: 150, duration: 1 },
  resolveIncrementalPullSupport: ({ tableId }) => intercomIncrementalPullSupport(tableId[0] ?? ''),
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Intercom', Service.INTERCOM);
    }
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('Access token is required for Intercom', Service.INTERCOM);
    }
    return new IntercomConnector(ctx.decryptedCredentials.apiKey, {
      rateLimiter: ctx.createRateLimiter(ctx.connectorAccount.id),
    });
  },
});
