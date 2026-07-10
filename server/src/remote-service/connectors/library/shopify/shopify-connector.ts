/**
 * Shopify Connector
 *
 * Connector for the Shopify e-commerce platform.
 * Uses generated GraphQL schemas and mutations from codegen.
 */

import { Type, type TSchema } from '@sinclair/typebox';
import { connectorMetadata, isShopifyConnectorExtras } from '@spinner/shared-types';
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
  ReadonlyFieldEditError,
  readonlyFieldEditErrorMessage,
} from '../../error';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  dotPath,
  EntityId,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../types';
import { ALL_ENTITY_TYPES, ENTITY_REGISTRY, EntityType, getEntityConfig, isChildEntity } from './graphql';
import { applyShopifyAgentFieldInstructions } from './shopify-agent-instructions';
import { SEO_METAFIELD_ENTITIES, ShopifyApiClient, ShopifyError } from './shopify-api-client';
import { buildShopifyDefaultView } from './shopify-default-view';
import { ShopifyCredentials } from './shopify-types';

const LOG_SOURCE = 'ShopifyConnector';

// Schema imports - these are the generated TypeBox schemas
import { ArticlesSchema } from './graphql/schemas/articles.schema';
import { BlogsSchema } from './graphql/schemas/blogs.schema';
import { CollectionsSchema } from './graphql/schemas/collections.schema';
import { CustomersSchema } from './graphql/schemas/customers.schema';
import { FilesSchema } from './graphql/schemas/files.schema';
import { MetaobjectsSchema } from './graphql/schemas/metaobjects.schema';
import { OrderLineItemsSchema } from './graphql/schemas/order-line-items.schema';
import { OrderShippingLinesSchema } from './graphql/schemas/order-shipping-lines.schema';
import { OrdersSchema } from './graphql/schemas/orders.schema';
import { PagesSchema } from './graphql/schemas/pages.schema';
import { ProductMediaSchema } from './graphql/schemas/product-media.schema';
import { ProductVariantsSchema } from './graphql/schemas/product-variants.schema';
import { ProductsSchema } from './graphql/schemas/products.schema';

// Read-only field imports from generated mutations
import { ARTICLES_READ_ONLY_FIELDS, ARTICLES_STRIP_ON_UPDATE_FIELDS } from './graphql/mutations/articles.mutations';
import { BLOGS_READ_ONLY_FIELDS } from './graphql/mutations/blogs.mutations';
import { COLLECTIONS_READ_ONLY_FIELDS } from './graphql/mutations/collections.mutations';
import { PAGES_READ_ONLY_FIELDS } from './graphql/mutations/pages.mutations';
import { PRODUCTS_READ_ONLY_FIELDS } from './graphql/mutations/products.mutations';

/**
 * Map entity types to their TypeBox schemas
 */
const SCHEMA_MAP: Record<EntityType, TSchema> = {
  products: ProductsSchema,
  product_variants: ProductVariantsSchema,
  product_media: ProductMediaSchema,
  collections: CollectionsSchema,
  pages: PagesSchema,
  blogs: BlogsSchema,
  articles: ArticlesSchema,
  customers: CustomersSchema,
  orders: OrdersSchema,
  order_line_items: OrderLineItemsSchema,
  order_shipping_lines: OrderShippingLinesSchema,
  files: FilesSchema,
  metaobjects: MetaobjectsSchema,
};

/**
 * Map entity types to their read-only field sets (for writable entities)
 */
const READ_ONLY_FIELDS_MAP: Partial<Record<EntityType, Set<string>>> = {
  products: PRODUCTS_READ_ONLY_FIELDS,
  collections: COLLECTIONS_READ_ONLY_FIELDS,
  pages: PAGES_READ_ONLY_FIELDS,
  blogs: BLOGS_READ_ONLY_FIELDS,
  articles: ARTICLES_READ_ONLY_FIELDS,
};

/**
 * Map entity types to their strip-on-update field sets
 */
const STRIP_ON_UPDATE_MAP: Partial<Record<EntityType, Set<string>>> = {
  articles: ARTICLES_STRIP_ON_UPDATE_FIELDS,
};

/**
 * Connector for the Shopify e-commerce platform.
 *
 * Supports full CRUD for Products, Collections, Pages, Blogs, Articles.
 * Read-only access for Customers, Orders, Files, Metaobjects.
 * Normalized child entities: Product Variants, Product Media, Order Line Items, Order Shipping Lines.
 */
export class ShopifyConnector extends Connector {
  readonly service = Service.SHOPIFY;
  static readonly displayName = 'Shopify';
  static readonly metadata = connectorMetadata({
    displayName: 'Shopify',
    table: 'resource',
    tables: 'resources',
    record: 'item',
    records: 'items',
    base: 'store',
    bases: 'stores',
    logo: 'https://static.scratch.md/connector-icons/shopify.svg',
    setupGuide: {
      label: 'Create a Shopify Custom App',
      url: '/shopify-custom-app',
    },
    credentialFields: {
      user_provided_params: [
        {
          key: 'shopDomain',
          type: 'string',
          label: 'Shop Domain',
          placeholder: 'your-store.myshopify.com',
          description: 'Your Shopify store domain (e.g., your-store.myshopify.com)',
          required: true,
        },
        {
          key: 'apiKey',
          type: 'password',
          label: 'Admin API Access Token',
          placeholder: 'shpat_...',
          description: 'The Admin API access token from your custom app (starts with shpat_)',
          required: true,
        },
      ],
    },
  });

  private readonly client: ShopifyApiClient;

  constructor(credentials: ShopifyCredentials, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new ShopifyApiClient(credentials, { rateLimiter: opts?.rateLimiter });
  }

  /**
   * Test the connection by validating credentials.
   */
  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  /**
   * List available tables - all entity types from generated registry.
   * Excludes Plus-only entities (customers, orders, etc.) as they require special access.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return ALL_ENTITY_TYPES.filter((entityType) => {
      const config = getEntityConfig(entityType);
      // Exclude Plus-only entities - they require Shopify Plus subscription
      if ('metadata' in config && config.metadata) {
        const metadata = config.metadata as { plusOnly?: boolean };
        if (metadata.plusOnly) return false;
      }
      return true;
    }).map((entityType) => {
      const config = getEntityConfig(entityType);
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
   * Fetch the JSON Table Spec for a Shopify entity type.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const entityType = id.wsId as EntityType;
    const config = ENTITY_REGISTRY[entityType];

    if (!config) {
      const supported = ALL_ENTITY_TYPES.join(', ');
      throw new ShopifyError(`Entity type '${id.wsId}' not found. Supported types: ${supported}`, 404);
    }

    const schema = SCHEMA_MAP[entityType];
    if (!schema) {
      throw new ShopifyError(`Schema not found for entity type '${entityType}'`, 500);
    }

    // Add parent foreign key to schema if this is a child entity
    const parent = 'parent' in config ? (config as { parent: { foreignKey: string } }).parent : null;
    let resolvedSchema =
      parent?.foreignKey && schema.properties && !(parent.foreignKey in schema.properties)
        ? Type.Object(
            { ...schema.properties, [parent.foreignKey]: Type.Optional(Type.Union([Type.String(), Type.Null()])) },
            schema.$id || schema.title ? { $id: schema.$id, title: schema.title } : {},
          )
        : schema;

    // SEO metafield entities (articles/pages/blogs) land the raw metafields verbatim as
    // `seoTitle`/`seoDescription`, each shaped `{ value?: string | null } | null` (Connector
    // Prime Directive — no reshape into a synthetic `seo` object). Inject those nested objects
    // into the schema so the value stays editable via the `seoTitle.value`/`seoDescription.value`
    // dot-paths. The default view groups them under an "SEO" banner (see shopify-default-view.ts).
    if (
      SEO_METAFIELD_ENTITIES.has(entityType) &&
      resolvedSchema.properties &&
      !('seoTitle' in resolvedSchema.properties)
    ) {
      const seoMetafieldObject = Type.Optional(
        Type.Union([Type.Object({ value: Type.Union([Type.String(), Type.Null()]) }), Type.Null()]),
      );
      resolvedSchema = Type.Object(
        {
          ...resolvedSchema.properties,
          seoTitle: seoMetafieldObject,
          seoDescription: seoMetafieldObject,
        },
        resolvedSchema.$id || resolvedSchema.title ? { $id: resolvedSchema.$id, title: resolvedSchema.title } : {},
      );
    }

    // Attach agent instructions (hand-maintained; the generated schemas can't carry them — codegen overwrites).
    resolvedSchema = applyShopifyAgentFieldInstructions(resolvedSchema, entityType);

    const spec: BaseJsonTableSpec = {
      id,
      slug: entityType,
      name: config.displayName,
      schema: resolvedSchema,
      idPath: dotPath('id'),
      generatedAt: new Date().toISOString(),
    };

    spec.defaultView = buildShopifyDefaultView(resolvedSchema, entityType);

    // Safely access columns - TypeScript union types make direct access difficult
    const columns = config.columns as
      | { slug?: string; title?: readonly string[]; mainContent?: readonly string[] }
      | undefined;
    if (columns?.slug) {
      spec.slugPath = dotPath(columns.slug);
    }
    if (columns?.title) {
      spec.titlePath = dotPath(columns.title.join('.'));
    }
    if (columns?.mainContent) {
      spec.mainContentPath = dotPath(columns.mainContent.join('.'));
    }

    return spec;
  }

  /**
   * Pull all entities of the given type as JSON files.
   * Child entities (variants, media, line items) are pulled via their parent.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const entityType = tableSpec.id.wsId as EntityType;

    if (!ENTITY_REGISTRY[entityType]) {
      throw new ShopifyError(`Unsupported table: ${tableSpec.id.wsId}`, 400);
    }

    const resumeCursor = (progress as { endCursor?: string })?.endCursor;

    // Check if this is a child entity
    if (isChildEntity(entityType)) {
      // Child entity resume not yet supported due to compound pagination (parent + child cursors)
      await this.pullChildRecords(entityType, callback);
    } else {
      await this.pullParentRecords(entityType, callback, resumeCursor);
    }
    return {};
  }

  /**
   * Pull records for a top-level (parent) entity.
   */
  private async pullParentRecords(
    entityType: EntityType,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    resumeCursor?: string,
  ): Promise<void> {
    for await (const batch of this.client.listEntities(entityType, 50, resumeCursor)) {
      await callback({
        files: batch.nodes as ConnectorFile[],
        connectorProgress: batch.endCursor ? { endCursor: batch.endCursor } : {},
      });
    }
  }

  /**
   * Pull records for a child entity by iterating through parents and extracting children.
   * Note: Resume not yet supported for child entities due to compound pagination.
   */
  private async pullChildRecords(
    entityType: EntityType,
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const config = ENTITY_REGISTRY[entityType];
    if (!('parent' in config) || !config.parent) {
      throw new ShopifyError(`Entity ${entityType} is marked as child but has no parent config`, 500);
    }

    const parentType = config.parent.entityType as EntityType;
    const foreignKey = config.parent.foreignKey;
    const connectionField = config.parent.connectionField;

    WSLogger.info({
      source: LOG_SOURCE,
      message: `Pulling ${entityType} via parent ${parentType}.${connectionField}`,
    });

    // Iterate through all parents
    for await (const batch of this.client.listEntities(parentType)) {
      for (const parent of batch.nodes) {
        const parentId = String(parent.id);

        // Fetch the connection data for this parent
        const children = await this.client.fetchConnection(parentId, parentType, connectionField);

        if (children.length > 0) {
          // Add foreign key to each child
          const normalizedChildren = children.map((child) => ({
            ...child,
            [foreignKey]: parentId,
          })) as ConnectorFile[];

          await callback({ files: normalizedChildren });
        }
      }
    }
  }

  /**
   * Fetch specific records by their GIDs using Shopify's `nodes` query.
   * The API client resolves the GraphQL type name from the entity registry.
   * For child entities, adds the parent foreign key from the node data if available.
   */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const entityType = tableSpec.id.wsId as EntityType;

    if (!ENTITY_REGISTRY[entityType]) {
      throw new ShopifyError(`Unsupported table: ${tableSpec.id.wsId}`, 400);
    }

    const nodes = await this.client.fetchNodesByIds(entityType, ids);

    if (isChildEntity(entityType)) {
      const config = ENTITY_REGISTRY[entityType];
      if ('parent' in config && config.parent) {
        const foreignKey = config.parent.foreignKey;
        const parentEntitySingular = config.parent.entityType.replace(/s$/, '');
        const files = nodes.map((node) => {
          const file = { ...node } as ConnectorFile;
          // Extract parent ID from the embedded parent object (e.g. node.product, node.order)
          if (!file[foreignKey]) {
            const parentObj = node[parentEntitySingular] as { id: string } | undefined;
            if (parentObj?.id) {
              file[foreignKey] = String(parentObj.id);
            }
          }
          return file;
        });
        await callback({ files });
        return;
      }
    }

    if (nodes.length > 0) {
      await callback({ files: nodes as ConnectorFile[] });
    }
  }

  /**
   * Get the batch size for CRUD operations.
   */
  getBatchSize(operation: 'create' | 'update' | 'delete'): number {
    return operation === 'delete' ? 1 : 10;
  }

  /**
   * Create records from JSON files.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const entityType = tableSpec.id.wsId as EntityType;
    this.assertWritable(entityType);

    const results: ConnectorFile[] = [];
    for (const file of files) {
      const input = this.stripReadOnlyFields(file, entityType);
      const created = await this.client.createEntity(entityType, input);
      results.push(created as ConnectorFile);
    }

    return results;
  }

  /**
   * Update records from JSON files.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const entityType = tableSpec.id.wsId as EntityType;
    this.assertWritable(entityType);

    const results: ConnectorFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const entityId = String(files[i].id);
      const input = this.buildUpdateInputOrThrowOnReadonly(changedFields[i] as ConnectorFile, entityType);
      const updated = await this.client.updateEntity(entityType, entityId, input);
      results.push(updated as unknown as ConnectorFile);
    }
    return results;
  }

  /**
   * Delete records.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const entityType = tableSpec.id.wsId as EntityType;
    this.assertWritable(entityType);

    const config = getEntityConfig(entityType);

    for (const file of files) {
      try {
        await this.client.deleteEntity(entityType, String(file.id));
      } catch (error) {
        // Ignore 404s - the entity may already be deleted
        if (error instanceof ShopifyError && error.statusCode === 404) {
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

  /**
   * Assert that the entity type supports write operations.
   */
  private assertWritable(entityType: EntityType): void {
    const config = getEntityConfig(entityType);
    if (config.readOnly) {
      throw new ShopifyError(
        `${config.displayName} are read-only and cannot be created, updated, or deleted`,
        400,
        'READ_ONLY',
      );
    }
  }

  /**
   * Strip read-only fields from a full record before a CREATE mutation. The
   * record carries every field verbatim from a pull (including the service's
   * read-only fields), so they're dropped rather than thrown on.
   */
  private stripReadOnlyFields(file: ConnectorFile, entityType: EntityType): Record<string, unknown> {
    const readOnly = READ_ONLY_FIELDS_MAP[entityType] ?? new Set<string>();
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(file)) {
      if (readOnly.has(key) || value === undefined) {
        continue;
      }
      result[key] = value;
    }

    return result;
  }

  /**
   * Build the UPDATE input from the user's sparse changed fields, throwing if any
   * changed field is read-only or not writable on update (DEV-10597). The keys
   * here are only what the user actually changed, so a read-only key is a genuine
   * read-only edit that must be surfaced rather than silently dropped (which sent
   * an empty/partial no-op mutation and reported success). Contrast
   * {@link stripReadOnlyFields}, used for create on the full record.
   */
  private buildUpdateInputOrThrowOnReadonly(
    changedFile: ConnectorFile,
    entityType: EntityType,
  ): Record<string, unknown> {
    const readOnly = READ_ONLY_FIELDS_MAP[entityType] ?? new Set<string>();
    const updateOnly = STRIP_ON_UPDATE_MAP[entityType];
    const writableFields: Record<string, unknown> = {};
    const readonlyChangedFieldNames: string[] = [];

    for (const [key, value] of Object.entries(changedFile)) {
      if (value === undefined) {
        continue;
      }
      if (readOnly.has(key) || (updateOnly && updateOnly.has(key))) {
        readonlyChangedFieldNames.push(key);
        continue;
      }
      writableFields[key] = value;
    }

    if (readonlyChangedFieldNames.length > 0) {
      throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedFieldNames));
    }

    return writableFields;
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath ?? tableSpec.slugColumnRemoteId);
  }

  /**
   * Extract error details for user-friendly error reporting.
   */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof ShopifyError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          status: error.statusCode,
          code: error.code,
          userErrors: error.userErrors,
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
}

connectorRegistry.register({
  service: Service.SHOPIFY,
  metadata: ShopifyConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  rateLimiterSpec: { points: 4, duration: 1 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Shopify', Service.SHOPIFY);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    if (!isShopifyConnectorExtras(ctx.connectorAccount.extras)) {
      throw new ConnectorInstantiationError('Shop domain is required for Shopify', Service.SHOPIFY);
    }
    const { shopDomain } = ctx.connectorAccount.extras;
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('Access token (API key) is required for Shopify', Service.SHOPIFY);
    }
    return new ShopifyConnector({ shopDomain, accessToken: ctx.decryptedCredentials.apiKey }, { rateLimiter });
  },
});
