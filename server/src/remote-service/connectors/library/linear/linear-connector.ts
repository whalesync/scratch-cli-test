/**
 * Linear Connector
 *
 * Connector for the Linear project management platform.
 * Supports CRUD for Issues and Projects; read-only for Teams, Users, Labels, and Cycles.
 */

import { connectorMetadata } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import _ from 'lodash';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector } from '../../connector';
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
import { ALL_ENTITY_TYPES, ENTITY_REGISTRY, type EntityType } from './graphql';
import { ISSUES_READ_ONLY_FIELDS, ISSUES_STRIP_ON_UPDATE_FIELDS } from './graphql/mutations/issues.mutations';
import { PROJECTS_READ_ONLY_FIELDS } from './graphql/mutations/projects.mutations';
import { LinearApiClient, LinearError } from './linear-api-client';
import { buildLinearUpdatedAtFilter, LinearUpdatedAtFilter } from './linear-incremental';
import { buildLinearJsonTableSpec } from './linear-json-schema';
import { LinearCredentials } from './linear-types';

const LOG_SOURCE = 'LinearConnector';

type WritableEntityType = 'issues' | 'projects';

/**
 * Read-only field sets from generated mutations, keyed by writable entity type.
 */
const READ_ONLY_FIELDS_MAP: Record<WritableEntityType, Set<string>> = {
  issues: ISSUES_READ_ONLY_FIELDS,
  projects: PROJECTS_READ_ONLY_FIELDS,
};

const STRIP_ON_UPDATE_MAP: Partial<Record<WritableEntityType, Set<string>>> = {
  issues: ISSUES_STRIP_ON_UPDATE_FIELDS,
};

/**
 * Connector for the Linear project management platform.
 *
 * Supports full CRUD for Issues and Projects.
 * Read-only access for Teams, Users, Labels, and Cycles.
 */
export class LinearConnector extends Connector {
  readonly service = Service.LINEAR;
  static readonly displayName = 'Linear';
  static readonly metadata = connectorMetadata({
    displayName: 'Linear',
    table: 'entity',
    tables: 'entities',
    record: 'item',
    records: 'items',
    logo: 'https://static.scratch.md/connector-icons/linear.svg',
    incrementalPull: true,
    oauth: { label: 'OAuth' },
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'API Key',
          placeholder: 'lin_api_...',
          description: 'Create a Personal API Key in Settings > Account > Security & Access',
          required: true,
        },
      ],
    },
  });

  private readonly client: LinearApiClient;

  constructor(credentials: LinearCredentials, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new LinearApiClient(credentials, { rateLimiter: opts?.rateLimiter });
  }

  /**
   * Test the connection by validating credentials.
   */
  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  /**
   * List available tables - all entity types.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return ALL_ENTITY_TYPES.map((entityType) => {
      const config = ENTITY_REGISTRY[entityType];
      return {
        id: { wsId: entityType, remoteId: [entityType] },
        displayName: config.displayName,
        metadata: {
          description: config.description,
        },
      };
    });
  }

  /**
   * Fetch the JSON Table Spec for a Linear entity type.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const entityType = id.wsId as EntityType;

    if (!ENTITY_REGISTRY[entityType]) {
      const supported = ALL_ENTITY_TYPES.join(', ');
      throw new LinearError(`Entity type '${id.wsId}' not found. Supported types: ${supported}`, 404);
    }

    return buildLinearJsonTableSpec(id);
  }

  /**
   * Linear supports incremental pulls unconditionally: every entity type
   * (Issue, Project, Team, User, IssueLabel, Cycle) has a guaranteed
   * server-side `updatedAt` system field and every list connection accepts an
   * `updatedAt` filter comparator. The field is fixed (not user-selectable), so
   * there is no per-folder config to inspect — this always returns `true`.
   */
  override supportsIncrementalPull(): boolean {
    return true;
  }

  /**
   * Pull all entities of the given type as JSON files.
   *
   * Full pull (default): scan every entity. Incremental pull: filter the
   * connection by `updatedAt > since` (minus a clock-skew margin) and return
   * the new watermark for the job to persist.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const entityType = tableSpec.id.wsId as EntityType;

    if (!ENTITY_REGISTRY[entityType]) {
      throw new LinearError(`Unsupported table: ${tableSpec.id.wsId}`, 400);
    }

    const resumeCursor = (progress as { endCursor?: string })?.endCursor;

    // Capture the watermark BEFORE the first API call so changes made mid-pull
    // aren't lost on the next run. `updatedAt` is server-side and Linear's `gt`
    // is exclusive while the watermark is client-side, so the helper subtracts
    // a clock-skew margin; idempotent commits absorb the small re-pulled
    // window. Linear has no user `options.filter` today — nothing to combine.
    let newWatermark: Date | undefined;
    let filter: LinearUpdatedAtFilter | undefined;
    if (options.pullMode === 'incremental' && options.since instanceof Date) {
      newWatermark = new Date();
      filter = buildLinearUpdatedAtFilter(options.since);
    }

    for await (const batch of this.client.listEntities(entityType, 50, resumeCursor, filter)) {
      await callback({
        files: batch.nodes as ConnectorFile[],
        connectorProgress: batch.endCursor ? { endCursor: batch.endCursor } : {},
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
    const entityType = tableSpec.id.wsId as EntityType;

    if (!ENTITY_REGISTRY[entityType]) {
      throw new LinearError(`Unsupported table: ${tableSpec.id.wsId}`, 400);
    }

    const BATCH_SIZE = 50;
    const batch: ConnectorFile[] = [];

    for (const id of ids) {
      const record = await this.client.fetchNodeById(entityType, id);
      if (record) {
        batch.push(record as ConnectorFile);
      }

      if (batch.length >= BATCH_SIZE) {
        await callback({ files: batch.splice(0) });
      }
    }

    if (batch.length > 0) {
      await callback({ files: batch });
    }
  }

  /**
   * Get the batch size for CRUD operations.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getBatchSize(_operation: 'create' | 'update' | 'delete'): number {
    return 50;
  }

  /**
   * Create records.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const entityType = tableSpec.id.wsId as EntityType;
    this.assertWritable(entityType);

    const results: ConnectorFile[] = [];
    for (const file of files) {
      const input = this.stripReadOnlyFields(file, entityType as WritableEntityType);
      const created = await this.createEntity(entityType as WritableEntityType, input);
      results.push(created as ConnectorFile);
    }

    return results;
  }

  /**
   * Update records.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<void> {
    const entityType = tableSpec.id.wsId as EntityType;
    this.assertWritable(entityType);

    for (let i = 0; i < files.length; i++) {
      const entityId = String(files[i].id);
      const input = this.stripReadOnlyFields(
        changedFields[i] as ConnectorFile,
        entityType as WritableEntityType,
        'update',
      );
      await this.updateEntity(entityType as WritableEntityType, entityId, input);
    }
  }

  /**
   * Delete records.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const entityType = tableSpec.id.wsId as EntityType;
    this.assertWritable(entityType);

    const config = ENTITY_REGISTRY[entityType];

    for (const file of files) {
      try {
        await this.deleteEntity(entityType as WritableEntityType, String(file.id));
      } catch (error) {
        if (error instanceof LinearError && error.statusCode === 404) {
          WSLogger.warn({
            source: LOG_SOURCE,
            message: `${config.displayName} ${String(file.id)} already deleted, skipping`,
          });
          continue;
        }
        throw error;
      }
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const entityType = tableSpec.id.wsId as EntityType;
    const slugField = tableSpec.slugFieldPath ?? tableSpec.slugColumnRemoteId;
    const titleField = tableSpec.titleColumnRemoteId?.length === 1 ? tableSpec.titleColumnRemoteId[0] : undefined;
    // Issues use identifier (e.g. "DEV-123") as slug — prefer it over title.
    // Other entities: prefer title over slug, since Linear slugs are often hashes (e.g. project slugId).
    const fieldPaths =
      entityType === 'issues'
        ? [slugField, titleField].filter((p): p is string => !!p)
        : [titleField, slugField].filter((p): p is string => !!p);
    if (fieldPaths.length === 0) return records.map(() => undefined);

    return records.map((record) => {
      for (const path of fieldPaths) {
        const value = _.get(record, path);
        if (typeof value === 'string' && value.trim()) return value;
        if (typeof value === 'number') return String(value);
      }
      return undefined;
    });
  }

  /**
   * Extract error details for user-friendly error reporting.
   */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof LinearError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          status: error.statusCode,
          code: error.code,
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

  // ============= Private Helpers =============

  private assertWritable(entityType: EntityType): void {
    const config = ENTITY_REGISTRY[entityType];
    if (config.readOnly) {
      throw new LinearError(`${config.displayName} are read-only and cannot be created, updated, or deleted`, 400);
    }
  }

  private stripReadOnlyFields(
    file: ConnectorFile,
    entityType: WritableEntityType,
    operation: 'create' | 'update' = 'create',
  ): Record<string, unknown> {
    const readOnly = READ_ONLY_FIELDS_MAP[entityType] ?? new Set<string>();
    const updateOnly = operation === 'update' ? STRIP_ON_UPDATE_MAP[entityType] : undefined;
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(file)) {
      if (readOnly.has(key) || (updateOnly && updateOnly.has(key)) || value === undefined) {
        continue;
      }
      result[key] = value;
    }

    return result;
  }

  private async createEntity(
    entityType: WritableEntityType,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (entityType) {
      case 'issues':
        return this.client.createIssue(input);
      case 'projects':
        return this.client.createProject(input);
    }
  }

  private async updateEntity(
    entityType: WritableEntityType,
    id: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    switch (entityType) {
      case 'issues':
        await this.client.updateIssue(id, input);
        break;
      case 'projects':
        await this.client.updateProject(id, input);
        break;
    }
  }

  private async deleteEntity(entityType: WritableEntityType, id: string): Promise<void> {
    switch (entityType) {
      case 'issues':
        await this.client.deleteIssue(id);
        break;
      case 'projects':
        await this.client.deleteProject(id);
        break;
    }
  }
}

// ============= Self-Registration =============

connectorRegistry.register({
  service: Service.LINEAR,
  metadata: LinearConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['oauth', 'user_provided_params'],
  rateLimiterSpec: { points: 60, duration: 1 },
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Linear', Service.LINEAR);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const accessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
      return new LinearConnector({ accessToken }, { rateLimiter });
    } else {
      if (!ctx.decryptedCredentials?.apiKey) {
        throw new ConnectorInstantiationError('API key is required for Linear', Service.LINEAR);
      }
      return new LinearConnector({ accessToken: ctx.decryptedCredentials.apiKey }, { rateLimiter });
    }
  },
});
