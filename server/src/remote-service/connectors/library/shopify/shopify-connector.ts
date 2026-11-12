/**
 * Shopify Connector
 *
 * Connector for the Shopify e-commerce platform.
 * Uses generated GraphQL schemas and mutations from codegen.
 */

import { Type, type TSchema } from '@sinclair/typebox';
import { connectorMetadata, IncrementalPullSupport, isShopifyConnectorExtras, TableView } from '@spinner/shared-types';
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
  NonWritableFieldEditError,
  nonWritableFieldEditErrorMessage,
  NonWritableFieldReason,
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
import {
  SEO_METAFIELD_ENTITIES,
  SHOPIFY_ACCESS_FIX_INSTRUCTIONS,
  ShopifyApiClient,
  ShopifyError,
} from './shopify-api-client';
import { buildShopifyDefaultView } from './shopify-default-view';
import {
  buildShopifyUpdatedAtSearchQuery,
  findMissingShopifyAccessScopesForEntity,
  shopifyEntityRequiresAccessScopeCheck,
  shopifyIncrementalPullSupport,
} from './shopify-incremental';
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
    incrementalPull: true,
    incrementalPullInstructions:
      'Incremental pull only downloads records changed since the last pull. Customers, Orders, Order Line Items, and Order Shipping Lines support this, because Shopify can filter customers and orders by their updated-at time. The other tables do not support incremental pull and always re-download in full.',
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
          // The access token is sent to this shop, so changing it means entering the token again (DEV-12723). The value
          // is stored in extras, where the edit check reads it too.
          connectionTarget: true,
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
   * List available tables - all entity types from generated registry. Customers and Orders are on
   * every Shopify plan; a token without the scopes they need fails their pull with a message naming
   * the missing scope (see {@link assertTokenHasAccessScopesForEntity}).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return ALL_ENTITY_TYPES.map((entityType) => {
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
   * Build the curated default TableView for a Shopify entity type purely from its
   * spec, deriving the entity type from `spec.id.wsId` and reading `spec.schema`.
   * Returns `undefined` for an unrecognized entity type (defensive; unreachable in
   * practice because the spec came from {@link fetchJsonTableSpec}).
   */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    const entityType = spec.id.wsId as EntityType;
    if (!ENTITY_REGISTRY[entityType]) return undefined;
    return buildShopifyDefaultView(spec.schema, entityType);
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
   * Customers, Orders, and the order child tables can pull only what changed since the last pull
   * (Shopify's `updated_at` search filter). Other tables always full-pull. With no table spec (the
   * REST layer asking about a folder in general) there's no table to answer for, so the answer is no.
   */
  override incrementalPullSupport(
    _options: PullRecordFilesOptions,
    tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    return tableSpec ? shopifyIncrementalPullSupport(tableSpec.id.wsId) : IncrementalPullSupport.NOT_SUPPORTED;
  }

  /**
   * Pull all entities of the given type as JSON files.
   * Child entities (variants, media, line items) are pulled via their parent.
   *
   * Incremental pull (Customers, Orders, and the order child tables): filter the list by Shopify's
   * `updated_at` search term from the previous watermark, less a clock-skew overlap, and return the
   * new watermark. An order child table filters its parent orders, since a line item or shipping
   * line change updates its order. Deleted records aren't seen by an incremental pull; a full pull
   * removes them.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const entityType = tableSpec.id.wsId as EntityType;

    if (!ENTITY_REGISTRY[entityType]) {
      throw new ShopifyError(`Unsupported table: ${tableSpec.id.wsId}`, 400);
    }

    // Captured before the first API call, so anything changed while this pull runs is pulled again
    // next time rather than missed.
    const pullStartedAt = new Date();
    const updatedAtSearchQueryIfIncremental =
      options.pullMode === 'incremental' &&
      options.since instanceof Date &&
      shopifyIncrementalPullSupport(entityType) === IncrementalPullSupport.SUPPORTED
        ? buildShopifyUpdatedAtSearchQuery(options.since)
        : undefined;

    await this.assertTokenHasAccessScopesForEntity(entityType);

    const resumeCursor = (progress as { endCursor?: string })?.endCursor;

    // Check if this is a child entity
    if (isChildEntity(entityType)) {
      // Child entity resume not yet supported due to compound pagination (parent + child cursors)
      await this.pullChildRecords(entityType, callback, updatedAtSearchQueryIfIncremental);
    } else {
      await this.pullParentRecords(entityType, callback, resumeCursor, updatedAtSearchQueryIfIncremental);
    }
    return updatedAtSearchQueryIfIncremental !== undefined ? { newWatermark: pullStartedAt } : {};
  }

  /**
   * Fail before pulling a table whose access scopes the token lacks (Customers and Orders), naming
   * each missing scope. Without this, Shopify fails the query partway through (ACCESS_DENIED), or,
   * for orders without `read_all_orders`, quietly returns only the last 60 days.
   */
  private async assertTokenHasAccessScopesForEntity(entityType: EntityType): Promise<void> {
    if (!shopifyEntityRequiresAccessScopeCheck(entityType)) return;

    const grantedAccessScopeHandles = await this.client.fetchGrantedAccessScopeHandles();
    const missingAccessScopes = findMissingShopifyAccessScopesForEntity(entityType, grantedAccessScopeHandles);
    if (missingAccessScopes.length === 0) return;

    const displayName = getEntityConfig(entityType).displayName;
    const missingAccessScopeList = missingAccessScopes.map(({ scope, reason }) => `${scope} (${reason})`).join(', ');
    throw new ShopifyError(
      `This Shopify connection's access token is missing scopes needed for ${displayName}: ` +
        `${missingAccessScopeList}. ${SHOPIFY_ACCESS_FIX_INSTRUCTIONS}`,
      403,
      'MISSING_ACCESS_SCOPES',
    );
  }

  /**
   * Pull records for a top-level (parent) entity.
   */
  private async pullParentRecords(
    entityType: EntityType,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    resumeCursor?: string,
    updatedAtSearchQueryIfIncremental?: string,
  ): Promise<void> {
    for await (const batch of this.client.listEntities(entityType, 50, resumeCursor, {
      updatedAtSearchQuery: updatedAtSearchQueryIfIncremental,
    })) {
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
    parentUpdatedAtSearchQueryIfIncremental?: string,
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

    // Iterate through all parents (or, for an incremental pull, the parents updated since the
    // watermark). Only each parent's id is used, so request nothing else: 250 per page, the most
    // Shopify allows.
    for await (const batch of this.client.listEntities(parentType, 250, undefined, {
      updatedAtSearchQuery: parentUpdatedAtSearchQueryIfIncremental,
      selectOnlyRecordIds: true,
    })) {
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

    await this.assertTokenHasAccessScopesForEntity(entityType);

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
    const readOnlyChangedFieldNames: string[] = [];
    const setOnCreateOnlyChangedFieldNames: string[] = [];

    for (const [key, value] of Object.entries(changedFile)) {
      if (value === undefined) {
        continue;
      }
      // A read-only field is service-computed and never writable; a STRIP_ON_UPDATE
      // field (e.g. an article's `blog` / `author`) is settable on create but rejected
      // on update. Both are surfaced, but with wording that matches the reason.
      if (readOnly.has(key)) {
        readOnlyChangedFieldNames.push(key);
        continue;
      }
      if (updateOnly && updateOnly.has(key)) {
        setOnCreateOnlyChangedFieldNames.push(key);
        continue;
      }
      writableFields[key] = value;
    }

    if (readOnlyChangedFieldNames.length > 0 || setOnCreateOnlyChangedFieldNames.length > 0) {
      throw new NonWritableFieldEditError(
        nonWritableFieldEditErrorMessage({
          [NonWritableFieldReason.ReadOnly]: readOnlyChangedFieldNames,
          [NonWritableFieldReason.SetOnCreateOnly]: setOnCreateOnlyChangedFieldNames,
        }),
      );
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
  resolveIncrementalPullSupport: ({ tableId }) => shopifyIncrementalPullSupport(tableId[0] ?? ''),
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
