import { ConnectorPullOptions, Service } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector } from '../../connector';
import { extractCommonDetailsFromAxiosError, extractErrorMessageFromAxiosError } from '../../error';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import { AirtableApiClient } from './airtable-api-client';
import { buildAirtableJsonTableSpec, isReadonlyField } from './airtable-json-schema';
import { AirtableSchemaParser } from './airtable-schema-parser';

interface AirtablePullOptions extends ConnectorPullOptions {
  filter?: string | undefined;
  // A view ID to pull records from. If not provided, all records will be pulled.
  view?: string | undefined;
}

export class AirtableConnector extends Connector<typeof Service.AIRTABLE> {
  readonly service = Service.AIRTABLE;
  static readonly displayName = 'Airtable';

  private readonly client: AirtableApiClient;
  private readonly schemaParser = new AirtableSchemaParser();

  constructor(apiKey: string) {
    super();
    this.client = new AirtableApiClient(apiKey);
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
    const baseSchema = await this.client.getBaseSchema(baseId);
    const table = baseSchema.tables.find((t) => t.id === tableId);
    if (!table) {
      throw new Error(`Table ${tableId} not found in base ${baseId}`);
    }

    return buildAirtableJsonTableSpec(id, table);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,

    _progress: JsonSafeObject,
    options: AirtablePullOptions,
  ): Promise<void> {
    const [baseId, tableId] = tableSpec.id.remoteId;

    const filterByFormula = options.filter && options.filter.trim() !== '' ? options.filter : undefined;
    const view = options.view ?? undefined;

    for await (const rawRecords of this.client.listRecords(baseId, tableId, {
      filterByFormula,
      view,
    })) {
      await callback({ files: rawRecords as unknown as ConnectorFile[] });
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

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error),
        description: error.message,
        additionalContext: {
          status: error.response?.status,
        },
      };
    }
    return {
      userFriendlyMessage: 'An error occurred while connecting to Airtable',
      description: error instanceof Error ? error.message : String(error),
    };
  }

  supportsFilters(): boolean {
    return true;
  }
}
