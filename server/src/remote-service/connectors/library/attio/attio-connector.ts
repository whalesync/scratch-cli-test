import { connectorMetadata } from '@spinner/shared-types';
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
import { buildAttioListTableSpec, buildAttioObjectTableSpec } from './attio-json-schema';
import {
  AttioDownloadProgress,
  AttioListEntry,
  AttioRecord,
  AttioStandardObject,
  AttioTableKind,
  STANDARD_OBJECT_DISPLAY,
  STANDARD_OBJECTS,
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
          placeholder: 'Attio API access token',
          description: 'Generate an access token in Attio at Settings → Developers → Create access token.',
          required: true,
        },
      ],
    },
  });

  private readonly client: AttioApiClient;
  /** Cache of (list api_slug → list name), populated by `listTables`. */
  private readonly listNameCache = new Map<string, string>();

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
    const objectTables: TablePreview[] = STANDARD_OBJECTS.map((slug) => ({
      id: { wsId: slug, remoteId: [slug] },
      displayName: STANDARD_OBJECT_DISPLAY[slug].plural,
      metadata: { tableKind: 'object', objectSlug: slug },
    }));

    const lists = await this.client.listLists();
    const listTables: TablePreview[] = lists
      // v1 only handles lists whose parent object is one we already expose.
      // Lists on custom objects fall out of v1 alongside custom objects.
      .filter((list) => {
        const parent = list.parent_object[0];
        return parent !== undefined && (STANDARD_OBJECTS as readonly string[]).includes(parent);
      })
      .map((list) => {
        this.listNameCache.set(list.api_slug, list.name);
        return {
          id: { wsId: sanitizeForTableWsId(`list_${list.api_slug}`), remoteId: ['list', list.api_slug] },
          displayName: list.name,
          parentPath: 'Lists',
          metadata: { tableKind: 'list', listSlug: list.api_slug, parentObjectSlug: list.parent_object[0] },
        };
      });

    return [...objectTables, ...listTables];
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const parsed = parseAttioTableId(id);
    switch (parsed.kind) {
      case 'object':
        return buildAttioObjectTableSpec(id, parsed.objectSlug, this.client);
      case 'list': {
        const name = this.listNameCache.get(parsed.listSlug) ?? (await this.lookupListName(parsed.listSlug));
        return buildAttioListTableSpec(id, parsed.listSlug, name, this.client);
      }
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
    for (let i = 0; i < files.length; i++) {
      // Prefer the sparse partial; only fall back to the full record when
      // `changedFields` isn't available (legacy publish paths). Tracked on DEV-10084.
      const payload = changedFields?.[i] ?? files[i];
      switch (parsed.kind) {
        case 'object': {
          const recordId = extractRecordId(files[i]);
          const values = toWriteValues((payload as { values?: unknown }).values);
          if (Object.keys(values).length === 0) continue; // nothing changed under `values`
          await this.client.updateRecord(parsed.objectSlug, recordId, values);
          break;
        }
        case 'list': {
          const entryId = extractEntryId(files[i]);
          const entryValues = toWriteValues((payload as { entry_values?: unknown }).entry_values);
          if (Object.keys(entryValues).length === 0) continue;
          await this.client.updateListEntry(parsed.listSlug, entryId, entryValues);
          break;
        }
        default:
          return assertUnreachable(parsed);
      }
    }
    return files;
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
}

/**
 * Parse an EntityId into one of the table kinds the connector exposes.
 * Standard-object slugs ('companies', 'people', 'deals') are checked first;
 * anything else with `'list'` as `remoteId[0]` is treated as a list.
 */
export function parseAttioTableId(id: EntityId): AttioTableKind {
  const head = id.remoteId[0];
  if ((STANDARD_OBJECTS as readonly string[]).includes(head)) {
    return { kind: 'object', objectSlug: head as AttioStandardObject };
  }
  if (head === 'list') {
    const slug = id.remoteId[1];
    if (!slug) throw new AttioError(`Invalid Attio list id: missing list slug in remoteId`);
    return { kind: 'list', listSlug: slug };
  }
  throw new AttioError(`Unknown Attio table id: ${head}`);
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
