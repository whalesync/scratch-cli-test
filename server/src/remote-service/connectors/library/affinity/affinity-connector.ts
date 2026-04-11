import { connectorMetadata, ConnectorPullOptions } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { Connector } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
} from '../../error';
import { sanitizeForTableWsId } from '../../ids';
import { Service } from '../../service-constants';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import { AffinityApiClient, AffinityError } from './affinity-api-client';
import { buildAffinityJsonTableSpec } from './affinity-json-schema';
import { AffinityDownloadProgress, AffinityEntityType, AffinityList, AffinityListEntry } from './affinity-types';

const LOG_SOURCE = 'AffinityConnector';
const READ_ONLY_MESSAGE = 'The Affinity connector is read-only.';

/**
 * Read-only connector for the Affinity v2 API.
 *
 * Each Affinity list becomes a Scratch table; each list entry becomes a record
 * file. Field data (list-specific + enriched + global + relationship-intelligence)
 * is fetched inline via the v2 list-entries endpoint, avoiding the v1 N+1 problem
 * (~95x fewer API calls for a 10k-record sync — see internal docs/2026-04-10).
 *
 * Writes (`createRecords`, `updateRecords`, `deleteRecords`) intentionally throw —
 * publishing back to Affinity is out of scope for the first pass.
 *
 * TODO(attachments): Affinity v2 has no file/attachment endpoints — the entire
 * v2 surface area was checked (see git history of this file for the audit) and
 * there are zero `attach`/`file`/`asset`/`upload`/`media` paths, and no `file`
 * variant in the `FieldMetadata.valueType` enum. Attachments only exist in v1 via
 * the Entity Files resource (`GET /entity-files?{person|organization|opportunity|list_entry}_id={id}`,
 * `GET /entity-files/{id}`, `GET /entity-files/{id}/download`).
 *
 * **v1 endpoints accept the same Bearer token as v2** (verified empirically against
 * `/auth/whoami`, `/lists`, `/entity-files`, and `/rate-limit`). Affinity's own
 * docs still claim v1 uses HTTP Basic auth, but that's outdated — auth has been
 * unified. So a v1 fallback can reuse the existing axios instance from
 * `AffinityApiClient` directly; no second client / second auth scheme needed.
 *
 * Adding attachment support would mean:
 *   - New methods on `AffinityApiClient` hitting v1 paths via the same axios
 *     instance: `listEntityFiles({ person_id|organization_id|opportunity_id|list_entry_id })`
 *     and `getEntityFileDownloadUrl(fileId)`.
 *   - An `includeAttachments` advanced setting (default off) — the fetch is
 *     unavoidably N+1 in v1 since there's no bulk endpoint, and v1 shares the
 *     same 900 req/min user cap, so a 10k-record list takes ~11 minutes of
 *     wall-clock just for the attachment fan-out.
 *   - Embedding fetched files under `entity._attachments` (preserving raw shape).
 *   - `x-scratch-asset-field` annotation on `entity._attachments` plus an
 *     `extractAssets()` override so Scratch's asset-indexing system can download
 *     the binaries via `GET /entity-files/{id}/download`.
 *
 * Worth re-checking https://developer.affinity.co/changelog before building this,
 * since v2 may add native attachment endpoints and obviate the v1 fallback.
 */
export class AffinityConnector extends Connector<string, AffinityDownloadProgress> {
  readonly service = Service.AFFINITY;
  static readonly displayName = 'Affinity';
  static readonly metadata = connectorMetadata({
    displayName: 'Affinity',
    table: 'list',
    tables: 'lists',
    record: 'list entry',
    records: 'list entries',
    logo: 'https://static.scratch.md/connector-icons/affinity.svg',
    supportedAuthMethods: ['user_provided_params'],
    defaultAuthMethod: 'user_provided_params',
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'API Key',
          placeholder: 'Affinity v2 API key',
          description:
            'Generate an API key in Affinity at Settings → API. The key needs the v2 export permissions for the lists you want to sync.',
          required: true,
        },
      ],
    },
  });

  private readonly client: AffinityApiClient;
  private readonly listCache = new Map<number, AffinityList>();

  constructor(apiKey: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new AffinityApiClient(apiKey, opts);
  }

  async testConnection(): Promise<void> {
    await this.client.testConnection();
  }

  /**
   * List every Affinity list as a Scratch table, grouped in the picker by entity
   * type ("Company lists", "Person lists", "Opportunity lists").
   */
  async listTables(): Promise<TablePreview[]> {
    const lists = await this.client.listAllLists();
    return lists.map((list) => {
      this.listCache.set(list.id, list);
      return {
        id: { wsId: sanitizeForTableWsId(`list_${list.id}`), remoteId: [String(list.id)] },
        displayName: list.name,
        parentPath: `${capitalize(list.type)} lists`,
        metadata: {
          listId: list.id,
          listType: list.type,
          isPublic: list.isPublic,
        },
      };
    });
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const listId = parseListId(id);
    const list = await this.getOrFetchList(listId);
    return buildAffinityJsonTableSpec(id, list, this.client);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: AffinityDownloadProgress }) => Promise<void>,
    progress: AffinityDownloadProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConnectorPullOptions,
  ): Promise<void> {
    const listId = parseListId(tableSpec.id);
    const resumeCursor = progress?.cursor;

    for await (const batch of this.client.listListEntries(listId, resumeCursor)) {
      const files = batch.data.map((entry) => listEntryToFile(entry));
      await callback({
        files,
        connectorProgress: batch.nextCursor ? { cursor: batch.nextCursor } : {},
      });
    }
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const listId = parseListId(tableSpec.id);
    const BATCH_SIZE = 25;
    const buffer: ConnectorFile[] = [];

    for (const idStr of ids) {
      const entryId = parseInt(idStr, 10);
      if (isNaN(entryId)) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Invalid non-numeric list-entry id "${idStr}", skipping`,
        });
        continue;
      }
      const entry = await this.client.getListEntry(listId, entryId);
      if (entry) {
        buffer.push(listEntryToFile(entry));
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
    return 1;
  }

  // ---- Read-only: write paths throw with a clear message ----

  // eslint-disable-next-line @typescript-eslint/require-await
  async createRecords(): Promise<ConnectorFile[]> {
    throw new AffinityError(`${READ_ONLY_MESSAGE} Creating list entries is not supported.`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async updateRecords(): Promise<void> {
    throw new AffinityError(`${READ_ONLY_MESSAGE} Updating list entries is not supported.`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteRecords(): Promise<void> {
    throw new AffinityError(`${READ_ONLY_MESSAGE} Deleting list entries is not supported.`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getSuggestedRecordFileNames(records: ConnectorFile[], _tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return records.map((record) => suggestNameForEntry(record));
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof AffinityError) {
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

  // ---- Helpers ----

  /** Look up a list by id, fetching from the API if not cached from `listTables`. */
  private async getOrFetchList(listId: number): Promise<AffinityList> {
    const cached = this.listCache.get(listId);
    if (cached) return cached;

    const list = await this.client.getList(listId);
    if (!list) {
      throw new AffinityError(`Affinity list ${listId} not found`, 404);
    }
    this.listCache.set(list.id, list);
    return list;
  }
}

function parseListId(id: EntityId): number {
  const raw = id.remoteId[0];
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new AffinityError(`Invalid Affinity list id in remoteId: ${raw}`);
  }
  return parsed;
}

/**
 * Transform a raw API list entry into the file shape stored in git.
 *
 * The Affinity v2 API returns `entity.fields` as an *array* of `{id, name, type,
 * value, enrichmentSource}` objects. Re-keying it into an object by field id
 * gives two benefits:
 *   1. Stable ordering — git diffs only show real changes, not array reorderings.
 *   2. Each field is addressable by its remote id (`entity.fields.field-1234`),
 *      which is what the json schema describes and what column-level sync needs.
 *
 * The transformation is fully lossless: the inner Field object (including `id`)
 * is preserved verbatim under its key.
 */
function listEntryToFile(entry: AffinityListEntry): ConnectorFile {
  const entity = entry.entity;
  const rawFields = entity?.fields;
  if (Array.isArray(rawFields)) {
    const keyed: Record<string, unknown> = {};
    for (const field of rawFields as Array<{ id?: unknown }>) {
      if (field && typeof field.id === 'string') {
        keyed[field.id] = field;
      }
    }
    entity.fields = keyed;
  }
  return entry as unknown as ConnectorFile;
}

/** Pull a human-friendly name out of an entity for filename suggestions. */
function suggestNameForEntry(record: ConnectorFile): string | undefined {
  const entity = (record as { entity?: Record<string, unknown> }).entity;
  if (!entity) return undefined;

  const name = entity.name;
  if (typeof name === 'string' && name.trim().length > 0) {
    return name.trim();
  }

  const first = entity.firstName;
  const last = entity.lastName;
  const parts: string[] = [];
  if (typeof first === 'string' && first.length > 0) parts.push(first);
  if (typeof last === 'string' && last.length > 0) parts.push(last);
  if (parts.length > 0) return parts.join(' ');

  return undefined;
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

connectorRegistry.register({
  service: Service.AFFINITY,
  metadata: AffinityConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  // Affinity v2 caps at 900 req/min per user. 10 req/sec leaves headroom for
  // bursty pulls and concurrent connector instances on the same key.
  rateLimiterSpec: { points: 10, duration: 1 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    const apiKey = ctx.decryptedCredentials?.apiKey;
    if (!apiKey) {
      throw new ConnectorInstantiationError('API key is required for Affinity', Service.AFFINITY);
    }
    const rateLimiter = ctx.connectorAccount ? ctx.createRateLimiter(ctx.connectorAccount.id) : undefined;
    return new AffinityConnector(apiKey, { rateLimiter });
  },
});

// Re-export for tests / future call sites that need the entity-type union.
export type { AffinityEntityType };
