import { connectorMetadata, ConnectorPullOptions, Service } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { Connector } from '../../connector';
import { extractCommonDetailsFromAxiosError, extractErrorMessageFromAxiosError } from '../../error';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import { PipedriveApiClient, PipedriveError } from './pipedrive-api-client';
import { buildPipedriveJsonTableSpec } from './pipedrive-json-schema';
import { ENTITY_DISPLAY_NAMES, ENTITY_TYPES, PipedriveDownloadProgress, PipedriveEntityType } from './pipedrive-types';

/**
 * Connector for the Pipedrive CRM.
 *
 * Supports three entity types:
 * - Deals (sales pipeline items)
 * - Persons (contacts)
 * - Organizations (companies)
 *
 * Uses the Pipedrive v2 API exclusively via the official SDK.
 */
export class PipedriveConnector extends Connector<typeof Service.PIPEDRIVE, PipedriveDownloadProgress> {
  readonly service = Service.PIPEDRIVE;
  static readonly displayName = 'Pipedrive';
  static readonly metadata = connectorMetadata({
    displayName: 'Pipedrive',
    table: 'entity',
    tables: 'entities',
    logo: 'https://static.scratch.md/connector-icons/pipedrive.svg',
    oauth: { label: 'OAuth' },
  });

  private readonly client: PipedriveApiClient;

  /** Cache of custom field keys per entity type (populated during fetchJsonTableSpec) */
  private customFieldKeysCache = new Map<PipedriveEntityType, Set<string>>();

  constructor(token: string, opts?: { rateLimiter?: RateLimiter; authType?: 'apiKey' | 'oauth' }) {
    super();
    this.client = new PipedriveApiClient(token, opts);
  }

  /**
   * Test the connection by listing deals.
   */
  async testConnection(): Promise<void> {
    await this.client.testConnection();
  }

  /**
   * List available entity types as tables.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return ENTITY_TYPES.map((entityType) => ({
      id: {
        wsId: entityType,
        remoteId: [entityType],
      },
      displayName: ENTITY_DISPLAY_NAMES[entityType],
      metadata: {
        description: `${ENTITY_DISPLAY_NAMES[entityType]} in your Pipedrive account`,
        entityType,
      },
    }));
  }

  /**
   * Fetch the JSON Table Spec for a Pipedrive entity type.
   * Calls the Fields API to discover system and custom fields dynamically.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const entityType = id.wsId as PipedriveEntityType;

    if (!ENTITY_TYPES.includes(entityType)) {
      throw new PipedriveError(
        `Entity type '${entityType}' not found. Pipedrive supports: ${ENTITY_TYPES.join(', ')}`,
        404,
      );
    }

    // Build schema and cache custom field keys
    const spec = await buildPipedriveJsonTableSpec(id, entityType, this.client);
    await this.populateCustomFieldKeysCache(entityType);
    return spec;
  }

  /**
   * Download all entities as JSON files using cursor pagination.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: PipedriveDownloadProgress }) => Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _progress: PipedriveDownloadProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConnectorPullOptions,
  ): Promise<void> {
    const entityType = tableSpec.id.wsId as PipedriveEntityType;

    for await (const batch of this.client.listEntities(entityType)) {
      await callback({ files: batch as unknown as ConnectorFile[] });
    }
  }

  /**
   * Fetch specific records by their IDs.
   */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const entityType = tableSpec.id.wsId as PipedriveEntityType;
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      const numericId = parseInt(id, 10);
      if (isNaN(numericId)) {
        WSLogger.warn({
          source: 'PipedriveConnector',
          message: `Invalid non-numeric ID "${id}" for ${entityType}, skipping`,
        });
        continue;
      }

      const entity = await this.client.getEntity(entityType, numericId);
      if (entity) {
        buffer.push(entity as ConnectorFile);
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
   * No bulk API — each create/update/delete is a separate request.
   */
  getBatchSize(): number {
    return 1;
  }

  /**
   * Create records in Pipedrive.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const entityType = tableSpec.id.wsId as PipedriveEntityType;
    const customFieldKeys = await this.getCustomFieldKeys(entityType);
    const results: ConnectorFile[] = [];

    for (const file of files) {
      const data = this.extractWritableData(file);
      const created = await this.client.createEntity(entityType, data, customFieldKeys);
      results.push(created as ConnectorFile);
    }

    return results;
  }

  /**
   * Update records in Pipedrive.
   * Supports changedKeys for partial updates.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedKeys?: (string[] | undefined)[],
  ): Promise<void> {
    const entityType = tableSpec.id.wsId as PipedriveEntityType;
    const customFieldKeys = await this.getCustomFieldKeys(entityType);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const entityId = parseInt(String(file.id), 10);

      let data: Record<string, unknown>;
      const keys = changedKeys?.[i];
      if (keys) {
        // Partial update: only send changed fields
        data = {};
        for (const key of keys) {
          if (key in file) {
            data[key] = file[key];
          }
        }
      } else {
        data = this.extractWritableData(file);
      }

      await this.client.updateEntity(entityType, entityId, data, customFieldKeys);
    }
  }

  /**
   * Delete records from Pipedrive. Ignores 404 errors.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const entityType = tableSpec.id.wsId as PipedriveEntityType;

    for (const file of files) {
      const entityId = parseInt(String(file.id), 10);
      await this.client.deleteEntity(entityType, entityId);
    }
  }

  /**
   * Extract error details from Pipedrive errors.
   */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof PipedriveError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          status: error.statusCode,
          code: error.code,
          responseData: error.responseData,
        },
      };
    }

    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['message', 'error']),
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
   * Extract writable data from a file, filtering out read-only system fields.
   */
  private extractWritableData(file: ConnectorFile): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(file)) {
      if (key === 'id' || key === 'add_time' || key === 'update_time') continue;
      data[key] = value;
    }
    return data;
  }

  /**
   * Get or populate the custom field keys cache for an entity type.
   */
  private async getCustomFieldKeys(entityType: PipedriveEntityType): Promise<Set<string>> {
    if (!this.customFieldKeysCache.has(entityType)) {
      await this.populateCustomFieldKeysCache(entityType);
    }
    return this.customFieldKeysCache.get(entityType) ?? new Set();
  }

  /**
   * Populate the custom field keys cache by querying the Fields API.
   */
  private async populateCustomFieldKeysCache(entityType: PipedriveEntityType): Promise<void> {
    const fields = await this.client.getFields(entityType);
    const customKeys = new Set<string>();
    for (const field of fields) {
      if (field.is_custom_field) {
        customKeys.add(field.field_code);
      }
    }
    this.customFieldKeysCache.set(entityType, customKeys);
  }
}
