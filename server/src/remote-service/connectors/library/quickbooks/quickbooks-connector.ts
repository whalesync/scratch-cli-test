import { connectorMetadata, ConnectorPullOptions, Service } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { Connector } from '../../connector';
import { extractCommonDetailsFromAxiosError, extractErrorMessageFromAxiosError } from '../../error';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import { QuickBooksApiClient, QuickBooksError } from './quickbooks-api-client';
import { buildQuickBooksJsonTableSpec } from './quickbooks-json-schema';
import {
  ENTITY_CONFIG,
  ENTITY_TYPES,
  QuickBooksCredentials,
  QuickBooksDownloadProgress,
  QuickBooksEntityType,
} from './quickbooks-types';

const PAGE_SIZE = 1000;

/**
 * Read-only connector for QuickBooks Online.
 *
 * Features:
 * - OAuth 2.0 authentication (access tokens last 1 hour, refresh tokens 100 days)
 * - Static schemas based on Intuit's API documentation (no runtime inference)
 * - Offset-based pagination using QBO's SQL-like query language
 * - Supports 23 entity types (Invoices, Customers, Items, Bills, etc.)
 *
 * This connector is read-only — create, update, and delete operations are not supported.
 */
export class QuickBooksConnector extends Connector<typeof Service.QUICKBOOKS, QuickBooksDownloadProgress> {
  readonly service = Service.QUICKBOOKS;
  static readonly displayName = 'QuickBooks Online';
  static readonly metadata = connectorMetadata({
    displayName: 'QuickBooks Online',
    table: 'entity',
    tables: 'entities',
    base: 'company',
    bases: 'companies',
    logo: 'https://static.scratch.md/connector-icons/quickbooks.svg',
    oauth: { label: 'OAuth' },
  });

  private readonly client: QuickBooksApiClient;

  constructor(credentials: QuickBooksCredentials, opts?: { rateLimiter?: RateLimiter; sandbox?: boolean }) {
    super();
    this.client = new QuickBooksApiClient(credentials, { rateLimiter: opts?.rateLimiter, sandbox: opts?.sandbox });
  }

  /**
   * Test the connection by querying CompanyInfo.
   */
  async testConnection(): Promise<void> {
    await this.client.testConnection();
  }

  /**
   * List available entity types. Returns a hardcoded list since QBO has no discovery API.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return ENTITY_TYPES.map((entityType) => ({
      id: {
        wsId: entityType.toLowerCase(),
        remoteId: [entityType],
      },
      displayName: ENTITY_CONFIG[entityType].displayName,
      metadata: {
        description: ENTITY_CONFIG[entityType].description,
        entityType,
      },
    }));
  }

  /**
   * Fetch the JSON Table Spec using static schemas.
   *
   * Returns a pre-defined TypeBox schema for the entity type. All schemas
   * have additionalProperties: true to handle undocumented fields gracefully.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const entityType = id.remoteId[0] as QuickBooksEntityType;

    if (!ENTITY_TYPES.includes(entityType)) {
      throw new QuickBooksError(
        `Entity type '${entityType}' is not supported. Supported types: ${ENTITY_TYPES.join(', ')}`,
        400,
        'UNSUPPORTED_ENTITY',
      );
    }

    return buildQuickBooksJsonTableSpec(id, entityType);
  }

  /**
   * Pull all records using offset-based pagination.
   *
   * QBO uses 1-based STARTPOSITION with MAXRESULTS up to 1000.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: QuickBooksDownloadProgress }) => Promise<void>,
    progress: QuickBooksDownloadProgress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConnectorPullOptions,
  ): Promise<void> {
    const entityType = tableSpec.id.remoteId[0];
    let startPosition = progress.nextStartPosition ?? 1;
    let hasMore = true;

    while (hasMore) {
      const result = await this.client.query(entityType, startPosition, PAGE_SIZE);
      hasMore = result.hasMore;
      startPosition += result.entities.length;

      if (result.entities.length > 0) {
        await callback({
          files: result.entities as ConnectorFile[],
          connectorProgress: { nextStartPosition: startPosition },
        });
      }
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
    const entityType = tableSpec.id.remoteId[0];
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      try {
        const entity = await this.client.getEntity(entityType, id);
        if (entity) {
          buffer.push(entity as ConnectorFile);
        }
      } catch (error) {
        WSLogger.warn({
          source: 'QuickBooksConnector',
          message: `Failed to fetch ${entityType} with ID "${id}", skipping`,
          error,
        });
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
   * Batch size — not used in practice since writes are unsupported, but must be > 0.
   */
  getBatchSize(): number {
    return 1;
  }

  /**
   * Not supported — this is a read-only connector.
   */
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async createRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<ConnectorFile[]> {
    throw new QuickBooksError(
      'QuickBooks Online connector is read-only. Create operations are not supported.',
      400,
      'READ_ONLY',
    );
  }

  /**
   * Not supported — this is a read-only connector.
   */
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async updateRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<void> {
    throw new QuickBooksError(
      'QuickBooks Online connector is read-only. Update operations are not supported.',
      400,
      'READ_ONLY',
    );
  }

  /**
   * Not supported — this is a read-only connector.
   */
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async deleteRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<void> {
    throw new QuickBooksError(
      'QuickBooks Online connector is read-only. Delete operations are not supported.',
      400,
      'READ_ONLY',
    );
  }

  /**
   * Extract error details from QuickBooks API errors.
   *
   * QBO error response shape: { Fault: { Error: [{ Message, Detail, code }] } }
   */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof QuickBooksError) {
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
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, [
          'Fault.Error[0].Detail',
          'Fault.Error[0].Message',
          'fault.error[0].detail',
          'fault.error[0].message',
        ]),
        description: error.message,
        additionalContext: {
          status: error.response?.status,
        },
      };
    }

    return this.fallbackErrorDetails(error);
  }
}
