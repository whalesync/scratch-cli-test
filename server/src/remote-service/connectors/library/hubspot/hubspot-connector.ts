import { connectorMetadata, ConnectorPullOptions } from '@spinner/shared-types';
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
import { Service } from '../../service-constants';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import { HubspotApiClient, HubspotError } from './hubspot-api-client';
import { buildHubspotJsonTableSpec } from './hubspot-json-schema';
import {
  ASSOCIATIONS_BY_OBJECT_TYPE,
  HubspotAssociation,
  HubspotDownloadProgress,
  HubspotRecord,
  OBJECT_CONFIG,
  STANDARD_OBJECT_TYPES,
} from './hubspot-types';

const LOG_SOURCE = 'HubspotConnector';

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
   * Pull all records for an object type using cursor pagination.
   * Includes associations in the response.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: HubspotDownloadProgress }) => Promise<void>,
    progress: HubspotDownloadProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConnectorPullOptions,
  ): Promise<void> {
    const objectType = tableSpec.id.remoteId[0];
    const propertyNames = await this.getPropertyNames(objectType);
    const associations = this.getAssociationTypes(objectType);

    for await (const batch of this.client.listRecords(objectType, propertyNames, associations, progress.afterCursor)) {
      await callback({
        files: batch.records as unknown as ConnectorFile[],
        connectorProgress: { afterCursor: batch.nextCursor },
      });
    }
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
      const properties = this.extractWritableProperties(file);
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
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<void> {
    const objectType = tableSpec.id.remoteId[0];
    const propertyNames = await this.getPropertyNames(objectType);
    const associationTypes = this.getAssociationTypes(objectType);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const recordId = String(file.id);
      const cf = changedFields?.[i];

      // Update properties if changed (or if changedFields not provided)
      const hasPropertyChanges = !cf || 'properties' in cf;
      if (hasPropertyChanges) {
        let properties: Record<string, unknown>;
        if (cf?.properties && typeof cf.properties === 'object' && !Array.isArray(cf.properties)) {
          // Deep changedFields: only send the specific sub-properties that changed
          const changedProps = cf.properties as Record<string, unknown>;
          const fileProps = (file as unknown as HubspotRecord).properties ?? {};
          properties = {};
          for (const propKey of Object.keys(changedProps)) {
            if (propKey in fileProps && !this.isReadOnlyProperty(propKey)) {
              properties[propKey] = fileProps[propKey];
            }
          }
        } else {
          properties = this.extractWritableProperties(file);
        }
        if (Object.keys(properties).length > 0) {
          await this.client.updateRecord(objectType, recordId, properties);
        }
      }

      // Sync associations if changed (or if changedFields not provided)
      const hasAssociationChanges = !cf || 'associations' in cf;
      if (hasAssociationChanges && associationTypes.length > 0) {
        // Fetch current remote state to compute the diff
        const currentRecord = await this.client.getRecord(objectType, recordId, propertyNames, associationTypes);
        if (currentRecord) {
          const currentAssociations = currentRecord.associations ?? {};
          const desiredAssociations = (file as unknown as HubspotRecord).associations ?? {};
          await this.syncAssociations(objectType, recordId, currentAssociations, desiredAssociations);
        }
      }
    }
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
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath);
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
   * Extract writable properties from a file, skipping read-only system fields.
   */
  private isReadOnlyProperty(key: string): boolean {
    return key.startsWith('hs_object_id') || key === 'createdate' || key === 'lastmodifieddate';
  }

  private extractWritableProperties(file: ConnectorFile): Record<string, unknown> {
    const properties = (file as unknown as HubspotRecord).properties;
    if (!properties) return {};

    const writable: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (this.isReadOnlyProperty(key)) continue;
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
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
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
