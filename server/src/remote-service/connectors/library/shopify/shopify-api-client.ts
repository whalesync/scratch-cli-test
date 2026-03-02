/**
 * Shopify GraphQL Admin API Client
 *
 * Low-level client for the Shopify Admin GraphQL API using axios.
 * Uses generated query fields and mutations from codegen.
 *
 * API docs: https://shopify.dev/docs/api/admin-graphql
 */

import axios, { AxiosInstance } from 'axios';
import { RateLimiter, WithRetryOpts, withRetry as standaloneWithRetry } from 'src/rate-limiter/rate-limiter';
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

const SHOPIFY_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) =>
    error instanceof ShopifyError &&
    (error.code === 'THROTTLED' || error.statusCode === 429 || error.message.toLowerCase().includes('throttle')),
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
  pages: PAGES_QUERY_FIELDS,
  blogs: BLOGS_QUERY_FIELDS,
  articles: ARTICLES_QUERY_FIELDS,
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

    this.client = axios.create({
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
  async *listEntities(entityType: string, pageSize = 50): AsyncGenerator<Record<string, unknown>[], void> {
    if (entityType === 'metaobjects') {
      yield* this.listMetaobjects(pageSize);
      return;
    }

    if (entityType === 'files') {
      yield* this.listFiles(pageSize);
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

    yield* this.paginatedList(queryString, rootField, pageSize);
  }

  /**
   * Generic paginated list generator.
   */
  private async *paginatedList<T>(queryString: string, rootField: string, pageSize: number): AsyncGenerator<T[], void> {
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      type ResponseType = Record<string, ShopifyConnection<T>>;
      const response: ResponseType = await this.query<ResponseType>(queryString, {
        first: pageSize,
        after: cursor,
      });

      const connection: ShopifyConnection<T> | undefined = response[rootField];
      if (!connection || connection.nodes.length === 0) break;

      yield connection.nodes;

      hasMore = connection.pageInfo.hasNextPage;
      cursor = connection.pageInfo.endCursor;
    }
  }

  /**
   * List files with normalization.
   */
  private async *listFiles(pageSize: number): AsyncGenerator<Record<string, unknown>[], void> {
    const queryFields = QUERY_FIELDS_MAP.files;
    const queryString = `
      query ListFiles($first: Int!, $after: String) {
        files(first: $first, after: $after) {
          nodes { ${queryFields} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    for await (const batch of this.paginatedList<Record<string, unknown>>(queryString, 'files', pageSize)) {
      const normalized = batch
        .filter((f) => f.id)
        .map((f) => {
          const file = { ...f };
          // Normalize MediaImage nested url to top-level
          if (!file.url && f.image) {
            file.url = (f.image as { url?: string })?.url;
            delete file.image;
          }
          // Extract numeric ID from GID for safe filenames
          const gid = String(file.id);
          const numericId = gid.split('/').pop() || gid;
          file.fileSlug = numericId;
          return file;
        });

      if (normalized.length > 0) {
        yield normalized;
      }
    }
  }

  /**
   * List metaobjects across all types.
   */
  private async *listMetaobjects(pageSize: number): AsyncGenerator<Record<string, unknown>[], void> {
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

        yield response.metaobjects.nodes;

        hasMore = response.metaobjects.pageInfo.hasNextPage;
        cursor = response.metaobjects.pageInfo.endCursor;
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
  async updateEntity(entityType: EntityType, id: string, input: Record<string, unknown>): Promise<void> {
    switch (entityType) {
      case 'products':
        await this.updateProduct(id, input as ShopifyProductInput);
        break;
      case 'collections':
        await this.updateCollection(id, input as ShopifyCollectionInput);
        break;
      case 'pages':
        await this.updatePage(id, input as ShopifyPageInput);
        break;
      case 'blogs':
        await this.updateBlog(id, input as ShopifyBlogInput);
        break;
      case 'articles':
        await this.updateArticle(id, input as ShopifyArticleInput);
        break;
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

  private async updateProduct(id: string, input: ShopifyProductInput): Promise<void> {
    const mutationInput = this.transformCategoryInput(input);
    const data = await this.query<{
      productUpdate: { product: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(PRODUCTS_UPDATE_MUTATION, { product: { ...mutationInput, id } });

    this.throwOnUserErrors(data.productUpdate.userErrors);
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

  private async updateCollection(id: string, input: ShopifyCollectionInput): Promise<void> {
    const data = await this.query<{
      collectionUpdate: { collection: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(COLLECTIONS_UPDATE_MUTATION, { input: { ...input, id } });

    this.throwOnUserErrors(data.collectionUpdate.userErrors);
  }

  private async deleteCollection(id: string): Promise<void> {
    const data = await this.query<{
      collectionDelete: { deletedCollectionId: string | null; userErrors: ShopifyUserError[] };
    }>(COLLECTIONS_DELETE_MUTATION, { input: { id } });

    this.throwOnUserErrors(data.collectionDelete.userErrors);
  }

  // ============= Page Mutations =============

  private async createPage(input: ShopifyPageInput): Promise<Record<string, unknown>> {
    const data = await this.query<{
      pageCreate: { page: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(PAGES_CREATE_MUTATION, { page: input });

    this.throwOnUserErrors(data.pageCreate.userErrors);

    if (!data.pageCreate.page) {
      throw new ShopifyError('Failed to create page', 500);
    }

    return data.pageCreate.page;
  }

  private async updatePage(id: string, input: ShopifyPageInput): Promise<void> {
    const data = await this.query<{
      pageUpdate: { page: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(PAGES_UPDATE_MUTATION, { id, page: input });

    this.throwOnUserErrors(data.pageUpdate.userErrors);
  }

  private async deletePage(id: string): Promise<void> {
    const data = await this.query<{
      pageDelete: { deletedPageId: string | null; userErrors: ShopifyUserError[] };
    }>(PAGES_DELETE_MUTATION, { id });

    this.throwOnUserErrors(data.pageDelete.userErrors);
  }

  // ============= Blog Mutations =============

  private async createBlog(input: ShopifyBlogInput): Promise<Record<string, unknown>> {
    const data = await this.query<{
      blogCreate: { blog: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(BLOGS_CREATE_MUTATION, { blog: input });

    this.throwOnUserErrors(data.blogCreate.userErrors);

    if (!data.blogCreate.blog) {
      throw new ShopifyError('Failed to create blog', 500);
    }

    return data.blogCreate.blog;
  }

  private async updateBlog(id: string, input: ShopifyBlogInput): Promise<void> {
    const data = await this.query<{
      blogUpdate: { blog: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(BLOGS_UPDATE_MUTATION, { id, blog: input });

    this.throwOnUserErrors(data.blogUpdate.userErrors);
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

    // Remove undefined values
    for (const key of Object.keys(articleInput)) {
      if (articleInput[key] === undefined) {
        delete articleInput[key];
      }
    }

    const data = await this.query<{
      articleCreate: { article: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(ARTICLES_CREATE_MUTATION, { article: articleInput });

    this.throwOnUserErrors(data.articleCreate.userErrors);

    if (!data.articleCreate.article) {
      throw new ShopifyError('Failed to create article', 500);
    }

    return data.articleCreate.article;
  }

  private async updateArticle(id: string, input: ShopifyArticleInput): Promise<void> {
    const data = await this.query<{
      articleUpdate: { article: Record<string, unknown> | null; userErrors: ShopifyUserError[] };
    }>(ARTICLES_UPDATE_MUTATION, { id, article: input });

    this.throwOnUserErrors(data.articleUpdate.userErrors);
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
