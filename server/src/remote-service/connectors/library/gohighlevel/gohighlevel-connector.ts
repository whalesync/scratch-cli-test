import { connectorMetadata, ConnectorSettingDefinition } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
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
import { GoHighLevelApiClient, GoHighLevelError } from './gohighlevel-api-client';
import {
  GOHIGHLEVEL_LOCATION_LIST_ENTITIES,
  GOHIGHLEVEL_LOCATION_LIST_ENTITY_BY_WS_ID,
  GoHighLevelLocationListEntityConfig,
} from './gohighlevel-entities';
import {
  buildContactsJsonTableSpec,
  buildCustomObjectJsonTableSpec,
  buildGenericEntityJsonTableSpec,
  buildOpportunitiesJsonTableSpec,
  buildPipelinesJsonTableSpec,
} from './gohighlevel-json-schema';
import { GOHIGHLEVEL_LOGO_DATA_URI } from './gohighlevel-logo';
import {
  GoHighLevelContactsDownloadProgress,
  GoHighLevelObjectRecordsDownloadProgress,
  GoHighLevelOpportunitiesDownloadProgress,
} from './gohighlevel-types';

const CONTACTS_TABLE_WS_ID = 'contacts';
const OPPORTUNITIES_TABLE_WS_ID = 'opportunities';
const PIPELINES_TABLE_WS_ID = 'pipelines';

/** Standard objects we expose through their dedicated tables, not as generic objects. */
const STANDARD_OBJECT_KEYS_HANDLED_ELSEWHERE = new Set<string>(['contact', 'opportunity']);

/** Display group for discovered custom objects in the table picker. */
const CUSTOM_OBJECTS_PARENT_PATH = 'Custom Objects';

/** HighLevel's max page size for the search endpoints. */
const CONTACTS_PAGE_LIMIT = 100;
const OPPORTUNITIES_PAGE_LIMIT = 100;
const OBJECT_RECORDS_PAGE_LIMIT = 100;

/** Reason shown in the table picker for the (not-yet-implemented) write actions. */
const WRITES_DISABLED_REASON = 'Publishing is not implemented yet — HighLevel is read-only for now.';

/**
 * Contacts pull options. The `include*` flags come from the Contacts-scoped
 * advanced-settings checkboxes and, when enabled, deep-fetch the contact's
 * sub-entities (one request each, per contact) and embed them on the record.
 */
interface GoHighLevelContactPullOptions extends PullRecordFilesOptions {
  includeNotes?: boolean;
  includeTasks?: boolean;
  includeAppointments?: boolean;
}

/**
 * Connector for HighLevel (GoHighLevel).
 *
 * Implemented (all read-only):
 *   - Auth via a **Private Integration Token** (Settings -> Private Integrations
 *     in a HighLevel sub-account) — an API-key-style bearer token scoped to one
 *     Location. OAuth (with the agency -> location token exchange) is deferred.
 *   - **Contacts** — dynamic schema (system fields + custom-field definitions
 *     from the Locations customFields API) + pull via `POST /contacts/search`
 *     with the `searchAfter` cursor.
 *   - **Opportunities** — dynamic schema (incl. opportunity custom fields and
 *     pipeline/contact foreign keys) + pull via `GET /opportunities/search` with
 *     the `startAfter`/`startAfterId` cursor.
 *   - **Pipelines** — static schema + single `GET /opportunities/pipelines`.
 *
 * Not yet implemented (throw a clear error rather than silently no-op'ing):
 *   - Writes (create/update/delete) for every table.
 *
 * Registered with `visible: false`, so it appears only in development builds
 * (see `client/src/hooks/use-connectors.ts`).
 *
 * API docs: https://marketplace.gohighlevel.com/docs/
 */
export class GoHighLevelConnector extends Connector {
  readonly service = Service.GOHIGHLEVEL;
  static readonly displayName = 'HighLevel';
  static readonly metadata = connectorMetadata({
    displayName: 'HighLevel',
    // Dev-only for now: visible:false hides it from production, but the client
    // shows it in development builds so we can connect and iterate.
    visible: false,
    table: 'object',
    tables: 'objects',
    record: 'record',
    records: 'records',
    logo: GOHIGHLEVEL_LOGO_DATA_URI,
    userProvidedParamsLabel: 'Private Integration',
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'Private Integration Token',
          placeholder: 'pit-...',
          description:
            'Create one in your HighLevel sub-account under Settings -> Private Integrations. Grant at least the contacts.readonly, opportunities.readonly, and locations/customFields.readonly scopes.',
          required: true,
        },
        {
          key: 'locationId',
          type: 'string',
          label: 'Location ID',
          placeholder: 'e.g. ve9EPM428h8vShlRW1KT',
          description: 'The sub-account ("Location") ID the token belongs to. Found in your HighLevel dashboard URL.',
          required: true,
        },
      ],
    },
    setupGuide: {
      label: 'HighLevel Private Integrations guide',
      url: 'https://help.gohighlevel.com/support/solutions/articles/155000003054-private-integrations-everything-you-need-to-know',
    },
  });

  /**
   * Contacts-only deep-fetch toggles. `forTableWsIds` scopes them to the Contacts
   * table so they don't clutter the advanced settings of other tables. Each is
   * opt-in (default off) because enabling it costs one extra request per contact.
   */
  static readonly advancedSettings: ConnectorSettingDefinition[] = [
    {
      key: 'includeNotes',
      type: 'boolean',
      label: 'Include contact notes',
      description: "Fetch and embed each contact's notes. Slower — one extra request per contact.",
      forTableWsIds: [CONTACTS_TABLE_WS_ID],
    },
    {
      key: 'includeTasks',
      type: 'boolean',
      label: 'Include contact tasks',
      description: "Fetch and embed each contact's tasks. Slower — one extra request per contact.",
      forTableWsIds: [CONTACTS_TABLE_WS_ID],
    },
    {
      key: 'includeAppointments',
      type: 'boolean',
      label: 'Include contact appointments',
      description: "Fetch and embed each contact's appointments. Slower — one extra request per contact.",
      forTableWsIds: [CONTACTS_TABLE_WS_ID],
    },
  ];

  private readonly client: GoHighLevelApiClient;

  constructor(privateIntegrationToken: string, locationId: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new GoHighLevelApiClient(privateIntegrationToken, locationId, opts);
  }

  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  async listTables(): Promise<TablePreview[]> {
    // Built-in tables (read-only). Writes are disabled until publishing is
    // implemented, so the picker doesn't offer actions that would throw.
    const builtInTables: TablePreview[] = [
      {
        id: { wsId: CONTACTS_TABLE_WS_ID, remoteId: [CONTACTS_TABLE_WS_ID] },
        displayName: 'Contacts',
        metadata: { description: 'Contacts in your HighLevel sub-account' },
      },
      {
        id: { wsId: OPPORTUNITIES_TABLE_WS_ID, remoteId: [OPPORTUNITIES_TABLE_WS_ID] },
        displayName: 'Opportunities',
        metadata: { description: 'Opportunities (deals) in your HighLevel sub-account' },
      },
      {
        id: { wsId: PIPELINES_TABLE_WS_ID, remoteId: [PIPELINES_TABLE_WS_ID] },
        displayName: 'Pipelines',
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
        disabledReason: 'Pipelines are read-only reference data.',
        metadata: { description: 'Opportunity pipelines and their stages (read-only reference data)' },
      },
    ];

    const locationListEntityTables: TablePreview[] = GOHIGHLEVEL_LOCATION_LIST_ENTITIES.map((entity) => ({
      id: { wsId: entity.wsId, remoteId: [entity.wsId] },
      displayName: entity.displayName,
      parentPath: entity.parentPath,
      disabledCreates: true,
      disabledUpdates: true,
      disabledDeletes: true,
      disabledReason: WRITES_DISABLED_REASON,
      metadata: { description: entity.description },
    }));

    return [...builtInTables, ...locationListEntityTables, ...(await this.listCustomObjectTables())];
  }

  /**
   * Discover the location's custom (and other non-built-in standard) objects via
   * the Objects API and expose each as its own table, grouped under "Custom
   * Objects". Contacts/Opportunities are skipped here — they have dedicated
   * tables above.
   *
   * Graceful degradation: if the Objects API is unavailable (e.g. the token
   * lacks the objects scope), we warn and return no custom-object tables rather
   * than failing the whole table list.
   */
  private async listCustomObjectTables(): Promise<TablePreview[]> {
    let objectDefinitions;
    try {
      objectDefinitions = await this.client.getObjects();
    } catch (error) {
      WSLogger.warn({
        source: 'GoHighLevelConnector',
        message: 'Could not list HighLevel custom objects; showing built-in tables only.',
        error,
      });
      return [];
    }

    const customObjectTables: TablePreview[] = [];
    for (const objectDefinition of objectDefinitions) {
      const objectKey = objectDefinition.key;
      if (!objectKey || STANDARD_OBJECT_KEYS_HANDLED_ELSEWHERE.has(objectKey)) {
        continue;
      }
      const displayName = objectDefinition.labels?.plural ?? objectDefinition.labels?.singular ?? objectKey;
      customObjectTables.push({
        // The remoteId carries the real object key (e.g. `custom_objects.pet`);
        // the wsId is a sanitized, path-safe slug of it.
        id: { wsId: sanitizeForTableWsId(objectKey), remoteId: [objectKey] },
        displayName,
        parentPath: CUSTOM_OBJECTS_PARENT_PATH,
        metadata: { description: objectDefinition.description ?? `${displayName} records`, objectKey },
      });
    }
    return customObjectTables;
  }

  /**
   * Build the JSON table spec for a table, discovering fields dynamically:
   * Contacts/Opportunities from the Locations customFields API, custom objects
   * from the Objects API.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    switch (id.wsId) {
      case CONTACTS_TABLE_WS_ID: {
        const contactCustomFieldDefinitions = await this.client.getContactCustomFieldDefinitions();
        return buildContactsJsonTableSpec(id, contactCustomFieldDefinitions);
      }
      case OPPORTUNITIES_TABLE_WS_ID: {
        const opportunityCustomFieldDefinitions = await this.client.getOpportunityCustomFieldDefinitions();
        return buildOpportunitiesJsonTableSpec(id, opportunityCustomFieldDefinitions);
      }
      case PIPELINES_TABLE_WS_ID:
        return buildPipelinesJsonTableSpec(id);
      default: {
        const listEntityConfig = GOHIGHLEVEL_LOCATION_LIST_ENTITY_BY_WS_ID.get(id.wsId);
        if (listEntityConfig) {
          return buildGenericEntityJsonTableSpec(id, listEntityConfig.displayName, listEntityConfig.idField);
        }
        // Otherwise it's a discovered custom object.
        const objectKey = this.objectKeyFromId(id);
        const { object, fields } = await this.client.getObjectSchema(objectKey);
        return buildCustomObjectJsonTableSpec(id, object ?? {}, fields ?? []);
      }
    }
  }

  /**
   * Pull all records for a table, checkpointing the pagination cursor to
   * `connectorProgress` so a stalled run resumes mid-scan.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    switch (tableSpec.id.wsId) {
      case CONTACTS_TABLE_WS_ID:
        await this.pullContacts(callback, progress, options as GoHighLevelContactPullOptions);
        break;
      case OPPORTUNITIES_TABLE_WS_ID:
        await this.pullOpportunities(callback, progress);
        break;
      case PIPELINES_TABLE_WS_ID:
        await this.pullPipelines(callback);
        break;
      default: {
        const listEntityConfig = GOHIGHLEVEL_LOCATION_LIST_ENTITY_BY_WS_ID.get(tableSpec.id.wsId);
        if (listEntityConfig) {
          await this.pullGenericEntity(listEntityConfig, callback, progress);
        } else {
          // Otherwise it's a discovered custom object.
          await this.pullCustomObjectRecords(tableSpec, callback, progress);
        }
        break;
      }
    }
    return {};
  }

  /**
   * Re-fetch specific records by ID (used after a publish). Skips 404s.
   */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    switch (tableSpec.id.wsId) {
      case CONTACTS_TABLE_WS_ID:
        await this.fetchByIds(ids, (id) => this.client.getContact(id), callback, true);
        break;
      case OPPORTUNITIES_TABLE_WS_ID:
        await this.fetchByIds(ids, (id) => this.client.getOpportunity(id), callback, false);
        break;
      case PIPELINES_TABLE_WS_ID: {
        // Pipelines have no get-by-id endpoint, so re-fetch all and filter.
        const requestedIds = new Set(ids);
        const matchingPipelines = (await this.client.getPipelines()).filter(
          (pipeline) => typeof pipeline.id === 'string' && requestedIds.has(pipeline.id),
        );
        if (matchingPipelines.length > 0) {
          await callback({ files: matchingPipelines as ConnectorFile[] });
        }
        break;
      }
      default: {
        const listEntityConfig = GOHIGHLEVEL_LOCATION_LIST_ENTITY_BY_WS_ID.get(tableSpec.id.wsId);
        if (listEntityConfig) {
          await this.fetchGenericEntityByIds(listEntityConfig, ids, callback);
        } else {
          // Otherwise it's a discovered custom object.
          const objectKey = this.objectKeyFromId(tableSpec.id);
          await this.fetchByIds(ids, (recordId) => this.client.getObjectRecord(objectKey, recordId), callback, false);
        }
        break;
      }
    }
  }

  getBatchSize(): number {
    // HighLevel has no bulk CRUD endpoints — records are written one at a time.
    return 1;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getNewFile(tableSpec: BaseJsonTableSpec): Promise<Record<string, unknown>> {
    // Opportunities require a `status` on create; default it so a new record is
    // closer to publishable (pipelineId / name / contactId are still required).
    if (tableSpec.id.wsId === OPPORTUNITIES_TABLE_WS_ID) return { status: 'open' };
    return {};
  }

  /**
   * Create records on Contacts / Opportunities / Custom Objects. Returns each
   * created record (carrying its new `id`) so the framework can link the file.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const wsId = tableSpec.id.wsId;
    const results: ConnectorFile[] = [];
    for (const file of files) {
      if (wsId === CONTACTS_TABLE_WS_ID) {
        results.push((await this.client.createContact(this.buildContactPayload(file))) as ConnectorFile);
      } else if (wsId === OPPORTUNITIES_TABLE_WS_ID) {
        results.push((await this.client.createOpportunity(this.buildOpportunityPayload(file))) as ConnectorFile);
      } else if (this.isCustomObjectTable(wsId)) {
        const objectKey = this.objectKeyFromId(tableSpec.id);
        results.push(
          (await this.client.createObjectRecord(objectKey, this.buildObjectRecordPayload(file))) as ConnectorFile,
        );
      } else {
        this.throwWritesNotSupported('create');
      }
    }
    return results;
  }

  /**
   * Update records. Uses the sparse `changedFields` payload for Contacts /
   * Opportunities (so unchanged/computed fields aren't re-sent); for Custom
   * Objects it sends the full `properties` bag (the records API replaces it).
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const wsId = tableSpec.id.wsId;
    const results: ConnectorFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const recordId = readRecordIdAsString(file, tableSpec.idColumnRemoteId);
      const changed = changedFields[i] ?? {};
      if (!recordId) {
        // No remote id to target — return the input unchanged.
        results.push(file);
        continue;
      }
      let updated: Record<string, unknown> | null = null;
      if (wsId === CONTACTS_TABLE_WS_ID) {
        updated = await this.client.updateContact(recordId, this.buildContactPayload(changed));
      } else if (wsId === OPPORTUNITIES_TABLE_WS_ID) {
        updated = await this.client.updateOpportunity(recordId, this.buildOpportunityPayload(changed));
      } else if (this.isCustomObjectTable(wsId)) {
        const objectKey = this.objectKeyFromId(tableSpec.id);
        updated = await this.client.updateObjectRecord(objectKey, recordId, this.buildObjectRecordPayload(file));
      } else {
        this.throwWritesNotSupported('update');
      }
      results.push((updated as ConnectorFile | null) ?? file);
    }
    return results;
  }

  /**
   * Delete records. `files` here are `{ [idColumnRemoteId]: remoteId }` filters
   * built by the publish flow. Each delete ignores 404 (already gone).
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const wsId = tableSpec.id.wsId;
    for (const filter of files) {
      const recordId = readRecordIdAsString(filter, tableSpec.idColumnRemoteId);
      if (!recordId) continue;
      if (wsId === CONTACTS_TABLE_WS_ID) {
        await this.client.deleteContact(recordId);
      } else if (wsId === OPPORTUNITIES_TABLE_WS_ID) {
        await this.client.deleteOpportunity(recordId);
      } else if (this.isCustomObjectTable(wsId)) {
        await this.client.deleteObjectRecord(this.objectKeyFromId(tableSpec.id), recordId);
      } else {
        this.throwWritesNotSupported('delete');
      }
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(
      records,
      tableSpec.slugFieldPath,
      'contactName',
      'name',
      'firstName',
      'email',
    );
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof GoHighLevelError) {
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
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['message', 'msg', 'error']),
        description: error.message,
        additionalContext: {
          status: error.response?.status,
        },
      };
    }

    return this.fallbackErrorDetails(error);
  }

  // --- Per-table pulls ------------------------------------------------------

  private async pullContacts(
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: GoHighLevelContactPullOptions,
  ): Promise<void> {
    const resumeSearchAfter = (progress as GoHighLevelContactsDownloadProgress).searchAfter;
    const includeNotes = options.includeNotes === true;
    const includeTasks = options.includeTasks === true;
    const includeAppointments = options.includeAppointments === true;
    const deepFetch = includeNotes || includeTasks || includeAppointments;

    for await (const page of this.client.searchContacts(CONTACTS_PAGE_LIMIT, resumeSearchAfter)) {
      const files: ConnectorFile[] = [];
      for (const contact of page.contacts) {
        const record = this.stripPaginationCursor(contact);
        if (deepFetch) {
          await this.attachContactSubEntities(record, includeNotes, includeTasks, includeAppointments);
        }
        files.push(record);
      }
      const connectorProgress: JsonSafeObject = page.searchAfter ? { searchAfter: page.searchAfter } : {};
      await callback({ files, connectorProgress });
    }
  }

  /**
   * Deep-fetch the opted-in contact sub-entities (one request each) and embed
   * them on the record in-place, mirroring how Notion embeds `page_content`.
   */
  private async attachContactSubEntities(
    record: ConnectorFile,
    includeNotes: boolean,
    includeTasks: boolean,
    includeAppointments: boolean,
  ): Promise<void> {
    const contactId = typeof record.id === 'string' ? record.id : undefined;
    if (!contactId) return;
    if (includeNotes) record.notes = await this.client.getContactNotes(contactId);
    if (includeTasks) record.tasks = await this.client.getContactTasks(contactId);
    if (includeAppointments) record.appointments = await this.client.getContactAppointments(contactId);
  }

  private async pullOpportunities(
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
  ): Promise<void> {
    const { startAfter, startAfterId } = progress as GoHighLevelOpportunitiesDownloadProgress;

    for await (const page of this.client.searchOpportunities(OPPORTUNITIES_PAGE_LIMIT, { startAfter, startAfterId })) {
      const connectorProgress: JsonSafeObject = {};
      if (page.startAfter !== undefined) connectorProgress.startAfter = page.startAfter;
      if (page.startAfterId !== undefined) connectorProgress.startAfterId = page.startAfterId;
      await callback({ files: page.opportunities as ConnectorFile[], connectorProgress });
    }
  }

  private async pullPipelines(
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
  ): Promise<void> {
    // Single unpaginated call — yield every pipeline as one batch.
    const pipelines = await this.client.getPipelines();
    if (pipelines.length > 0) {
      await callback({ files: pipelines as ConnectorFile[], connectorProgress: {} });
    }
  }

  private async pullCustomObjectRecords(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
  ): Promise<void> {
    const objectKey = this.objectKeyFromId(tableSpec.id);
    const resumePage = (progress as GoHighLevelObjectRecordsDownloadProgress).page ?? 1;

    for await (const page of this.client.searchObjectRecords(objectKey, OBJECT_RECORDS_PAGE_LIMIT, resumePage)) {
      // Search records carry an ES sort cursor (`sort`, or `searchAfter` per the
      // spec) — transport, not data. Strip both before storing.
      const files = page.records.map((record) => {
        const file: Record<string, unknown> = { ...record };
        delete file.sort;
        delete file.searchAfter;
        return file as ConnectorFile;
      });
      await callback({ files, connectorProgress: { page: page.nextPage } });
    }
  }

  private async pullGenericEntity(
    config: GoHighLevelLocationListEntityConfig,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
  ): Promise<void> {
    for await (const page of this.client.listLocationEntity(config, progress)) {
      await callback({ files: page.records as ConnectorFile[], connectorProgress: page.cursor });
    }
  }

  /**
   * Re-fetch generic-entity records by ID. These read-only entities have no
   * uniform get-by-id endpoint, so we page the list and collect matches (used
   * only on post-publish re-pulls, which don't occur while writes are disabled).
   */
  private async fetchGenericEntityByIds(
    config: GoHighLevelLocationListEntityConfig,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const requestedIds = new Set(ids);
    const matches: ConnectorFile[] = [];

    for await (const page of this.client.listLocationEntity(config, {})) {
      for (const record of page.records) {
        const recordId = record[config.idField];
        if (typeof recordId === 'string' && requestedIds.has(recordId)) {
          matches.push(record as ConnectorFile);
        }
      }
      if (matches.length >= requestedIds.size) {
        break;
      }
    }

    if (matches.length > 0) {
      await callback({ files: matches });
    }
  }

  // --- Private helpers ------------------------------------------------------

  /**
   * The real HighLevel object key for a custom-object table lives in
   * `id.remoteId[0]` (the wsId is a sanitized slug). Throws if missing.
   */
  private objectKeyFromId(id: EntityId): string {
    const objectKey = id.remoteId[0];
    if (!objectKey) {
      this.throwUnknownTable(id.wsId);
    }
    return objectKey;
  }

  /**
   * Fetch records one-by-one by ID and flush to the callback in batches.
   * `stripCursor` removes the contacts-only `searchAfter` transport field.
   */
  private async fetchByIds(
    ids: string[],
    fetchOne: (id: string) => Promise<Record<string, unknown> | null>,
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
    stripCursor: boolean,
  ): Promise<void> {
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      const record = await fetchOne(id);
      if (record) {
        buffer.push(stripCursor ? this.stripPaginationCursor(record) : (record as ConnectorFile));
      }
      if (buffer.length >= BATCH_SIZE) {
        await callback({ files: buffer.splice(0) });
      }
    }

    if (buffer.length > 0) {
      await callback({ files: buffer });
    }
  }

  /**
   * Return a copy of a contact with the `searchAfter` pagination cursor removed
   * — it is transport metadata (an ES sort key), not contact data, and must not
   * be persisted into the stored record.
   */
  private stripPaginationCursor(contact: Record<string, unknown>): ConnectorFile {
    const record: Record<string, unknown> = { ...contact };
    delete record.searchAfter;
    return record;
  }

  private throwUnknownTable(wsId: string): never {
    throw new GoHighLevelError(`HighLevel: unknown table '${wsId}'.`);
  }

  private throwWritesNotSupported(operation: string): never {
    throw new GoHighLevelError(`HighLevel: ${operation} is not supported for this table (read-only).`);
  }

  // --- Write payload builders -----------------------------------------------

  /**
   * True when the table is a discovered custom object (writable via the Objects
   * records API) — i.e. not a built-in and not a read-only generic location entity.
   */
  private isCustomObjectTable(wsId: string): boolean {
    return (
      wsId !== CONTACTS_TABLE_WS_ID &&
      wsId !== OPPORTUNITIES_TABLE_WS_ID &&
      wsId !== PIPELINES_TABLE_WS_ID &&
      !GOHIGHLEVEL_LOCATION_LIST_ENTITY_BY_WS_ID.has(wsId)
    );
  }

  /**
   * Contacts write payload: drop the id (identity, not writable) and map
   * `customFields` from the read shape `{ id, value }` to the write shape
   * `{ id, field_value }`. Other fields are sent as-is (the API rejects invalid
   * ones); `locationId` is injected by the client on create.
   */
  private buildContactPayload(source: Record<string, unknown>): Record<string, unknown> {
    return this.buildWritePayloadWithCustomFields(source, 'value');
  }

  /**
   * Opportunities write payload: same as contacts but the read value key is
   * `fieldValue`. On create the API also requires pipelineId/name/status/contactId
   * (the user must supply them); `locationId` is injected by the client.
   */
  private buildOpportunityPayload(source: Record<string, unknown>): Record<string, unknown> {
    return this.buildWritePayloadWithCustomFields(source, 'fieldValue');
  }

  /**
   * Custom-object record write payload: HighLevel keeps record values in a keyed
   * `properties` bag (both read and write), so it passes through unchanged.
   * `owner`/`followers` are forwarded when present; `locationId` is injected by
   * the client. The update endpoint replaces `properties`, so callers send the
   * full bag (from the stored record), not a sparse diff.
   */
  private buildObjectRecordPayload(source: Record<string, unknown>): Record<string, unknown> {
    // Only `properties` is round-tripped. The record reads `owners`/`followers`
    // back as ARRAYS, but the write DTO expects OBJECTS — forwarding them 422s
    // ("followers must be an object"). They aren't edited through the properties
    // bag, so we leave them to HighLevel rather than send a rejected shape.
    return { properties: source.properties ?? {} };
  }

  /**
   * Shared builder for Contacts/Opportunities: clone the source, drop the id,
   * and transform a `customFields` array from `{ id, <readValueKey> }` to the
   * write shape `{ id, field_value }` (preserving `key` when present).
   */
  private buildWritePayloadWithCustomFields(
    source: Record<string, unknown>,
    readValueKey: 'value' | 'fieldValue',
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...source };
    delete payload.id;
    if (Array.isArray(payload.customFields)) {
      payload.customFields = payload.customFields.map((entry) => this.toWriteCustomField(entry, readValueKey));
    }
    return payload;
  }

  /** Map one custom-field value object to the HighLevel write shape. */
  private toWriteCustomField(entry: unknown, readValueKey: 'value' | 'fieldValue'): unknown {
    if (!entry || typeof entry !== 'object') return entry;
    const source = entry as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof source.id === 'string') out.id = source.id;
    if (typeof source.key === 'string') out.key = source.key;
    out.field_value = source[readValueKey];
    return out;
  }
}

connectorRegistry.register({
  service: Service.GOHIGHLEVEL,
  metadata: GoHighLevelConnector.metadata,
  advancedSettings: GoHighLevelConnector.advancedSettings,
  supportedAuthMethods: ['user_provided_params'],
  // HighLevel burst limit is 100 requests / 10s per app per location.
  rateLimiterSpec: { points: 100, duration: 10 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for HighLevel', Service.GOHIGHLEVEL);
    }
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('Private Integration Token is required for HighLevel', Service.GOHIGHLEVEL);
    }
    if (!ctx.decryptedCredentials?.locationId) {
      throw new ConnectorInstantiationError('Location ID is required for HighLevel', Service.GOHIGHLEVEL);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    return new GoHighLevelConnector(ctx.decryptedCredentials.apiKey, ctx.decryptedCredentials.locationId, {
      rateLimiter,
    });
  },
});
