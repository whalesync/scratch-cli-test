/**
 * Shopify GraphQL Admin API Client
 *
 * Low-level client for the Shopify Admin GraphQL API using axios.
 * Uses generated query fields and mutations from codegen.
 *
 * API docs: https://shopify.dev/docs/api/admin-graphql
 */

import { AxiosInstance, isAxiosError } from 'axios';
import { RateLimiter, WithRetryOpts, withRetry as standaloneWithRetry } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  ShopifyArticleInput,
  ShopifyBlogInput,
  ShopifyCollectionInput,
  ShopifyConnection,
  ShopifyCredentials,
  ShopifyGraphQLResponse,
  ShopifyMetaobjectDefinition,
  ShopifyPageInput,
  ShopifyProductInput,
  ShopifyUserError,
} from './shopify-types';

// Generated query fields
import { ARTICLES_QUERY_FIELDS } from './graphql/schemas/articles.schema';
import { BLOGS_QUERY_FIELDS } from './graphql/schemas/blogs.schema';
import { COLLECTIONS_QUERY_FIELDS } from './graphql/schemas/collections.schema';
import { CUSTOMERS_QUERY_FIELDS } from './graphql/schemas/customers.schema';
import { FILES_QUERY_FIELDS } from './graphql/schemas/files.schema';
import { METAOBJECTS_QUERY_FIELDS } from './graphql/schemas/metaobjects.schema';
import { ORDER_LINE_ITEMS_QUERY_FIELDS } from './graphql/schemas/order-line-items.schema';
import { ORDER_SHIPPING_LINES_QUERY_FIELDS } from './graphql/schemas/order-shipping-lines.schema';
import { ORDERS_QUERY_FIELDS } from './graphql/schemas/orders.schema';
import { PAGES_QUERY_FIELDS } from './graphql/schemas/pages.schema';
import { PRODUCT_MEDIA_QUERY_FIELDS } from './graphql/schemas/product-media.schema';
import { PRODUCT_VARIANTS_QUERY_FIELDS } from './graphql/schemas/product-variants.schema';
import { PRODUCTS_QUERY_FIELDS } from './graphql/schemas/products.schema';

// Generated mutations
import {
  ARTICLES_CREATE_MUTATION,
  ARTICLES_DELETE_MUTATION,
  ARTICLES_UPDATE_MUTATION,
} from './graphql/mutations/articles.mutations';
import {
  BLOGS_CREATE_MUTATION,
  BLOGS_DELETE_MUTATION,
  BLOGS_UPDATE_MUTATION,
} from './graphql/mutations/blogs.mutations';
import {
  COLLECTIONS_CREATE_MUTATION,
  COLLECTIONS_DELETE_MUTATION,
  COLLECTIONS_UPDATE_MUTATION,
} from './graphql/mutations/collections.mutations';
import {
  PAGES_CREATE_MUTATION,
  PAGES_DELETE_MUTATION,
  PAGES_UPDATE_MUTATION,
} from './graphql/mutations/pages.mutations';
import {
  PRODUCTS_CREATE_MUTATION,
  PRODUCTS_DELETE_MUTATION,
  PRODUCTS_UPDATE_MUTATION,
} from './graphql/mutations/products.mutations';

import { API_VERSION, ENTITY_REGISTRY, EntityType } from './graphql';

// Connection pagination size
const CONNECTION_PAGE_SIZE = 25;

// ============= SEO Metafield Support =============

/**
 * Entity types that store SEO data as metafields (global.title_tag / global.description_tag)
 * rather than a native `seo` field. For these types we query the metafields as the raw
 * `seoTitle`/`seoDescription` aliases and land them VERBATIM on the record (Connector Prime
 * Directive) — no reshape into a synthetic `seo` object. The schema/view layer makes those
 * verbatim fields editable, and on publish {@link extractSeoMetafieldsFromVerbatimFields}
 * converts them back into the metafields array the mutation expects.
 */
export const SEO_METAFIELD_ENTITIES = new Set(['articles', 'pages', 'blogs']);

/** GraphQL fragment appended to query fields for SEO metafield entities. */
const SEO_METAFIELD_QUERY_FRAGMENT =
  ' seoTitle: metafield(namespace: "global", key: "title_tag") { value } seoDescription: metafield(namespace: "global", key: "description_tag") { value }';

/**
 * Convert the verbatim `seoTitle`/`seoDescription` metafield-alias fields (each shaped
 * `{ value?: string | null } | null`, exactly as they land from a pull) into the Shopify
 * metafields array format a create/update mutation expects. Merges with any existing
 * `metafields` in the input, then removes the alias fields from the input object.
 */
export function extractSeoMetafieldsFromVerbatimFields(input: Record<string, unknown>): Record<string, unknown> {
  const seoTitle = input.seoTitle as { value?: string | null } | null | undefined;
  const seoDescription = input.seoDescription as { value?: string | null } | null | undefined;

  const metafields: Array<{ namespace: string; key: string; type: string; value: string }> = [];

  const titleValue = seoTitle?.value;
  if (titleValue !== undefined && titleValue !== null) {
    metafields.push({ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: titleValue });
  }
  const descriptionValue = seoDescription?.value;
  if (descriptionValue !== undefined && descriptionValue !== null) {
    metafields.push({
      namespace: 'global',
      key: 'description_tag',
      type: 'single_line_text_field',
      value: descriptionValue,
    });
  }

  delete input.seoTitle;
  delete input.seoDescription;

  if (metafields.length > 0) {
    const existing = (input.metafields as Array<Record<string, unknown>>) ?? [];
    input.metafields = [...existing, ...metafields];
  }

  return input;
}

/**
 * True when Shopify is rate-limiting us. This surfaces in two distinct forms:
 *  - GraphQL-level throttling — the common case. Shopify returns HTTP 200 with an
 *    `errors[]` entry whose `extensions.code` is `THROTTLED`, which
 *    {@link ShopifyApiClient.executeQuery} surfaces as a `ShopifyError` with code
 *    `'THROTTLED'` (some responses only carry the word "throttle" in the message).
 *  - HTTP 429 at the transport/gateway layer — axios rejects with a raw AxiosError
 *    before we ever parse the GraphQL body, so it never becomes a `ShopifyError`.
 *
 * Kept as its own named predicate so the retry policy composes as plain English
 * (rate-limited OR a transient server error) without conflating the two.
 */
export function isShopifyRateLimitError(error: unknown): boolean {
  if (isAxiosError(error)) {
    return error.response?.status === 429;
  }
  return (
    error instanceof ShopifyError && (error.code === 'THROTTLED' || error.message.toLowerCase().includes('throttle'))
  );
}

/**
 * HTTP 5xx codes we treat as transient, retryable Shopify server/infrastructure
 * failures: 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout.
 *
 * We deliberately EXCLUDE 500 Internal Server Error. 502/503/504 are gateway /
 * availability signals — the request did not reach, or was not completed by, a
 * healthy backend — so retrying is safe even for a non-idempotent mutation (POST):
 * the write almost certainly did not persist. A 500 is ambiguous: the backend may
 * have processed the write and then errored, so blindly retrying a create risks a
 * DUPLICATE record, which violates the project's non-destructive / reversible
 * principle. (Shopify's GraphQL API returns HTTP 200 even for GraphQL-level errors,
 * so a genuine 5xx here is a transport/gateway failure, not a query error.)
 */
const SHOPIFY_RETRYABLE_SERVER_ERROR_STATUSES = new Set([502, 503, 504]);

/**
 * True when an error is a transient Shopify server-side failure worth retrying
 * (see {@link SHOPIFY_RETRYABLE_SERVER_ERROR_STATUSES}). The retry predicate sees
 * the RAW AxiosError — a non-2xx HTTP response rejects before `executeQuery` can
 * wrap it into a `ShopifyError` — so this checks `error.response.status` directly.
 */
export function isTransientShopifyServerError(error: unknown): boolean {
  return isAxiosError(error) && SHOPIFY_RETRYABLE_SERVER_ERROR_STATUSES.has(error.response?.status ?? 0);
}

/**
 * Retry options for Shopify API calls. Retries two DISTINCT, independently-scoped
 * failures:
 *  - Rate-limiting — GraphQL-level `THROTTLED` or a transport-layer HTTP 429 (see
 *    {@link isShopifyRateLimitError}).
 *  - Transient Shopify server errors — a narrow 502/503/504 set (see
 *    {@link isTransientShopifyServerError}).
 *
 * The two are kept as SEPARATE predicates on purpose: widening the transient-server
 * case never loosens what counts as rate-limited, and genuine 4xx / GraphQL user
 * errors still surface immediately. `getRetryAfterS` honors a `Retry-After` header
 * when Shopify sends one (429s), else the limiter falls back to exponential backoff.
 */
export const SHOPIFY_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isShopifyRateLimitError(error) || isTransientShopifyServerError(error),
  getRetryAfterS: (error) => {
    if (!isAxiosError(error)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const header = error.response?.headers?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
  maxRetryDelayMs: 30_000,
};

/**
 * Shopify API error
 */
export class ShopifyError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string,
    public userErrors?: ShopifyUserError[],
  ) {
    super(message);
    this.name = 'ShopifyError';
  }
}

/**
 * Normalize a shop domain to the full myshopify.com format.
 */
function normalizeDomain(input: string): string {
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.replace(/\/$/, '');
  if (!domain.includes('.myshopify.com')) {
    domain = `${domain}.myshopify.com`;
  }
  return domain;
}

// ============= Query Field Mapping =============

const QUERY_FIELDS_MAP: Record<string, string> = {
  products: PRODUCTS_QUERY_FIELDS,
  product_variants: PRODUCT_VARIANTS_QUERY_FIELDS,
  product_media: PRODUCT_MEDIA_QUERY_FIELDS,
  collections: COLLECTIONS_QUERY_FIELDS,
  pages: PAGES_QUERY_FIELDS + SEO_METAFIELD_QUERY_FRAGMENT,
  blogs: BLOGS_QUERY_FIELDS + SEO_METAFIELD_QUERY_FRAGMENT,
  articles: ARTICLES_QUERY_FIELDS + SEO_METAFIELD_QUERY_FRAGMENT,
  customers: CUSTOMERS_QUERY_FIELDS,
  orders: ORDERS_QUERY_FIELDS,
  order_line_items: ORDER_LINE_ITEMS_QUERY_FIELDS,
  order_shipping_lines: ORDER_SHIPPING_LINES_QUERY_FIELDS,
  files: FILES_QUERY_FIELDS,
  metaobjects: METAOBJECTS_QUERY_FIELDS,
};

// ============= GraphQL Root Field Mapping =============

const ROOT_FIELD_MAP: Record<string, string> = {
  products: 'products',
  collections: 'collections',
  pages: 'pages',
  blogs: 'blogs',
  articles: 'articles',
  customers: 'customers',
  orders: 'orders',
  files: 'files',
};

// ============= Connection Field Mapping =============

// Map from parent entity type + connection field to child query fields
const CONNECTION_FIELDS_MAP: Record<string, Record<string, string>> = {
  products: {
    variants: PRODUCT_VARIANTS_QUERY_FIELDS,
    media: PRODUCT_MEDIA_QUERY_FIELDS,
    images: `id url altText width height`,
  },
  orders: {
    lineItems: ORDER_LINE_ITEMS_QUERY_FIELDS,
    shippingLines: ORDER_SHIPPING_LINES_QUERY_FIELDS,
  },
};

/**
 * Shopify GraphQL API client.
 */
export class ShopifyApiClient {
  private readonly client: AxiosInstance;
  private readonly domain: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(credentials: ShopifyCredentials, opts?: { rateLimiter?: RateLimiter }) {
    this.domain = normalizeDomain(credentials.shopDomain);
    this.rateLimiter = opts?.rateLimiter;

    this.client = createApiClient({
      baseURL: `https://${this.domain}/admin/api/${API_VERSION}`,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': credentials.accessToken,
      },
    });
  }

  // ============= Core GraphQL Execution =============

  /**
   * Execute a GraphQL query/mutation with automatic retry on throttling.
   */
  private async query<T>(queryString: string, variables?: Record<string, unknown>): Promise<T> {
    const fn = () => this.executeQuery<T>(queryString, variables);
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, SHOPIFY_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, SHOPIFY_RETRY_OPTS);
  }

  /**
   * Execute a single GraphQL query/mutation (no retry).
   */
  private async executeQuery<T>(queryString: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await this.client.post<ShopifyGraphQLResponse<T>>('/graphql.json', {
      query: queryString,
      variables,
    });

    const result = response.data;

    if (result.errors && result.errors.length > 0) {
      const error = result.errors[0];
      const code = error.extensions?.code as string | undefined;
      throw new ShopifyError(error.message, 400, code);
    }

    if (!result.data) {
      throw new ShopifyError('No data returned from Shopify API', 500);
    }

    return result.data;
  }

  // ============= Connection Validation =============

  /**
   * Validate credentials by querying shop info.
   */
  async validateCredentials(): Promise<void> {
    try {
      await this.query<{ shop: { id: string; name: string } }>(`
        query { shop { id name } }
      `);
    } catch (error) {
      if (error instanceof ShopifyError && (error.statusCode === 401 || error.statusCode === 403)) {
        throw new ShopifyError('Invalid Shopify credentials', 401, 'UNAUTHORIZED');
      }
      throw error;
    }
  }

  // ============= Generic List Methods =============

  /**
   * List entities by type using generated query fields.
   */
  async *listEntities(
    entityType: string,
    pageSize = 50,
    resumeCursor?: string,
  ): AsyncGenerator<{ nodes: Record<string, unknown>[]; endCursor: string | null }, void> {
    if (entityType === 'metaobjects') {
      // Metaobject resume not yet supported due to compound pagination (definition + cursor)
      yield* this.listMetaobjects(pageSize);
      return;
    }

    if (entityType === 'files') {
      yield* this.listFiles(pageSize, resumeCursor);
      return;
    }

    const rootField = ROOT_FIELD_MAP[entityType];
    const queryFields = QUERY_FIELDS_MAP[entityType];

    if (!rootField || !queryFields) {
      throw new ShopifyError(`Unknown entity type: ${entityType}`, 400);
    }

    const queryString = `
      query List${capitalize(rootField)}($first: Int!, $after: String) {
        ${rootField}(first: $first, after: $after) {
          nodes { ${queryFields} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    // SEO metafields (seoTitle/seoDescription aliases) land verbatim — no reshape.
    yield* this.paginatedList<Record<string, unknown>>(queryString, rootField, pageSize, resumeCursor);
  }

  /**
   * Generic paginated list generator.
   */
  private async *paginatedList<T>(
    queryString: string,
    rootField: string,
    pageSize: number,
    resumeCursor?: string,
  ): AsyncGenerator<{ nodes: T[]; endCursor: string | null }, void> {
    let cursor: string | null = resumeCursor ?? null;
    let hasMore = true;

    while (hasMore) {
      type ResponseType = Record<string, ShopifyConnection<T>>;
      const response: ResponseType = await this.query<ResponseType>(queryString, {
        first: pageSize,
        after: cursor,
      });

      const connection: ShopifyConnection<T> | undefined = response[rootField];
      if (!connection || connection.nodes.length === 0) break;

      hasMore = connection.pageInfo.hasNextPage;
      cursor = connection.pageInfo.endCursor;

      yield { nodes: connection.nodes, endCursor: cursor };
    }
  }

  /**
   * List files. Nodes are yielded verbatim (Connector Prime Directive) — a MediaImage keeps
   * its nested `image { url … }` object rather than being flattened to a top-level `url`. We
   * only drop nodes without an `id` (defensive; the API shouldn't return those).
   */
  private async *listFiles(
    pageSize: number,
    resumeCursor?: string,
  ): AsyncGenerator<{ nodes: Record<string, unknown>[]; endCursor: string | null }, void> {
    const queryFields = QUERY_FIELDS_MAP.files;
    const queryString = `
      query ListFiles($first: Int!, $after: String) {
        files(first: $first, after: $after) {
          nodes { ${queryFields} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    for await (const page of this.paginatedList<Record<string, unknown>>(
      queryString,
      'files',
      pageSize,
      resumeCursor,
    )) {
      const nodesWithId = page.nodes.filter((f) => f.id);
      if (nodesWithId.length > 0) {
        yield { nodes: nodesWithId, endCursor: page.endCursor };
      }
    }
  }

  /**
   * List metaobjects across all types.
   */
  private async *listMetaobjects(
    pageSize: number,
  ): AsyncGenerator<{ nodes: Record<string, unknown>[]; endCursor: string | null }, void> {
    const definitions = await this.listMetaobjectDefinitions();
    const queryFields = QUERY_FIELDS_MAP.metaobjects;

    for (const def of definitions) {
      const queryString = `
        query ListMetaobjects($type: String!, $first: Int!, $after: String) {
          metaobjects(type: $type, first: $first, after: $after) {
            nodes { ${queryFields} }
            pageInfo { hasNextPage endCursor }
          }
        }
      `;

      let cursor: string | null = null;
      let hasMore = true;

      while (hasMore) {
        type MetaobjectsResponse = { metaobjects: ShopifyConnection<Record<string, unknown>> };
        const response: MetaobjectsResponse = await this.query<MetaobjectsResponse>(queryString, {
          type: def.type,
          first: pageSize,
          after: cursor,
        });

        if (!response.metaobjects || response.metaobjects.nodes.length === 0) break;

        hasMore = response.metaobjects.pageInfo.hasNextPage;
        cursor = response.metaobjects.pageInfo.endCursor;

        yield { nodes: response.metaobjects.nodes, endCursor: cursor };
      }
    }
  }

  /**
   * Fetch all metaobject definitions.
   */
  private async listMetaobjectDefinitions(): Promise<ShopifyMetaobjectDefinition[]> {
    const allDefs: ShopifyMetaobjectDefinition[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    const queryString = `
      query ListMetaobjectDefinitions($first: Int!, $after: String) {
        metaobjectDefinitions(first: $first, after: $after) {
          nodes { id type name }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    while (hasMore) {
      type DefsResponse = { metaobjectDefinitions: ShopifyConnection<ShopifyMetaobjectDefinition> };
      const response: DefsResponse = await this.query<DefsResponse>(queryString, { first: 50, after: cursor });

      if (!response.metaobjectDefinitions || response.metaobjectDefinitions.nodes.length === 0) break;

      allDefs.push(...response.metaobjectDefinitions.nodes);
      hasMore = response.metaobjectDefinitions.pageInfo.hasNextPage;
      cursor = response.metaobjectDefinitions.pageInfo.endCursor;
    }

    return allDefs;
  }

  // ============= Bulk Node Fetching =============

  /**
   * Entity types that cannot be fetched via the top-level `nodes(ids:)` query.
   * - order_line_items / order_shipping_lines: don't implement the Node interface.
   * - product_media / files: their graphqlType is an interface (Media / File), not
   *   a concrete Node type, so inline fragments won't resolve reliably.
   */
  private static readonly NODES_UNSUPPORTED_TYPES = new Set<string>([
    'order_line_items',
    'order_shipping_lines',
    'product_media',
    'files',
  ]);

  /**
   * Fetch multiple nodes by their GIDs using Shopify's top-level `nodes` query.
   * Resolves the GraphQL type name from the entity registry.
   * Batches requests to stay within Shopify's 250-node limit per query.
   */
  async fetchNodesByIds(entityType: EntityType, ids: string[]): Promise<Record<string, unknown>[]> {
    if (ShopifyApiClient.NODES_UNSUPPORTED_TYPES.has(entityType)) {
      const config = ENTITY_REGISTRY[entityType];
      throw new ShopifyError(
        `pullRecordFilesByIds is not supported for ${config.displayName}. ` +
          `These entities cannot be fetched via the Shopify nodes query.`,
        400,
      );
    }

    const config = ENTITY_REGISTRY[entityType];
    const graphqlTypeName = config.graphqlType as string;
    const queryFields = QUERY_FIELDS_MAP[entityType];
    if (!queryFields) {
      throw new ShopifyError(`No query fields for entity type: ${entityType}`, 400);
    }

    const NODES_BATCH_SIZE = 250;
    const allNodes: Record<string, unknown>[] = [];

    for (let i = 0; i < ids.length; i += NODES_BATCH_SIZE) {
      const batch = ids.slice(i, i + NODES_BATCH_SIZE);

      const queryString = `
        query FetchNodesByIds($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ${graphqlTypeName} {
              ${queryFields}
            }
          }
        }
      `;

      const data = await this.query<{ nodes: (Record<string, unknown> | null)[] }>(queryString, { ids: batch });

      if (data.nodes) {
        for (const node of data.nodes) {
          if (node && node.id) {
            allNodes.push(node);
          }
        }
      }
    }

    // SEO metafields (seoTitle/seoDescription aliases) land verbatim — no reshape.
    return allNodes;
  }

  // ============= Connection Fetching =============

  /**
   * Fetch all records from a connection field on a parent entity.
   * Used for pulling child entities (variants, media, line items, etc.)
   */
  async fetchConnection(
    parentId: string,
    parentType: string,
    connectionField: string,
  ): Promise<Record<string, unknown>[]> {
    const connectionFieldsForParent = CONNECTION_FIELDS_MAP[parentType];
    if (!connectionFieldsForParent) {
      throw new ShopifyError(`Unknown parent type for connection: ${parentType}`, 400);
    }

    const queryFields = connectionFieldsForParent[connectionField];
    if (!queryFields) {
      throw new ShopifyError(`Unknown connection field: ${parentType}.${connectionField}`, 400);
    }

    const parentTypeName = capitalize(parentType.replace(/s$/, '')); // products -> Product

    const queryString = `
      query FetchConnection($id: ID!, $first: Int!, $after: String) {
        node(id: $id) {
          ... on ${parentTypeName} {
            ${connectionField}(first: $first, after: $after) {
              nodes { ${queryFields} }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    `;

    const allNodes: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const data = await this.query<{ node: Record<string, unknown> | null }>(queryString, {
        id: parentId,
        first: CONNECTION_PAGE_SIZE,
        after: cursor,
      });

      if (!data.node) break;

      const connectionData = data.node[connectionField] as {
        nodes: Record<string, unknown>[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      } | null;

      if (!connectionData || connectionData.nodes.length === 0) break;

      allNodes.push(...connectionData.nodes);
      hasMore = connectionData.pageInfo.hasNextPage;
      cursor = connectionData.pageInfo.endCursor;
    }

    return allNodes;
  }

  // ============= CRUD Operations =============

  /**
   * Create an entity.
   */
  async createEntity(entityType: EntityType, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (entityType) {
      case 'products':
        return this.createProduct(input as ShopifyProductInput);
      case 'collections':
        return this.createCollection(input as ShopifyCollectionInput);
      case 'pages':
        return this.createPage(input as ShopifyPageInput);
      case 'blogs':
        return this.createBlog(input as ShopifyBlogInput);
      case 'articles':
        return this.createArticle(input as ShopifyArticleInput);
      default:
        throw new ShopifyError(`Create not supported for entity type: ${entityType}`, 400);
    }
  }

  /**
   * Update an entity.
   */
  async updateEntity(
    entityType: EntityType,
    id: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (entityType) {
      case 'products':
        return this.updateProduct(id, input as ShopifyProductInput);
      case 'collections':
        return this.updateCollection(id, input as ShopifyCollectionInput);
      case 'pages':
        return this.updatePage(id, input as ShopifyPageInput);
      case 'blogs':
        return this.updateBlog(id, input as ShopifyBlogInput);
      case 'articles':
        return this.updateArticle(id, input as ShopifyArticleInput);
      default:
        throw new ShopifyError(`Update not supported for entity type: ${entityType}`, 400);
    }
  }

  /**
   * Delete an entity.
   */
  async deleteEntity(entityType: EntityType, id: string): Promise<void> {
    switch (entityType) {
      case 'products':
        await this.deleteProduct(id);
        break;
      case 'collections':
        await this.deleteCollection(id);
        break;
      case 'pages':
        await this.deletePage(id);
        break;
      case 'blogs':
        await this.deleteBlog(id);
        break;
      case 'articles':
        await this.deleteArticle(id);
        break;
      default:
        throw new ShopifyError(`Delete not supported for entity type: ${entityType}`, 400);
    }
  }

  // ============= Product Mutations =============

  private async createProduct(input: ShopifyProductInput): Promise<Record<string, unknown>> {
    const mutationInput = this.transformCategoryInput(input);
    const data = await this.query<{
      productCreate: { product: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(PRODUCTS_CREATE_MUTATION, { product: mutationInput });

    this.throwOnUserErrors(data.productCreate.userErrors);

    if (!data.productCreate.product) {
      throw new ShopifyError('Failed to create product', 500);
    }

    return data.productCreate.product;
  }

  private async updateProduct(id: string, input: ShopifyProductInput): Promise<Record<string, unknown>> {
    const mutationInput = this.transformCategoryInput(input);
    const data = await this.query<{
      productUpdate: { product: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(PRODUCTS_UPDATE_MUTATION, { product: { ...mutationInput, id } });

    this.throwOnUserErrors(data.productUpdate.userErrors);
    if (!data.productUpdate.product) {
      throw new ShopifyError('Failed to update product', 500);
    }
    return data.productUpdate.product;
  }

  private async deleteProduct(id: string): Promise<void> {
    const data = await this.query<{
      productDelete: { deletedProductId: string | null; userErrors: ShopifyUserError[] };
    }>(PRODUCTS_DELETE_MUTATION, { input: { id } });

    this.throwOnUserErrors(data.productDelete.userErrors);
  }

  // ============= Collection Mutations =============

  private async createCollection(input: ShopifyCollectionInput): Promise<Record<string, unknown>> {
    const data = await this.query<{
      collectionCreate: { collection: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(COLLECTIONS_CREATE_MUTATION, { input });

    this.throwOnUserErrors(data.collectionCreate.userErrors);

    if (!data.collectionCreate.collection) {
      throw new ShopifyError('Failed to create collection', 500);
    }

    return data.collectionCreate.collection;
  }

  private async updateCollection(id: string, input: ShopifyCollectionInput): Promise<Record<string, unknown>> {
    const data = await this.query<{
      collectionUpdate: { collection: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(COLLECTIONS_UPDATE_MUTATION, { input: { ...input, id } });

    this.throwOnUserErrors(data.collectionUpdate.userErrors);
    if (!data.collectionUpdate.collection) {
      throw new ShopifyError('Failed to update collection', 500);
    }
    return data.collectionUpdate.collection;
  }

  private async deleteCollection(id: string): Promise<void> {
    const data = await this.query<{
      collectionDelete: { deletedCollectionId: string | null; userErrors: ShopifyUserError[] };
    }>(COLLECTIONS_DELETE_MUTATION, { input: { id } });

    this.throwOnUserErrors(data.collectionDelete.userErrors);
  }

  // ============= Page Mutations =============

  private async createPage(input: ShopifyPageInput): Promise<Record<string, unknown>> {
    const mutationInput = extractSeoMetafieldsFromVerbatimFields({ ...input });
    const data = await this.query<{
      pageCreate: { page: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(PAGES_CREATE_MUTATION, { page: mutationInput });

    this.throwOnUserErrors(data.pageCreate.userErrors);

    if (!data.pageCreate.page) {
      throw new ShopifyError('Failed to create page', 500);
    }

    return data.pageCreate.page;
  }

  private async updatePage(id: string, input: ShopifyPageInput): Promise<Record<string, unknown>> {
    const mutationInput = extractSeoMetafieldsFromVerbatimFields({ ...input });
    const data = await this.query<{
      pageUpdate: { page: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(PAGES_UPDATE_MUTATION, { id, page: mutationInput });

    this.throwOnUserErrors(data.pageUpdate.userErrors);
    if (!data.pageUpdate.page) {
      throw new ShopifyError('Failed to update page', 500);
    }
    return data.pageUpdate.page;
  }

  private async deletePage(id: string): Promise<void> {
    const data = await this.query<{
      pageDelete: { deletedPageId: string | null; userErrors: ShopifyUserError[] };
    }>(PAGES_DELETE_MUTATION, { id });

    this.throwOnUserErrors(data.pageDelete.userErrors);
  }

  // ============= Blog Mutations =============

  private async createBlog(input: ShopifyBlogInput): Promise<Record<string, unknown>> {
    const mutationInput = extractSeoMetafieldsFromVerbatimFields({ ...input });
    const data = await this.query<{
      blogCreate: { blog: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(BLOGS_CREATE_MUTATION, { blog: mutationInput });

    this.throwOnUserErrors(data.blogCreate.userErrors);

    if (!data.blogCreate.blog) {
      throw new ShopifyError('Failed to create blog', 500);
    }

    return data.blogCreate.blog;
  }

  private async updateBlog(id: string, input: ShopifyBlogInput): Promise<Record<string, unknown>> {
    const mutationInput = extractSeoMetafieldsFromVerbatimFields({ ...input });
    const data = await this.query<{
      blogUpdate: { blog: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(BLOGS_UPDATE_MUTATION, { id, blog: mutationInput });

    this.throwOnUserErrors(data.blogUpdate.userErrors);
    if (!data.blogUpdate.blog) {
      throw new ShopifyError('Failed to update blog', 500);
    }
    return data.blogUpdate.blog;
  }

  private async deleteBlog(id: string): Promise<void> {
    const data = await this.query<{
      blogDelete: { deletedBlogId: string | null; userErrors: ShopifyUserError[] };
    }>(BLOGS_DELETE_MUTATION, { id });

    this.throwOnUserErrors(data.blogDelete.userErrors);
  }

  // ============= Article Mutations =============

  private async createArticle(input: ShopifyArticleInput): Promise<Record<string, unknown>> {
    // Articles require blog.id in the mutation input as flat blogId
    if (!input.blog?.id) {
      throw new ShopifyError('blog.id is required to create an article', 400, 'MISSING_BLOG_ID');
    }

    // Transform blog.id → blogId and author
    const authorName = input.author?.name?.trim() || 'Admin';
    const articleInput: Record<string, unknown> = {
      title: input.title,
      body: input.body,
      summary: input.summary,
      handle: input.handle,
      tags: input.tags,
      isPublished: input.isPublished,
      templateSuffix: input.templateSuffix,
      blogId: input.blog.id,
      author: { name: authorName },
    };

    // Carry the verbatim SEO metafield-alias fields through so they convert to metafields below.
    if (input.seoTitle !== undefined) {
      articleInput.seoTitle = input.seoTitle;
    }
    if (input.seoDescription !== undefined) {
      articleInput.seoDescription = input.seoDescription;
    }

    // Remove undefined values
    for (const key of Object.keys(articleInput)) {
      if (articleInput[key] === undefined) {
        delete articleInput[key];
      }
    }

    // Convert verbatim seoTitle/seoDescription to metafields
    extractSeoMetafieldsFromVerbatimFields(articleInput);

    const data = await this.query<{
      articleCreate: { article: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(ARTICLES_CREATE_MUTATION, { article: articleInput });

    this.throwOnUserErrors(data.articleCreate.userErrors);

    if (!data.articleCreate.article) {
      throw new ShopifyError('Failed to create article', 500);
    }

    return data.articleCreate.article;
  }

  private async updateArticle(id: string, input: ShopifyArticleInput): Promise<Record<string, unknown>> {
    const mutationInput = extractSeoMetafieldsFromVerbatimFields({ ...input });
    const data = await this.query<{
      articleUpdate: { article: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(ARTICLES_UPDATE_MUTATION, { id, article: mutationInput });

    this.throwOnUserErrors(data.articleUpdate.userErrors);
    if (!data.articleUpdate.article) {
      throw new ShopifyError('Failed to update article', 500);
    }
    return data.articleUpdate.article;
  }

  private async deleteArticle(id: string): Promise<void> {
    const data = await this.query<{
      articleDelete: { deletedArticleId: string | null; userErrors: ShopifyUserError[] };
    }>(ARTICLES_DELETE_MUTATION, { id });

    this.throwOnUserErrors(data.articleDelete.userErrors);
  }

  // ============= Helpers =============

  /**
   * Transform category from object format to Shopify's ID format.
   */
  private transformCategoryInput(input: ShopifyProductInput): Record<string, unknown> {
    const raw = { ...input } as Record<string, unknown>;
    const category = raw.category as { id?: string } | null | undefined;

    if (category === undefined) return raw;
    if (category === null) {
      raw.category = null;
      return raw;
    }

    raw.category = category.id ?? null;
    return raw;
  }

  /**
   * Throw a ShopifyError if there are user errors from a mutation.
   */
  private throwOnUserErrors(userErrors: ShopifyUserError[]): void {
    if (userErrors.length > 0) {
      throw new ShopifyError(userErrors.map((e) => e.message).join(', '), 400, 'USER_ERROR', userErrors);
    }
  }
}

// ============= Utilities =============

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
