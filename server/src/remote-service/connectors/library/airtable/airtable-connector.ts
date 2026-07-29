import {
  connectorMetadata,
  ConnectorSettingDefinition,
  CreateFieldResult,
  CreateTableResult,
  IncrementalPullSupport,
  SchemaCreationCapabilities,
  TableView,
} from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import _ from 'lodash';
import { ConnectorAssetExtractionInput, ConnectorAssetResult } from 'src/asset/asset.types';
import { RateLimiter, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { defaultResolveFieldValue, extractFromAnnotatedSchema } from '../../asset-extraction-helpers';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
  ReadonlyFieldEditError,
  readonlyFieldEditErrorMessage,
} from '../../error';
import {
  type NormalizedCreateFieldsPlan,
  type NormalizedCreateTablePlan,
  type ResolvedCreateFieldSpec,
} from '../../schema-creation.types';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  CreateDestination,
  EntityId,
  findLastModifiedFieldName,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../types';
import { AirtableApiClient } from './airtable-api-client';
import {
  AIRTABLE_SCHEMA_CREATION_CAPABILITIES,
  buildAirtableCreateField,
  isAirtablePrimaryEligibleKind,
} from './airtable-create-schema';
import { buildAirtableDefaultView } from './airtable-default-view';
import { buildAirtableModifiedSinceFormula, combineAirtableFormulas } from './airtable-incremental';
import { buildAirtableJsonTableSpec, isReadonlyField } from './airtable-json-schema';
import { AirtableSchemaParser } from './airtable-schema-parser';
import { type AirtableApiCreateField } from './airtable-types';

interface AirtablePullOptions extends PullRecordFilesOptions {
  filter?: string | undefined;
  // A view ID to pull records from. If not provided, all records will be pulled.
  view?: string | undefined;
}

/**
 * Resolve the field name to use for the modified-since filter, preferring an
 * explicit user setting over the schema-annotated auto-detection. Pure (no
 * `this`) so both the connector instance and the REST-layer capability resolver
 * can call it. A `null` tableSpec means no schema is on hand, so only an
 * explicit `options.modifiedAtField` can resolve.
 */
export function resolveAirtableModifiedAtField(
  options: PullRecordFilesOptions,
  tableSpec: BaseJsonTableSpec | null,
): string | undefined {
  if (typeof options.modifiedAtField === 'string' && options.modifiedAtField.trim() !== '') {
    return options.modifiedAtField.trim();
  }
  return tableSpec ? findLastModifiedFieldName(tableSpec) : undefined;
}

/**
 * Three-state incremental-pull capability for Airtable. Airtable can always do
 * incremental pulls once a last-modified field is known, so the only two
 * outcomes are `SUPPORTED` (an explicit or auto-detected field exists) and
 * `NEEDS_CONFIGURATION` (neither — the user must pick a field, or the table has
 * no `lastModifiedTime` column to auto-detect).
 */
export function airtableIncrementalPullSupport(
  options: PullRecordFilesOptions,
  tableSpec: BaseJsonTableSpec | null,
): IncrementalPullSupport {
  return resolveAirtableModifiedAtField(options, tableSpec) !== undefined
    ? IncrementalPullSupport.SUPPORTED
    : IncrementalPullSupport.NEEDS_CONFIGURATION;
}

export class AirtableConnector extends Connector {
  readonly service = Service.AIRTABLE;
  static readonly displayName = 'Airtable';
  static readonly metadata = connectorMetadata({
    displayName: 'Airtable',
    base: 'base',
    bases: 'bases',
    logo: 'https://static.scratch.md/connector-icons/airtable.svg',
    incrementalPull: true,
    incrementalPullInstructions:
      'To enable incremental pulls, this table must contain a timestamp column that tracks when a row was last changed (e.g. updated_at).',
    // Airtable implements the create-schema seam (supportsSchemaCreation() === true).
    supportsSchemaCreation: true,
    oauth: { label: 'OAuth' },
    credentialFields: {
      user_provided_params: [
        { key: 'apiKey', type: 'password', label: 'Personal Access Token', placeholder: 'pat...', required: true },
      ],
    },
  });
  static readonly advancedSettings: ConnectorSettingDefinition[] = [
    {
      key: 'view',
      type: 'string',
      label: 'View',
      description: 'Airtable view ID to pull records from. Leave empty to pull all records.',
      placeholder: 'Enter view ID...',
    },
    {
      key: 'modifiedAtField',
      type: 'field-select',
      label: 'Last modified time field',
      description: 'Select a Last Modified Time field on this table to enable incremental pulls.',
      placeholder: 'e.g. Last Modified Time',
      // Incremental pull needs a full timestamp watermark, so only date-time
      // fields qualify (a date-only field lacks the time precision). Airtable
      // maps Last Modified Time (and Created Time / Date-time) to JSON Schema
      // `format: 'date-time'`, so the picker offers only those.
      fieldSelectFormats: ['date-time'],
    },
  ];

  private readonly client: AirtableApiClient;
  private readonly schemaParser = new AirtableSchemaParser();

  constructor(apiKey: string, opts?: { rateLimiter?: RateLimiter; retryOverrides?: Partial<WithRetryOpts> }) {
    super();
    this.client = new AirtableApiClient(apiKey, {
      rateLimiter: opts?.rateLimiter,
      retryOverrides: opts?.retryOverrides,
    });
  }

  public async testConnection(): Promise<void> {
    // Don't throw.
    await this.client.listBases();
  }

  /**
   * Airtable doesn't expose API quota via its API, but usage is visible in the
   * workspace billing page. We look up the workspaceId from the first base and
   * return a dashboard link so the user can check manually.
   */
  async getApiQuota(): Promise<{ dashboardUrl: string }> {
    const bases = await this.client.listBases();
    const firstBase = bases.bases[0];
    if (!firstBase) {
      return { dashboardUrl: 'https://airtable.com' };
    }
    const metadata = await this.client.getBaseMetadata(firstBase.id);
    return { dashboardUrl: `https://airtable.com/${metadata.workspaceId}/workspace/billing` };
  }

  async listTables(): Promise<TablePreview[]> {
    const bases = await this.client.listBases();
    const tables: TablePreview[] = [];
    for (const base of bases.bases) {
      const baseSchema = await this.client.getBaseSchema(base.id);
      tables.push(...baseSchema.tables.map((table) => this.schemaParser.parseTablePreview(base, table)));
    }
    return tables;
  }

  /** A new Airtable table lives inside a base, so the create destinations are the user's bases. */
  override async listCreateDestinations(): Promise<CreateDestination[]> {
    const bases = await this.client.listBases();
    return bases.bases.map((base) => ({ id: base.id, name: base.name }));
  }

  /**
   * Fetch JSON Table Spec directly from the Airtable API for a table.
   * Returns a schema that describes the raw Airtable record format:
   * { id: string, fields: { ... }, createdTime: string }
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const [baseId, tableId] = id.remoteId;
    const bases = await this.client.listBases();
    const base = bases.bases.find((b) => b.id === baseId);
    if (!base) {
      throw new Error(`Base ${baseId} not found`);
    }
    const baseSchema = await this.client.getBaseSchema(baseId);
    const table = baseSchema.tables.find((t) => t.id === tableId);
    if (!table) {
      throw new Error(`Table ${tableId} not found in base ${baseId}`);
    }

    return buildAirtableJsonTableSpec(id, base, table);
  }

  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    return buildAirtableDefaultView(spec);
  }

  /**
   * Suggest filenames from the Airtable primary field (display name).
   * Airtable records have shape: { id, fields: { "Field Name": value }, createdTime }
   */
  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const primaryFieldName = this.resolvePrimaryFieldName(tableSpec);
    if (!primaryFieldName) {
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath ?? tableSpec.slugColumnRemoteId);
    }
    return records.map((record) => {
      const value = _.get(record, ['fields', primaryFieldName]) as unknown;
      return typeof value === 'string' && value.trim() ? value : undefined;
    });
  }

  /**
   * Resolve the primary field name for filename extraction.
   * titlePath is now the dot path 'fields.<fieldName>', so split it back into
   * segments and return the field name (the segment after 'fields').
   *
   * Caveat: an Airtable field name containing a literal `.` over-splits here and
   * yields a truncated name (see `BaseJsonTableSpec.titlePath`). This only affects
   * the suggested filename — it falls back to the record id — never correctness.
   */
  private resolvePrimaryFieldName(tableSpec: BaseJsonTableSpec): string | undefined {
    if (!tableSpec.titlePath) {
      return undefined;
    }

    const titlePathSegments = _.toPath(tableSpec.titlePath);
    // 'fields.<fieldName>' — return the field name directly.
    if (titlePathSegments.length >= 2) {
      return titlePathSegments[1];
    }

    // Fallback for a single-segment path (shouldn't happen with the current schema).
    if (titlePathSegments.length === 1) {
      return titlePathSegments[0];
    }

    return undefined;
  }

  /**
   * Airtable supports incremental pulls when we know which field on the table
   * stores the row's last-modified timestamp. Resolution order:
   *   1. Explicit `options.modifiedAtField` set on the data folder.
   *   2. Auto-detected field: any column whose schema is annotated with
   *      `x-scratch-last-modified-field` (Airtable's `lastModifiedTime` field
   *      type is annotated this way by the schema builder).
   * Without either, we can't build the `IS_AFTER` filter, so we report no
   * support and the job demotes the run to a full scan.
   */
  override incrementalPullSupport(
    options: PullRecordFilesOptions,
    tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    return airtableIncrementalPullSupport(options, tableSpec);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: AirtablePullOptions,
  ): Promise<PullRecordFilesResult> {
    const [baseId, tableId] = tableSpec.id.remoteId;

    const modifiedAtField = resolveAirtableModifiedAtField(options, tableSpec);
    const isIncremental =
      options.pullMode === 'incremental' && modifiedAtField !== undefined && options.since instanceof Date;

    let newWatermark: Date | undefined;
    let filterByFormula: string | undefined;

    if (isIncremental && options.since && modifiedAtField) {
      // Capture the start-of-pull timestamp BEFORE the first API call so we
      // don't lose changes that happen mid-pull. Idempotent commits absorb
      // any duplicates this overlap creates.
      newWatermark = new Date();
      const incrementalFormula = buildAirtableModifiedSinceFormula(modifiedAtField, options.since);
      filterByFormula = combineAirtableFormulas(options.filter, incrementalFormula);
    } else {
      filterByFormula = options.filter && options.filter.trim() !== '' ? options.filter : undefined;
    }

    const view = options.view ?? undefined;
    const resumeOffset = (progress as { airtableOffset?: string })?.airtableOffset;

    for await (const batch of this.client.listRecords(baseId, tableId, {
      filterByFormula,
      view,
      resumeOffset,
    })) {
      await callback({
        files: batch.records as unknown as ConnectorFile[],
        connectorProgress: batch.nextOffset ? { airtableOffset: batch.nextOffset } : {},
      });
    }

    return newWatermark ? { newWatermark } : {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const [baseId, tableId] = tableSpec.id.remoteId;
    const BATCH_SIZE = 100;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const filterByFormula = `OR(${batch.map((id) => `RECORD_ID()='${id}'`).join(',')})`;

      for await (const batch of this.client.listRecords(baseId, tableId, { filterByFormula })) {
        await callback({ files: batch.records as unknown as ConnectorFile[] });
      }
    }
  }

  getBatchSize(): number {
    return 10;
  }

  // -------------------------------------------------------------------------
  // Schema creation (create-schema API — DEV-10379)
  // -------------------------------------------------------------------------

  override supportsSchemaCreation(): boolean {
    return true;
  }

  override getSchemaCreationCapabilities(): SchemaCreationCapabilities {
    return AIRTABLE_SCHEMA_CREATION_CAPABILITIES;
  }

  /**
   * Create one table and its non-deferred fields in a single Airtable create-table
   * call. The target base is `plan.remoteParentId[0]` (Airtable has no default base
   * and cannot create one via API, so a missing base fails the table). Airtable
   * requires the primary field to be `fields[0]`, so the `isPrimary` field is moved
   * to the front; fields that can't be mapped (a cross-base link) become per-field
   * skips. Creates are NOT idempotent — re-running creates a second table.
   */
  override async createTable(plan: NormalizedCreateTablePlan): Promise<CreateTableResult> {
    const baseId = plan.remoteParentId?.[0];
    if (!baseId) {
      return this.failedTableResult(plan, 'Airtable requires a target base (remoteParentId) to create a table');
    }

    // Map every requested field to an Airtable field request or a skip reason.
    const skippedFieldReasons = new Map<string, string>();
    const builtFieldsByName = new Map<string, AirtableApiCreateField>();
    for (const field of plan.fields) {
      const built = buildAirtableCreateField(field, { baseId });
      if ('skip' in built) {
        skippedFieldReasons.set(field.name, built.skip);
      } else {
        builtFieldsByName.set(field.name, built.field);
      }
    }

    // Airtable mandates a primary field as fields[0], of a primary-eligible type.
    // The generic validator enforces this for a vetted request; guard defensively
    // for direct/un-validated callers.
    const primaryField = this.selectPrimaryField(plan.fields, skippedFieldReasons);
    if (!primaryField) {
      return this.failedTableResult(
        plan,
        'Airtable requires a primary field with a text-like type; none of the requested fields can be the primary',
      );
    }
    const primaryBuiltField = builtFieldsByName.get(primaryField.name);
    if (!primaryBuiltField) {
      return this.failedTableResult(
        plan,
        skippedFieldReasons.get(primaryField.name) ?? 'the primary field could not be created',
      );
    }

    // Order built fields with the primary first, preserving request order otherwise.
    // Record links beyond the first to any one target table are held back — see
    // `selectLinkFieldNamesToAddAfterTableCreation`.
    const linkFieldNamesToAddAfterCreation = this.selectLinkFieldNamesToAddAfterTableCreation(
      plan.fields,
      builtFieldsByName,
      primaryField.name,
    );
    const orderedFields: AirtableApiCreateField[] = [primaryBuiltField];
    for (const field of plan.fields) {
      if (field.name === primaryField.name || linkFieldNamesToAddAfterCreation.has(field.name)) {
        continue;
      }
      const built = builtFieldsByName.get(field.name);
      if (built) {
        orderedFields.push(built);
      }
    }

    try {
      const response = await this.client.createTable(baseId, { name: plan.name, fields: orderedFields });
      const remoteFieldIdByName = new Map<string, string>(
        response.fields.map((field): [string, string] => [field.name, field.id]),
      );
      const failedFieldReasons = new Map<string, string>();
      for (const fieldName of linkFieldNamesToAddAfterCreation) {
        const built = builtFieldsByName.get(fieldName);
        if (!built) {
          continue;
        }
        try {
          const addedField = await this.client.createField(baseId, response.id, built);
          remoteFieldIdByName.set(fieldName, addedField.id);
        } catch (error) {
          failedFieldReasons.set(fieldName, this.extractConnectorErrorDetails(error).userFriendlyMessage);
        }
      }
      return {
        ref: plan.ref,
        name: plan.name,
        status: skippedFieldReasons.size > 0 || failedFieldReasons.size > 0 ? 'partial' : 'created',
        remoteTableId: [baseId, response.id],
        fields: this.buildFieldResults(plan.fields, skippedFieldReasons, remoteFieldIdByName, failedFieldReasons),
      };
    } catch (error) {
      return {
        ref: plan.ref,
        name: plan.name,
        status: 'failed',
        fields: plan.fields.map((field) => ({ name: field.name, status: 'failed' as const })),
        error: this.extractConnectorErrorDetails(error).userFriendlyMessage,
      };
    }
  }

  /**
   * Add fields to an existing table — one Airtable create-field call per field so a
   * single bad field fails in isolation. Also used by the server to add deferred
   * cyclic/self record-link fields after every table in a multi-table create
   * exists. `plan.remoteTableId` is `[baseId, tableId]`.
   */
  override async createFields(plan: NormalizedCreateFieldsPlan): Promise<CreateFieldResult[]> {
    const [baseId, tableId] = plan.remoteTableId;
    if (!baseId || !tableId) {
      return plan.fields.map((field) => ({
        name: field.name,
        status: 'failed' as const,
        error: 'Airtable requires a [baseId, tableId] remote table id to add fields',
      }));
    }

    const results: CreateFieldResult[] = [];
    for (const field of plan.fields) {
      const built = buildAirtableCreateField(field, { baseId });
      if ('skip' in built) {
        results.push({ name: field.name, status: 'skipped', error: built.skip });
        continue;
      }
      try {
        const response = await this.client.createField(baseId, tableId, built.field);
        results.push({ name: field.name, status: 'created', remoteFieldId: response.id });
      } catch (error) {
        results.push({
          name: field.name,
          status: 'failed',
          error: this.extractConnectorErrorDetails(error).userFriendlyMessage,
        });
      }
    }
    return results;
  }

  /**
   * Names of the record-link fields that must be added AFTER the table exists,
   * one create-field call each, rather than batched into `createTable`.
   *
   * Airtable auto-creates a reciprocal ("mirror") link field on the target table
   * for every link field pointing at it, named after the table the mirror points
   * back at. Created ONE AT A TIME, Airtable de-duplicates that name — the second
   * mirror becomes `"People 2"`. Created in a SINGLE `createTable` call, that
   * de-duplication does not happen: N links to the same target leave N mirrors on
   * the target ALL named `"People"`. Airtable then rejects every record write to
   * the target keyed by that name with `Ambiguous field name: "People"`, and the
   * duplicate columns cannot be repaired through the API (there is no delete-field
   * endpoint, and renaming to a name already in use is refused) — DEV-11101.
   *
   * So the first link to a given target rides along in `createTable` and each
   * additional link to that SAME target is held back, letting Airtable's own
   * de-duplication run. Links to distinct targets never collide, so they stay
   * batched. Skipped fields (e.g. a cross-base link) are ignored here.
   */
  private selectLinkFieldNamesToAddAfterTableCreation(
    fields: ResolvedCreateFieldSpec[],
    builtFieldsByName: Map<string, AirtableApiCreateField>,
    primaryFieldName: string,
  ): Set<string> {
    const namesToAddAfterCreation = new Set<string>();
    const targetTableIdsAlreadyLinkedInBatch = new Set<string>();
    for (const field of fields) {
      const built = builtFieldsByName.get(field.name);
      if (!built || built.type !== 'multipleRecordLinks') {
        continue;
      }
      const linkedTableId = built.options.linkedTableId;
      if (!targetTableIdsAlreadyLinkedInBatch.has(linkedTableId)) {
        targetTableIdsAlreadyLinkedInBatch.add(linkedTableId);
        continue;
      }
      // Airtable requires the primary field in the batched create, and a record
      // link can never be the primary — but guard rather than silently drop it.
      if (field.name !== primaryFieldName) {
        namesToAddAfterCreation.add(field.name);
      }
    }
    return namesToAddAfterCreation;
  }

  /**
   * Choose the field Airtable will treat as the primary (`fields[0]`): the
   * `isPrimary`-designated field when it maps to a primary-eligible type, otherwise
   * (defensively) the first primary-eligible, non-skipped field. Returns `undefined`
   * when no field can be the primary.
   */
  private selectPrimaryField(
    fields: ResolvedCreateFieldSpec[],
    skippedFieldReasons: Map<string, string>,
  ): ResolvedCreateFieldSpec | undefined {
    const isEligible = (field: ResolvedCreateFieldSpec): boolean =>
      !skippedFieldReasons.has(field.name) && isAirtablePrimaryEligibleKind(field.fieldType.kind);

    const designatedPrimaryField = fields.find((field) => field.isPrimary);
    if (designatedPrimaryField && isEligible(designatedPrimaryField)) {
      return designatedPrimaryField;
    }
    return fields.find(isEligible);
  }

  /**
   * Build the per-field result list: each requested field is `created` (with its
   * Airtable field id when the response returned one) unless it was skipped or
   * failed, in which case the reason is surfaced. `failedFieldReasons` covers the
   * held-back record links added after the table was created (see
   * {@link selectLinkFieldNamesToAddAfterTableCreation}), which can fail on their
   * own without failing the table.
   */
  private buildFieldResults(
    fields: ResolvedCreateFieldSpec[],
    skippedFieldReasons: Map<string, string>,
    remoteFieldIdByName: Map<string, string>,
    failedFieldReasons: Map<string, string> = new Map(),
  ): CreateFieldResult[] {
    return fields.map((field) => {
      const skipReason = skippedFieldReasons.get(field.name);
      if (skipReason !== undefined) {
        return { name: field.name, status: 'skipped', error: skipReason };
      }
      const failureReason = failedFieldReasons.get(field.name);
      if (failureReason !== undefined) {
        return { name: field.name, status: 'failed', error: failureReason };
      }
      const remoteFieldId = remoteFieldIdByName.get(field.name);
      return remoteFieldId !== undefined
        ? { name: field.name, status: 'created', remoteFieldId }
        : { name: field.name, status: 'created' };
    });
  }

  /** A whole-table `failed` result with every field marked failed and a shared reason. */
  private failedTableResult(plan: NormalizedCreateTablePlan, error: string): CreateTableResult {
    return {
      ref: plan.ref,
      name: plan.name,
      status: 'failed',
      fields: plan.fields.map((field) => ({ name: field.name, status: 'failed' as const })),
      error,
    };
  }

  /**
   * Create records in Airtable from raw JSON files.
   * Files should be in Airtable's native format: { fields: { "Field Name": value } }
   * Returns the created records with their new IDs.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const [baseId, tableId] = tableSpec.id.remoteId;

    // Extract the fields from each file (Airtable expects { fields: {...} })
    const airtableRecords = files.map((file) => ({
      fields: this.processFieldDataWithSchema(file, tableSpec),
    }));

    const created = await this.client.createRecords(baseId, tableId, airtableRecords);

    // Return the created records as ConnectorFiles
    return created.map((record) => record as unknown as ConnectorFile);
  }

  /**
   * Update records in Airtable from raw JSON files.
   * Files should have an 'id' field and the fields to update.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const [baseId, tableId] = tableSpec.id.remoteId;

    const airtableRecords = files.map((file, i) => ({
      id: file.id as string,
      fields: this.extractChangedWritableFieldsOrThrowOnReadonly(changedFields[i] as ConnectorFile, tableSpec),
    }));

    const updated = await this.client.updateRecords(baseId, tableId, airtableRecords);
    return updated.map((record) => record as unknown as ConnectorFile);
  }

  /**
   * Build the `fields` payload for an UPDATE from the user's sparse changed
   * fields. Unlike {@link processFieldDataWithSchema} (used for create, which
   * receives the full record and must drop the service's computed fields), the
   * argument here lists ONLY the fields the user actually changed — so a
   * read-only field present in it means the user edited a read-only field. We
   * surface that loudly instead of silently dropping it (DEV-10597): stripping
   * it would PATCH `fields: {}`, which Airtable accepts as a 200 no-op, and the
   * user's edit would vanish while the publish reported success.
   */
  extractChangedWritableFieldsOrThrowOnReadonly(
    changedFile: ConnectorFile,
    tableSpec: BaseJsonTableSpec,
  ): Record<string, unknown> {
    const changedFields = (changedFile.fields as Record<string, unknown>) || {};
    const writableFields: Record<string, unknown> = {};
    const readonlyChangedFieldNames: string[] = [];

    for (const [key, value] of Object.entries(changedFields)) {
      if (value === undefined || key === 'id') {
        continue;
      }
      if (isReadonlyField(key, tableSpec)) {
        readonlyChangedFieldNames.push(key);
        continue;
      }
      writableFields[key] = value;
    }

    if (readonlyChangedFieldNames.length > 0) {
      throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedFieldNames));
    }

    return writableFields;
  }

  /**
   * Delete records from Airtable.
   * Files should have an 'id' field with the record ID to delete.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const [baseId, tableId] = tableSpec.id.remoteId;
    const recordIds = files.map((file) => file.id as string);
    await this.client.deleteRecords(baseId, tableId, recordIds);
  }

  /**
   * Process a ConnectorFile using the JSON table spec to extract writable fields.
   * Filters out the 'id' field and any fields marked as read-only in the schema.
   */
  processFieldDataWithSchema(file: ConnectorFile, tableSpec: BaseJsonTableSpec): Record<string, unknown> {
    const fields = (file.fields as Record<string, unknown>) || {};
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }

      // Skip the id field
      if (key === 'id') {
        continue;
      }

      // Skip read-only fields
      if (isReadonlyField(key, tableSpec)) {
        continue;
      }

      result[key] = value;
    }

    return result;
  }

  extractAssets(input: ConnectorAssetExtractionInput): ConnectorAssetResult[] {
    return extractFromAnnotatedSchema(input, {
      extractUrl: (item) => (typeof item['url'] === 'string' ? item['url'] : undefined),
      resolveFieldValue: defaultResolveFieldValue,
    });
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['error.message', 'error']),
        description: error.message,
        additionalContext: {
          status: error.response?.status,
        },
      };
    }
    return this.fallbackErrorDetails(error);
  }

  supportsFilters(): boolean {
    return true;
  }
}

connectorRegistry.register({
  service: Service.AIRTABLE,
  metadata: AirtableConnector.metadata,
  advancedSettings: AirtableConnector.advancedSettings,
  supportedAuthMethods: ['oauth', 'user_provided_params'],
  rateLimiterSpec: { points: 5, duration: 1 },
  resolveIncrementalPullSupport: ({ options, tableSpec }) => airtableIncrementalPullSupport(options, tableSpec),
  incrementalPullAutoDetectsFromSchema: true,
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Airtable', Service.AIRTABLE);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
      return new AirtableConnector(accessToken, { rateLimiter });
    } else {
      if (!ctx.decryptedCredentials?.apiKey) {
        throw new ConnectorInstantiationError('API key is required for Airtable', Service.AIRTABLE);
      }
      return new AirtableConnector(ctx.decryptedCredentials.apiKey, { rateLimiter });
    }
  },
});
