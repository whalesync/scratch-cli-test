import { connectorMetadata, TableView } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { assertUnreachable } from 'src/utils/asserts';
import { Connector } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
} from '../../error';
import { sanitizeForTableWsId } from '../../ids';
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
import { AttioApiClient, AttioError } from './attio-api-client';
import {
  buildAttioDefaultView,
  buildAttioFlatView,
  LIST_VIEW_CONFIG,
  MEMBERS_FLAT_VIEW_CONFIG,
  OBJECT_VIEW_CONFIG,
  TASKS_FLAT_VIEW_CONFIG,
} from './attio-default-view';
import {
  ATTIO_MEMBERS_TABLE_REMOTE_ID,
  buildAttioListTableSpec,
  buildAttioMembersTableSpec,
  buildAttioObjectTableSpec,
  buildAttioTasksTableSpec,
} from './attio-json-schema';
import {
  AttioDownloadProgress,
  AttioListEntry,
  AttioRecord,
  AttioTableKind,
  AttioTask,
  AttioTaskAssignee,
  AttioTaskLinkedRecord,
  AttioWorkspaceMember,
} from './attio-types';
import { toWriteValues } from './attio-write-shape';

/**
 * Connector for the Attio v2 REST API.
 *
 * v1 scope (per the shaping doc at internal/projects/2026-05-05-attio-integration):
 *   - Standard objects: companies, people, deals (read-write)
 *   - Custom fields on those three (fall out for free from the attributes endpoint)
 *   - Lists, modeled as their own tables — entries wrap the parent record
 *     under `parent_record`, list-scoped fields under `entry_values`
 *
 * Out of v1 (deferred): custom *objects*, notes/tasks/comments.
 *
 * Auth: API-key (workspace token from Settings → Developers) for now. OAuth
 * lights up by adding `'oauth'` to `supportedAuthMethods` and registering an
 * `AttioOAuthProvider` — the Bearer-token wire format is the same.
 *
 * Lists pattern is lifted from the Affinity connector — see Affinity's
 * `affinity-connector.ts` for the precedent and CONNECTOR_GUIDE.md →
 * "Fixed vs. user-defined tables" for the broader pattern.
 */
export class AttioConnector extends Connector<string, AttioDownloadProgress> {
  readonly service = Service.ATTIO;
  static readonly displayName = 'Attio';
  static readonly metadata = connectorMetadata({
    displayName: 'Attio',
    table: 'object',
    tables: 'objects',
    record: 'record',
    records: 'records',
    logo: 'https://static.scratch.md/connector-icons/attio-2.svg',
    supportedAuthMethods: ['user_provided_params'],
    defaultAuthMethod: 'user_provided_params',
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'Access Token',
          description: 'Generate an access token in Attio at Settings → Developers → Create access token.',
          required: true,
        },
      ],
    },
  });

  private readonly client: AttioApiClient;
  /** Cache of (list api_slug → list name), populated by `listTables`. */
  private readonly listNameCache = new Map<string, string>();
  /** Cache of (object api_slug → display nouns), populated by `listTables`. */
  private readonly objectDisplayCache = new Map<string, { singular: string; plural: string }>();

  constructor(accessToken: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new AttioApiClient(accessToken, opts);
  }

  async testConnection(): Promise<void> {
    await this.client.testConnection();
  }

  /**
   * Picker tree:
   *
   *   Companies         ← /v2/objects/companies/records
   *   People            ← /v2/objects/people/records
   *   Deals             ← /v2/objects/deals/records
   *   Lists/<list name> ← /v2/lists/{slug}/entries
   */
  async listTables(): Promise<TablePreview[]> {
    // Every object the workspace exposes — standard (companies/people/deals)
    // *and* the rest (events, products, users, workspaces, custom objects).
    // They all share the `/v2/objects/{slug}` endpoint family, so one codepath
    // (parsed.kind === 'object') handles them all.
    const objects = await this.client.listObjects();
    const objectTables: TablePreview[] = objects.map((obj) => {
      const display = { singular: obj.singular_noun, plural: obj.plural_noun };
      this.objectDisplayCache.set(obj.api_slug, display);
      return {
        id: { wsId: sanitizeForTableWsId(obj.api_slug), remoteId: [obj.api_slug] },
        displayName: display.plural,
        metadata: { tableKind: 'object', objectSlug: obj.api_slug },
      };
    });

    const lists = await this.client.listLists();
    const listTables: TablePreview[] = lists
      // Expose every list regardless of parent object (custom-object lists
      // included). A list with no resolvable parent is skipped — without a
      // `parent_object` we couldn't create entries in it.
      .filter((list) => list.parent_object[0] !== undefined)
      .map((list) => {
        this.listNameCache.set(list.api_slug, list.name);
        return {
          id: { wsId: sanitizeForTableWsId(`list_${list.api_slug}`), remoteId: ['list', list.api_slug] },
          displayName: list.name,
          parentPath: 'Lists',
          metadata: { tableKind: 'list', listSlug: list.api_slug, parentObjectSlug: list.parent_object[0] },
        };
      });

    // Workspace members — a read-only reference directory (teammates), the
    // target for `actor-reference` fields. Its own endpoint + fixed shape, so
    // its own table kind; all writes disabled.
    const membersTable: TablePreview = {
      // remoteId is `['members']` (see ATTIO_MEMBERS_TABLE_REMOTE_ID) — the id that
      // `actor-reference` foreign keys target and that becomes this folder's tableId.
      id: { wsId: 'workspace_members', remoteId: [...ATTIO_MEMBERS_TABLE_REMOTE_ID] },
      displayName: 'Workspace Members',
      disabledCreates: true,
      disabledUpdates: true,
      disabledDeletes: true,
      disabledReason: 'Workspace members are a read-only reference directory in Attio.',
      metadata: { tableKind: 'members' },
    };

    // Tasks — their own endpoint + flat shape (not the object `values[]`
    // envelope), so their own table kind. Full CRUD; content is write-once.
    const tasksTable: TablePreview = {
      id: { wsId: 'tasks', remoteId: ['tasks'] },
      displayName: 'Tasks',
      metadata: { tableKind: 'tasks' },
    };

    return [...objectTables, ...listTables, membersTable, tasksTable];
  }

  /**
   * Rebuild the default view for a table purely from its spec. Only object and
   * list tables carry a curated view today — Members and Tasks emit none. The
   * table kind is recovered from `spec.id` via the same `parseAttioTableId`
   * dispatcher the rest of the connector uses, and the per-object view config is
   * chosen exactly as `buildAttioObjectTableSpec` did before this moved here.
   */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    const parsed = parseAttioTableId(spec.id);
    switch (parsed.kind) {
      case 'object': {
        const viewConfig = OBJECT_VIEW_CONFIG[parsed.objectSlug] ?? { valuesKey: 'values' };
        return buildAttioDefaultView(spec.schema, viewConfig);
      }
      case 'list':
        return buildAttioDefaultView(spec.schema, LIST_VIEW_CONFIG);
      case 'members':
        return buildAttioFlatView(spec.schema, MEMBERS_FLAT_VIEW_CONFIG);
      case 'tasks':
        return buildAttioFlatView(spec.schema, TASKS_FLAT_VIEW_CONFIG);
      default:
        return assertUnreachable(parsed);
    }
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const parsed = parseAttioTableId(id);
    switch (parsed.kind) {
      case 'object': {
        const display =
          this.objectDisplayCache.get(parsed.objectSlug) ?? (await this.lookupObjectDisplay(parsed.objectSlug));
        return buildAttioObjectTableSpec(id, parsed.objectSlug, this.client, display);
      }
      case 'list': {
        const name = this.listNameCache.get(parsed.listSlug) ?? (await this.lookupListName(parsed.listSlug));
        return buildAttioListTableSpec(id, parsed.listSlug, name, this.client);
      }
      case 'members':
        return buildAttioMembersTableSpec(id);
      case 'tasks':
        return buildAttioTasksTableSpec(id);
      default:
        return assertUnreachable(parsed);
    }
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: AttioDownloadProgress }) => Promise<void>,
    progress: AttioDownloadProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const parsed = parseAttioTableId(tableSpec.id);
    const resumeOffset = progress?.offset;

    switch (parsed.kind) {
      case 'object': {
        for await (const batch of this.client.queryRecords(parsed.objectSlug, resumeOffset)) {
          await callback({
            files: batch.data as unknown as ConnectorFile[],
            connectorProgress: batch.nextOffset !== undefined ? { offset: batch.nextOffset } : {},
          });
        }
        return {};
      }
      case 'list': {
        for await (const batch of this.client.queryListEntries(parsed.listSlug, resumeOffset)) {
          await callback({
            files: batch.data as unknown as ConnectorFile[],
            connectorProgress: batch.nextOffset !== undefined ? { offset: batch.nextOffset } : {},
          });
        }
        return {};
      }
      case 'members': {
        // Single page — the endpoint returns the full member set with no
        // pagination params.
        const members = await this.client.listWorkspaceMembers();
        await callback({ files: members as unknown as ConnectorFile[], connectorProgress: {} });
        return {};
      }
      case 'tasks': {
        for await (const batch of this.client.queryTasks(resumeOffset)) {
          await callback({
            files: batch.data as unknown as ConnectorFile[],
            connectorProgress: batch.nextOffset !== undefined ? { offset: batch.nextOffset } : {},
          });
        }
        return {};
      }
      default:
        return assertUnreachable(parsed);
    }
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const parsed = parseAttioTableId(tableSpec.id);
    const buffer: ConnectorFile[] = [];

    for (const recordId of ids) {
      switch (parsed.kind) {
        case 'object': {
          const rec = await this.client.getRecord(parsed.objectSlug, recordId);
          if (rec) buffer.push(rec as unknown as ConnectorFile);
          break;
        }
        case 'list': {
          const entry = await this.client.getListEntry(parsed.listSlug, recordId);
          if (entry) buffer.push(entry as unknown as ConnectorFile);
          break;
        }
        case 'members': {
          // No get-member-by-id endpoint — list and filter. The member set is
          // tiny, so the per-id refetch cost is negligible.
          const members = await this.client.listWorkspaceMembers();
          const found = members.find((member) => member.id.workspace_member_id === recordId);
          if (found) buffer.push(found as unknown as ConnectorFile);
          break;
        }
        case 'tasks': {
          const task = await this.client.getTask(recordId);
          if (task) buffer.push(task as unknown as ConnectorFile);
          break;
        }
        default:
          return assertUnreachable(parsed);
      }
    }

    if (buffer.length > 0) {
      await callback({ files: buffer });
    }
  }

  getBatchSize(): number {
    // Attio has no bulk create/update/delete API — every write is a single
    // request. createRecords / updateRecords loop internally.
    return 1;
  }

  // ---- Writes ----

  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const parsed = parseAttioTableId(tableSpec.id);
    const created: ConnectorFile[] = [];
    for (const file of files) {
      switch (parsed.kind) {
        case 'object': {
          const values = toWriteValues((file as { values?: unknown }).values);
          const rec = await this.client.createRecord(parsed.objectSlug, values);
          created.push(rec as unknown as ConnectorFile);
          break;
        }
        case 'list': {
          const entryValues = toWriteValues((file as { entry_values?: unknown }).entry_values);
          const parentRecordId = readString(file, 'parent_record_id');
          const parentObject = readString(file, 'parent_object');
          if (!parentRecordId || !parentObject) {
            throw new AttioError(
              'Cannot create list entry: `parent_record_id` and `parent_object` are required on the file.',
            );
          }
          const entry = await this.client.createListEntry(parsed.listSlug, parentObject, parentRecordId, entryValues);
          created.push(entry as unknown as ConnectorFile);
          break;
        }
        case 'members':
          throw new AttioError('Workspace members are read-only — create is not supported.');
        case 'tasks': {
          const task = await this.client.createTask(readTaskWriteFields(file));
          created.push(task as unknown as ConnectorFile);
          break;
        }
        default:
          return assertUnreachable(parsed);
      }
    }
    return created;
  }

  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const parsed = parseAttioTableId(tableSpec.id);
    const results: ConnectorFile[] = [];
    for (let i = 0; i < files.length; i++) {
      // Prefer the sparse partial; only fall back to the full record when
      // `changedFields` isn't available (legacy publish paths). Tracked on DEV-10084.
      const payload = changedFields?.[i] ?? files[i];
      switch (parsed.kind) {
        case 'object': {
          const recordId = extractRecordId(files[i]);
          const values = toWriteValues((payload as { values?: unknown }).values);
          if (Object.keys(values).length === 0) {
            results.push(files[i]);
            continue;
          }
          const updated = await this.client.updateRecord(parsed.objectSlug, recordId, values);
          results.push(updated as unknown as ConnectorFile);
          break;
        }
        case 'list': {
          const entryId = extractEntryId(files[i]);
          const entryValues = toWriteValues((payload as { entry_values?: unknown }).entry_values);
          if (Object.keys(entryValues).length === 0) {
            results.push(files[i]);
            continue;
          }
          const updated = await this.client.updateListEntry(parsed.listSlug, entryId, entryValues);
          results.push(updated as unknown as ConnectorFile);
          break;
        }
        case 'members':
          throw new AttioError('Workspace members are read-only — update is not supported.');
        case 'tasks': {
          const taskId = extractTaskId(files[i]);
          // Content is immutable on update (write-once, DEV-10408) — only the
          // mutable fields present in the (sparse) payload are sent. If only
          // content changed, the update is empty → no-op.
          const fields = readTaskUpdateFields(payload);
          if (Object.keys(fields).length === 0) {
            results.push(files[i]);
            continue;
          }
          const updated = await this.client.updateTask(taskId, fields);
          results.push(updated as unknown as ConnectorFile);
          break;
        }
        default:
          return assertUnreachable(parsed);
      }
    }
    return results;
  }

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const parsed = parseAttioTableId(tableSpec.id);
    for (const file of files) {
      switch (parsed.kind) {
        case 'object':
          await this.client.deleteRecord(parsed.objectSlug, extractRecordId(file));
          break;
        case 'list':
          await this.client.deleteListEntry(parsed.listSlug, extractEntryId(file));
          break;
        case 'members':
          throw new AttioError('Workspace members are read-only — delete is not supported.');
        case 'tasks':
          await this.client.deleteTask(extractTaskId(file));
          break;
        default:
          return assertUnreachable(parsed);
      }
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const parsed = parseAttioTableId(tableSpec.id);
    return records.map((record) => {
      switch (parsed.kind) {
        case 'object':
          return suggestNameFromValues((record as unknown as AttioRecord).values);
        case 'list':
          // List entries don't carry their own name — fall back to the parent
          // record id so the filename is at least stable and unique. The user
          // can rename, and the parent record file (in companies/people/deals)
          // already has a meaningful name.
          return (record as unknown as AttioListEntry).parent_record_id;
        case 'members': {
          const member = record as unknown as AttioWorkspaceMember;
          const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ').trim();
          return fullName || member.email_address;
        }
        case 'tasks': {
          const task = record as unknown as AttioTask;
          const content = task.content_plaintext?.trim();
          return content && content.length > 0 ? content.slice(0, 80) : task.id.task_id;
        }
        default:
          return assertUnreachable(parsed);
      }
    });
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof AttioError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: { status: error.statusCode },
      };
    }

    if (isAxiosError(error)) {
      const common = extractCommonDetailsFromAxiosError(this, error);
      if (common) return common;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['message', 'error', 'errors']),
        description: error.message,
        additionalContext: { status: error.response?.status },
      };
    }

    return this.fallbackErrorDetails(error);
  }

  /**
   * Fallback when `fetchJsonTableSpec` is called for a list before
   * `listTables` populated the cache (e.g. after a server restart).
   */
  private async lookupListName(listSlug: string): Promise<string> {
    const lists = await this.client.listLists();
    const found = lists.find((list) => list.api_slug === listSlug);
    if (!found) throw new AttioError(`Attio list "${listSlug}" not found`, 404);
    this.listNameCache.set(listSlug, found.name);
    return found.name;
  }

  /**
   * Fallback when `fetchJsonTableSpec` is called for an object before
   * `listTables` populated the display cache (e.g. after a server restart).
   * Returns `undefined` if the slug isn't found — `buildAttioObjectTableSpec`
   * then falls back to the standard-object labels / the slug itself.
   */
  private async lookupObjectDisplay(objectSlug: string): Promise<{ singular: string; plural: string } | undefined> {
    const objects = await this.client.listObjects();
    const found = objects.find((obj) => obj.api_slug === objectSlug);
    if (!found) return undefined;
    const display = { singular: found.singular_noun, plural: found.plural_noun };
    this.objectDisplayCache.set(objectSlug, display);
    return display;
  }
}

/**
 * Parse an EntityId into one of the table kinds the connector exposes. A list
 * id is `['list', <slug>]`; **any other head is an object api_slug** (standard
 * or custom — they share the `/v2/objects/{slug}` endpoint family). `'list'` is
 * the one reserved head; an object whose api_slug is literally `list` isn't a
 * thing Attio allows.
 */
export function parseAttioTableId(id: EntityId): AttioTableKind {
  const head = id.remoteId[0];
  if (head === 'list') {
    const slug = id.remoteId[1];
    if (!slug) throw new AttioError(`Invalid Attio list id: missing list slug in remoteId`);
    return { kind: 'list', listSlug: slug };
  }
  if (head === ATTIO_MEMBERS_TABLE_REMOTE_ID[0]) return { kind: 'members' };
  if (head === 'tasks') return { kind: 'tasks' };
  if (!head) throw new AttioError('Invalid Attio table id: empty remoteId');
  return { kind: 'object', objectSlug: head };
}

/** Extract the `record_id` from a record file's `id` triple. */
function extractRecordId(file: ConnectorFile): string {
  const id = (file as { id?: unknown }).id;
  if (
    id &&
    typeof id === 'object' &&
    'record_id' in id &&
    typeof (id as { record_id: unknown }).record_id === 'string'
  ) {
    return (id as { record_id: string }).record_id;
  }
  throw new AttioError('Record file is missing `id.record_id` — cannot route the write.');
}

/** Extract the `entry_id` from a list-entry file's `id` triple. */
function extractEntryId(file: ConnectorFile): string {
  const id = (file as { id?: unknown }).id;
  if (id && typeof id === 'object' && 'entry_id' in id && typeof (id as { entry_id: unknown }).entry_id === 'string') {
    return (id as { entry_id: string }).entry_id;
  }
  throw new AttioError('List-entry file is missing `id.entry_id` — cannot route the write.');
}

/** Extract the `task_id` from a task file's `id`. */
function extractTaskId(file: ConnectorFile): string {
  const id = (file as { id?: unknown }).id;
  if (id && typeof id === 'object' && 'task_id' in id && typeof (id as { task_id: unknown }).task_id === 'string') {
    return (id as { task_id: string }).task_id;
  }
  throw new AttioError('Task file is missing `id.task_id` — cannot route the write.');
}

/** Read an array field off a file, or `[]` if missing/wrong-typed. */
function readArray<T>(file: Record<string, unknown>, key: string): T[] {
  const value = file[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Translate a task record file into the full **create** payload. Read shape
 * (`content_plaintext`) → write shape (`content` + `format`); Attio requires
 * every field, so missing ones default (no deadline → `null`, etc.).
 */
function readTaskWriteFields(file: ConnectorFile): {
  content: string;
  deadlineAt: string | null;
  isCompleted: boolean;
  linkedRecords: AttioTaskLinkedRecord[];
  assignees: AttioTaskAssignee[];
} {
  const f = file as Record<string, unknown>;
  return {
    content: readString(file, 'content_plaintext') ?? '',
    deadlineAt: typeof f.deadline_at === 'string' ? f.deadline_at : null,
    isCompleted: f.is_completed === true,
    linkedRecords: readArray<AttioTaskLinkedRecord>(f, 'linked_records'),
    assignees: readArray<AttioTaskAssignee>(f, 'assignees'),
  };
}

/**
 * Build the sparse **update** payload from a (changed-fields) task payload —
 * only the mutable keys present are included. `content_plaintext` is
 * deliberately never mapped (immutable on update; see DEV-10408).
 */
function readTaskUpdateFields(payload: Record<string, unknown>): {
  isCompleted?: boolean;
  deadlineAt?: string | null;
  linkedRecords?: AttioTaskLinkedRecord[];
  assignees?: AttioTaskAssignee[];
} {
  const fields: {
    isCompleted?: boolean;
    deadlineAt?: string | null;
    linkedRecords?: AttioTaskLinkedRecord[];
    assignees?: AttioTaskAssignee[];
  } = {};
  if ('is_completed' in payload) fields.isCompleted = payload.is_completed === true;
  if ('deadline_at' in payload) {
    fields.deadlineAt = typeof payload.deadline_at === 'string' ? payload.deadline_at : null;
  }
  if ('linked_records' in payload) fields.linkedRecords = readArray<AttioTaskLinkedRecord>(payload, 'linked_records');
  if ('assignees' in payload) fields.assignees = readArray<AttioTaskAssignee>(payload, 'assignees');
  return fields;
}

/** Read a top-level string field from a file, or return `undefined` if missing/wrong-typed. */
function readString(file: ConnectorFile, key: string): string | undefined {
  const value = (file as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Pull a human-friendly name out of the `values` map. */
function suggestNameFromValues(values: Record<string, unknown[]> | undefined): string | undefined {
  if (!values) return undefined;
  const nameValues = values.name;
  if (!Array.isArray(nameValues) || nameValues.length === 0) return undefined;
  const first = nameValues[0] as Record<string, unknown> | undefined;
  if (!first) return undefined;

  // `personal-name` attributes carry a `full_name` field; everything else
  // tends to use `value`.
  const fullName = first.full_name;
  if (typeof fullName === 'string' && fullName.trim().length > 0) return fullName.trim();

  const value = first.value;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();

  return undefined;
}

connectorRegistry.register({
  service: Service.ATTIO,
  metadata: AttioConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  // Attio's published rate limit is 100 req/s per workspace token. Leave
  // headroom for concurrent connector instances on the same key.
  rateLimiterSpec: { points: 50, duration: 1 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    const apiKey = ctx.decryptedCredentials?.apiKey;
    if (!apiKey) {
      throw new ConnectorInstantiationError('Access token is required for Attio', Service.ATTIO);
    }
    const rateLimiter = ctx.connectorAccount ? ctx.createRateLimiter(ctx.connectorAccount.id) : undefined;
    return new AttioConnector(apiKey, { rateLimiter });
  },
});
