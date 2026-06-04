import { connectorMetadata, IncrementalPullSupport } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
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
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../types';
import { PipedriveApiClient, PipedriveError } from './pipedrive-api-client';
import { buildPipedriveUpdatedSince } from './pipedrive-incremental';
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
export class PipedriveConnector extends Connector<string, PipedriveDownloadProgress> {
  readonly service = Service.PIPEDRIVE;
  static readonly displayName = 'Pipedrive';
  static readonly metadata = connectorMetadata({
    displayName: 'Pipedrive',
    table: 'entity',
    tables: 'entities',
    logo: 'https://static.scratch.md/connector-icons/pipedrive.svg',
    incrementalPull: true,
    // No user-facing caveats: `update_time` is a fixed system field on every
    // Pipedrive entity and `updated_since` is unconditional, so there are no
    // notes to show
    incrementalPullInstructions: null,
    oauth: { label: 'OAuth' },
    credentialFields: {
      user_provided_params: [
        { key: 'apiKey', type: 'password', label: 'API Key', placeholder: 'Enter API Key', required: true },
      ],
    },
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
   * Pipedrive supports incremental pulls unconditionally: every entity type
   * (deals, persons, organizations) has a guaranteed server-side `update_time`
   * system field and the v2 list endpoints accept the `updated_since` filter.
   * The field is fixed (not user-selectable), so there is no per-folder config
   * to inspect — this always returns `SUPPORTED`.
   */
  override incrementalPullSupport(): IncrementalPullSupport {
    return IncrementalPullSupport.SUPPORTED;
  }

  /**
   * Download entities as JSON files using cursor pagination.
   *
   * Full pull (default): scan every entity. Incremental pull: filter each list
   * endpoint by `updated_since` (the clock-skewed watermark) and return the new
   * watermark for the job to persist.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: PipedriveDownloadProgress }) => Promise<void>,
    progress: PipedriveDownloadProgress,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const entityType = tableSpec.id.wsId as PipedriveEntityType;
    const resumeCursor = (progress as { nextCursor?: string })?.nextCursor;

    // Capture the watermark BEFORE the first API call so records changed
    // mid-pull aren't lost on the next run. Pipedrive's `updated_since` is
    // inclusive (`>=`) but `update_time` is server-side while the watermark is
    // client-side, so the helper subtracts a clock-skew margin; idempotent
    // commits absorb the small re-pulled window. Pipedrive has no user
    // `options.filter` today — nothing to combine.
    let newWatermark: Date | undefined;
    let updatedSince: string | undefined;
    if (options.pullMode === 'incremental' && options.since instanceof Date) {
      newWatermark = new Date();
      updatedSince = buildPipedriveUpdatedSince(options.since);
    }

    for await (const batch of this.client.listEntities(entityType, resumeCursor, updatedSince)) {
      await callback({
        files: batch.data as unknown as ConnectorFile[],
        connectorProgress: batch.nextCursor ? { nextCursor: batch.nextCursor } : {},
      });
    }
    return newWatermark ? { newWatermark } : {};
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
   * Supports changedFields for partial updates.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const entityType = tableSpec.id.wsId as PipedriveEntityType;
    const customFieldKeys = await this.getCustomFieldKeys(entityType);

    const results: ConnectorFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const entityId = parseInt(String(file.id), 10);

      const cf = changedFields?.[i];
      const data = cf ?? this.extractWritableData(file);

      const updated = await this.client.updateEntity(entityType, entityId, data, customFieldKeys);
      results.push(updated as unknown as ConnectorFile);
    }
    return results;
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

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePath = tableSpec.titleColumnRemoteId?.length === 1 ? tableSpec.titleColumnRemoteId[0] : undefined;
    return suggestFileNamesFromFieldPaths(records, titlePath);
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

connectorRegistry.register({
  service: Service.PIPEDRIVE,
  metadata: PipedriveConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['oauth', 'user_provided_params'],
  rateLimiterSpec: { points: 10, duration: 2 },
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Pipedrive', Service.PIPEDRIVE);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
      return new PipedriveConnector(accessToken, { rateLimiter, authType: 'oauth' });
    } else {
      if (!ctx.decryptedCredentials?.apiKey) {
        throw new ConnectorInstantiationError('API key is required for Pipedrive', Service.PIPEDRIVE);
      }
      return new PipedriveConnector(ctx.decryptedCredentials.apiKey, { rateLimiter });
    }
  },
});
