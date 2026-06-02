import { connectorMetadata, ConnectorSettingDefinition, IncrementalPullSupport } from '@spinner/shared-types';
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
import { AirtableApiClient } from './airtable-api-client';
import { buildAirtableModifiedSinceFormula, combineAirtableFormulas } from './airtable-incremental';
import { buildAirtableJsonTableSpec, isReadonlyField } from './airtable-json-schema';
import { AirtableSchemaParser } from './airtable-schema-parser';

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
    oauth: { label: 'OAuth' },
    credentialFields: {
      user_provided_params: [
        { key: 'apiKey', type: 'password', label: 'API Key', placeholder: 'Enter API Key', required: true },
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
      description:
        'Name of a Last Modified Time field on this table. Enables incremental pulls — when set, scheduled INCREMENTAL_PULL runs fetch only records modified since the previous run. Leave empty to always do full pulls.',
      placeholder: 'e.g. Last Modified Time',
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

  /**
   * Suggest filenames from the Airtable primary field (display name).
   * Airtable records have shape: { id, fields: { "Field Name": value }, createdTime }
   */
  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const primaryFieldName = this.resolvePrimaryFieldName(tableSpec);
    if (!primaryFieldName) {
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath ?? tableSpec.slugColumnRemoteId);
    }
    return records.map((record) => {
      const value = _.get(record, ['fields', primaryFieldName]) as unknown;
      return typeof value === 'string' && value.trim() ? value : undefined;
    });
  }

  /**
   * Resolve the primary field name for filename extraction.
   * titleColumnRemoteId is now ['fields', fieldName], so just return the field name directly.
   */
  private resolvePrimaryFieldName(tableSpec: BaseJsonTableSpec): string | undefined {
    if (!tableSpec.titleColumnRemoteId || tableSpec.titleColumnRemoteId.length === 0) {
      return undefined;
    }

    // titleColumnRemoteId is ['fields', fieldName] — return the field name directly
    if (tableSpec.titleColumnRemoteId.length >= 2) {
      return tableSpec.titleColumnRemoteId[1];
    }

    // Fallback for single-element array (shouldn't happen with new schema)
    if (tableSpec.titleColumnRemoteId.length === 1) {
      return tableSpec.titleColumnRemoteId[0];
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
      fields: this.processFieldDataWithSchema(changedFields[i] as ConnectorFile, tableSpec),
    }));

    const updated = await this.client.updateRecords(baseId, tableId, airtableRecords);
    return updated.map((record) => record as unknown as ConnectorFile);
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
