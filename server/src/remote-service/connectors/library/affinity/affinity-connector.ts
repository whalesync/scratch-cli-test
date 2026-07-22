import { connectorMetadata, TableView } from '@spinner/shared-types';
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
import { buildAffinityDefaultView } from './affinity-default-view';
import {
  buildAffinityCompaniesTableSpec,
  buildAffinityEntityFilesTableSpec,
  buildAffinityJsonTableSpec,
  buildAffinityNotesTableSpec,
  buildAffinityOpportunitiesTableSpec,
  buildAffinityPersonsTableSpec,
  buildAffinityUsersTableSpec,
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
import {
  buildCompanyBasicsUpdatePayload,
  buildCompanyCreatePayload,
  buildFieldValueUpdatesForChangedRecord,
  buildNonEmptyFieldValueUpdatesForNewRecord,
  buildNoteCreateRequestFromRecordFile,
  buildOpportunityBasicsUpdatePayload,
  buildOpportunityCreatePayload,
  buildPersonBasicsUpdatePayload,
  buildPersonCreatePayload,
  COMPANY_WRITABLE_BASIC_KEYS,
  OPPORTUNITY_WRITABLE_BASIC_KEYS,
  PERSON_WRITABLE_BASIC_KEYS,
  splitChangedRecordIntoBasicsAndFields,
} from './affinity-write-translation';

// Each tenant-wide table uses a fixed string in `remoteId[0]` to distinguish
// it from user-created lists, which use the numeric Affinity list id. These
// strings can never collide with list ids because `parseInt('persons', 10)`
// returns NaN — see `parseAffinityTableId` below.
const TENANT_PERSONS_ID = 'persons';
const TENANT_COMPANIES_ID = 'companies';
const TENANT_OPPORTUNITIES_ID = 'opportunities';
const TENANT_NOTES_ID = 'notes';
const TENANT_ENTITY_FILES_ID = 'entity-files';
const TENANT_USERS_ID = 'users';

const LOG_SOURCE = 'AffinityConnector';

/**
 * Connector for the Affinity v2 API.
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
 * Writes (DEV-10298): full read-write across two API versions. The v2 API
 * writes FIELD VALUES + Notes; the v1 API does whole-record create/update/
 * delete, record *basics* (firstName/name/domain/emails), opportunity create,
 * and list membership (same Bearer token). The connector routes each operation
 * to whichever API supports it and always sets field values through v2 — even
 * on a freshly v1-created record — so it never touches the v1 field-values
 * endpoint. Only Entity Files are read-only (no v1 metadata-update endpoint).
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
          description: 'Generate an API key in Affinity at Settings → Manage Apps → New App.',
          required: true,
        },
      ],
    },
  });

  private readonly client: AffinityApiClient;
  private readonly listCache = new Map<number, AffinityList>();
  /**
   * Host-provided, per-user feature-flag check (see `ConnectorFactoryContext`).
   * When set (the real publish path always sets it), the write methods gate on
   * `ENABLE_AFFINITY_WRITE`. When undefined (direct construction, e.g. tests),
   * the gate is inert and writes proceed. Fail-closed at the host: a missing or
   * unknown user resolves to `false`.
   */
  private readonly isFeatureEnabled?: (flagKey: string) => Promise<boolean>;

  constructor(
    apiKey: string,
    opts?: { rateLimiter?: RateLimiter; isFeatureEnabled?: (flagKey: string) => Promise<boolean> },
  ) {
    super();
    this.client = new AffinityApiClient(apiKey, { rateLimiter: opts?.rateLimiter });
    this.isFeatureEnabled = opts?.isFeatureEnabled;
  }

  /**
   * Gate writes behind the `ENABLE_AFFINITY_WRITE` feature flag (DEV-10298).
   * The Affinity connector implements full write CRUD, but publishing is being
   * productionized — so until the publishing user is on the flag, every
   * create/update/delete is refused with a read-only error (the
   * pre-write-codepath behavior). When the host wired no flag check (direct
   * construction, e.g. tests), the gate is inert. Called at the top of every
   * write method so a disabled flag short-circuits before any API call.
   */
  private async assertAffinityWritesEnabled(): Promise<void> {
    if (!this.isFeatureEnabled) {
      return;
    }
    const writesEnabled = await this.isFeatureEnabled('ENABLE_AFFINITY_WRITE');
    if (!writesEnabled) {
      throw new AffinityError(
        'Affinity is read-only for this user. Publishing changes to Affinity is gated behind the ' +
          'ENABLE_AFFINITY_WRITE feature flag — enable it for your user to publish.',
      );
    }
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
      {
        id: { wsId: TENANT_USERS_ID, remoteId: [TENANT_USERS_ID] },
        displayName: 'Users',
        metadata: { tableKind: 'tenant-users' },
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

  /**
   * Generate the default TableView from a table spec, deriving everything from
   * the spec's verbatim schema + `titlePath`. Pure `spec → view`: the schema-gen
   * path no longer stamps `defaultView` onto the spec; this override reproduces
   * exactly what it used to set. `buildAffinityDefaultView` self-dispatches off
   * the schema shape (list-entry `entity` wrapper vs. flat tenant table, notes,
   * entity files), so a single call covers all seven Affinity table kinds.
   */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    return buildAffinityDefaultView(spec.schema, spec.titlePath);
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
      case 'tenant-users':
        return buildAffinityUsersTableSpec(id);
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
      case 'tenant-users': {
        for await (const batch of this.client.listAllUsers(resumeCursor)) {
          // Users are flat with no `fields` container — pass through verbatim.
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
        case 'tenant-users': {
          const user = await this.client.getUser(recordId);
          if (user) buffer.push(user as unknown as ConnectorFile);
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

  // ---- Writes (DEV-10298) ----
  //
  // The Affinity v2 API writes FIELD VALUES + Notes; whole-record create/delete,
  // record *basics* (firstName/name/domain/emails), opportunity create, and list
  // membership are v1-API-only (phase 2). The connector routes each operation to
  // whichever API supports it — and always sets field VALUES through the v2 path,
  // even on a freshly v1-created record, so it never touches the v1 field-values
  // endpoint. Entity Files remain read-only (no v1 metadata-update endpoint).

  /**
   * Create records. Dispatches by table: persons/companies/opportunities create
   * the record's basics via v1 then set field values via v2; list entries create
   * list membership via v1; Notes create via v2. The new remote id flows back
   * into the returned file (re-read through the same path a pull uses).
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    await this.assertAffinityWritesEnabled();
    const parsed = parseAffinityTableId(tableSpec.id);
    switch (parsed.kind) {
      case 'tenant-notes':
        return this.createNoteRecords(files);
      case 'tenant-persons':
      case 'tenant-companies':
        return this.createTenantRecords(parsed.kind, tableSpec, files);
      case 'tenant-opportunities':
        return this.createOpportunityRecords(files);
      case 'list':
        return this.createListEntryRecords(parsed.listId, tableSpec, files);
      case 'tenant-entity-files':
        throw new AffinityError('Entity Files are read-only: they cannot be created through the connector.');
      case 'tenant-users':
        throw new AffinityError('Users are a read-only reference table: they cannot be created through the connector.');
      default:
        return assertUnreachable(parsed);
    }
  }

  /**
   * Update records. Persons/companies split a change into **basics** (v1 `PUT`)
   * and **field values** (v2 `update-fields`); opportunities update their name
   * via v1; list entries update field values via v2; Notes update content via
   * v2. A changed field with no write path throws — never silently dropped.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    await this.assertAffinityWritesEnabled();
    const parsed = parseAffinityTableId(tableSpec.id);

    switch (parsed.kind) {
      case 'tenant-entity-files':
        throw new AffinityError(
          'Entity Files are read-only: the Affinity v1 entity-files API has no metadata-update endpoint.',
        );
      case 'tenant-users':
        throw new AffinityError('Users are a read-only reference table: they cannot be edited through the connector.');
      case 'tenant-opportunities':
        return this.updateOpportunityRecords(files, changedFields);
      case 'tenant-notes':
        return this.updateNoteRecords(files, changedFields);
      case 'tenant-persons':
      case 'tenant-companies':
        return this.updateTenantRecords(parsed.kind, tableSpec, files, changedFields);
      case 'list':
        return this.updateListEntryRecordFieldValues(parsed.listId, tableSpec, files, changedFields);
      default:
        return assertUnreachable(parsed);
    }
  }

  /**
   * Delete records. Persons/companies/opportunities and list entries delete via
   * v1; Notes via v2. An already-deleted target (404) is a no-op. Entity Files
   * are read-only.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    await this.assertAffinityWritesEnabled();
    const parsed = parseAffinityTableId(tableSpec.id);
    if (parsed.kind === 'tenant-entity-files') {
      throw new AffinityError('Entity Files are read-only: they cannot be deleted through the connector.');
    }
    if (parsed.kind === 'tenant-users') {
      throw new AffinityError('Users are a read-only reference table: they cannot be deleted through the connector.');
    }

    for (const file of files) {
      const recordId = readNumericRecordId(file);
      if (recordId === undefined) {
        throw new AffinityError(`Cannot delete a ${describeTableKind(parsed.kind)} record without a numeric "id".`);
      }
      switch (parsed.kind) {
        case 'tenant-notes':
          await this.client.deleteNote(recordId);
          break;
        case 'tenant-persons':
          await this.client.deletePerson(recordId);
          break;
        case 'tenant-companies':
          await this.client.deleteCompany(recordId);
          break;
        case 'tenant-opportunities':
          await this.client.deleteOpportunity(recordId);
          break;
        case 'list':
          await this.client.deleteListEntry(parsed.listId, recordId);
          break;
        default:
          return assertUnreachable(parsed);
      }
    }
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
      case 'tenant-users':
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

  // ---- Write helpers ----

  /**
   * Create notes (v2). A new note file needs `content.html` plus at least one
   * association id under `personsPreview` / `companiesPreview` /
   * `opportunitiesPreview` `.data[].id` (the shape a pulled note carries).
   */
  private async createNoteRecords(files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const createdNoteFiles: ConnectorFile[] = [];
    for (const file of files) {
      const noteCreateRequest = buildNoteCreateRequestFromRecordFile(file as unknown as Record<string, unknown>);
      const createdNote = await this.client.createNote(noteCreateRequest);
      const persistedNote = await this.client.getNote(createdNote.id);
      createdNoteFiles.push((persistedNote ?? createdNote) as unknown as ConnectorFile);
    }
    return createdNoteFiles;
  }

  /**
   * Create tenant persons / companies: v1 `POST` for the record basics, then v2
   * `update-fields` for any non-empty custom field values, then re-read via v2
   * for the canonical on-disk shape (with the new id + hydrated field values).
   */
  private async createTenantRecords(
    tableKind: 'tenant-persons' | 'tenant-companies',
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
  ): Promise<ConnectorFile[]> {
    const createdFiles: ConnectorFile[] = [];
    for (const file of files) {
      const recordObject = file as unknown as Record<string, unknown>;

      const newRecordId =
        tableKind === 'tenant-persons'
          ? (await this.client.createPerson(buildPersonCreatePayload(recordObject))).id
          : (await this.client.createCompany(buildCompanyCreatePayload(recordObject))).id;

      const fieldValueUpdates = buildNonEmptyFieldValueUpdatesForNewRecord({
        fullRecordFile: recordObject,
        tableSpecSchema: tableSpec.schema as unknown as Record<string, unknown>,
        recordHasEntityWrapper: false,
      });
      if (fieldValueUpdates.length > 0) {
        if (tableKind === 'tenant-persons') {
          await this.client.updatePersonFieldValues(newRecordId, fieldValueUpdates);
        } else {
          await this.client.updateCompanyFieldValues(newRecordId, fieldValueUpdates);
        }
      }

      const persistedRecord =
        tableKind === 'tenant-persons'
          ? await this.client.getPerson(newRecordId)
          : await this.client.getCompany(newRecordId);
      createdFiles.push(persistedRecord ? tenantRecordToFile(persistedRecord) : withRecordId(file, newRecordId));
    }
    return createdFiles;
  }

  /**
   * Create opportunities (v1). A new opportunity file needs `name` + `listId`
   * (which opportunity-type list to create it in). Opportunities are thin
   * (id/name/listId, no fields), so there's no field-value step.
   */
  private async createOpportunityRecords(files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const createdFiles: ConnectorFile[] = [];
    for (const file of files) {
      const created = await this.client.createOpportunity(
        buildOpportunityCreatePayload(file as unknown as Record<string, unknown>),
      );
      const persisted = await this.client.getOpportunity(created.id);
      createdFiles.push(persisted ? (persisted as unknown as ConnectorFile) : withRecordId(file, created.id));
    }
    return createdFiles;
  }

  /**
   * Create list entries = list membership (v1). A new list-entry file needs
   * `entity.id` (the person/company/opportunity to add to this list). After the
   * entry exists, set its list-specific field values via v2, then re-read.
   */
  private async createListEntryRecords(
    listId: number,
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
  ): Promise<ConnectorFile[]> {
    const createdFiles: ConnectorFile[] = [];
    for (const file of files) {
      const recordObject = file as unknown as Record<string, unknown>;
      const entityId = readEntityIdFromListEntryFile(recordObject);
      if (entityId === undefined) {
        throw new AffinityError(
          'A new list entry needs "entity.id" — the id of the person, company, or opportunity to add to the list.',
        );
      }

      const createdEntry = await this.client.createListEntry(listId, entityId);

      const fieldValueUpdates = buildNonEmptyFieldValueUpdatesForNewRecord({
        fullRecordFile: recordObject,
        tableSpecSchema: tableSpec.schema as unknown as Record<string, unknown>,
        recordHasEntityWrapper: true,
      });
      if (fieldValueUpdates.length > 0) {
        await this.client.updateListEntryFieldValues(listId, createdEntry.id, fieldValueUpdates);
      }

      const persistedEntry = await this.client.getListEntry(listId, createdEntry.id);
      createdFiles.push(persistedEntry ? listEntryToFile(persistedEntry) : withRecordId(file, createdEntry.id));
    }
    return createdFiles;
  }

  /**
   * Update notes: only `content` is writable (the previews are server-computed
   * includes; association edits aren't wired into the record shape yet).
   */
  private async updateNoteRecords(
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const updatedNoteFiles: ConnectorFile[] = [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const noteId = readNumericRecordId(file);
      if (noteId === undefined) {
        throw new AffinityError('Cannot update a note without a numeric "id" in the record file.');
      }

      const changedRecordSparseObject = changedFields?.[fileIndex];
      if (changedRecordSparseObject !== undefined) {
        const unsupportedChangedKeys = Object.keys(changedRecordSparseObject).filter((key) => key !== 'content');
        if (unsupportedChangedKeys.length > 0) {
          throw new AffinityError(
            `Only a note's content can be edited; these fields are not writable: ${unsupportedChangedKeys.join(', ')}.`,
          );
        }
      }

      const contentHtml = (file as { content?: { html?: unknown } }).content?.html;
      if (typeof contentHtml !== 'string') {
        throw new AffinityError('Note "content.html" must be an HTML string to update a note.');
      }

      await this.client.updateNote(noteId, { content: { html: contentHtml } });
      const persistedNote = await this.client.getNote(noteId);
      updatedNoteFiles.push((persistedNote ?? file) as unknown as ConnectorFile);
    }
    return updatedNoteFiles;
  }

  /**
   * Update tenant persons / companies. A change is split into **basics** (name /
   * email — v1 `PUT`) and **field values** (v2 `update-fields`); each half fires
   * only if it actually changed. A changed top-level key that's neither a
   * writable basic nor a field value throws. Re-reads via v2 for the return shape.
   */
  private async updateTenantRecords(
    tableKind: 'tenant-persons' | 'tenant-companies',
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const tableSpecSchema = tableSpec.schema as unknown as Record<string, unknown>;
    const writableBasicKeys = tableKind === 'tenant-persons' ? PERSON_WRITABLE_BASIC_KEYS : COMPANY_WRITABLE_BASIC_KEYS;

    const updatedRecordFiles: ConnectorFile[] = [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const recordObject = file as unknown as Record<string, unknown>;
      const recordId = readNumericRecordId(file);
      if (recordId === undefined) {
        throw new AffinityError('Cannot update a record without a numeric "id" in the record file.');
      }

      const changedRecordSparseObject = changedFields?.[fileIndex];
      let fieldValueUpdates: ReturnType<typeof buildFieldValueUpdatesForChangedRecord> = [];

      if (changedRecordSparseObject === undefined) {
        // No diff available — re-send every writable field; basics left untouched.
        fieldValueUpdates = buildFieldValueUpdatesForChangedRecord({
          changedRecordSparseObject: undefined,
          fullRecordFile: recordObject,
          tableSpecSchema,
          recordHasEntityWrapper: false,
        });
      } else {
        const { basicsChanged, fieldsChangedSparse } = splitChangedRecordIntoBasicsAndFields(
          changedRecordSparseObject,
          writableBasicKeys,
        );

        if (Object.keys(basicsChanged).length > 0) {
          if (tableKind === 'tenant-persons') {
            const basicsBody = buildPersonBasicsUpdatePayload(basicsChanged);
            if (basicsBody) await this.client.updatePerson(recordId, basicsBody);
          } else {
            const basicsBody = buildCompanyBasicsUpdatePayload(basicsChanged);
            if (basicsBody) await this.client.updateCompany(recordId, basicsBody);
          }
        }

        if (fieldsChangedSparse) {
          fieldValueUpdates = buildFieldValueUpdatesForChangedRecord({
            changedRecordSparseObject: fieldsChangedSparse,
            fullRecordFile: recordObject,
            tableSpecSchema,
            recordHasEntityWrapper: false,
          });
        }
      }

      if (fieldValueUpdates.length > 0) {
        if (tableKind === 'tenant-persons') {
          await this.client.updatePersonFieldValues(recordId, fieldValueUpdates);
        } else {
          await this.client.updateCompanyFieldValues(recordId, fieldValueUpdates);
        }
      }

      const persistedRecord =
        tableKind === 'tenant-persons' ? await this.client.getPerson(recordId) : await this.client.getCompany(recordId);
      updatedRecordFiles.push(persistedRecord ? tenantRecordToFile(persistedRecord) : file);
    }
    return updatedRecordFiles;
  }

  /** Update opportunities (v1): rename only (the tenant Opportunities table is thin — id/name/listId). */
  private async updateOpportunityRecords(
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const updatedFiles: ConnectorFile[] = [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const recordId = readNumericRecordId(file);
      if (recordId === undefined) {
        throw new AffinityError('Cannot update an opportunity without a numeric "id" in the record file.');
      }

      const changedRecordSparseObject = changedFields?.[fileIndex];
      if (changedRecordSparseObject !== undefined) {
        const { basicsChanged } = splitChangedRecordIntoBasicsAndFields(
          changedRecordSparseObject,
          OPPORTUNITY_WRITABLE_BASIC_KEYS,
        );
        const basicsBody = buildOpportunityBasicsUpdatePayload(basicsChanged);
        if (basicsBody) await this.client.updateOpportunity(recordId, basicsBody);
      }

      const persisted = await this.client.getOpportunity(recordId);
      updatedFiles.push(persisted ? (persisted as unknown as ConnectorFile) : file);
    }
    return updatedFiles;
  }

  /** Push changed field values on list entries and read back the persisted entries. */
  private async updateListEntryRecordFieldValues(
    listId: number,
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const updatedEntryFiles: ConnectorFile[] = [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const listEntryId = readNumericRecordId(file);
      if (listEntryId === undefined) {
        throw new AffinityError('Cannot update a list entry without a numeric "id" in the record file.');
      }

      const updates = buildFieldValueUpdatesForChangedRecord({
        changedRecordSparseObject: changedFields?.[fileIndex],
        fullRecordFile: file as unknown as Record<string, unknown>,
        tableSpecSchema: tableSpec.schema as unknown as Record<string, unknown>,
        recordHasEntityWrapper: true,
      });

      if (updates.length > 0) {
        await this.client.updateListEntryFieldValues(listId, listEntryId, updates);
      }

      const persistedEntry = await this.client.getListEntry(listId, listEntryId);
      updatedEntryFiles.push(persistedEntry ? listEntryToFile(persistedEntry) : file);
    }
    return updatedEntryFiles;
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
    case TENANT_USERS_ID:
      return { kind: 'tenant-users' };
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new AffinityError(`Invalid Affinity table id in remoteId: ${raw}`);
  }
  return { kind: 'list', listId: parsed };
}

/** Read a record's numeric Affinity id off the file (accepts a numeric string for robustness). */
function readNumericRecordId(file: ConnectorFile): number | undefined {
  const rawId = (file as { id?: unknown }).id;
  if (typeof rawId === 'number' && Number.isFinite(rawId)) return rawId;
  if (typeof rawId === 'string') {
    const parsedId = parseInt(rawId, 10);
    if (!isNaN(parsedId)) return parsedId;
  }
  return undefined;
}

/** Read the wrapped entity's id off a list-entry file (`entity.id`) — the member to add to the list. */
function readEntityIdFromListEntryFile(listEntryRecordObject: Record<string, unknown>): number | undefined {
  const entity = listEntryRecordObject['entity'];
  const entityId = (entity as { id?: unknown } | undefined)?.id;
  if (typeof entityId === 'number' && Number.isFinite(entityId)) return entityId;
  if (typeof entityId === 'string') {
    const parsedId = parseInt(entityId, 10);
    if (!isNaN(parsedId)) return parsedId;
  }
  return undefined;
}

/** Return a shallow copy of a record file with its `id` set — fallback when a post-write re-read returns null. */
function withRecordId(file: ConnectorFile, id: number): ConnectorFile {
  return { ...(file as unknown as Record<string, unknown>), id } as unknown as ConnectorFile;
}

/** Human-readable words for a table kind, for write-unsupported error messages. */
function describeTableKind(kind: AffinityTableKind['kind']): string {
  switch (kind) {
    case 'list':
      return 'list entries';
    case 'tenant-persons':
      return 'people';
    case 'tenant-companies':
      return 'companies';
    case 'tenant-opportunities':
      return 'opportunities';
    case 'tenant-notes':
      return 'notes';
    case 'tenant-entity-files':
      return 'entity files';
    case 'tenant-users':
      return 'users';
    default:
      return assertUnreachable(kind);
  }
}

/**
 * Store a list entry verbatim as the file on disk (the Connector Prime
 * Directive). The `fields` array under `entry.entity.fields` is kept exactly as
 * Affinity returns it — `[{ id, name, type, enrichmentSource, value }]` — and
 * each element is exposed as an editable column via the schema's
 * `x-scratch-array-keyed-by` annotation (see `affinity-fields.ts`); no
 * array→keyed-object reshape on disk.
 */
function listEntryToFile(entry: AffinityListEntry): ConnectorFile {
  return entry as unknown as ConnectorFile;
}

/**
 * Store a tenant-wide person/company record verbatim as the file on disk. The
 * `fields` array lives at the top level (no `entity` wrapper) and is kept
 * exactly as Affinity returns it — same verbatim-array + `x-scratch-array-keyed-by`
 * model as list entries. Opportunities have no fields and pass through the same way.
 */
function tenantRecordToFile(record: AffinityPerson | AffinityCompany): ConnectorFile {
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
    return new AffinityConnector(apiKey, { rateLimiter, isFeatureEnabled: ctx.isFeatureEnabled });
  },
});

// Re-export for tests / future call sites that need the entity-type union.
export type { AffinityEntityType };
