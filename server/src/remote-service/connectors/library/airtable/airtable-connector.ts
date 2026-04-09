import { connectorMetadata, ConnectorPullOptions, ConnectorSettingDefinition } from '@spinner/shared-types';
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
import { REMOTE_FIELD_ID } from '../../json-schema';
import { Service } from '../../service-constants';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import { AirtableApiClient } from './airtable-api-client';
import { buildAirtableJsonTableSpec, isReadonlyField } from './airtable-json-schema';
import { AirtableSchemaParser } from './airtable-schema-parser';

interface AirtablePullOptions extends ConnectorPullOptions {
  filter?: string | undefined;
  // A view ID to pull records from. If not provided, all records will be pulled.
  view?: string | undefined;
}

export class AirtableConnector extends Connector {
  readonly service = Service.AIRTABLE;
  static readonly displayName = 'Airtable';
  static readonly metadata = connectorMetadata({
    displayName: 'Airtable',
    base: 'base',
    bases: 'bases',
    logo: 'https://static.scratch.md/connector-icons/airtable.svg',
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
   * Handles both the nameFieldOverride case (single-element titleColumnRemoteId)
   * and the normal case (3-element [baseId, tableId, fieldId]).
   */
  private resolvePrimaryFieldName(tableSpec: BaseJsonTableSpec): string | undefined {
    if (!tableSpec.titleColumnRemoteId || tableSpec.titleColumnRemoteId.length === 0) {
      return undefined;
    }

    // nameFieldOverride sets titleColumnRemoteId to a single-element array with the field name
    if (tableSpec.titleColumnRemoteId.length === 1) {
      return tableSpec.titleColumnRemoteId[0];
    }

    // Normal case: [baseId, tableId, fieldId] — look up field name from schema
    const targetFieldId = tableSpec.titleColumnRemoteId[2];
    const schema = tableSpec.schema as Record<string, unknown> | undefined;
    const topProps = schema?.properties as Record<string, Record<string, unknown>> | undefined;
    const fieldsSchema = topProps?.fields?.properties as Record<string, Record<string, unknown>> | undefined;
    if (!fieldsSchema) {
      return undefined;
    }
    for (const [name, fieldSchema] of Object.entries(fieldsSchema)) {
      if (fieldSchema[REMOTE_FIELD_ID] === targetFieldId) {
        return name;
      }
    }
    return undefined;
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: AirtablePullOptions,
  ): Promise<void> {
    const [baseId, tableId] = tableSpec.id.remoteId;

    const filterByFormula = options.filter && options.filter.trim() !== '' ? options.filter : undefined;
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
  async updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const [baseId, tableId] = tableSpec.id.remoteId;

    const airtableRecords = files.map((file) => ({
      id: file.id as string,
      fields: this.processFieldDataWithSchema(file, tableSpec),
    }));

    await this.client.updateRecords(baseId, tableId, airtableRecords);
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
