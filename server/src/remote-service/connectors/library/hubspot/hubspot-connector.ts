import {
  connectorMetadata,
  ConnectorSettingDefinition,
  IncrementalPullSupport,
  TableView,
} from '@spinner/shared-types';
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
  ReadonlyFieldEditError,
  readonlyFieldEditErrorMessage,
} from '../../error';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  EntityId,
  findLastModifiedFieldName,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../types';
import { HubspotApiClient, HubspotError } from './hubspot-api-client';
import { buildHubspotDefaultView } from './hubspot-default-view';
import { buildHubspotJsonTableSpec, isReadonlyHubspotProperty } from './hubspot-json-schema';
import {
  ASSOCIATIONS_BY_OBJECT_TYPE,
  HubspotAssociation,
  HubspotAssociationResult,
  HubspotDownloadProgress,
  HubspotRecord,
  OBJECT_CONFIG,
  STANDARD_OBJECT_TYPES,
} from './hubspot-types';

const LOG_SOURCE = 'HubspotConnector';

// --- Published-quote recall (DEV-10886) -------------------------------------
//
// HubSpot locks a published quote (`hs_locked = true`) and rejects any property
// PATCH with "Published Quote cannot be edited." To edit a published quote you
// must do HubSpot's own "Recall & edit" dance: PATCH `hs_status` → DRAFT
// (recall), make the change, then PATCH `hs_status` back to the published value.
// A quote that has been e-signed by all parties or paid can't be recalled at all.

/** The HubSpot object type whose records are published/locked quotes. */
const QUOTES_OBJECT_TYPE = 'quotes';

/** The quote property holding the publish state (`DRAFT`, `APPROVED`, …). */
const QUOTE_STATUS_PROPERTY_NAME = 'hs_status';

/** The read-only quote property HubSpot flips to `true` once a quote is published. */
const QUOTE_LOCKED_PROPERTY_NAME = 'hs_locked';

/** The `hs_status` value that recalls a quote back to an editable draft. */
const QUOTE_DRAFT_STATUS = 'DRAFT';

/**
 * `hs_status` values in which HubSpot treats a quote as published and locks it
 * against property edits. Used as the fallback signal when the read-only
 * `hs_locked` property isn't present on the fetched record.
 */
const PUBLISHED_LOCKED_QUOTE_STATUSES = new Set(['APPROVAL_NOT_NEEDED', 'APPROVED']);

/**
 * Whether the remote quote is currently published and therefore locked against
 * property edits. Prefers the authoritative read-only `hs_locked` flag and falls
 * back to the published-status set when the flag isn't in the fetched properties.
 */
function isQuotePublishedAndLocked(remoteQuote: HubspotRecord): boolean {
  if (remoteQuote.properties?.[QUOTE_LOCKED_PROPERTY_NAME] === 'true') {
    return true;
  }
  const status = remoteQuote.properties?.[QUOTE_STATUS_PROPERTY_NAME];
  return typeof status === 'string' && PUBLISHED_LOCKED_QUOTE_STATUSES.has(status);
}

/**
 * The status the quote should end in once the edit lands. This is the record's
 * **on-disk** `hs_status` — the user's intended final status (still the published
 * value when they only edited, say, Terms; `DRAFT` if they deliberately
 * un-published). Using the on-disk value keeps the recall dance idempotent/
 * resumable (a crash mid-dance converges to the same end state on the next run).
 * Falls back to the live status the quote had before recall when the on-disk
 * record carries no `hs_status`. The recall dance owns `hs_status` entirely: it's
 * applied as the final step (re-locking a recalled quote), never inside the
 * content PATCH.
 */
function resolveQuoteDesiredFinalStatus(
  onDiskQuoteFile: ConnectorFile,
  remoteQuoteBeforeEdit: HubspotRecord,
): string | undefined {
  const onDiskStatus = (onDiskQuoteFile as unknown as HubspotRecord).properties?.[QUOTE_STATUS_PROPERTY_NAME];
  if (typeof onDiskStatus === 'string' && onDiskStatus.trim() !== '') {
    return onDiskStatus;
  }
  const liveStatus = remoteQuoteBeforeEdit.properties?.[QUOTE_STATUS_PROPERTY_NAME];
  return typeof liveStatus === 'string' && liveStatus.trim() !== '' ? liveStatus : undefined;
}

/**
 * Resolve the property name to use for the modified-since filter, preferring an
 * explicit user setting over the schema-annotated auto-detection. Pure (no
 * `this`) so both the connector instance and the REST-layer capability resolver
 * can call it. A `null` tableSpec means no schema is on hand, so only an
 * explicit `options.modifiedAtField` can resolve. The resolved name is the
 * HubSpot property key (e.g. `hs_lastmodifieddate`), which is exactly what the
 * CRM Search API filters and sorts on.
 */
export function resolveHubspotModifiedAtField(
  options: PullRecordFilesOptions,
  tableSpec: BaseJsonTableSpec | null,
): string | undefined {
  if (typeof options.modifiedAtField === 'string' && options.modifiedAtField.trim() !== '') {
    return options.modifiedAtField.trim();
  }
  return tableSpec ? findLastModifiedFieldName(tableSpec) : undefined;
}

/**
 * Three-state incremental-pull capability for HubSpot. Standard objects expose
 * an auto-detectable modified-date property (`hs_lastmodifieddate` /
 * `lastmodifieddate`) → `SUPPORTED`. A custom object whose modified-date
 * property the annotation missed has no resolvable field until the user declares
 * one via the `modifiedAtField` advanced setting → `NEEDS_CONFIGURATION` (never
 * `NOT_SUPPORTED`, since any HubSpot object the user configures can be searched).
 * With a `null` tableSpec the field can't be auto-detected yet; the REST layer
 * reads the schema and re-resolves whenever the answer isn't already `SUPPORTED`.
 */
export function hubspotIncrementalPullSupport(
  options: PullRecordFilesOptions,
  tableSpec: BaseJsonTableSpec | null,
): IncrementalPullSupport {
  return resolveHubspotModifiedAtField(options, tableSpec) !== undefined
    ? IncrementalPullSupport.SUPPORTED
    : IncrementalPullSupport.NEEDS_CONFIGURATION;
}

/**
 * Connector for HubSpot CRM.
 *
 * Supports all standard CRM objects (contacts, companies, deals, tickets, etc.),
 * custom objects, and associations between objects.
 *
 * Associations are stored on the record as part of the raw API response.
 * On publish, the connector diffs associations and writes them via the v4 API.
 */
export class HubspotConnector extends Connector<string, HubspotDownloadProgress> {
  readonly service = Service.HUBSPOT;
  static readonly displayName = 'HubSpot';
  static readonly metadata = connectorMetadata({
    displayName: 'HubSpot',
    table: 'object',
    tables: 'objects',
    logo: 'https://static.scratch.md/connector-icons/hubspot.svg',
    incrementalPull: true,
    incrementalPullInstructions:
      'Note: incremental pulls re-fetch each changed record individually to include its associations, so large deltas pull slower than a full pull; associations changed WITHOUT a property change do not bump the modified date, so periodic full pulls still reconcile those.',
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'Private App Access Token',
          placeholder: 'pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          required: true,
        },
      ],
    },
    userProvidedParamsLabel: 'Private App Token',
  });
  static readonly advancedSettings: ConnectorSettingDefinition[] = [
    {
      key: 'modifiedAtField',
      type: 'field-select',
      label: 'Last modified date property',
      description:
        'Select the property that records this object’s last-modified date. Scratch uses the Hubspot last modified date property by default.',
      placeholder: 'e.g. hs_lastmodifieddate',
    },
  ];

  private readonly client: HubspotApiClient;

  /** Cache of property names per object type (populated during fetchJsonTableSpec). */
  private propertyNamesCache = new Map<string, string[]>();

  constructor(accessToken: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new HubspotApiClient(accessToken, opts);
  }

  async testConnection(): Promise<void> {
    await this.client.testConnection();
  }

  /**
   * Returns the daily and per-second rate-limit state from HubSpot response
   * headers. The daily limit is the most useful — it resets at midnight UTC
   * and varies by plan (e.g., 500k/day for Enterprise).
   */
  async getApiQuota(): Promise<{ quota: JsonSafeObject }> {
    const quota = await this.client.getApiQuota();
    return { quota: quota as unknown as JsonSafeObject };
  }

  /**
   * List all available object types as tables.
   * Includes standard CRM objects and custom objects.
   */
  async listTables(): Promise<TablePreview[]> {
    const tables: TablePreview[] = [];

    // Standard object types
    for (const objectType of STANDARD_OBJECT_TYPES) {
      const config = OBJECT_CONFIG[objectType];
      if (!config) continue;

      tables.push({
        id: { wsId: objectType, remoteId: [objectType] },
        displayName: config.displayName,
        disabledCreates: config.disabledCreates ? true : undefined,
      });
    }

    // Custom objects
    try {
      const schemas = await this.client.getCustomObjectSchemas();
      for (const schema of schemas) {
        tables.push({
          id: {
            wsId: schema.fullyQualifiedName,
            remoteId: [schema.fullyQualifiedName],
          },
          displayName: schema.labels.plural,
          parentPath: 'Custom Objects',
        });
      }
    } catch (error) {
      // Custom object schemas may fail if the account doesn't have access
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to fetch custom object schemas, skipping',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return tables;
  }

  /**
   * Build the default TableView for a HubSpot object purely from its spec. The
   * object type is the spec's remote id (`fetchJsonTableSpec` derives it as
   * `id.remoteId[0]`), and the per-object display tuning (title/priority
   * columns, whether to blanket-hide the `hs_`-managed namespace) comes from
   * OBJECT_CONFIG. HubSpot always yields a view, so this never returns undefined.
   */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    const objectType = spec.id.remoteId[0];
    const config = OBJECT_CONFIG[objectType];
    return buildHubspotDefaultView(spec.schema, {
      titleFieldPath: config?.titleFieldPath,
      priorityFields: config?.priorityFields,
      hideHubspotManagedProperties: config?.hideHubspotManagedPropertiesByDefault ?? false,
    });
  }

  /**
   * Fetch the JSON Table Spec for a HubSpot object type.
   * Dynamically discovers properties via the Properties API.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const objectType = id.remoteId[0];
    const { spec, propertyNames } = await buildHubspotJsonTableSpec(id, objectType, this.client);
    this.propertyNamesCache.set(objectType, propertyNames);
    return spec;
  }

  /**
   * HubSpot supports incremental pulls when we know which property records the
   * object's last-modified date. Resolution order:
   *   1. Explicit `options.modifiedAtField` set on the data folder.
   *   2. Auto-detected property annotated `x-scratch-last-modified-field`
   *      (`hs_lastmodifieddate` / `lastmodifieddate` — the schema builder
   *      annotates whichever the object exposes).
   * Standard objects auto-detect with zero config; a custom object whose
   * modified-date property the annotation missed reports `NEEDS_CONFIGURATION`
   * until the user declares the property.
   */
  override incrementalPullSupport(
    options: PullRecordFilesOptions,
    tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    return hubspotIncrementalPullSupport(options, tableSpec);
  }

  /**
   * Pull records for an object type using cursor pagination.
   *
   * Full pull (default): scan every record via the list endpoint, including
   * associations. Incremental pull: switch to the CRM Search API filtered by the
   * resolved modified-date property (the clock-skewed watermark), re-fetch each
   * changed record via single-record GET to hydrate its `associations` (the
   * Search API never returns them, and emitting search results bare would wipe
   * previously-pulled association data from the record file), and return the
   * new watermark for the job to persist. Associations changed WITHOUT a
   * property change don't bump the modified date, so the periodic full pull
   * still reconciles that drift.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: HubspotDownloadProgress }) => Promise<void>,
    progress: HubspotDownloadProgress,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const objectType = tableSpec.id.remoteId[0];
    const propertyNames = await this.getPropertyNames(objectType);

    const modifiedAtField = resolveHubspotModifiedAtField(options, tableSpec);
    const isIncremental =
      options.pullMode === 'incremental' && modifiedAtField !== undefined && options.since instanceof Date;

    if (isIncremental && options.since && modifiedAtField) {
      // Capture the start-of-pull timestamp BEFORE the first API call so records
      // changed mid-pull aren't lost on the next run. Idempotent commits absorb
      // any duplicates this overlap creates.
      const newWatermark = new Date();
      const associationTypesToHydrate = this.getAssociationTypes(objectType);
      for await (const batch of this.client.searchRecordsModifiedSince(
        objectType,
        propertyNames,
        modifiedAtField,
        options.since,
        progress.afterCursor,
      )) {
        // The Search API returns `properties` but never `associations`, and the
        // pull job writes record files wholesale — so emitting search results
        // directly would rewrite a previously-pulled record WITHOUT its
        // `associations` key, silently wiping association data that is still
        // live in HubSpot (a downstream sync then nulls the FK at the
        // destination). Re-fetch each changed record via single-record GET —
        // the only endpoint besides list that embeds `associations` in the
        // same shape — so incremental files carry the same complete shape as
        // full-pull files. Costs one GET per changed record; incremental
        // deltas are small and `withRetry` absorbs 429s.
        let filesToEmit: ConnectorFile[];
        if (associationTypesToHydrate.length === 0) {
          filesToEmit = batch.records as unknown as ConnectorFile[];
        } else {
          const recordsWithAssociationsHydrated: ConnectorFile[] = [];
          for (const searchResultRecord of batch.records) {
            const fullRecordWithAssociations = await this.client.getRecord(
              objectType,
              searchResultRecord.id,
              propertyNames,
              associationTypesToHydrate,
            );
            // null means the record was deleted/archived between the search
            // page and this GET; skip it — deletion reconciliation owns that.
            if (fullRecordWithAssociations) {
              recordsWithAssociationsHydrated.push(fullRecordWithAssociations as unknown as ConnectorFile);
            }
          }
          filesToEmit = recordsWithAssociationsHydrated;
        }
        await callback({
          files: filesToEmit,
          connectorProgress: { afterCursor: batch.nextCursor },
        });
      }
      return { newWatermark };
    }

    const associations = this.getAssociationTypes(objectType);
    for await (const batch of this.client.listRecords(objectType, propertyNames, associations, progress.afterCursor)) {
      await callback({
        files: batch.records as unknown as ConnectorFile[],
        connectorProgress: { afterCursor: batch.nextCursor },
      });
    }
    return {};
  }

  /**
   * Fetch specific records by their IDs.
   * Uses individual GET requests since batch read doesn't support associations.
   */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const objectType = tableSpec.id.remoteId[0];
    const propertyNames = await this.getPropertyNames(objectType);
    const associations = this.getAssociationTypes(objectType);
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      const record = await this.client.getRecord(objectType, id, propertyNames, associations);
      if (record) {
        buffer.push(record as unknown as ConnectorFile);
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

  /**
   * Create records in HubSpot.
   * Creates the record first, then sets up associations if present.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const objectType = tableSpec.id.remoteId[0];
    const propertyNames = await this.getPropertyNames(objectType);
    const associationTypes = this.getAssociationTypes(objectType);
    const results: ConnectorFile[] = [];

    for (const file of files) {
      const properties = this.extractWritableProperties(file, tableSpec);
      const created = await this.client.createRecord(objectType, properties);

      // Create associations from the file
      const fileAssociations = (file as unknown as HubspotRecord).associations;
      if (fileAssociations) {
        await this.syncAssociations(objectType, created.id, {}, fileAssociations);
      }

      // Re-fetch with associations to get the complete state
      const complete = await this.client.getRecord(objectType, created.id, propertyNames, associationTypes);
      results.push((complete ?? created) as unknown as ConnectorFile);
    }

    return results;
  }

  /**
   * Update records in HubSpot.
   * Updates properties via PATCH, then diffs and syncs associations via v4 API.
   *
   * Published quotes are a special case: HubSpot locks them and rejects the
   * property PATCH, so their writes route through a recall → edit → re-publish
   * dance ({@link applyQuoteUpdateRecallingIfPublished}). Every other object type
   * takes the straight PATCH + association-sync path ({@link applyStandardUpdate}).
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const objectType = tableSpec.id.remoteId[0];
    const propertyNames = await this.getPropertyNames(objectType);
    const associationTypes = this.getAssociationTypes(objectType);

    const results: ConnectorFile[] = new Array<ConnectorFile>(files.length);
    const writtenIndexes: number[] = [];

    // Phase 1: writes. PATCH /properties and sync associations for side effects.
    // Track which indexes actually had a write so Phase 2 only refetches those.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const recordId = String(file.id);
      const cf = changedFields?.[i];

      const propertiesToWrite = this.computeWritablePropertiesToPublish(file, tableSpec, cf);
      // Only sync associations when this object supports them AND the changeset
      // touches them (a full publish — `cf` undefined — always does). An
      // `undefined` result means "leave associations alone".
      const shouldSyncAssociations = (!cf || 'associations' in cf) && associationTypes.length > 0;
      const desiredAssociations = shouldSyncAssociations
        ? ((file as unknown as HubspotRecord).associations ?? {})
        : undefined;

      const wrote =
        objectType === QUOTES_OBJECT_TYPE
          ? await this.applyQuoteUpdateRecallingIfPublished({
              recordId,
              propertiesToWrite,
              desiredAssociations,
              onDiskQuoteFile: file,
              propertyNames,
              associationTypes,
            })
          : await this.applyStandardUpdate({
              objectType,
              recordId,
              propertiesToWrite,
              desiredAssociations,
              propertyNames,
              associationTypes,
            });

      if (wrote) {
        writtenIndexes.push(i);
      } else {
        // No write fired for this row (empty changeset). Input is already
        // canonical — same as what the next pull would return.
        results[i] = file;
      }
    }

    // Phase 2: refetch. Mirror `pullRecordFilesByIds` (line 186) exactly so the
    // returned ConnectorFile is byte-equal to a fresh pull — sidestepping every
    // HubSpot-specific divergence: PATCH /properties returns only the default
    // property set, never returns associations, and server-side property
    // normalization (calculated fields, enum coercion) is only visible via GET.
    // Per-record GET because HubSpot's batchReadRecords endpoint doesn't
    // support `associations` (see hubspot-api-client.ts:172).
    for (const index of writtenIndexes) {
      const recordId = String(files[index].id);
      const refetched = await this.client.getRecord(objectType, recordId, propertyNames, associationTypes);
      // Record disappeared between write and refetch (e.g. concurrent delete).
      // Fall back to input file; the dispatch-site identity assertion will
      // catch any cross-row misalignment from a true mismatch.
      results[index] = (refetched as unknown as ConnectorFile) ?? files[index];
    }

    return results;
  }

  /**
   * Delete records from HubSpot. Ignores 404 errors.
   */
  async deleteRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const objectType = _tableSpec.id.remoteId[0];

    for (const file of files) {
      await this.client.deleteRecord(objectType, String(file.id));
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath);
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof HubspotError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          status: error.statusCode,
          category: error.category,
          responseData: error.responseData,
        },
      };
    }

    if (isAxiosError(error)) {
      // 403 from HubSpot means the PAT lacks the required scope for this object — not that the
      // token itself is invalid. Give a targeted message so users know to update their app scopes.
      if (error.response?.status === 403) {
        const url = error.config?.url ?? '';
        const match = url.match(/\/crm\/v3\/(?:properties|objects)\/([^/?]+)/);
        const objectType = match ? match[1] : null;
        return {
          userFriendlyMessage: objectType
            ? `Your HubSpot Private App token doesn't have permission to access "${objectType}". Add the required scope in your HubSpot Private App settings.`
            : `Your HubSpot Private App token doesn't have permission to access this object. Check your Private App scopes.`,
          description: error.message,
          additionalContext: { status: 403, url },
        };
      }

      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['message', 'category']),
        description: error.message,
        additionalContext: {
          status: error.response?.status,
        },
      };
    }

    return this.fallbackErrorDetails(error);
  }

  // --- Private helpers ---

  /**
   * Resolve the writable property payload to PATCH for one record, honoring the
   * (possibly deep) `changedFields` diff. Returns `{}` when the changeset touches
   * no writable property (association-only or empty changeset).
   *
   * Deep `changedFields`: only the specific sub-properties that changed are sent.
   * A read-only property present among them means the user genuinely edited a
   * read-only property (changedFields is the published-vs-working diff), so we
   * surface it loudly instead of silently dropping the edit (DEV-10597). A full
   * publish (`changedFields` undefined) or a shallow `{ properties: … }` marker
   * falls back to every writable property on the file.
   */
  private computeWritablePropertiesToPublish(
    file: ConnectorFile,
    tableSpec: BaseJsonTableSpec,
    changedFieldsForFile: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const cf = changedFieldsForFile;
    if (cf && !('properties' in cf)) {
      // The changeset names other keys (e.g. associations) but not properties —
      // nothing to PATCH.
      return {};
    }
    if (cf?.properties && typeof cf.properties === 'object' && !Array.isArray(cf.properties)) {
      const changedProps = cf.properties as Record<string, unknown>;
      const fileProps = (file as unknown as HubspotRecord).properties ?? {};
      const properties: Record<string, unknown> = {};
      const readonlyChangedPropertyNames: string[] = [];
      for (const propKey of Object.keys(changedProps)) {
        if (isReadonlyHubspotProperty(propKey, tableSpec)) {
          readonlyChangedPropertyNames.push(propKey);
          continue;
        }
        if (propKey in fileProps) {
          properties[propKey] = fileProps[propKey];
        }
      }
      if (readonlyChangedPropertyNames.length > 0) {
        throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedPropertyNames));
      }
      return properties;
    }
    return this.extractWritableProperties(file, tableSpec);
  }

  /**
   * Standard (non-quote) update: PATCH the writable properties, then diff+sync
   * associations. Returns whether any write fired (drives the Phase-2 refetch).
   */
  private async applyStandardUpdate(params: {
    objectType: string;
    recordId: string;
    propertiesToWrite: Record<string, unknown>;
    desiredAssociations: Record<string, HubspotAssociationResult> | undefined;
    propertyNames: string[];
    associationTypes: string[];
  }): Promise<boolean> {
    const { objectType, recordId, propertiesToWrite, desiredAssociations, propertyNames, associationTypes } = params;
    let wrote = false;

    if (Object.keys(propertiesToWrite).length > 0) {
      await this.client.updateRecord(objectType, recordId, propertiesToWrite);
      wrote = true;
    }

    if (desiredAssociations !== undefined) {
      // Fetch current remote state to compute the diff.
      const currentRecord = await this.client.getRecord(objectType, recordId, propertyNames, associationTypes);
      if (currentRecord) {
        await this.syncAssociations(objectType, recordId, currentRecord.associations ?? {}, desiredAssociations);
        // Conservative: mark as written even when syncAssociations was a no-op
        // (desired == current). The cost is one extra GET in the refetch phase;
        // the benefit is no need to plumb a "did anything actually change" signal
        // through syncAssociations.
        wrote = true;
      }
    }

    return wrote;
  }

  /**
   * Update a quote, transparently recalling it first if it's published/locked
   * (DEV-10886). HubSpot rejects a content PATCH on a published quote, so we do
   * its own "Recall & edit": recall to DRAFT, apply the edits, then set the
   * record's on-disk status (re-locking a recalled quote).
   *
   * The recall dance **owns `hs_status`**: it is stripped from the content PATCH
   * and applied only as the final step. That guarantees every content and
   * association write happens inside the unlocked (recalled) window — even on a
   * full publish, where `hs_status` would otherwise ride along in the content
   * PATCH and re-lock the quote before the associations are synced. It also
   * avoids a redundant second `hs_status` PATCH.
   *
   * One GET reads the live quote (its lock state + status + current associations),
   * reused for the association diff. Returns whether any write fired (drives the
   * Phase-2 refetch).
   *
   * Failure handling:
   *  - The recall itself is refused for a signed/paid quote → a clear, actionable
   *    error ({@link recallPublishedQuoteToDraftOrThrow}).
   *  - Any failure after a successful recall → best-effort restore of the original
   *    published status, so a live quote is never left silently unpublished
   *    ({@link bestEffortRestorePublishedQuoteStatus}).
   */
  private async applyQuoteUpdateRecallingIfPublished(params: {
    recordId: string;
    propertiesToWrite: Record<string, unknown>;
    desiredAssociations: Record<string, HubspotAssociationResult> | undefined;
    onDiskQuoteFile: ConnectorFile;
    propertyNames: string[];
    associationTypes: string[];
  }): Promise<boolean> {
    const { recordId, propertiesToWrite, desiredAssociations, onDiskQuoteFile, propertyNames, associationTypes } =
      params;

    // Split the payload: hs_status is driven by the recall dance (recall +
    // final-status step), never sent in the content PATCH.
    const statusChangeRequested = QUOTE_STATUS_PROPERTY_NAME in propertiesToWrite;
    const contentPropertiesToWrite = { ...propertiesToWrite };
    delete contentPropertiesToWrite[QUOTE_STATUS_PROPERTY_NAME];

    const hasContentPropertyEdits = Object.keys(contentPropertiesToWrite).length > 0;
    const hasAssociationChanges = desiredAssociations !== undefined;
    if (!hasContentPropertyEdits && !hasAssociationChanges && !statusChangeRequested) {
      return false;
    }

    // Read the live quote first (one GET, reused for the association diff below)
    // to learn whether it's locked and what its live status is. A quotes
    // property-only edit does one extra GET vs. the standard path — quotes are
    // low-volume, so the clarity is worth it.
    const remoteQuoteBeforeEdit = await this.client.getRecord(
      QUOTES_OBJECT_TYPE,
      recordId,
      propertyNames,
      associationTypes,
    );
    if (!remoteQuoteBeforeEdit) {
      // Quote vanished between plan and publish (concurrent delete). Nothing to
      // write; the refetch phase falls back to the input file. Non-destructive.
      return false;
    }

    const quoteWasPublishedAndLocked = isQuotePublishedAndLocked(remoteQuoteBeforeEdit);
    // Where the quote should end up (the user's intended final status, on-disk).
    const desiredFinalStatus = resolveQuoteDesiredFinalStatus(onDiskQuoteFile, remoteQuoteBeforeEdit);
    // Exactly what was live before we touched it — the failure-restore target.
    const liveStatusBeforeRecall = remoteQuoteBeforeEdit.properties?.[QUOTE_STATUS_PROPERTY_NAME] ?? undefined;

    if (quoteWasPublishedAndLocked) {
      await this.recallPublishedQuoteToDraftOrThrow(recordId);
    }
    // Status the quote sits at once content edits run: DRAFT if we recalled,
    // otherwise unchanged (the content PATCH never touches hs_status).
    const quoteStatusDuringEdits = quoteWasPublishedAndLocked ? QUOTE_DRAFT_STATUS : liveStatusBeforeRecall;

    try {
      if (hasContentPropertyEdits) {
        await this.client.updateRecord(QUOTES_OBJECT_TYPE, recordId, contentPropertiesToWrite);
      }
      if (desiredAssociations !== undefined) {
        // Synced while the quote is unlocked (still DRAFT if we recalled), before
        // the final status step below re-locks it.
        await this.syncAssociations(
          QUOTES_OBJECT_TYPE,
          recordId,
          remoteQuoteBeforeEdit.associations ?? {},
          desiredAssociations,
        );
      }
      // Final step: move hs_status to the desired end state. This re-publishes a
      // recalled quote and carries through a deliberate status change on an
      // unlocked one; no-op when it's already at the target.
      await this.setQuoteStatusIfChanged(recordId, quoteStatusDuringEdits, desiredFinalStatus);
    } catch (editOrRepublishError) {
      if (quoteWasPublishedAndLocked) {
        await this.bestEffortRestorePublishedQuoteStatus(recordId, liveStatusBeforeRecall);
      }
      throw editOrRepublishError;
    }

    return true;
  }

  /**
   * Recall a published quote by PATCHing `hs_status` → DRAFT, unlocking it for
   * edits. A quote that's been e-signed by all parties or paid can't be recalled
   * at all — HubSpot refuses the PATCH; convert that into a clear, actionable
   * error (routed through the per-record publish-failure path like any rejection).
   */
  private async recallPublishedQuoteToDraftOrThrow(recordId: string): Promise<void> {
    try {
      await this.client.updateRecord(QUOTES_OBJECT_TYPE, recordId, {
        [QUOTE_STATUS_PROPERTY_NAME]: QUOTE_DRAFT_STATUS,
      });
    } catch (error) {
      // Only a 400 VALIDATION_ERROR means "this quote can't be recalled" (signed/
      // paid). A 403 is a missing quote-write scope on the PAT — let it propagate
      // raw so extractConnectorErrorDetails routes it to the scope-specific
      // message instead of this (a HubspotError would be matched first and mask it).
      if (isAxiosError(error) && error.response?.status === 400) {
        throw new HubspotError(
          'This HubSpot quote has been signed or paid and can no longer be edited. HubSpot does not allow ' +
            'recalling a signed or paid quote. Undo the change to this quote, then publish again.',
          error.response.status,
          'QUOTE_NOT_RECALLABLE',
          error.response.data,
        );
      }
      throw error;
    }
  }

  /**
   * Move a quote's `hs_status` to `desiredStatus` as the final step of the recall
   * dance — re-publishing a recalled quote, or carrying through a deliberate
   * status change on an unlocked one. No-op when there's no desired status or it
   * already matches `currentStatus` (e.g. a recalled quote whose intended final
   * status is DRAFT, or an unlocked quote whose status didn't change), so we never
   * fire a pointless PATCH.
   */
  private async setQuoteStatusIfChanged(
    recordId: string,
    currentStatus: string | undefined,
    desiredStatus: string | undefined,
  ): Promise<void> {
    if (!desiredStatus || desiredStatus === currentStatus) {
      return;
    }
    await this.client.updateRecord(QUOTES_OBJECT_TYPE, recordId, { [QUOTE_STATUS_PROPERTY_NAME]: desiredStatus });
  }

  /**
   * After a recall succeeded but a later step failed, try to put the quote's
   * status back to what was live before recall, so we never leave a published
   * quote silently unpublished. Best-effort: a failure here is logged, not thrown
   * (the original edit error is what the caller re-throws).
   */
  private async bestEffortRestorePublishedQuoteStatus(
    recordId: string,
    liveStatusBeforeRecall: string | undefined,
  ): Promise<void> {
    if (!liveStatusBeforeRecall || liveStatusBeforeRecall === QUOTE_DRAFT_STATUS) {
      return;
    }
    try {
      await this.client.updateRecord(QUOTES_OBJECT_TYPE, recordId, {
        [QUOTE_STATUS_PROPERTY_NAME]: liveStatusBeforeRecall,
      });
    } catch (restoreError) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message:
          `Failed to restore published status "${liveStatusBeforeRecall}" for recalled quote ${recordId} ` +
          `after a publish error; the quote may be left in DRAFT and need manual re-publish`,
        error: restoreError instanceof Error ? restoreError.message : String(restoreError),
      });
    }
  }

  /**
   * Get cached property names for an object type, or fetch them.
   */
  private async getPropertyNames(objectType: string): Promise<string[]> {
    if (!this.propertyNamesCache.has(objectType)) {
      const properties = await this.client.getProperties(objectType);
      this.propertyNamesCache.set(
        objectType,
        properties.map((p) => p.name),
      );
    }
    return this.propertyNamesCache.get(objectType) ?? [];
  }

  /**
   * Get the association types for an object type.
   */
  private getAssociationTypes(objectType: string): string[] {
    return ASSOCIATIONS_BY_OBJECT_TYPE[objectType] ?? [];
  }

  /**
   * Extract writable properties from a file, skipping any marked readonly in the schema.
   */
  private extractWritableProperties(file: ConnectorFile, tableSpec: BaseJsonTableSpec): Record<string, unknown> {
    const properties = (file as unknown as HubspotRecord).properties;
    if (!properties) return {};

    const writable: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (isReadonlyHubspotProperty(key, tableSpec)) continue;
      writable[key] = value;
    }
    return writable;
  }

  /**
   * Sync associations by diffing current vs desired state.
   * Creates new associations and removes deleted ones.
   */
  private async syncAssociations(
    objectType: string,
    recordId: string,
    current: Record<string, { results: HubspotAssociation[] }>,
    desired: Record<string, { results: HubspotAssociation[] }>,
  ): Promise<void> {
    // Collect all association types from both current and desired
    const allAssocTypes = new Set([...Object.keys(current), ...Object.keys(desired)]);

    for (const assocType of allAssocTypes) {
      const currentIds = new Set((current[assocType]?.results ?? []).map((a) => a.id));
      const desiredIds = new Set((desired[assocType]?.results ?? []).map((a) => a.id));

      // Create new associations
      for (const id of desiredIds) {
        if (!currentIds.has(id)) {
          try {
            await this.client.createAssociation(objectType, recordId, assocType, id);
          } catch (error) {
            WSLogger.warn({
              source: LOG_SOURCE,
              message: `Failed to create association ${objectType}/${recordId} -> ${assocType}/${id}`,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // Delete removed associations
      for (const id of currentIds) {
        if (!desiredIds.has(id)) {
          try {
            await this.client.deleteAssociation(objectType, recordId, assocType, id);
          } catch (error) {
            WSLogger.warn({
              source: LOG_SOURCE,
              message: `Failed to delete association ${objectType}/${recordId} -> ${assocType}/${id}`,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  }
}

// --- Self-registration ---

connectorRegistry.register({
  service: Service.HUBSPOT,
  metadata: HubspotConnector.metadata,
  advancedSettings: HubspotConnector.advancedSettings,
  supportedAuthMethods: ['user_provided_params'],
  resolveIncrementalPullSupport: ({ options, tableSpec }) => hubspotIncrementalPullSupport(options, tableSpec),
  incrementalPullAutoDetectsFromSchema: true,
  rateLimiterSpec: { points: 10, duration: 1 }, // 10 req/s — HubSpot private apps allow 100 req/10s
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('Private app access token is required for HubSpot', Service.HUBSPOT);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount?.id ?? 'default');
    return new HubspotConnector(ctx.decryptedCredentials.apiKey, { rateLimiter });
  },
});
