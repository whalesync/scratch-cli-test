import { connectorMetadata } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { assertUnreachable } from 'src/utils/asserts';
import { JsonSafeObject } from 'src/utils/objects';
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
import { AffinityApiClient, AffinityError } from './affinity-api-client';
import {
  buildAffinityCompaniesTableSpec,
  buildAffinityEntityFilesTableSpec,
  buildAffinityJsonTableSpec,
  buildAffinityNotesTableSpec,
  buildAffinityOpportunitiesTableSpec,
  buildAffinityPersonsTableSpec,
} from './affinity-json-schema';
import {
  AffinityCompany,
  AffinityDownloadProgress,
  AffinityEntityType,
  AffinityList,
  AffinityListEntry,
  AffinityPerson,
  AffinityTableKind,
} from './affinity-types';

// Each tenant-wide table uses a fixed string in `remoteId[0]` to distinguish
// it from user-created lists, which use the numeric Affinity list id. These
// strings can never collide with list ids because `parseInt('persons', 10)`
// returns NaN — see `parseAffinityTableId` below.
const TENANT_PERSONS_ID = 'persons';
const TENANT_COMPANIES_ID = 'companies';
const TENANT_OPPORTUNITIES_ID = 'opportunities';
const TENANT_NOTES_ID = 'notes';
const TENANT_ENTITY_FILES_ID = 'entity-files';

const LOG_SOURCE = 'AffinityConnector';
const READ_ONLY_MESSAGE = 'The Affinity connector is read-only.';

/**
 * Read-only connector for the Affinity v2 API.
 *
 * Exposes the following kinds of tables:
 *   - **Tenant-wide People** (`GET /v2/persons`) — every person in the workspace,
 *     regardless of list membership. Flat record shape (no `entity` wrapper).
 *   - **Tenant-wide Companies** (`GET /v2/companies`) — same idea, for companies.
 *   - **Tenant-wide Opportunities** (`GET /v2/opportunities`) — fixed three-column
 *     schema (`id` / `name` / `listId`), no field data (Affinity v2 doesn't expose
 *     it for this endpoint and there's no `/v2/opportunities/fields` either).
 *   - **Tenant-wide Notes** (`GET /v2/notes` with `includes`) — every note in
 *     the workspace, with company/person/opportunity previews included inline.
 *   - **Entity Files** (`GET /entity-files`, v1 API) — file attachments uploaded
 *     to persons, organizations, or opportunities. Uses the v1 token-based
 *     pagination via the same Bearer token as v2 endpoints.
 *   - **User-created lists** (`GET /v2/lists/{id}/list-entries`) — each list
 *     becomes its own table, grouped under "Lists/" in the picker, with the
 *     full list-specific + enriched + global + relationship-intelligence field
 *     data fetched inline (~95x fewer calls than the v1 N+1 fan-out).
 *
 * Tables are dispatched via `parseAffinityTableId`, which checks the
 * sentinel strings before falling through to numeric list-id parsing. See
 * CONNECTOR_GUIDE.md → "Fixed vs. user-defined tables" for the broader pattern.
 *
 * Writes (`createRecords`, `updateRecords`, `deleteRecords`) intentionally throw —
 * publishing back to Affinity is out of scope for the first pass.
 *
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
          description: 'Generate an API key in Affinity at Settings → Manage Apps → New App.',
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
   * Returns the raw `GET /rate-limit` response from Affinity, which includes
   * both the per-minute user bucket and the monthly org bucket. Surfaced in
   * the client's "View API Quota" dialog so users can keep an eye on their
   * monthly cap (Affinity org plans have notably tight monthly quotas).
   */
  async getApiQuota(): Promise<{ quota: JsonSafeObject }> {
    const quota = await this.client.getQuota();
    return { quota: quota as unknown as JsonSafeObject };
  }

  /**
   * Build the picker tree:
   *
   *   Companies/         ← tenant-wide GET /v2/companies
   *   People/            ← tenant-wide GET /v2/persons
   *   Opportunities/     ← tenant-wide GET /v2/opportunities
   *   Lists/
   *     <list name>/     ← every user-created list, flat (names are
   *                        globally unique within a tenant — confirmed
   *                        empirically against Affinity)
   *
   * The three tenant tables are top-level (no `parentPath`); all user-created
   * lists are grouped under a single `Lists/` folder regardless of entity type.
   */
  async listTables(): Promise<TablePreview[]> {
    const tenantTables: TablePreview[] = [
      {
        id: { wsId: TENANT_COMPANIES_ID, remoteId: [TENANT_COMPANIES_ID] },
        displayName: 'Companies',
        metadata: { tableKind: 'tenant-companies' },
      },
      {
        id: { wsId: TENANT_PERSONS_ID, remoteId: [TENANT_PERSONS_ID] },
        displayName: 'People',
        metadata: { tableKind: 'tenant-persons' },
      },
      {
        id: { wsId: TENANT_OPPORTUNITIES_ID, remoteId: [TENANT_OPPORTUNITIES_ID] },
        displayName: 'Opportunities',
        metadata: { tableKind: 'tenant-opportunities' },
      },
      {
        id: { wsId: TENANT_NOTES_ID, remoteId: [TENANT_NOTES_ID] },
        displayName: 'Notes',
        metadata: { tableKind: 'tenant-notes' },
      },
      {
        id: { wsId: TENANT_ENTITY_FILES_ID, remoteId: [TENANT_ENTITY_FILES_ID] },
        displayName: 'Entity Files',
        metadata: { tableKind: 'tenant-entity-files' },
      },
    ];

    const lists = await this.client.listAllLists();
    const listTables: TablePreview[] = lists.map((list) => {
      this.listCache.set(list.id, list);
      return {
        id: { wsId: sanitizeForTableWsId(`list_${list.id}`), remoteId: [String(list.id)] },
        displayName: list.name,
        parentPath: 'Lists',
        metadata: {
          listId: list.id,
          listType: list.type,
          isPublic: list.isPublic,
        },
      };
    });

    return [...tenantTables, ...listTables];
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const parsed = parseAffinityTableId(id);
    switch (parsed.kind) {
      case 'list': {
        const list = await this.getOrFetchList(parsed.listId);
        return buildAffinityJsonTableSpec(id, list, this.client);
      }
      case 'tenant-persons':
        return buildAffinityPersonsTableSpec(id, this.client);
      case 'tenant-companies':
        return buildAffinityCompaniesTableSpec(id, this.client);
      case 'tenant-opportunities':
        return buildAffinityOpportunitiesTableSpec(id);
      case 'tenant-notes':
        return buildAffinityNotesTableSpec(id);
      case 'tenant-entity-files':
        return buildAffinityEntityFilesTableSpec(id);
      default:
        return assertUnreachable(parsed);
    }
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: AffinityDownloadProgress }) => Promise<void>,
    progress: AffinityDownloadProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const parsed = parseAffinityTableId(tableSpec.id);
    const resumeCursor = progress?.cursor;

    switch (parsed.kind) {
      case 'list': {
        for await (const batch of this.client.listListEntries(parsed.listId, resumeCursor)) {
          const files = batch.data.map((entry) => listEntryToFile(entry));
          await callback({
            files,
            connectorProgress: batch.nextCursor ? { cursor: batch.nextCursor } : {},
          });
        }
        return {};
      }
      case 'tenant-persons': {
        for await (const batch of this.client.listAllPersons(resumeCursor)) {
          const files = batch.data.map((p) => tenantRecordToFile(p));
          await callback({
            files,
            connectorProgress: batch.nextCursor ? { cursor: batch.nextCursor } : {},
          });
        }
        return {};
      }
      case 'tenant-companies': {
        for await (const batch of this.client.listAllCompanies(resumeCursor)) {
          const files = batch.data.map((c) => tenantRecordToFile(c));
          await callback({
            files,
            connectorProgress: batch.nextCursor ? { cursor: batch.nextCursor } : {},
          });
        }
        return {};
      }
      case 'tenant-opportunities': {
        for await (const batch of this.client.listAllOpportunities(resumeCursor)) {
          // Opportunities have no field data — pass through verbatim, no
          // array→keyed-object transform needed.
          const files = batch.data as unknown as ConnectorFile[];
          await callback({
            files,
            connectorProgress: batch.nextCursor ? { cursor: batch.nextCursor } : {},
          });
        }
        return {};
      }
      case 'tenant-notes': {
        for await (const batch of this.client.listAllNotes(resumeCursor)) {
          const files = batch.data as unknown as ConnectorFile[];
          await callback({
            files,
            connectorProgress: batch.nextCursor ? { cursor: batch.nextCursor } : {},
          });
        }
        return {};
      }
      case 'tenant-entity-files': {
        for await (const batch of this.client.listAllEntityFiles(resumeCursor)) {
          const files = batch.data as unknown as ConnectorFile[];
          await callback({
            files,
            connectorProgress: batch.nextCursor ? { cursor: batch.nextCursor } : {},
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
    const parsed = parseAffinityTableId(tableSpec.id);
    const BATCH_SIZE = 25;
    const buffer: ConnectorFile[] = [];

    const flushIfFull = async () => {
      if (buffer.length >= BATCH_SIZE) {
        await callback({ files: buffer.splice(0) });
      }
    };

    for (const idStr of ids) {
      const recordId = parseInt(idStr, 10);
      if (isNaN(recordId)) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Invalid non-numeric Affinity record id "${idStr}", skipping`,
        });
        continue;
      }

      switch (parsed.kind) {
        case 'list': {
          const entry = await this.client.getListEntry(parsed.listId, recordId);
          if (entry) buffer.push(listEntryToFile(entry));
          break;
        }
        case 'tenant-persons': {
          const person = await this.client.getPerson(recordId);
          if (person) buffer.push(tenantRecordToFile(person));
          break;
        }
        case 'tenant-companies': {
          const company = await this.client.getCompany(recordId);
          if (company) buffer.push(tenantRecordToFile(company));
          break;
        }
        case 'tenant-opportunities': {
          const opp = await this.client.getOpportunity(recordId);
          if (opp) buffer.push(opp as unknown as ConnectorFile);
          break;
        }
        case 'tenant-notes': {
          const note = await this.client.getNote(recordId);
          if (note) buffer.push(note as unknown as ConnectorFile);
          break;
        }
        case 'tenant-entity-files': {
          const file = await this.client.getEntityFile(recordId);
          if (file) buffer.push(file as unknown as ConnectorFile);
          break;
        }
        default:
          return assertUnreachable(parsed);
      }

      await flushIfFull();
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

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const parsed = parseAffinityTableId(tableSpec.id);
    switch (parsed.kind) {
      case 'list':
        // List entries wrap the entity under `record.entity`.
        return records.map((record) => suggestNameForListEntry(record));
      case 'tenant-persons':
      case 'tenant-companies':
      case 'tenant-opportunities':
      case 'tenant-notes':
      case 'tenant-entity-files':
        // Tenant records are flat — name fields live at the top level.
        return records.map((record) => suggestNameForTenantRecord(record));
      default:
        return assertUnreachable(parsed);
    }
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

/**
 * Parse an EntityId into one of the six kinds of tables this connector exposes.
 * The five tenant-table sentinels are checked first; anything else falls through
 * to numeric list-id parsing.
 */
export function parseAffinityTableId(id: EntityId): AffinityTableKind {
  const raw = id.remoteId[0];
  switch (raw) {
    case TENANT_PERSONS_ID:
      return { kind: 'tenant-persons' };
    case TENANT_COMPANIES_ID:
      return { kind: 'tenant-companies' };
    case TENANT_OPPORTUNITIES_ID:
      return { kind: 'tenant-opportunities' };
    case TENANT_NOTES_ID:
      return { kind: 'tenant-notes' };
    case TENANT_ENTITY_FILES_ID:
      return { kind: 'tenant-entity-files' };
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new AffinityError(`Invalid Affinity table id in remoteId: ${raw}`);
  }
  return { kind: 'list', listId: parsed };
}

/**
 * Replace a `fields` *array* on an object with an object keyed by each field's
 * `id`, in place. Affinity v2 returns fields as `[{id, name, type, value,
 * enrichmentSource}]`; we re-key for two reasons:
 *
 *   1. Stable ordering — git diffs only show real changes, not array reorderings.
 *   2. Each field is addressable by its remote id (e.g. `fields.field-1234`),
 *      which is what the JSON schema describes and what column-level sync needs.
 *
 * The transformation is fully lossless — the inner Field object (including its
 * `id`) is preserved verbatim under its key.
 */
function rekeyFieldsArrayInPlace(target: { fields?: unknown }): void {
  const rawFields = target.fields;
  if (!Array.isArray(rawFields)) return;
  const keyed: Record<string, unknown> = {};
  for (const field of rawFields as Array<{ id?: unknown }>) {
    if (field && typeof field.id === 'string') {
      keyed[field.id] = field;
    }
  }
  target.fields = keyed;
}

/**
 * Transform a list entry into the file shape stored in git. The fields array
 * lives under `entry.entity.fields` (list entries wrap the entity).
 */
function listEntryToFile(entry: AffinityListEntry): ConnectorFile {
  if (entry.entity) {
    rekeyFieldsArrayInPlace(entry.entity as { fields?: unknown });
  }
  return entry as unknown as ConnectorFile;
}

/**
 * Transform a tenant-wide person/company record into the file shape stored in
 * git. The fields array lives at the top level (no `entity` wrapper). Used for
 * persons and companies; opportunities have no fields and pass through verbatim.
 */
function tenantRecordToFile(record: AffinityPerson | AffinityCompany): ConnectorFile {
  rekeyFieldsArrayInPlace(record as { fields?: unknown });
  return record as unknown as ConnectorFile;
}

/** Filename suggestion for a list entry — looks at `record.entity.{name|firstName|lastName}`. */
function suggestNameForListEntry(record: ConnectorFile): string | undefined {
  const entity = (record as { entity?: Record<string, unknown> }).entity;
  return entity ? suggestNameForEntityShape(entity) : undefined;
}

/** Filename suggestion for a tenant record — fields live at the top level. */
function suggestNameForTenantRecord(record: ConnectorFile): string | undefined {
  return suggestNameForEntityShape(record as unknown as Record<string, unknown>);
}

/** Pull a human-friendly name out of any object that has Affinity-style name fields. */
function suggestNameForEntityShape(entity: Record<string, unknown>): string | undefined {
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
