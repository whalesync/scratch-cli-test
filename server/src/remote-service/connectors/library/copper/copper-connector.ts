import { connectorMetadata, TableView, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
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
  PullRecordFilesOptions,
  PullRecordFilesResult,
  readRecordIdAsString,
  TablePreview,
} from '../../types';
import { CopperApiClient, CopperError } from './copper-api-client';
import { buildCopperDefaultView } from './copper-default-view';
import { buildCopperJsonTableSpec, buildCopperReferenceTableSpec } from './copper-json-schema';
import { COPPER_LOGO_DATA_URI } from './copper-logo';
import {
  COPPER_ENTITY_CONFIG,
  COPPER_ENTITY_TYPES,
  COPPER_REFERENCE_ENTITY_CONFIG,
  COPPER_REFERENCE_ENTITY_TYPES,
  CopperDownloadProgress,
  CopperEntityType,
  isCopperReferenceEntityType,
} from './copper-types';

const LOG_SOURCE = 'CopperConnector';

/** Batch size for re-pulling specific records by id. */
const PULL_BY_IDS_BATCH_SIZE = 20;

/**
 * Connector for the Copper CRM.
 *
 * Supports six writable record entities: People, Companies, Opportunities,
 * Leads, Tasks, Projects. (Activities are deferred — read-only system rows,
 * no `date_modified`.) Listing is via `POST /{entity}/search` (offset
 * pagination); custom fields are discovered via `/custom_field_definitions`.
 *
 * v1 ships full-scan pull only; incremental is a fast-follow.
 */
export class CopperConnector extends Connector<string, CopperDownloadProgress> {
  readonly service = Service.COPPER;
  static readonly displayName = 'Copper';
  static readonly metadata = connectorMetadata({
    displayName: 'Copper',
    table: 'entity',
    tables: 'entities',
    logo: COPPER_LOGO_DATA_URI,
    // Validated end-to-end (all 6 entities full CRUD + custom-field reshape + FK move) — visible in production.
    visible: true,
    credentialFields: {
      user_provided_params: [
        { key: 'apiKey', type: 'password', label: 'API Key', placeholder: 'Enter your Copper API key', required: true },
        {
          key: 'email',
          type: 'string',
          label: 'Account Email',
          placeholder: 'The email the API key was generated under',
          required: true,
        },
      ],
    },
  });

  private readonly client: CopperApiClient;

  constructor(credentials: { apiKey: string; email: string }, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new CopperApiClient(credentials, opts);
  }

  async testConnection(): Promise<void> {
    await this.client.testConnection();
  }

  /** List the six writable entity types plus the read-only reference tables. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    const writable: TablePreview[] = COPPER_ENTITY_TYPES.map((entityType) => ({
      id: { wsId: entityType, remoteId: [entityType] },
      displayName: COPPER_ENTITY_CONFIG[entityType].displayName,
      metadata: { entityType },
    }));
    // Pipelines / Pipeline Stages: pull-only reference tables (no CRUD). They are
    // the FK targets of Opportunities.pipeline_id / pipeline_stage_id.
    const reference: TablePreview[] = COPPER_REFERENCE_ENTITY_TYPES.map((refType) => ({
      id: { wsId: refType, remoteId: [refType] },
      displayName: COPPER_REFERENCE_ENTITY_CONFIG[refType].displayName,
      disabledCreates: true,
      disabledUpdates: true,
      disabledDeletes: true,
      disabledReason: 'Copper pipelines/stages are a read-only reference table.',
      metadata: { entityType: refType },
    }));
    return [...writable, ...reference];
  }

  /**
   * Build the schema for a Copper entity: static system fields merged with
   * dynamically discovered custom field definitions.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    if (isCopperReferenceEntityType(id.wsId)) {
      return buildCopperReferenceTableSpec(id, id.wsId);
    }
    const entityType = this.resolveEntityType(id.wsId);
    const customFieldDefinitions = await this.client.listCustomFieldDefinitions();
    return buildCopperJsonTableSpec(id, entityType, customFieldDefinitions);
  }

  /**
   * Rebuild the default grid view from the spec alone. Read-only reference
   * tables (pipelines / pipeline stages) never carried a curated view — mirror
   * `fetchJsonTableSpec`'s dispatch and leave them view-less.
   */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    if (isCopperReferenceEntityType(spec.id.wsId)) {
      return undefined;
    }
    return buildCopperDefaultView(spec);
  }

  /**
   * Stream all records via offset-paginated `POST /{entity}/search`. Checkpoints
   * the next page so a stalled job resumes mid-table. Full-scan only in v1.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: CopperDownloadProgress }) => Promise<void>,
    progress: CopperDownloadProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    // Read-only reference tables: fetch the whole small list via GET (no pagination,
    // no custom-field reshape — these aren't record entities).
    if (isCopperReferenceEntityType(tableSpec.id.wsId)) {
      const records = await this.client.listReferenceEntities(
        COPPER_REFERENCE_ENTITY_CONFIG[tableSpec.id.wsId].endpoint,
      );
      if (records.length > 0) {
        await callback({ files: records as ConnectorFile[] });
      }
      return {};
    }

    const entityType = this.resolveEntityType(tableSpec.id.wsId);
    const startPage = typeof progress?.nextPage === 'number' && progress.nextPage > 0 ? progress.nextPage : 1;

    for await (const batch of this.client.listEntities(entityType, undefined, startPage)) {
      await callback({
        // Stored verbatim; each custom_fields element becomes an editable column
        // via the schema's x-scratch-array-keyed-by annotation (copper-custom-fields.ts).
        files: batch.records as ConnectorFile[],
        connectorProgress: { nextPage: batch.nextPage },
      });
    }
    return {};
  }

  /** Re-fetch specific records by id (e.g. after a publish). Skips 404s. */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    // Reference tables have no get-by-id; refetch the small list and filter.
    if (isCopperReferenceEntityType(tableSpec.id.wsId)) {
      const wanted = new Set(ids.map(String));
      const matched = (
        await this.client.listReferenceEntities(COPPER_REFERENCE_ENTITY_CONFIG[tableSpec.id.wsId].endpoint)
      ).filter((record) => wanted.has(String(record.id)));
      if (matched.length > 0) {
        await callback({ files: matched as ConnectorFile[] });
      }
      return;
    }

    const entityType = this.resolveEntityType(tableSpec.id.wsId);
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      const numericId = parseInt(id, 10);
      if (isNaN(numericId)) {
        WSLogger.warn({ source: LOG_SOURCE, message: `Invalid non-numeric id "${id}" for ${entityType}, skipping` });
        continue;
      }

      const record = await this.client.getEntity(entityType, numericId);
      if (record) {
        buffer.push(record as ConnectorFile);
      }

      if (buffer.length >= PULL_BY_IDS_BATCH_SIZE) {
        await callback({ files: buffer.splice(0) });
      }
    }

    if (buffer.length > 0) {
      await callback({ files: buffer });
    }
  }

  /** One request per record — no bulk write wired in v1. */
  getBatchSize(): number {
    return 1;
  }

  /** Create records; returns Copper's response (carries the assigned id). */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const entityType = this.resolveEntityType(tableSpec.id.wsId);
    const readonlyKeys = readonlyFieldKeys(tableSpec);
    const results: ConnectorFile[] = [];

    for (const file of files) {
      // Strip read-only system fields; the custom_fields array is sent verbatim
      // (Copper ignores writes to its own computed fields).
      const body = stripReadonlyFields(file, readonlyKeys);
      const created = await this.client.createEntity(entityType, body);
      results.push(created as ConnectorFile);
    }

    return results;
  }

  /** Update records. Prefers the sparse `changedFields` payload (Copper applies only sent fields). */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const entityType = this.resolveEntityType(tableSpec.id.wsId);
    const readonlyKeys = readonlyFieldKeys(tableSpec);
    const results: ConnectorFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const id = readRecordIdAsString(file, tableSpec.idPath);
      if (!id) {
        WSLogger.warn({ source: LOG_SOURCE, message: `Skipping update for ${entityType} record with no id` });
        continue;
      }

      const changed = changedFields?.[i];
      // Sparse changedFields lists only what the user changed, so a read-only key
      // here is a genuine read-only edit → surface it (DEV-10597). The no-diff
      // fallback re-sends the full record, where read-only system fields are
      // always present and must be stripped, not thrown on.
      // The sparse `changed.custom_fields` is already the [{custom_field_definition_id,
      // value}] array Copper expects (the publish diff is keyed-array-aware), so no
      // reshape is needed on either the request or the verbatim response.
      const body = changed
        ? extractChangedWritableFieldsOrThrowOnReadonly(changed, readonlyKeys)
        : stripReadonlyFields(file, readonlyKeys);
      const updated = await this.client.updateEntity(entityType, parseInt(id, 10), body);
      results.push(updated as ConnectorFile);
    }

    return results;
  }

  /** Delete records by id. Already-deleted (404) is a no-op. */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const entityType = this.resolveEntityType(tableSpec.id.wsId);

    for (const file of files) {
      const id = readRecordIdAsString(file, tableSpec.idPath);
      if (!id) continue;
      await this.client.deleteEntity(entityType, parseInt(id, 10));
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePath = tableSpec.titlePath && !tableSpec.titlePath.includes('.') ? tableSpec.titlePath : undefined;
    return suggestFileNamesFromFieldPaths(records, titlePath, 'name');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof CopperError) {
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
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['message', 'error']),
        description: error.message,
        additionalContext: { status: error.response?.status },
      };
    }

    return this.fallbackErrorDetails(error);
  }

  // --- Private helpers ---

  private resolveEntityType(wsId: string): CopperEntityType {
    if (isCopperReferenceEntityType(wsId)) {
      throw new CopperError(`'${wsId}' is a read-only reference table and cannot be written.`, 400);
    }
    if (!(COPPER_ENTITY_TYPES as string[]).includes(wsId)) {
      throw new CopperError(`Entity type '${wsId}' not found. Copper supports: ${COPPER_ENTITY_TYPES.join(', ')}`, 404);
    }
    return wsId as CopperEntityType;
  }
}

/** Collect the set of top-level field keys marked `x-scratch-readonly` in the schema. */
function readonlyFieldKeys(tableSpec: BaseJsonTableSpec): Set<string> {
  const keys = new Set<string>();
  const schema = tableSpec.schema as { properties?: Record<string, Record<string, unknown>> };
  const properties = schema.properties;
  if (!properties) return keys;
  for (const [key, fieldSchema] of Object.entries(properties)) {
    if (fieldSchema && fieldSchema[X_SCRATCH_READONLY] === true) {
      keys.add(key);
    }
  }
  return keys;
}

/** Return a copy of the record with read-only fields removed (never sent on write). */
function stripReadonlyFields(record: Record<string, unknown>, readonlyKeys: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (readonlyKeys.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build the writable update payload from the user's sparse changed fields,
 * throwing if any changed field is read-only. Unlike {@link stripReadonlyFields}
 * (used for the full-record create / no-diff fallback), the keys here are only
 * the fields the user actually changed, so a read-only key means a genuine
 * read-only edit that must be surfaced rather than silently dropped (DEV-10597).
 */
function extractChangedWritableFieldsOrThrowOnReadonly(
  changedRecord: Record<string, unknown>,
  readonlyKeys: Set<string>,
): Record<string, unknown> {
  const writableFields: Record<string, unknown> = {};
  const readonlyChangedFieldKeys: string[] = [];
  for (const [key, value] of Object.entries(changedRecord)) {
    if (readonlyKeys.has(key)) {
      readonlyChangedFieldKeys.push(key);
      continue;
    }
    writableFields[key] = value;
  }
  if (readonlyChangedFieldKeys.length > 0) {
    throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedFieldKeys));
  }
  return writableFields;
}

connectorRegistry.register({
  service: Service.COPPER,
  metadata: CopperConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  rateLimiterSpec: { points: 3, duration: 1 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    const apiKey = ctx.decryptedCredentials?.apiKey;
    const email = ctx.decryptedCredentials?.email;
    if (!apiKey || !email) {
      throw new ConnectorInstantiationError('API key and account email are required for Copper', Service.COPPER);
    }
    const rateLimiter = ctx.connectorAccount ? ctx.createRateLimiter(ctx.connectorAccount.id) : undefined;
    return new CopperConnector({ apiKey, email }, { rateLimiter });
  },
});
