/**
 * Shopify connector type definitions.
 *
 * TypeScript interfaces for Shopify GraphQL Admin API entities.
 * API docs: https://shopify.dev/docs/api/admin-graphql
 */

// ============= Entity Type Discriminators =============

export type ShopifyEntityType =
  | 'products'
  | 'collections'
  | 'pages'
  | 'articles'
  | 'blogs'
  | 'customers'
  | 'orders'
  | 'files'
  | 'metaobjects';

export type ShopifyWritableEntityType = 'products' | 'collections' | 'pages' | 'articles' | 'blogs';

// ============= Credentials =============

/**
 * Credentials for the Shopify Admin API.
 */
export interface ShopifyCredentials {
  /** Store domain (e.g., "my-store" or "my-store.myshopify.com") */
  shopDomain: string;
  /** Admin API access token */
  accessToken: string;
}

// ============= Entity Interfaces =============

/**
 * Shopify Product from the Admin GraphQL API.
 */
export interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  description: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  tags: string[];
  templateSuffix: string | null;
  category: {
    id: string;
    name: string;
    fullName: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  /** Owned connection - populated by hydration */
  variants?: Record<string, unknown>[];
  /** Owned connection - populated by hydration */
  images?: Record<string, unknown>[];
  /** Owned connection - populated by hydration */
  media?: Record<string, unknown>[];
}

/**
 * Shopify Collection (Custom or Smart).
 */
export interface ShopifyCollection {
  id: string;
  handle: string;
  title: string;
  description: string;
  descriptionHtml: string;
  sortOrder: string;
  templateSuffix: string | null;
  updatedAt: string;
}

/**
 * Shopify Page (static content page).
 */
export interface ShopifyPage {
  id: string;
  handle: string;
  title: string;
  body: string;
  bodySummary: string;
  isPublished: boolean;
  publishedAt: string | null;
  templateSuffix: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Shopify Blog.
 */
export interface ShopifyBlog {
  id: string;
  handle: string;
  title: string;
  templateSuffix: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Shopify Article (blog post).
 */
export interface ShopifyArticle {
  id: string;
  handle: string;
  title: string;
  body: string;
  summary: string;
  author: { name: string };
  tags: string[];
  isPublished: boolean;
  publishedAt: string | null;
  templateSuffix: string | null;
  blog: { id: string; handle: string };
  createdAt: string;
  updatedAt: string;
}

/**
 * Shopify Customer.
 */
export interface ShopifyCustomer {
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  state: string;
  note: string | null;
  verifiedEmail: boolean;
  taxExempt: boolean;
  tags: string[];
  amountSpent: { amount: string; currencyCode: string };
  numberOfOrders: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Shopify money amount.
 */
export interface ShopifyMoneyBag {
  shopMoney: { amount: string; currencyCode: string };
}

/**
 * Shopify Order.
 */
export interface ShopifyOrder {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  customer: { id: string; displayName: string } | null;
  totalPriceSet: ShopifyMoneyBag;
  subtotalPriceSet: ShopifyMoneyBag;
  totalShippingPriceSet: ShopifyMoneyBag;
  totalTaxSet: ShopifyMoneyBag;
  totalDiscountsSet: ShopifyMoneyBag;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  tags: string[];
  note: string | null;
  cancelledAt: string | null;
  closedAt: string | null;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Owned connection - populated by hydration */
  lineItems?: Record<string, unknown>[];
  /** Owned connection - populated by hydration */
  shippingLines?: Record<string, unknown>[];
}

/**
 * Shopify File (GenericFile, MediaImage, Video).
 */
export interface ShopifyFile {
  id: string;
  alt: string | null;
  fileStatus: string;
  mimeType: string | null;
  originalFileSize: number | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Shopify Metaobject.
 */
export interface ShopifyMetaobject {
  id: string;
  handle: string;
  type: string;
  displayName: string;
  fields: Array<{ key: string; value: string; type: string }>;
  updatedAt: string;
}

/**
 * Shopify Metaobject Definition (used to discover types).
 */
export interface ShopifyMetaobjectDefinition {
  id: string;
  type: string;
  name: string;
}

// ============= Input Interfaces (writable entities) =============

/**
 * Input type for product create/update mutations.
 */
export interface ShopifyProductInput {
  title?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  tags?: string[];
  handle?: string;
  templateSuffix?: string;
  category?: {
    id: string;
  } | null;
}

/**
 * Input type for collection create/update mutations.
 */
export interface ShopifyCollectionInput {
  title?: string;
  descriptionHtml?: string;
  handle?: string;
  sortOrder?: string;
  templateSuffix?: string;
}

/**
 * Input type for page create/update mutations.
 */
export interface ShopifyPageInput {
  title?: string;
  body?: string;
  handle?: string;
  isPublished?: boolean;
  templateSuffix?: string;
  /** Verbatim SEO metafield-alias fields (global.title_tag / global.description_tag). */
  seoTitle?: { value?: string | null };
  seoDescription?: { value?: string | null };
}

/**
 * Input type for blog create/update mutations.
 */
export interface ShopifyBlogInput {
  title?: string;
  handle?: string;
  templateSuffix?: string;
  /** Verbatim SEO metafield-alias fields (global.title_tag / global.description_tag). */
  seoTitle?: { value?: string | null };
  seoDescription?: { value?: string | null };
}

/**
 * Input type for article create/update mutations.
 */
export interface ShopifyArticleInput {
  title?: string;
  body?: string;
  summary?: string;
  handle?: string;
  tags?: string[];
  isPublished?: boolean;
  templateSuffix?: string;
  blog?: { id: string };
  author?: { name: string };
  /** Verbatim SEO metafield-alias fields (global.title_tag / global.description_tag). */
  seoTitle?: { value?: string | null };
  seoDescription?: { value?: string | null };
}

// ============= GraphQL Infrastructure =============

/**
 * GraphQL pagination info.
 */
export interface ShopifyPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Generic GraphQL connection type for paginated results.
 */
export interface ShopifyConnection<T> {
  nodes: T[];
  pageInfo: ShopifyPageInfo;
}

/**
 * User error from Shopify mutations.
 */
export interface ShopifyUserError {
  field: string[] | null;
  message: string;
}

/**
 * Generic GraphQL response wrapper.
 */
export interface ShopifyGraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
    extensions?: Record<string, unknown>;
  }>;
}

/**
 * Paginated response for list operations.
 */
export interface ShopifyPaginatedResponse<T> {
  data: T[];
  pageInfo: ShopifyPageInfo;
}
