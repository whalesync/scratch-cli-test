/**
 * Shopify Codegen Configuration
 *
 * Entity configurations, field filters, and mappings specific to
 * the Shopify GraphQL Admin API.
 */

import {
  EntityConfig,
  FieldFilterConfig,
  PluginConfig,
  ScalarMapping,
} from "../types";

// =============================================================================
// SHOPIFY PLUS-ONLY FEATURES
// =============================================================================

/**
 * Fields that require Shopify Plus / special scopes
 */
export const SHOPIFY_PLUS_ONLY_FIELDS = new Set([
  // Staff member fields (Plus only)
  "createdByStaff",
  "updatedByStaff",
  "staffMember",
  "staffMembers",
  "assignedStaffMembers",
  "staffNote",
  "staffNotes",
  "createdBy",
  "updatedBy",
  "assignedTo",
  "lockedByStaff",

  // Customer PII fields (Plus only for read access)
  "defaultEmailAddress",
  "defaultPhoneNumber",
  "emailAddress",
  "phoneNumber",
  "firstName",
  "lastName",
  "addresses",
  "addressesV2",
  "defaultAddress",
  "billingAddress",
  "shippingAddress",
  "customer",
  "email",
  "phone",
  "canNotifyCustomer",
  "customerAcceptsMarketing",
  "customerJourneySummary",
  "customerLocale",
  "displayAddress",

  // B2B/Company fields (Plus only)
  "company",
  "companyContact",
  "companyLocation",
  "companyLocations",
  "purchasingEntity",
  "purchasingCompany",

  // Payment fields (Plus only)
  "creditCard",
  "paymentDetails",
  "paymentInstrument",
  "paymentMethod",
  "customerPaymentMethod",
]);

// =============================================================================
// SCALAR MAPPINGS
// =============================================================================

export const SHOPIFY_SCALAR_MAPPINGS: Record<string, ScalarMapping> = {
  String: { typeboxType: "string", nullable: true },
  Int: { typeboxType: "number", nullable: true },
  Float: { typeboxType: "number", nullable: true },
  Boolean: { typeboxType: "boolean", nullable: true },
  ID: { typeboxType: "string", nullable: false },
  DateTime: { typeboxType: "string", nullable: true, format: "date-time" },
  URL: { typeboxType: "string", nullable: true },
  HTML: { typeboxType: "string", nullable: true },
  JSON: { typeboxType: "unknown", nullable: true },
  Money: { typeboxType: "string", nullable: true },
  Decimal: { typeboxType: "string", nullable: true },
  UnsignedInt64: { typeboxType: "string", nullable: true },
  UtcOffset: { typeboxType: "string", nullable: true },
  FormattedString: { typeboxType: "string", nullable: true },
  Color: { typeboxType: "string", nullable: true },
  ARN: { typeboxType: "string", nullable: true },
  StorefrontID: { typeboxType: "string", nullable: true },
};

// =============================================================================
// FIELD FILTERS
// =============================================================================

export const SHOPIFY_FIELD_FILTERS: FieldFilterConfig = {
  skipFields: new Set([
    // Internal cursor field - not useful for users
    "defaultCursor",

    // Deprecated fields
    "storefrontId",
    "admin_graphql_api_id",
    "channel",
    "channels",
    "publishedOnChannel",
    "publishedOnCurrentChannel",
    "publishedOnCurrentPublication",
    "unpublishedChannels",
    "availablePublicationCount",
    "publicationCount",
    "publications",
    "risks",
    "riskLevel",
    "customerJourney",
    "landingPageDisplayText",
    "landingPageUrl",
    "referralCode",
    "referrerDisplayText",
    "referrerUrl",
    "localizationExtensions",
    "physicalLocation",
    "subtotalPrice",
    "totalPrice",
    "totalTax",
    "totalDiscounts",
    "totalShippingPrice",
    "totalReceived",
    "totalRefunded",
    "totalCapturable",
    "totalTipReceived",
    "cartDiscountAmount",
    "netPayment",
    "emailMarketingConsent",
    "smsMarketingConsent",
    "hasTimelineComment",
    "market",
    "unsubscribeUrl",
    "validEmailAddress",
    // Fields requiring special access
    "metafieldDefinitions",
    "privateMetafields",
    "deliveryProfile",
    "deliveryProfiles",
    "shippingProfile",
    "merchantEditableErrors",
    "discountAllocations",
    "discountApplications",
    "duties",
    "dutiesIncluded",
    "originalTotalDutiesSet",
    "currentTotalDutiesSet",
    "totalTipReceivedSet",
    "paymentTerms",
    "draftOrderTag",
    "localizationExtensionsConnection",
    "checkoutChargeAmount",
    "shopifyPaymentsAccount",
    "appInstallation",
    "privateData",

    // Nested fields that leak internal app details
    "apiKey",
  ]),

  skipConnections: new Set([
    "variants",
    "media",
    "images",
    "collections",
    "products",
    "orders",
    "metafields",
    "events",
    "lineItems",
    "shippingLines",
    "fulfillments",
    "refunds",
    "transactions",
    "returns",
    "disputes",
    "agreements",
    "fulfillmentOrders",
    "resourcePublications",
    "resourcePublicationsV2",
    "unpublishedPublications",
    "sellingPlanGroups",
    "bundleComponents",
    "productComponents",
    "productParents",
    "productVariantComponents",
    "companyContactProfiles",
    "storeCreditAccounts",
    "subscriptionContracts",
    "paymentMethods",
    "addressesV2",
    "countryHarmonizedSystemCodes",
    "inventoryLevels",
  ]),

  fieldsRequiringArgs: new Set([
    "metafield",
    "privateMetafield",
    "inCollection",
    "inventoryLevel",
    "contextualPricing",
    "publishedOnPublication",
    "publishedInContext",
    "resourcePublicationOnCurrentPublication",
    "hasTaggedImage",
    "translations",
    "localizedFields",
  ]),

  referenceOnlyFields: new Set([
    "customer",
    "product",
    "variant",
    "featuredMedia",
    "featuredImage",
  ]),

  skipExpansionTypes: new Set([
    "Publication",
    "ResourcePublication",
    "ResourcePublicationV2",
    "AppInstallation",
    "MetafieldDefinition",
    "PrivateMetafield",
    "MailingAddress",
    "CustomerAddress",
  ]),
};

// =============================================================================
// INTERFACE IMPLEMENTATIONS
// =============================================================================

export const SHOPIFY_INTERFACE_IMPLEMENTATIONS: Record<string, string[]> = {
  Media: ["MediaImage", "Video", "ExternalVideo", "Model3d"],
  File: ["GenericFile", "MediaImage", "Video", "ExternalVideo", "Model3d"],
  Node: [],
  MetafieldReference: [],
  PurchasingEntity: ["Customer", "Company", "PurchasingCompany"],
  CommentEventEmbed: [],
  CustomerMoment: [],
  CustomerPaymentMethod: [],
};

// =============================================================================
// ENTITY CONFIGURATIONS
// =============================================================================

export const SHOPIFY_ENTITIES: EntityConfig[] = [
  // ============= Writable Entities =============
  {
    entityType: "products",
    graphqlType: "Product",
    displayName: "Products",
    description: "Products in your Shopify store",
    readOnly: false,
    columns: {
      slug: "handle",
      title: ["title"],
      mainContent: ["products", "descriptionHtml"],
    },
    mutations: {
      create: "productCreate",
      update: "productUpdate",
      delete: "productDelete",
      inputType: "ProductInput",
      // Fields in output but not detected as read-only by codegen
      additionalReadOnlyFields: ["combinedListingRole"],
    },
  },
  {
    entityType: "product_variants",
    graphqlType: "ProductVariant",
    displayName: "Product Variants",
    description: "Product variants (sizes, colors, etc.)",
    readOnly: false,
    columns: {
      title: ["displayName"],
    },
    mutations: {
      // Shopify uses bulk mutations for variants
      create: "productVariantsBulkCreate",
      update: "productVariantsBulkUpdate",
      delete: "productVariantsBulkDelete",
      inputType: "ProductVariantsBulkInput",
      bulk: true, // Flag to indicate these are bulk mutations
    },
    parent: {
      entityType: "products",
      foreignKey: "productId",
      connectionField: "variants",
    },
  },
  {
    entityType: "product_media",
    graphqlType: "Media",
    displayName: "Product Media",
    description: "Images and videos attached to products",
    readOnly: false,
    columns: {
      slug: "id",
      title: ["id"],
    },
    mutations: {
      create: "productCreateMedia",
      delete: "productDeleteMedia",
    },
    parent: {
      entityType: "products",
      foreignKey: "productId",
      connectionField: "media",
    },
  },
  {
    entityType: "collections",
    graphqlType: "Collection",
    displayName: "Collections",
    description: "Product collections",
    readOnly: false,
    columns: {
      slug: "handle",
      title: ["title"],
      mainContent: ["collections", "descriptionHtml"],
    },
    mutations: {
      create: "collectionCreate",
      update: "collectionUpdate",
      delete: "collectionDelete",
      inputType: "CollectionInput",
    },
  },
  {
    entityType: "pages",
    graphqlType: "Page",
    displayName: "Pages",
    description: "Static content pages",
    readOnly: false,
    columns: {
      slug: "handle",
      title: ["title"],
      mainContent: ["pages", "body"],
    },
    mutations: {
      create: "pageCreate",
      update: "pageUpdate",
      delete: "pageDelete",
      inputType: "PageCreateInput",
    },
  },
  {
    entityType: "blogs",
    graphqlType: "Blog",
    displayName: "Blogs",
    description: "Blog channels",
    readOnly: false,
    columns: {
      slug: "handle",
      title: ["title"],
    },
    mutations: {
      create: "blogCreate",
      update: "blogUpdate",
      delete: "blogDelete",
      inputType: "BlogCreateInput",
    },
  },
  {
    entityType: "articles",
    graphqlType: "Article",
    displayName: "Articles",
    description: "Blog articles",
    readOnly: false,
    columns: {
      slug: "handle",
      title: ["title"],
      mainContent: ["articles", "body"],
    },
    mutations: {
      create: "articleCreate",
      update: "articleUpdate",
      delete: "articleDelete",
      inputType: "ArticleCreateInput",
      stripOnUpdateFields: ["blog", "author"],
    },
  },

  // ============= Read-Only Entities =============
  {
    entityType: "customers",
    graphqlType: "Customer",
    displayName: "Customers",
    description: "Store customers (read-only)",
    readOnly: true,
    metadata: { plusOnly: true },
    columns: {
      title: ["displayName"],
    },
  },
  {
    entityType: "orders",
    graphqlType: "Order",
    displayName: "Orders",
    description: "Store orders with line items (read-only)",
    readOnly: true,
    metadata: { plusOnly: true },
    columns: {
      title: ["name"],
    },
  },
  {
    entityType: "order_line_items",
    graphqlType: "LineItem",
    displayName: "Order Line Items",
    description: "Individual items within orders",
    readOnly: true,
    metadata: { plusOnly: true },
    columns: {
      title: ["name"],
    },
    parent: {
      entityType: "orders",
      foreignKey: "orderId",
      connectionField: "lineItems",
    },
  },
  {
    entityType: "order_shipping_lines",
    graphqlType: "ShippingLine",
    displayName: "Order Shipping Lines",
    description: "Shipping methods for orders",
    readOnly: true,
    metadata: { plusOnly: true },
    columns: {
      title: ["title"],
    },
    parent: {
      entityType: "orders",
      foreignKey: "orderId",
      connectionField: "shippingLines",
    },
  },
  {
    entityType: "files",
    graphqlType: "File",
    displayName: "Files",
    description: "Uploaded files and media (read-only)",
    readOnly: true,
    columns: {
      slug: "id",
    },
  },
  {
    entityType: "metaobjects",
    graphqlType: "Metaobject",
    displayName: "Metaobjects",
    description: "Custom metaobject entries (read-only)",
    readOnly: true,
    columns: {
      slug: "handle",
      title: ["displayName"],
    },
  },
];

// =============================================================================
// CONFIG BUILDERS
// =============================================================================

/**
 * Get field filters with Plus-only fields excluded
 */
export function getFieldFiltersForCodegen(): FieldFilterConfig {
  // Always exclude Plus-only fields during codegen (run on non-Plus stores)
  const skipFields = new Set(SHOPIFY_FIELD_FILTERS.skipFields);
  for (const field of SHOPIFY_PLUS_ONLY_FIELDS) {
    skipFields.add(field);
  }

  return {
    ...SHOPIFY_FIELD_FILTERS,
    skipFields,
  };
}

/**
 * Create full plugin config for Shopify codegen
 */
export function createShopifyPluginConfig(): PluginConfig {
  return {
    serviceName: "shopify",
    entities: SHOPIFY_ENTITIES,
    scalarMappings: SHOPIFY_SCALAR_MAPPINGS,
    fieldFilters: getFieldFiltersForCodegen(),
    maxFieldDepth: 2,
    interfaceImplementations: SHOPIFY_INTERFACE_IMPLEMENTATIONS,
  };
}
