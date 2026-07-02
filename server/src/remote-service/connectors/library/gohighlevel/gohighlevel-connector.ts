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
  CUSTOM_FIELD_KEY_FIELD,
  CUSTOM_FIELD_WRITE_VALUE_KEY,
  CUSTOM_FIELDS_KEY,
  type GoHighLevelCustomFieldValueKey,
} from './gohighlevel-custom-fields';
import {
  GOHIGHLEVEL_ENTITY_FIELDS,
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
const CALENDARS_TABLE_WS_ID = 'calendars';

/**
 * Calendar fields kept read-only even though Calendars is a writable table.
 *
 * **Verified against the GHL OpenAPI** (`apps/calendars.json` → `CalendarCreateDTO`
 * + `CalendarUpdateDTO`): of the 56 fields we enumerate, **55 are accepted on
 * create/update** and only `id` is genuinely API-read-only (and the id field is
 * always read-only on its own). `locationId` is API-writable too, but we keep it
 * read-only here **by connector policy** — it's the connection scope the client
 * injects on create, not something a user re-points by editing the field. So the
 * only read-only exception to declare is `locationId`.
 *
 * (Passing this set to buildGenericEntityJsonTableSpec is also what flags the table
 * as writable — see that function. For a future writable entity whose response has
 * MANY read-only fields, source the read-only set the same way: response fields
 * minus the entity's Create/Update DTO properties.)
 */
const CALENDAR_READONLY_FIELD_KEYS: ReadonlySet<string> = new Set(['locationId']);

/** Standard objects we expose through their dedicated tables, not as generic objects. */
const STANDARD_OBJECT_KEYS_HANDLED_ELSEWHERE = new Set<string>(['contact', 'opportunity']);

/** Display group for discovered custom objects in the table picker. */
const CUSTOM_OBJECTS_PARENT_PATH = 'Custom Objects';
const STANDARD_OBJECTS_PARENT_PATH = 'Standard Objects';
/** Human-defined custom objects are keyed `custom_objects.*`; standard objects-API objects (e.g. `business`) are not. */
const isCustomObjectKey = (objectKey: string): boolean => objectKey.startsWith('custom_objects.');

/** HighLevel's max page size for the search endpoints. */
const CONTACTS_PAGE_LIMIT = 100;
const OPPORTUNITIES_PAGE_LIMIT = 100;
const OBJECT_RECORDS_PAGE_LIMIT = 100;

/**
 * How many contacts' sub-entities (notes/tasks/appointments) to deep-fetch at
 * once when a Contacts advanced-settings toggle is enabled. Each enabled
 * sub-entity costs one extra request per contact, so a naive one-contact-at-a-time
 * pass turns a 100-contact page into 100+ serial round-trips and crawls
 * (DEV-10499: a 1,300-contact pull stalled a live onboarding). Fetching several
 * contacts concurrently keeps the pull moving; the shared RateLimiter throttles
 * the actual request rate (HighLevel allows 100 req / 10s ≈ 10 req/s) and retries
 * 429s, so this constant only bounds how many requests are queued in flight, never
 * the request rate itself. Sized to the per-second budget so we comfortably
 * saturate it without piling up unbounded in-flight work.
 */
const CONTACT_SUB_ENTITY_DEEP_FETCH_CONCURRENCY = 10;

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
 * Map an async function over `items` with at most `maxConcurrentTasks` running at
 * once, returning the results in input order and rejecting with the first error
 * encountered. On error, workers stop pulling new items and any already-in-flight
 * tasks settle first (no unhandled rejections), then the first error is thrown —
 * mirroring the fail-fast semantics of the previous sequential `await` loop while
 * fanning the work out. Used to deep-fetch many contacts' sub-entities at once
 * instead of one contact at a time (DEV-10499).
 */
export async function mapWithBoundedConcurrency<Item, Result>(
  items: Item[],
  maxConcurrentTasks: number,
  mapItemToResult: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const resultsInInputOrder = new Array<Result>(items.length);
  let nextItemIndexToProcess = 0;
  let firstErrorEncountered: unknown;
  let hasErrorBeenEncountered = false;

  const runWorker = async (): Promise<void> => {
    while (!hasErrorBeenEncountered) {
      const currentItemIndex = nextItemIndexToProcess;
      nextItemIndexToProcess += 1;
      if (currentItemIndex >= items.length) return;
      try {
        resultsInInputOrder[currentItemIndex] = await mapItemToResult(items[currentItemIndex], currentItemIndex);
      } catch (error) {
        if (!hasErrorBeenEncountered) {
          hasErrorBeenEncountered = true;
          firstErrorEncountered = error;
        }
        return;
      }
    }
  };

  const workerCount = Math.min(maxConcurrentTasks, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (hasErrorBeenEncountered) throw firstErrorEncountered;
  return resultsInInputOrder;
}

/**
 * Connector for HighLevel (GoHighLevel).
 *
 * Auth: a **Private Integration Token** (Settings -> Private Integrations in a
 * HighLevel sub-account) — an API-key-style bearer token scoped to one Location.
 * OAuth (with the agency -> location token exchange) is deferred.
 *
 * Tables (grouped on disk into `/Standard Objects/` and `/Custom Objects/`):
 *   - **Contacts** / **Opportunities** — dynamic schema (system fields + per-Location
 *     custom fields from the Locations customFields API, kept verbatim in the
 *     `customFields` array and surfaced as per-element editable columns via the
 *     `x-scratch-array-keyed-by` annotation); **full CRUD**. Opportunities carry
 *     pipeline/contact FKs.
 *   - **Custom Objects** + the standard `business`/Companies object — discovered from
 *     the Objects API; **full CRUD** via the records API.
 *   - **Pipelines** and a set of location-scoped reference tables (Calendars, Forms,
 *     Products, Users, …) — read-only pull.
 *
 * API docs: https://marketplace.gohighlevel.com/docs/
 */
export class GoHighLevelConnector extends Connector {
  readonly service = Service.GOHIGHLEVEL;
  static readonly displayName = 'HighLevel';
  static readonly metadata = connectorMetadata({
    displayName: 'HighLevel',
    visible: true,
    table: 'object',
    tables: 'objects',
    record: 'record',
    records: 'records',
    logo: GOHIGHLEVEL_LOGO_DATA_URI,
    oauth: { label: 'OAuth' },
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
      description:
        "Fetch and embed each contact's notes. Slower — one extra request per contact (fetched in parallel).",
      forTableWsIds: [CONTACTS_TABLE_WS_ID],
    },
    {
      key: 'includeTasks',
      type: 'boolean',
      label: 'Include contact tasks',
      description:
        "Fetch and embed each contact's tasks. Slower — one extra request per contact (fetched in parallel).",
      forTableWsIds: [CONTACTS_TABLE_WS_ID],
    },
    {
      key: 'includeAppointments',
      type: 'boolean',
      label: 'Include contact appointments',
      description:
        "Fetch and embed each contact's appointments. Slower — one extra request per contact (fetched in parallel).",
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

    const locationListEntityTables: TablePreview[] = GOHIGHLEVEL_LOCATION_LIST_ENTITIES.map((entity) => {
      // Calendars is the one location-list entity with full CRUD (create/update/delete
      // via the Calendars API — see createRecords/updateRecords/deleteRecords and the
      // writable spec from buildGenericEntityJsonTableSpec). Leaving its write flags
      // unset is what keeps `isTableFullyLocked` false, so the table picker offers
      // editing instead of forcing the folder read-only. Every other location-list
      // entity stays pull-only.
      const entityIsWritable = entity.wsId === CALENDARS_TABLE_WS_ID;
      return {
        id: { wsId: entity.wsId, remoteId: [entity.wsId] },
        displayName: entity.displayName,
        parentPath: entity.parentPath,
        ...(entityIsWritable
          ? {}
          : {
              disabledCreates: true,
              disabledUpdates: true,
              disabledDeletes: true,
              disabledReason: WRITES_DISABLED_REASON,
            }),
        metadata: { description: entity.description },
      };
    });

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
        parentPath: isCustomObjectKey(objectKey) ? CUSTOM_OBJECTS_PARENT_PATH : STANDARD_OBJECTS_PARENT_PATH,
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
          return buildGenericEntityJsonTableSpec(
            id,
            listEntityConfig.displayName,
            listEntityConfig.idField,
            GOHIGHLEVEL_ENTITY_FIELDS[id.wsId],
            // Calendars is writable (create/update/delete via the Calendars API); the
            // read-only exception set both flags it writable and keeps locationId/id
            // read-only. The other generic entities stay fully read-only (undefined).
            id.wsId === CALENDARS_TABLE_WS_ID ? CALENDAR_READONLY_FIELD_KEYS : undefined,
          );
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
      case CONTACTS_TABLE_WS_ID: {
        // Records carry the verbatim `customFields` array — stored as-is (no reshape).
        await this.fetchByIds(ids, (id) => this.client.getContact(id), callback, true);
        break;
      }
      case OPPORTUNITIES_TABLE_WS_ID: {
        // Records carry the verbatim `customFields` array — stored as-is (no reshape).
        await this.fetchByIds(ids, (id) => this.client.getOpportunity(id), callback, false);
        break;
      }
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
        // The response carries the verbatim `customFields` array — stored as-is.
        results.push((await this.client.createContact(this.buildContactPayload(file))) as ConnectorFile);
      } else if (wsId === OPPORTUNITIES_TABLE_WS_ID) {
        results.push((await this.client.createOpportunity(this.buildOpportunityPayload(file))) as ConnectorFile);
      } else if (wsId === CALENDARS_TABLE_WS_ID) {
        results.push((await this.client.createCalendar(this.buildCalendarPayload(file))) as ConnectorFile);
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
      const recordId = readRecordIdAsString(file, tableSpec.idPath);
      const changed = changedFields[i] ?? {};
      if (!recordId) {
        // No remote id to target — return the input unchanged.
        results.push(file);
        continue;
      }
      let updated: Record<string, unknown> | null = null;
      if (wsId === CONTACTS_TABLE_WS_ID) {
        // The response carries the verbatim `customFields` array — stored as-is.
        updated = await this.client.updateContact(recordId, this.buildContactPayload(changed));
      } else if (wsId === OPPORTUNITIES_TABLE_WS_ID) {
        // `followers` rides separately (the update endpoint rejects it), so a
        // followers-only edit leaves an empty update payload — skip the PUT in that
        // case and just reconcile followers through their dedicated endpoints.
        const opportunityPayload = this.buildOpportunityPayload(changed);
        if (Object.keys(opportunityPayload).length > 0) {
          updated = await this.client.updateOpportunity(recordId, opportunityPayload);
        }
        if ('followers' in changed) {
          await this.reconcileOpportunityFollowers(recordId, extractFollowerUserIds(changed.followers));
        }
      } else if (wsId === CALENDARS_TABLE_WS_ID) {
        // HighLevel merges per field on PUT, so the sparse `changed` payload is a
        // valid partial update — only the edited fields are sent.
        const calendarPayload = this.buildCalendarPayload(changed);
        if (Object.keys(calendarPayload).length > 0) {
          updated = await this.client.updateCalendar(recordId, calendarPayload);
        }
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
   * Delete records. `files` here are `{ [idPath]: remoteId }` filters
   * built by the publish flow. Each delete ignores 404 (already gone).
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const wsId = tableSpec.id.wsId;
    for (const filter of files) {
      const recordId = readRecordIdAsString(filter, tableSpec.idPath);
      if (!recordId) continue;
      if (wsId === CONTACTS_TABLE_WS_ID) {
        await this.client.deleteContact(recordId);
      } else if (wsId === OPPORTUNITIES_TABLE_WS_ID) {
        await this.client.deleteOpportunity(recordId);
      } else if (wsId === CALENDARS_TABLE_WS_ID) {
        await this.client.deleteCalendar(recordId);
      } else if (this.isCustomObjectTable(wsId)) {
        await this.client.deleteObjectRecord(this.objectKeyFromId(tableSpec.id), recordId);
      } else {
        this.throwWritesNotSupported('delete');
      }
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'contactName', 'name', 'firstName', 'email');
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
      // Each contact carries its verbatim `customFields` array — stored as-is; the
      // schema's x-scratch-array-keyed-by annotation exposes each element as an
      // editable column (gohighlevel-custom-fields.ts). Only strip the transport cursor.
      const files: ConnectorFile[] = page.contacts.map((contact) => this.stripPaginationCursor(contact));
      // Deep-fetch the opted-in sub-entities for the whole page concurrently
      // rather than one contact at a time — see DEV-10499. The RateLimiter caps
      // the real request rate, so this just keeps the request pipe full.
      if (deepFetch) {
        await mapWithBoundedConcurrency(files, CONTACT_SUB_ENTITY_DEEP_FETCH_CONCURRENCY, (record) =>
          this.attachContactSubEntities(record, includeNotes, includeTasks, includeAppointments),
        );
      }
      const connectorProgress: JsonSafeObject = page.searchAfter ? { searchAfter: page.searchAfter } : {};
      await callback({ files, connectorProgress });
    }
  }

  /**
   * Deep-fetch the opted-in contact sub-entities and embed them on the record
   * in-place, mirroring how Notion embeds `page_content`. The (independent)
   * sub-entity requests for a single contact are issued together so an opted-in
   * contact costs one round-trip's latency, not one per enabled sub-entity.
   */
  private async attachContactSubEntities(
    record: ConnectorFile,
    includeNotes: boolean,
    includeTasks: boolean,
    includeAppointments: boolean,
  ): Promise<void> {
    const contactId = typeof record.id === 'string' ? record.id : undefined;
    if (!contactId) return;
    const [notes, tasks, appointments] = await Promise.all([
      includeNotes ? this.client.getContactNotes(contactId) : Promise.resolve(undefined),
      includeTasks ? this.client.getContactTasks(contactId) : Promise.resolve(undefined),
      includeAppointments ? this.client.getContactAppointments(contactId) : Promise.resolve(undefined),
    ]);
    if (notes !== undefined) record.notes = notes;
    if (tasks !== undefined) record.tasks = tasks;
    if (appointments !== undefined) record.appointments = appointments;
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
      // Each opportunity carries its verbatim `customFields` array (value key
      // `fieldValue`) — stored as-is; the annotation drives per-element columns.
      const files = page.opportunities.map((opportunity) => ({ ...opportunity }) as ConnectorFile);
      await callback({ files, connectorProgress });
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
   * `stripCursor` removes the contacts-only `searchAfter` transport field. Records
   * (including any verbatim `customFields` array) are stored exactly as returned.
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
        const file = stripCursor ? this.stripPaginationCursor(record) : (record as ConnectorFile);
        buffer.push(file);
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
   * Contacts write payload: drop the id (identity, not writable) and translate the
   * verbatim `customFields` array element `{ id, value }` into the API write shape
   * `{ id, field_value }`. Other fields are sent as-is (the API rejects invalid
   * ones); `locationId` is injected by the client on create.
   */
  private buildContactPayload(source: Record<string, unknown>): Record<string, unknown> {
    return this.buildWritePayloadWithCustomFields(source, 'value');
  }

  /**
   * Opportunities write payload: same custom-field translation as contacts, but
   * each verbatim element reads its value from `fieldValue` (contacts use `value`)
   * — GHL's read-key asymmetry. On create the API also requires
   * pipelineId/name/status/contactId (the user must supply them); `locationId` is
   * injected by the client.
   */
  private buildOpportunityPayload(source: Record<string, unknown>): Record<string, unknown> {
    const payload = this.buildWritePayloadWithCustomFields(source, 'fieldValue');
    // Strip read-only hydrated sub-objects: HighLevel returns these on read but
    // does not accept them on write. Critically, sending the hydrated `contact`
    // object alongside a changed top-level `contactId` makes HighLevel SILENTLY
    // IGNORE the `contactId` change (the FK re-parent no-ops while publish reports
    // success). `notes`/`tasks`/`calendarEvents` are opt-in deep-fetch hydration.
    for (const hydratedReadOnlyKey of ['contact', 'notes', 'tasks', 'calendarEvents']) {
      delete payload[hydratedReadOnlyKey];
    }
    // `followers` is NOT an updatable property on the opportunity update endpoint
    // (it 422s "property followers should not exist"). It's reconciled separately
    // through the dedicated add/remove endpoints — see reconcileOpportunityFollowers.
    delete payload.followers;
    return payload;
  }

  /**
   * Reconcile an opportunity's followers to a desired set. HighLevel doesn't accept
   * `followers` on the update endpoint, so we read the current followers, diff against
   * the desired set, and apply only the delta through the dedicated add/remove
   * endpoints. Converges idempotently (safe to re-run — re-adding an existing follower
   * or removing an absent one is a no-op on our side).
   */
  private async reconcileOpportunityFollowers(opportunityId: string, desiredFollowerUserIds: string[]): Promise<void> {
    const currentOpportunity = await this.client.getOpportunity(opportunityId);
    const currentFollowerUserIds = extractFollowerUserIds(currentOpportunity?.followers);
    const desiredFollowerUserIdSet = new Set(desiredFollowerUserIds);
    const currentFollowerUserIdSet = new Set(currentFollowerUserIds);
    const followerUserIdsToAdd = desiredFollowerUserIds.filter((userId) => !currentFollowerUserIdSet.has(userId));
    const followerUserIdsToRemove = currentFollowerUserIds.filter((userId) => !desiredFollowerUserIdSet.has(userId));
    await this.client.addOpportunityFollowers(opportunityId, followerUserIdsToAdd);
    await this.client.removeOpportunityFollowers(opportunityId, followerUserIdsToRemove);
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
   * Calendar write payload: clone the source and drop the fields HighLevel computes
   * or rejects on write — `id` (identity) and `locationId` (the connection scope,
   * injected by the client on create). Every other calendar field is sent verbatim
   * (the API ignores/rejects an invalid one). Used for both create (the full new
   * record) and update (the sparse `changedFields` diff — HighLevel merges per field).
   */
  private buildCalendarPayload(source: Record<string, unknown>): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...source };
    delete payload.id;
    delete payload.locationId;
    return payload;
  }

  /**
   * Shared builder for Contacts/Opportunities: clone the source, drop the id, and
   * translate the verbatim `customFields` array (stored as `[{ id, <readValueKey> }]`)
   * into the HighLevel write shape `[{ id, field_value }]` — the write key is
   * `field_value` for BOTH entities, while the read key differs (`value` for
   * Contacts, `fieldValue` for Opportunities). The publish diff is keyed-array-aware,
   * so on update the array is already sparse (only the changed elements), and
   * HighLevel merges `customFields` by id — a single-element array is a valid partial
   * write. When `customFields` is absent the payload simply carries no custom fields.
   */
  private buildWritePayloadWithCustomFields(
    source: Record<string, unknown>,
    readValueKey: GoHighLevelCustomFieldValueKey,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...source };
    delete payload.id;
    const verbatimCustomFieldsArray = payload[CUSTOM_FIELDS_KEY];
    if (Array.isArray(verbatimCustomFieldsArray)) {
      payload[CUSTOM_FIELDS_KEY] = verbatimCustomFieldsArray
        .filter(
          (element): element is Record<string, unknown> =>
            !!element && typeof element === 'object' && !Array.isArray(element),
        )
        .map((element) => ({
          [CUSTOM_FIELD_KEY_FIELD]: element[CUSTOM_FIELD_KEY_FIELD],
          [CUSTOM_FIELD_WRITE_VALUE_KEY]: element[readValueKey],
        }));
    }
    return payload;
  }
}

/**
 * Normalize an opportunity `followers` value to a list of user-id strings.
 * HighLevel returns followers as an array of user-id strings; tolerate the
 * occasional `{ id }` / `{ _id }` object shape defensively, and treat anything
 * else (null / undefined / non-array) as no followers.
 */
function extractFollowerUserIds(followersValue: unknown): string[] {
  if (!Array.isArray(followersValue)) return [];
  const followerUserIds: string[] = [];
  for (const follower of followersValue) {
    if (typeof follower === 'string') {
      followerUserIds.push(follower);
    } else if (follower && typeof follower === 'object') {
      const candidate = (follower as Record<string, unknown>).id ?? (follower as Record<string, unknown>)._id;
      if (typeof candidate === 'string') followerUserIds.push(candidate);
    }
  }
  return followerUserIds;
}

connectorRegistry.register({
  service: Service.GOHIGHLEVEL,
  metadata: GoHighLevelConnector.metadata,
  advancedSettings: GoHighLevelConnector.advancedSettings,
  supportedAuthMethods: ['oauth', 'user_provided_params'],
  // HighLevel burst limit is 100 requests / 10s per app per location.
  rateLimiterSpec: { points: 100, duration: 10 },
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for HighLevel', Service.GOHIGHLEVEL);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);

    // OAuth: a Marketplace-app access token (auto-refreshed on read) scoped to a
    // single Location. The Location ID came back on the token exchange and is
    // persisted as oauthWorkspaceId — every HighLevel REST call is Location-scoped.
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const locationId = ctx.decryptedCredentials?.oauthWorkspaceId;
      if (!locationId) {
        throw new ConnectorInstantiationError(
          'Location ID is missing from the HighLevel OAuth connection',
          Service.GOHIGHLEVEL,
        );
      }
      const accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
      return new GoHighLevelConnector(accessToken, locationId, { rateLimiter });
    }

    // Private Integration Token: a long-lived bearer token + manually-entered Location ID.
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('Private Integration Token is required for HighLevel', Service.GOHIGHLEVEL);
    }
    if (!ctx.decryptedCredentials?.locationId) {
      throw new ConnectorInstantiationError('Location ID is required for HighLevel', Service.GOHIGHLEVEL);
    }
    return new GoHighLevelConnector(ctx.decryptedCredentials.apiKey, ctx.decryptedCredentials.locationId, {
      rateLimiter,
    });
  },
});
