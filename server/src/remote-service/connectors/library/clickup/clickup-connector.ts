import { connectorMetadata } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
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
  readRecordIdAsString,
  TablePreview,
} from '../../types';
import { ClickUpApiClient, ClickUpError } from './clickup-api-client';
import {
  buildClickUpDocsTableSpec,
  buildClickUpJsonTableSpec,
  buildClickUpUsersTableSpec,
} from './clickup-json-schema';
import {
  CLICKUP_DOCS_TABLE_NAME,
  CLICKUP_PRIORITY_NAME_TO_INT,
  CLICKUP_READONLY_CUSTOM_FIELD_TYPES,
  CLICKUP_USERS_TABLE_NAME,
  ClickUpCredentials,
  ClickUpDownloadProgress,
  ClickUpList,
  ClickUpTableKind,
} from './clickup-types';

const LOG_SOURCE = 'ClickUpConnector';

/** Batch size for re-pulling specific tasks by id. */
const PULL_BY_IDS_BATCH_SIZE = 20;

/** A custom-field write extracted from a record: which field id and the value to set. */
interface ClickUpCustomFieldWrite {
  fieldId: string;
  value: unknown;
}

/**
 * Connector for ClickUp — a **multi-entity** connector. The entity kind is the
 * first segment of a table's `remoteId` (see {@link ClickUpTableKind}):
 * - **`list`** — a List's **Tasks** (the common dynamic table; full CRUD; schema =
 *   standard task fields + per-list **Custom Fields** from `GET /list/{id}/field`).
 * - **`users`** — the workspace's **Members** (read-only reference; from `GET /team`).
 * - **`doc`** — the workspace's **Docs** (read-only; the **v3** API — its own codepath).
 *
 * Records are stored verbatim and land at a hierarchical path:
 * `/{Workspace}/{Space}/{Folder}/{List}/{task}.json` for tasks, `/{Workspace}/Users/…`
 * and `/{Workspace}/Docs/…` for the others.
 *
 * Auth is a personal API token (`user_provided_params`), CLI-connectable. Task
 * writes cover the core editable fields + custom-field values; `assignees`/`tags`/
 * `parent` and the Users/Docs entities are read-only in v1 — see STATE.md.
 */
export class ClickUpConnector extends Connector<string, ClickUpDownloadProgress> {
  readonly service = Service.CLICKUP;
  static readonly displayName = 'ClickUp';
  static readonly metadata = connectorMetadata({
    displayName: 'ClickUp',
    table: 'list',
    tables: 'lists',
    record: 'task',
    records: 'tasks',
    logo: 'https://static.scratch.md/connector-icons/clickup.svg',
    // Hidden from the production connector picker until v1 is validated end-to-end;
    // still selectable in local dev (use-connectors.ts shows all connectors when NODE_ENV=development).
    visible: false,
    defaultAuthMethod: 'user_provided_params',
    setupGuide: { label: 'Where to find your API token', url: 'https://app.clickup.com/settings/apps' },
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'API Token',
          placeholder: 'pk_…  (Settings → Apps → API Token)',
          required: true,
        },
      ],
    },
  });

  private readonly client: ClickUpApiClient;

  constructor(credentials: ClickUpCredentials, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new ClickUpApiClient(credentials, opts);
  }

  async testConnection(): Promise<void> {
    await this.client.testConnection();
  }

  /**
   * Discover every table across all workspaces: the per-workspace **Users** and
   * **Docs** entities, plus each List (Tasks) walked from Space → (Folder →) List.
   * The entity kind + team id are encoded in `remoteId` so the other methods can
   * dispatch and build the `/{Workspace}/…` path.
   */
  async listTables(): Promise<TablePreview[]> {
    const tables: TablePreview[] = [];
    const teams = await this.client.listTeams();

    for (const team of teams) {
      // Per-workspace singleton entities (own codepaths).
      tables.push({
        id: { wsId: sanitizeForTableWsId(`users-${team.id}`), remoteId: ['users', team.id] },
        displayName: CLICKUP_USERS_TABLE_NAME,
        parentPath: team.name,
      });
      tables.push({
        id: { wsId: sanitizeForTableWsId(`docs-${team.id}`), remoteId: ['doc', team.id] },
        displayName: CLICKUP_DOCS_TABLE_NAME,
        parentPath: team.name,
      });

      const spaces = await this.client.listSpaces(team.id);
      for (const space of spaces) {
        // Lists inside folders.
        const folders = await this.client.listFolders(space.id);
        for (const folder of folders) {
          for (const list of folder.lists ?? []) {
            tables.push({
              id: { wsId: sanitizeForTableWsId(list.id), remoteId: ['list', team.id, list.id] },
              displayName: list.name,
              parentPath: `${team.name}/${space.name}/${folder.name}`,
            });
          }
        }
        // Lists directly under the space (folderless).
        const folderlessLists = await this.client.listFolderlessLists(space.id);
        for (const list of folderlessLists) {
          tables.push({
            id: { wsId: sanitizeForTableWsId(list.id), remoteId: ['list', team.id, list.id] },
            displayName: list.name,
            parentPath: `${team.name}/${space.name}`,
          });
        }
      }
    }

    return tables;
  }

  /** Build the schema for a table, dispatching on the entity kind. */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const parsed = parseClickUpTableId(id);

    if (parsed.kind === 'users') {
      return buildClickUpUsersTableSpec(id, await this.resolveWorkspaceName(parsed.teamId));
    }
    if (parsed.kind === 'doc') {
      return buildClickUpDocsTableSpec(id, await this.resolveWorkspaceName(parsed.teamId));
    }

    // list: static task fields + dynamically discovered custom fields.
    const listId = requireListId(parsed);
    const [workspaceName, list, customFieldDefinitions] = await Promise.all([
      this.resolveWorkspaceName(parsed.teamId),
      this.client.getList(listId),
      this.client.listCustomFields(listId),
    ]);
    const listName = list?.name ?? id.wsId;
    const basePath = [workspaceName, ...buildBasePathFromList(list)].filter(Boolean);
    return buildClickUpJsonTableSpec(id, listName, customFieldDefinitions, basePath);
  }

  /**
   * Stream all of a list's tasks via the page-based task endpoint. Checkpoints
   * the next page so a stalled job resumes mid-list. Full-scan only in v1.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: ClickUpDownloadProgress }) => Promise<void>,
    progress: ClickUpDownloadProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const parsed = parseClickUpTableId(tableSpec.id);

    // Users: the workspace's members come inline on `GET /team` (no pagination).
    if (parsed.kind === 'users') {
      const members = await this.fetchWorkspaceMembers(parsed.teamId);
      if (members.length > 0) await callback({ files: members });
      return {};
    }

    // Docs: the v3 docs endpoint (its own codepath, cursor-paginated internally).
    if (parsed.kind === 'doc') {
      const docs = (await this.client.listDocs(requireTeamId(parsed))) as ConnectorFile[];
      if (docs.length > 0) await callback({ files: docs });
      return {};
    }

    // list: page through the List's tasks.
    const listId = requireListId(parsed);
    let page = typeof progress?.nextPage === 'number' && progress.nextPage > 0 ? progress.nextPage : 0;
    for (;;) {
      const { tasks, lastPage } = await this.client.listTasksPage(listId, page);
      if (tasks.length > 0) {
        await callback({ files: tasks as ConnectorFile[], connectorProgress: { nextPage: page + 1 } });
      }
      if (lastPage) break;
      page++;
    }

    return {};
  }

  /** Re-fetch specific records by id (e.g. after a publish). Skips 404s. */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const parsed = parseClickUpTableId(tableSpec.id);

    // Users / Docs have no get-by-id — re-fetch the (small) full set and filter.
    if (parsed.kind === 'users' || parsed.kind === 'doc') {
      const wanted = new Set(ids);
      const all =
        parsed.kind === 'users'
          ? await this.fetchWorkspaceMembers(parsed.teamId)
          : ((await this.client.listDocs(requireTeamId(parsed))) as ConnectorFile[]);
      const matched = all.filter((record) => wanted.has(String(record.id)));
      if (matched.length > 0) await callback({ files: matched });
      return;
    }

    // list: ClickUp has a per-task get-by-id.
    const buffer: ConnectorFile[] = [];
    for (const id of ids) {
      const task = await this.client.getTask(id);
      if (task) {
        buffer.push(task as ConnectorFile);
      }
      if (buffer.length >= PULL_BY_IDS_BATCH_SIZE) {
        await callback({ files: buffer.splice(0) });
      }
    }
    if (buffer.length > 0) {
      await callback({ files: buffer });
    }
  }

  /** One request per record — ClickUp has no bulk task write. */
  getBatchSize(): number {
    return 1;
  }

  /** Create tasks; returns ClickUp's response (carries the assigned id). */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const parsed = parseClickUpTableId(tableSpec.id);
    if (parsed.kind !== 'list') {
      if (files.length > 0) throw new ClickUpError(`ClickUp ${parsed.kind} is read-only — cannot create records`);
      return [];
    }
    const listId = requireListId(parsed);
    const results: ConnectorFile[] = [];

    for (const file of files) {
      const body = buildTaskWritePayload(file);
      const customFieldWrites = extractCustomFieldWrites(file);
      if (customFieldWrites.length > 0) {
        // ClickUp accepts custom field values inline on create.
        body.custom_fields = customFieldWrites.map((write) => ({ id: write.fieldId, value: write.value }));
      }
      const created = await this.client.createTask(listId, body);
      results.push(created as ConnectorFile);
    }

    return results;
  }

  /**
   * Update tasks. Standard editable fields go through `PUT /task/{id}`; changed
   * custom-field values go through `POST /task/{id}/field/{field_id}` (the task
   * update endpoint can't set them). Prefers the sparse `changedFields` payload.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const parsed = parseClickUpTableId(tableSpec.id);
    if (parsed.kind !== 'list') {
      if (files.length > 0) throw new ClickUpError(`ClickUp ${parsed.kind} is read-only — cannot update records`);
      return [];
    }
    const results: ConnectorFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const taskId = readRecordIdAsString(file, tableSpec.idPath);
      if (!taskId) {
        WSLogger.warn({ source: LOG_SOURCE, message: 'Skipping update for task with no id' });
        results.push(file);
        continue;
      }

      const source = changedFields?.[i] ?? file;

      const standardPayload = buildTaskWritePayload(source);
      let updated: Record<string, unknown> | undefined;
      if (Object.keys(standardPayload).length > 0) {
        updated = await this.client.updateTask(taskId, standardPayload);
      }

      // Custom field values: set each one present in the changed payload.
      for (const write of extractCustomFieldWrites(source)) {
        await this.client.setCustomFieldValue(taskId, write.fieldId, write.value);
      }

      results.push((updated as ConnectorFile) ?? file);
    }

    return results;
  }

  /** Delete tasks by id. Already-deleted (404) is a no-op. */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const parsed = parseClickUpTableId(tableSpec.id);
    if (parsed.kind !== 'list') {
      if (files.length > 0) throw new ClickUpError(`ClickUp ${parsed.kind} is read-only — cannot delete records`);
      return;
    }
    for (const file of files) {
      const taskId = readRecordIdAsString(file, tableSpec.idPath);
      if (!taskId) continue;
      await this.client.deleteTask(taskId);
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePath = tableSpec.titlePath && !tableSpec.titlePath.includes('.') ? tableSpec.titlePath : undefined;
    return suggestFileNamesFromFieldPaths(records, titlePath, 'name');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof ClickUpError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: { status: error.statusCode, responseData: error.responseData },
      };
    }

    if (isAxiosError(error)) {
      const common = extractCommonDetailsFromAxiosError(this, error);
      if (common) return common;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['err', 'error', 'message']),
        description: error.message,
        additionalContext: { status: error.response?.status },
      };
    }

    return this.fallbackErrorDetails(error);
  }

  // --- Private helpers ---

  /** Resolve a workspace's display name (the top path segment) from its team id. */
  private async resolveWorkspaceName(teamId: string | undefined): Promise<string> {
    if (!teamId) return '';
    const teams = await this.client.listTeams();
    return teams.find((team) => team.id === teamId)?.name ?? '';
  }

  /** Read a workspace's members (the Users entity) from `GET /team`, as record files. */
  private async fetchWorkspaceMembers(teamId: string | undefined): Promise<ConnectorFile[]> {
    if (!teamId) return [];
    const teams = await this.client.listTeams();
    const team = teams.find((t) => t.id === teamId);
    return (team?.members ?? []).map((member) => member.user as ConnectorFile);
  }
}

// --- Table-id parsing (multi-entity dispatch) ---

interface ClickUpParsedTableId {
  kind: ClickUpTableKind;
  teamId?: string;
  listId?: string;
}

/**
 * Parse a table's `remoteId` into its entity kind + ids. New format:
 * `['list', teamId, listId]` / `['users', teamId]` / `['doc', teamId]`. Falls
 * back to legacy single-element `[listId]` (treated as a list) so folders linked
 * before the multi-entity refactor still resolve.
 */
function parseClickUpTableId(id: EntityId): ClickUpParsedTableId {
  const [first, second, third] = id.remoteId;
  if (first === 'list') return { kind: 'list', teamId: second, listId: third };
  if (first === 'users') return { kind: 'users', teamId: second };
  if (first === 'doc') return { kind: 'doc', teamId: second };
  if (first) return { kind: 'list', listId: first }; // legacy [listId]
  throw new ClickUpError(`Invalid ClickUp table id: ${JSON.stringify(id.remoteId)}`);
}

function requireListId(parsed: ClickUpParsedTableId): string {
  if (!parsed.listId) throw new ClickUpError('ClickUp list table is missing its list id');
  return parsed.listId;
}

function requireTeamId(parsed: ClickUpParsedTableId): string {
  if (!parsed.teamId) throw new ClickUpError('ClickUp table is missing its workspace (team) id');
  return parsed.teamId;
}

// --- Path construction ---

/**
 * Build the Scratch folder path prefix from a list's place in the ClickUp
 * hierarchy, so records land at `/{Space}/{Folder}/{List}/{task}.json` (mirroring
 * Airtable's `/{base}/{table}` and Postgres' `/{schema}/{table}`). Folderless
 * lists sit in a ClickUp-internal `hidden` folder, which is excluded — they land
 * at `/{Space}/{List}/{task}.json`.
 */
function buildBasePathFromList(list: ClickUpList | null): string[] {
  if (!list) return [];
  const basePath: string[] = [];
  if (list.space?.name) basePath.push(list.space.name);
  if (list.folder && !list.folder.hidden && list.folder.name) basePath.push(list.folder.name);
  return basePath;
}

// --- Write-shape translation (read shape on disk → ClickUp write shape) ---

/**
 * Build the `PUT/POST` task body from a record source (the full file on create,
 * or the sparse `changedFields` on update). Only the editable standard fields
 * are included, and only when present in `source` — so a sparse update stays
 * partial. Read-shape objects (`status`, `priority`) and date strings are
 * translated to ClickUp's write shape (name / int / number).
 */
function buildTaskWritePayload(source: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if ('name' in source) payload.name = source.name;
  if ('description' in source) payload.description = source.description ?? '';
  if ('status' in source) {
    const statusName = extractStatusName(source.status);
    if (statusName !== undefined) payload.status = statusName;
  }
  if ('priority' in source) payload.priority = extractPriorityInt(source.priority);
  if ('due_date' in source) payload.due_date = toEpochMs(source.due_date);
  if ('start_date' in source) payload.start_date = toEpochMs(source.start_date);
  // `points` and `time_estimate` are gated on ClickApps (Sprint Points / Time Estimates).
  // Sending them to a list where the ClickApp is disabled 400s the WHOLE write
  // (ECODE ITEM_227), so only send a real (non-null) value the user actually set —
  // never an empty value from a verbatim pull. A genuine value on a disabled list
  // still surfaces the API error rather than being silently dropped.
  if ('points' in source && source.points != null) payload.points = source.points;
  if ('time_estimate' in source && source.time_estimate != null) payload.time_estimate = source.time_estimate;

  return payload;
}

/** Read shape `status` is an object (`{ status: "to do", ... }`); write shape is the name string. */
function extractStatusName(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'status' in value) {
    const name = (value as { status?: unknown }).status;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

/** Read shape `priority` is an object (`{ priority: "high", id: "2" }`); write shape is an int 1–4. */
function extractPriorityInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
  }
  if (typeof value === 'object') {
    const obj = value as { priority?: unknown; id?: unknown };
    if (typeof obj.priority === 'string') {
      const mapped = CLICKUP_PRIORITY_NAME_TO_INT[obj.priority.toLowerCase()];
      if (mapped !== undefined) return mapped;
    }
    if (typeof obj.id === 'string') {
      const parsed = parseInt(obj.id, 10);
      if (!isNaN(parsed)) return parsed;
    }
    if (typeof obj.id === 'number') return obj.id;
  }
  return null;
}

/** ClickUp dates are epoch-ms; stored as strings on read, written as numbers. */
function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Extract writable custom-field values from a record source. Each verbatim
 * `custom_fields` entry is `{ id, name, type, value }`; we set the `value` for
 * every entry that has an id and a non-computed type. (When `source` is a sparse
 * `changedFields`, ClickUp arrays aren't deep-diffed, so the full new array is
 * present whenever any custom field changed — setting each value is idempotent.)
 */
function extractCustomFieldWrites(source: Record<string, unknown>): ClickUpCustomFieldWrite[] {
  const raw = source.custom_fields;
  if (!Array.isArray(raw)) return [];

  const writes: ClickUpCustomFieldWrite[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, type, value } = entry as { id?: unknown; type?: unknown; value?: unknown };
    if (typeof id !== 'string') continue;
    if (typeof type === 'string' && CLICKUP_READONLY_CUSTOM_FIELD_TYPES.has(type)) continue;
    if (value === undefined) continue;
    writes.push({ fieldId: id, value });
  }
  return writes;
}

connectorRegistry.register({
  service: Service.CLICKUP,
  metadata: ClickUpConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  // ClickUp free plan allows 100 requests/min per token; stay just under it.
  rateLimiterSpec: { points: 90, duration: 60 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    const apiKey = ctx.decryptedCredentials?.apiKey;
    if (!apiKey) {
      throw new ConnectorInstantiationError('API token is required for ClickUp', Service.CLICKUP);
    }
    const rateLimiter = ctx.connectorAccount ? ctx.createRateLimiter(ctx.connectorAccount.id) : undefined;
    return new ClickUpConnector({ apiKey }, { rateLimiter });
  },
});
