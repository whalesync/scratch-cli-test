/* eslint-disable @typescript-eslint/no-unused-vars */
import { TableView, connectorMetadata } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
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
import { SquareApiClient, SquareError } from './square-api-client';
import { SquareAuthParser } from './square-auth-parser';
import { buildSquareDefaultView } from './square-default-view';
import { buildSquareJsonTableSpec } from './square-json-schema';
import {
  SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE,
  SQUARE_ENTITY_TYPES,
  SquareCredentials,
  SquareEntityType,
  SquarePullProgress,
  isSquareEntityType,
  normalizeSquareEnvironment,
} from './square-types';

/**
 * Connector for Square (point of sale, payments, catalog, customers).
 *
 * Read-only: it pulls Square data into Scratch — chiefly so Live Export can mirror it into a
 * destination such as Supabase — and never writes back. Every table is a fixed Square object type
 * whose record shape comes from Square's published OpenAPI spec (see
 * `square-entity-schemas.generated.ts`); Square has no schema-introspection endpoint to read
 * instead.
 *
 * Records are stored exactly as Square returns them. The only things stripped are the list
 * responses' envelopes (the records key and `cursor`).
 */
export class SquareConnector extends Connector<string, SquarePullProgress> {
  readonly service = Service.SQUARE;
  static readonly displayName = 'Square';
  static readonly metadata = connectorMetadata({
    displayName: 'Square',
    table: 'resource',
    tables: 'resources',
    base: 'account',
    bases: 'accounts',
    logo: 'https://static.scratch.md/connector-icons/square.svg',
    // Hidden in Scratch's own connector pickers until a live Square account has been pulled end to
    // end. Live Export doesn't read this flag — it offers sources from LIVE_EXPORT_SOURCE_SERVICES.
    visible: false,
    defaultAuthMethod: 'user_provided_params',
    userProvidedParamsLabel: 'Access Token',
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'Access Token',
          placeholder: 'EAAA…',
          description:
            'A Square access token. In the Square Developer Dashboard, open (or create) an application, ' +
            'then copy the Production access token from its Credentials page. Sandbox tokens work too.',
          required: true,
        },
      ],
    },
  });

  private readonly client: SquareApiClient;

  constructor(credentials: SquareCredentials, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new SquareApiClient(credentials, { rateLimiter: opts?.rateLimiter });
  }

  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return SQUARE_ENTITY_TYPES.map((entityType) => {
      const entityConfig = SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE[entityType];
      return {
        id: { wsId: entityType, remoteId: [entityType] },
        displayName: entityConfig.displayName,
        disabledCreates: true as const,
        disabledUpdates: true as const,
        disabledDeletes: true as const,
        disabledReason: 'The Square connector is read-only',
        metadata: { description: entityConfig.description, entityType },
      };
    });
  }

  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    if (!isSquareEntityType(spec.id.wsId)) return undefined;
    return buildSquareDefaultView(spec.schema, spec.id.wsId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    if (!isSquareEntityType(id.wsId)) {
      throw new SquareError(`Square has no table '${id.wsId}'. Tables: ${SQUARE_ENTITY_TYPES.join(', ')}`, 404);
    }
    return buildSquareJsonTableSpec(id, id.wsId, this.client.environment);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: SquarePullProgress }) => Promise<void>,
    progress: SquarePullProgress,
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const entityType = this.entityTypeOf(tableSpec);
    for await (const page of this.client.listEntityPages(entityType, progress)) {
      await callback({ files: page.records as ConnectorFile[], connectorProgress: page.progressAfterPage });
    }
    return {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const entityType = this.entityTypeOf(tableSpec);
    const RECORDS_PER_CALLBACK = 20;
    const bufferedRecords: ConnectorFile[] = [];
    for (const recordId of ids) {
      const record = await this.client.retrieveEntity(entityType, recordId);
      if (record) bufferedRecords.push(record as ConnectorFile);
      if (bufferedRecords.length >= RECORDS_PER_CALLBACK) {
        await callback({ files: bufferedRecords.splice(0) });
      }
    }
    if (bufferedRecords.length > 0) await callback({ files: bufferedRecords });
  }

  getBatchSize(): number {
    return 100;
  }

  createRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<ConnectorFile[]> {
    throw new Error('The Square connector is read-only. Records cannot be created through Scratch.');
  }

  updateRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<ConnectorFile[]> {
    throw new Error('The Square connector is read-only. Records cannot be updated through Scratch.');
  }

  deleteRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<void> {
    throw new Error('The Square connector is read-only. Records cannot be deleted through Scratch.');
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'id');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof SquareError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          status: error.statusCode,
          squareErrors: error.squareErrors,
          responseData: error.responseData,
        },
      };
    }

    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;
      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['errors.0.detail', 'message']),
        description: error.message,
        additionalContext: { status: error.response?.status },
      };
    }

    return this.fallbackErrorDetails(error);
  }

  private entityTypeOf(tableSpec: BaseJsonTableSpec): SquareEntityType {
    const entityType = tableSpec.id.wsId;
    if (!isSquareEntityType(entityType)) {
      throw new SquareError(`Square has no table '${entityType}'`, 404);
    }
    return entityType;
  }
}

connectorRegistry.register({
  service: Service.SQUARE,
  metadata: SquareConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  // Square publishes no fixed request quota (it throttles adaptively and answers 429), so stay
  // well under what a single seller's integrations typically sustain and back off on 429.
  rateLimiterSpec: {
    points: 10,
    duration: 1,
  },
  createAuthParser() {
    return new SquareAuthParser();
  },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Square', Service.SQUARE);
    }
    const accessToken = ctx.decryptedCredentials?.apiKey;
    if (!accessToken) {
      throw new ConnectorInstantiationError('An access token is required for Square', Service.SQUARE);
    }
    return new SquareConnector(
      { accessToken, environment: normalizeSquareEnvironment(ctx.decryptedCredentials?.squareEnvironment) },
      { rateLimiter: ctx.createRateLimiter(ctx.connectorAccount.id) },
    );
  },
});
