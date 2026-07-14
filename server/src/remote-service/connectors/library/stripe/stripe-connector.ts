/* eslint-disable @typescript-eslint/no-unused-vars */
import { TableView, connectorMetadata } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { JsonSafeObject } from 'src/utils/objects';
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
import { StripeApiClient, StripeError } from './stripe-api-client';
import { buildStripeDefaultView } from './stripe-default-view';
import { buildStripeJsonTableSpec } from './stripe-json-schema';
import { StripeCredentials, StripeEntityType } from './stripe-types';

/**
 * Entity types supported by Stripe
 */
const ENTITY_TYPES: StripeEntityType[] = [
  'customers',
  'products',
  'prices',
  'subscriptions',
  'invoices',
  'payment_intents',
  'charges',
];

/**
 * Display names for Stripe entity types
 */
const ENTITY_DISPLAY_NAMES: Record<StripeEntityType, string> = {
  customers: 'Customers',
  products: 'Products',
  prices: 'Prices',
  subscriptions: 'Subscriptions',
  invoices: 'Invoices',
  payment_intents: 'Payment Intents',
  charges: 'Charges',
};

/**
 * Descriptions for Stripe entity types
 */
const ENTITY_DESCRIPTIONS: Record<StripeEntityType, string> = {
  customers: 'Customer accounts and their details',
  products: 'Products and services in your catalog',
  prices: 'Pricing configurations for your products',
  subscriptions: 'Recurring billing subscriptions',
  invoices: 'Invoices sent to customers',
  payment_intents: 'Payment intents tracking payment lifecycle',
  charges: 'Individual charge transactions',
};

/**
 * Connector for the Stripe payment platform.
 *
 * This is a read-only connector — it pulls data from Stripe but does not
 * support creating, updating, or deleting records through Scratch.
 *
 * Supported entity types:
 * - Customers
 * - Products
 * - Prices
 * - Subscriptions
 * - Invoices
 * - Payment Intents
 * - Charges
 */
export class StripeConnector extends Connector {
  readonly service = Service.STRIPE;
  static readonly displayName = 'Stripe';
  static readonly metadata = connectorMetadata({
    displayName: 'Stripe',
    table: 'resource',
    tables: 'resources',
    base: 'account',
    bases: 'accounts',
    logo: 'https://static.scratch.md/connector-icons/stripe.svg',
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'Secret API Key',
          placeholder: 'sk_live_... or sk_test_...',
          description: 'Your Stripe secret key from the Developers > API keys page',
          required: true,
        },
      ],
    },
  });

  private readonly client: StripeApiClient;

  constructor(credentials: StripeCredentials) {
    super();
    this.client = new StripeApiClient(credentials);
  }

  /**
   * Test the connection by validating the API key.
   */
  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  /**
   * List available tables. Stripe has customers, products, prices, subscriptions, invoices, payment intents, and charges.
   * All tables are read-only (creates disabled).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return ENTITY_TYPES.map((entityType) => ({
      id: {
        wsId: entityType,
        remoteId: [entityType],
      },
      displayName: ENTITY_DISPLAY_NAMES[entityType],
      disabledCreates: true as const,
      disabledUpdates: true as const,
      disabledDeletes: true as const,
      disabledReason: 'Stripe connector is read-only',
      metadata: {
        description: ENTITY_DESCRIPTIONS[entityType],
        entityType,
      },
    }));
  }

  /**
   * Build the default TableView for a Stripe entity type by deriving it from the spec's schema.
   */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    const entityType = spec.id.wsId as StripeEntityType;
    if (!ENTITY_TYPES.includes(entityType)) return undefined; // defensive
    return buildStripeDefaultView(spec.schema, entityType);
  }

  /**
   * Fetch the JSON Table Spec for a Stripe entity type.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const entityType = id.wsId as StripeEntityType;

    if (!ENTITY_TYPES.includes(entityType)) {
      throw new StripeError(`Entity type '${entityType}' not found. Stripe supports: ${ENTITY_TYPES.join(', ')}`, 404);
    }

    return buildStripeJsonTableSpec(id, entityType);
  }

  /**
   * Pull all records for a Stripe entity type.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const entityType = tableSpec.id.wsId as StripeEntityType;
    const resumeAfter = (progress as { startingAfter?: string })?.startingAfter;

    for await (const entities of this.client.listEntities(entityType, 100, resumeAfter)) {
      const lastEntity = entities[entities.length - 1];
      const lastId = lastEntity?.id as string | undefined;
      await callback({
        files: entities as unknown as ConnectorFile[],
        connectorProgress: lastId ? { startingAfter: lastId } : {},
      });
    }
    return {};
  }

  /**
   * Pull specific records by ID.
   */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const entityType = tableSpec.id.wsId as StripeEntityType;
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      const entity = await this.client.getEntity(entityType, id);
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
   * Batch size for operations. Stripe allows up to 100 per list request.
   */
  getBatchSize(): number {
    return 100;
  }

  /**
   * Stripe connector is read-only — creating records is not supported.
   */
  createRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<ConnectorFile[]> {
    throw new Error('Stripe connector is read-only. Records cannot be created through Scratch.');
  }

  /**
   * Stripe connector is read-only — updating records is not supported.
   */
  updateRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<ConnectorFile[]> {
    throw new Error('Stripe connector is read-only. Records cannot be updated through Scratch.');
  }

  /**
   * Stripe connector is read-only — deleting records is not supported.
   */
  deleteRecords(_tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<void> {
    throw new Error('Stripe connector is read-only. Records cannot be deleted through Scratch.');
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'id');
  }

  /**
   * Extract error details from Stripe API errors.
   */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof StripeError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          status: error.statusCode,
          code: error.code,
          type: error.type,
          responseData: error.responseData,
        },
      };
    }

    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;

      // Stripe returns errors in { error: { message, type, code } } format
      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, [
          'error.message',
          'error',
          'message',
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

connectorRegistry.register({
  service: Service.STRIPE,
  metadata: StripeConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  rateLimiterSpec: {
    points: 90,
    duration: 1,
  },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Stripe', Service.STRIPE);
    }
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('API key is required for Stripe', Service.STRIPE);
    }
    return new StripeConnector({ apiKey: ctx.decryptedCredentials.apiKey });
  },
});
