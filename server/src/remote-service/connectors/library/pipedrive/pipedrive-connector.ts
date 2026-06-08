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
import { PipedriveApiClient, PipedriveError, PipedriveListResume } from './pipedrive-api-client';
import { buildPipedriveUpdatedSince } from './pipedrive-incremental';
import { buildPipedriveJsonTableSpec } from './pipedrive-json-schema';
import {
  coercePipedriveEntityId,
  ENTITY_CONFIG,
  ENTITY_DISPLAY_NAMES,
  ENTITY_TYPES,
  PipedriveDownloadProgress,
  PipedriveEntityType,
} from './pipedrive-types';

/**
 * Connector for the Pipedrive CRM.
 *
 * Supports the standard Pipedrive object types:
 * - Deals (sales pipeline items)
 * - Persons (contacts)
 * - Organizations (companies)
 * - Products
 * - Activities (calls, meetings, tasks)
 * - Leads
 * - Notes
 * - Pipelines and Stages (deal pipeline configuration)
 *
 * Talks to the Pipedrive REST API exclusively through {@link PipedriveApiClient}
 * (an explicit axios client), not a vendored SDK. Most objects use the modern v2
 * API; leads and notes are only available on the legacy v1 API. The client and
 * the per-entity {@link ENTITY_CONFIG} hide those differences (paths, pagination,
 * update verb, custom-field placement, id type) from this connector.
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

    return buildPipedriveJsonTableSpec(id, entityType, this.client);
  }

  /**
   * Incremental support is decided per entity type. Every Pipedrive object with
   * a guaranteed server-side `update_time` whose list endpoint accepts
   * `updated_since` supports it (deals, persons, organizations, products,
   * activities, leads, notes); the pipeline/stage config endpoints reject
   * `updated_since` (HTTP 400) and so are always full-pulled. The deciding field
   * is fixed (not user-selectable), so there is no per-folder config to inspect —
   * the answer comes straight from {@link ENTITY_CONFIG}. A `null` tableSpec
   * (REST computing the value before a folder's first pull) reports the
   * connector's general capability; the pull path always has a spec and gates
   * precisely.
   */
  override incrementalPullSupport(
    _options: PullRecordFilesOptions,
    tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    if (!tableSpec) return IncrementalPullSupport.SUPPORTED;
    const entityType = tableSpec.id.wsId as PipedriveEntityType;
    return ENTITY_CONFIG[entityType].supportsIncremental
      ? IncrementalPullSupport.SUPPORTED
      : IncrementalPullSupport.NOT_SUPPORTED;
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
    const config = ENTITY_CONFIG[entityType];

    // Resume from whichever pagination marker this entity uses: a cursor (v2) or
    // a `start` offset (v1 leads/notes).
    const resume: PipedriveListResume =
      config.paginationStyle === 'cursor' ? { cursor: progress.nextCursor } : { start: progress.nextStart };

    // Capture the watermark BEFORE the first API call so records changed
    // mid-pull aren't lost on the next run. Pipedrive's `updated_since` is
    // inclusive (`>=`) but `update_time` is server-side while the watermark is
    // client-side, so the helper subtracts a clock-skew margin; idempotent
    // commits absorb the small re-pulled window. Pipedrive has no user
    // `options.filter` today — nothing to combine. Entities whose endpoint
    // rejects `updated_since` (pipelines/stages) never take this branch, so they
    // are always full-pulled even if a caller requests incremental.
    let newWatermark: Date | undefined;
    let updatedSince: string | undefined;
    if (config.supportsIncremental && options.pullMode === 'incremental' && options.since instanceof Date) {
      newWatermark = new Date();
      updatedSince = buildPipedriveUpdatedSince(options.since);
    }

    for await (const batch of this.client.listEntities(entityType, resume, updatedSince)) {
      let connectorProgress: PipedriveDownloadProgress = {};
      if (batch.nextCursor !== undefined) {
        connectorProgress = { nextCursor: batch.nextCursor };
      } else if (batch.nextStart !== undefined) {
        connectorProgress = { nextStart: batch.nextStart };
      }
      await callback({
        files: batch.data as unknown as ConnectorFile[],
        connectorProgress,
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
      const entityId = coercePipedriveEntityId(entityType, id);
      if (entityId === null) {
        WSLogger.warn({
          source: 'PipedriveConnector',
          message: `Invalid ID "${id}" for ${entityType}, skipping`,
        });
        continue;
      }

      const entity = await this.client.getEntity(entityType, entityId);
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
    const results: ConnectorFile[] = [];

    for (const file of files) {
      const data = this.extractWritableData(file);
      const created = await this.client.createEntity(entityType, data);
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

    const results: ConnectorFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const entityId = coercePipedriveEntityId(entityType, file.id);
      if (entityId === null) {
        WSLogger.warn({
          source: 'PipedriveConnector',
          message: `Invalid ID "${String(file.id)}" for ${entityType}, skipping update`,
        });
        continue;
      }

      const cf = changedFields?.[i];
      const data = cf ?? this.extractWritableData(file);

      const updated = await this.client.updateEntity(entityType, entityId, data);
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
      const entityId = coercePipedriveEntityId(entityType, file.id);
      if (entityId === null) {
        WSLogger.warn({
          source: 'PipedriveConnector',
          message: `Invalid ID "${String(file.id)}" for ${entityType}, skipping delete`,
        });
        continue;
      }
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
