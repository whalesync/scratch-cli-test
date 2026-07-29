import { Kind, TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewBannerGroup,
  TableViewCol,
  TableViewSubfield,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { ENTITY_REGISTRY, EntityType } from './graphql';

// ── Priority fields per entity type ──
// Fields listed here appear first, in this order. Anything not listed goes after alphabetically.
const PRIORITY_FIELDS: Record<string, string[]> = {
  products: ['title', 'id', 'handle', 'status', 'vendor', 'productType', 'description', 'descriptionHtml', 'tags'],
  product_variants: ['title', 'id', 'displayName', 'sku', 'price', 'compareAtPrice', 'inventoryQuantity'],
  product_media: ['id', 'alt', 'mediaContentType', 'status', 'mimeType'],
  collections: ['title', 'id', 'handle', 'description', 'descriptionHtml'],
  pages: ['title', 'id', 'handle', 'body', 'bodySummary', 'createdAt'],
  blogs: ['title', 'id', 'handle', 'createdAt'],
  articles: ['title', 'id', 'handle', 'author', 'body', 'tags'],
  customers: ['displayName', 'id', 'note', 'numberOfOrders', 'state', 'tags'],
  orders: ['name', 'id', 'displayFinancialStatus', 'displayFulfillmentStatus', 'currencyCode', 'createdAt'],
  order_line_items: ['name', 'id', 'title', 'sku', 'quantity', 'currentQuantity', 'vendor'],
  order_shipping_lines: ['title', 'id', 'code', 'price', 'source'],
  files: ['id', 'alt', 'fileStatus', 'mimeType', 'mediaContentType', 'filename'],
  metaobjects: ['displayName', 'id', 'handle', 'type'],
};

const DEFAULT_PRIORITY = ['title', 'id', 'handle', 'name', 'status'];

// Fields that should be hidden by default — complex nested objects and system fields.
const HIDDEN_FIELDS = new Set([
  'legacyResourceId',
  'feedback',
  'standardizedProductType',
  'templateSuffix',
  'giftCardTemplateSuffix',
  'priceRange',
  'priceRangeV2',
  'compareAtPriceRange',
  'productPublications',
  'resourcePublicationsCount',
  'availablePublicationsCount',
  'sellingPlanGroupsCount',
  'variantsCount',
  'mediaCount',
  'productComponentsCount',
  'fulfillmentsCount',
  'transactionsCount',
]);

/**
 * Object fields whose column should DISPLAY a single inner leaf ("pluck") instead of the
 * raw object — the same idea as the count/money shape detectors, but keyed by field name
 * where the shape is entity-specific rather than a recognizable `{count, precision}` /
 * `{amount, currencyCode}` shape. The verbatim object stays on disk (Connector Prime
 * Directive); the view just pre-selects the leaf as a subfield, and the raw object is still
 * reachable via the built-in "All" option. A pluck applies only when the field's schema is
 * actually an object exposing that inner path, so a same-named scalar field is left alone.
 */
const PLUCK_SUBFIELD_BY_FIELD_NAME: Record<string, { relativePath: string; name: string; type: TablePropertyType }> = {
  // articles.author is `{ name }` — Notion otherwise gets the literal `{"name":"…"}` (DEV-11018).
  author: { relativePath: 'name', name: 'Name', type: 'string' },
  // products.category is a taxonomy object `{ fullName, id, isLeaf, … }` (DEV-11020).
  category: { relativePath: 'fullName', name: 'Full Name', type: 'string' },
  // products.featuredImage is `{ id, url, altText }` once the query pulls url/altText (DEV-11020).
  featuredImage: { relativePath: 'url', name: 'URL', type: 'url' },
};

/**
 * Nested object fields to surface as a foreign-key column plucked to the linked record's id,
 * rather than dumping the whole object as text. Keyed by `<entityType>.<fieldId>`. The
 * verbatim object stays on disk (Connector Prime Directive); the view points the column at
 * the inner id and declares the FK so a destination sync makes it a relation (DEV-11017,
 * DEV-11049). All of these reference objects are read-only (strip-on-update / whole entity
 * read-only), so surfacing them as a link never publishes edits back through them.
 */
const NESTED_FOREIGN_KEY_COLS: Record<string, { idPath: string; linkedTableId: string; name: string }> = {
  // articles.blog is the full blog object; pluck blog.id and link to the Blogs table.
  // Safe as a read-side column: `blog` is already strip-on-update for articles.
  'articles.blog': { idPath: 'blog.id', linkedTableId: 'blogs', name: 'Blog' },
  // product_variants.product is the verbatim `{ id }` back-reference to the owning product. It
  // links to the same Products table as the injected `productId` FK, so the injected column is
  // suppressed in favor of this verbatim one (see suppressedInjectedParentForeignKeyTables).
  'product_variants.product': { idPath: 'product.id', linkedTableId: 'products', name: 'Product' },
  // order_line_items references its product and variant in addition to its parent order; these
  // are distinct relations from the injected `orderId` parent FK (DEV-11049).
  'order_line_items.product': { idPath: 'product.id', linkedTableId: 'products', name: 'Product' },
  'order_line_items.variant': { idPath: 'variant.id', linkedTableId: 'product_variants', name: 'Variant' },
};

/**
 * The injected parent foreign key for a child entity (variants/media → products,
 * line-items/shipping-lines → orders), or undefined for a top-level entity. The value is
 * the flat FK field the pull injects (`productId`/`orderId`) plus the parent table's wsId,
 * which is the `linkedTableId` a destination sync resolves the relation against (DEV-11017).
 */
function parentForeignKeyForEntity(entityType: string): { field: string; linkedTableId: string } | undefined {
  const config = ENTITY_REGISTRY[entityType as EntityType] as
    | { parent?: { entityType: string; foreignKey: string } }
    | undefined;
  if (config?.parent) {
    return { field: config.parent.foreignKey, linkedTableId: config.parent.entityType };
  }
  return undefined;
}

/**
 * Build a default TableView for a Shopify entity type by reading the TypeBox schema.
 * Prioritizes important fields, hides system metadata, and maps types.
 */
export function buildShopifyDefaultView(schema: TSchema, entityType: string): TableView {
  const properties: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const fieldIds = Object.keys(properties);
  const priority = PRIORITY_FIELDS[entityType] ?? DEFAULT_PRIORITY;
  const sorted = sortFields(fieldIds, priority);
  const cols: (TableViewCol | TableViewBannerGroup)[] = [];

  const parentForeignKey = parentForeignKeyForEntity(entityType);
  // Tables already linked by a nested-object FK actually present in this schema. When the
  // injected parent FK (`productId`) points at the same table as a verbatim nested reference
  // (`product` → `product.id`), we drop the injected column so the relation isn't duplicated
  // (DEV-11049). Keyed by target table so `order_line_items` (parent → Orders, nested → Products/
  // Product Variants) keeps its `orderId` FK while `product_variants` sheds its redundant one.
  const tablesLinkedByAnEmittedNestedForeignKey = collectNestedForeignKeyTargetTables(entityType, properties);
  let verbatimSeoBannerEmitted = false;

  for (const fieldId of sorted) {
    const fieldSchema = properties[fieldId];
    const nestedForeignKey = NESTED_FOREIGN_KEY_COLS[`${entityType}.${fieldId}`];
    if (fieldId === 'seo') {
      // Native `seo` object (products/collections) — expand its title/description into columns.
      cols.push(buildSeoBannerGroup(fieldSchema));
    } else if (fieldId === 'seoTitle' || fieldId === 'seoDescription') {
      // Verbatim SEO metafields (articles/pages/blogs) — `seoTitle`/`seoDescription`, each
      // `{ value }`. Group both under one "SEO" banner and skip the raw object cols so we
      // don't emit both. Emit the banner only once, at the first of the two fields seen.
      if (!verbatimSeoBannerEmitted) {
        cols.push(buildVerbatimSeoMetafieldBannerGroup(properties.seoTitle, properties.seoDescription));
        verbatimSeoBannerEmitted = true;
      }
    } else if (nestedForeignKey) {
      // Nested object relation (articles.blog): plucked to its inner id + FK, instead of a
      // JSON blob. Read-only — we surface the link but never publish edits back through it.
      cols.push(buildForeignKeyCol(nestedForeignKey.idPath, nestedForeignKey.name, nestedForeignKey.linkedTableId));
    } else if (parentForeignKey && fieldId === parentForeignKey.field) {
      if (tablesLinkedByAnEmittedNestedForeignKey.has(parentForeignKey.linkedTableId)) {
        // A verbatim nested reference (e.g. product_variants `product` → `product.id`) already
        // links this table, so the injected flat FK would be a duplicate relation. Keep the
        // field on the record but hide the redundant column (DEV-11049).
        cols.push({ kind: 'col', path: fieldId, name: formatFieldName(fieldId), type: 'string', hidden: true });
      } else {
        // Injected parent FK (media `productId`, line-items/shipping-lines `orderId`): declare
        // the relation so it exports as a link. Read-only — it's a structural back-reference
        // derived from the pull, not a user-editable field.
        cols.push(buildForeignKeyCol(fieldId, formatFieldName(fieldId), parentForeignKey.linkedTableId));
      }
    } else {
      cols.push(buildCol(fieldId, fieldSchema));
    }
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Sort field IDs so priority fields come first (in their defined order), then the rest alphabetically. */
function sortFields(fieldIds: string[], priority: string[]): string[] {
  const priorityIndex = new Map(priority.map((f, i) => [f, i]));
  const inPriority: string[] = [];
  const rest: string[] = [];

  for (const id of fieldIds) {
    if (priorityIndex.has(id)) {
      inPriority.push(id);
    } else {
      rest.push(id);
    }
  }

  inPriority.sort((a, b) => (priorityIndex.get(a) ?? 0) - (priorityIndex.get(b) ?? 0));
  rest.sort((a, b) => a.localeCompare(b));

  return [...inPriority, ...rest];
}

/** Map a TypeBox schema to a TablePropertyType based on Kind and format annotations. */
function mapType(fieldSchema: TSchema): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;

  // Check format annotation first
  const format = (fieldSchema as TSchema & { format?: string }).format;
  if (format === 'date-time' || format === 'date') return 'date';

  // Check TypeBox Kind
  const kind = fieldSchema[Kind];
  switch (kind) {
    case 'Boolean':
      return 'checkbox';
    case 'Number':
    case 'Integer':
      return 'number';
    case 'Array':
      return 'object';
    case 'Object':
      return 'object';
    case 'Union': {
      // For Union types (e.g. Type.Optional wraps as Union([inner, Null])), inspect inner types
      const anyOf = (fieldSchema as TSchema & { anyOf?: TSchema[] }).anyOf;
      if (anyOf) {
        const nonNull = anyOf.find((s) => s[Kind] !== 'Null');
        if (nonNull) return mapType(nonNull);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Format a camelCase field ID as a human-readable column name (camelCase → Title Case). */
function formatFieldName(fieldId: string): string {
  // Insert space before uppercase letters, then title-case each word
  return fieldId
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Unwrap Union([Object, Null]) to get the inner Object schema.
 * Shopify schemas commonly wrap objects as `Type.Optional(Type.Union([Type.Object({...}), Type.Null()]))`.
 */
function unwrapToObject(schema: TSchema): TSchema | undefined {
  if (!schema) return undefined;
  const kind = schema[Kind];
  if (kind === 'Object') return schema;
  if (kind === 'Union') {
    const anyOf = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
    if (anyOf) {
      const obj = anyOf.find((s) => s[Kind] === 'Object');
      if (obj) return obj;
    }
  }
  // Handle Type.Optional which wraps inner schema directly
  if (kind === 'Optional') {
    return unwrapToObject(schema);
  }
  return undefined;
}

/** Check if an object schema has exactly the given property names (and no others). */
function hasExactProperties(objSchema: TSchema, propNames: string[]): boolean {
  const props = (objSchema as TSchema & { properties?: Record<string, TSchema> }).properties;
  if (!props) return false;
  const keys = Object.keys(props);
  return keys.length === propNames.length && propNames.every((n) => n in props);
}

/** Detect Shopify count objects ({count, precision}) and return subfields. */
function detectCountSubfields(fieldSchema: TSchema): TableViewSubfield[] | undefined {
  const obj = unwrapToObject(fieldSchema);
  if (!obj) return undefined;
  if (!hasExactProperties(obj, ['count', 'precision'])) return undefined;
  return [
    { relativePath: 'count', name: 'Count', type: 'number' },
    { relativePath: 'precision', name: 'Precision', type: 'string' },
  ];
}

/** Detect Shopify money objects ({amount, currencyCode}) and return subfields. */
function detectMoneySubfields(fieldSchema: TSchema): TableViewSubfield[] | undefined {
  const obj = unwrapToObject(fieldSchema);
  if (!obj) return undefined;
  if (!hasExactProperties(obj, ['amount', 'currencyCode'])) return undefined;
  return [
    { relativePath: 'amount', name: 'Amount', type: 'number' },
    { relativePath: 'currencyCode', name: 'Currency Code', type: 'string' },
  ];
}

/** Build a banner group for the SEO field, expanding title and description into separate columns. */
function buildSeoBannerGroup(fieldSchema: TSchema): TableViewBannerGroup {
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;
  return {
    kind: 'banner-group',
    name: 'SEO',
    cols: [
      { kind: 'col', path: 'seo.title', name: 'Title', readonly: isReadonly || undefined },
      { kind: 'col', path: 'seo.description', name: 'Description', readonly: isReadonly || undefined },
    ],
  };
}

/**
 * Build a banner group for the verbatim SEO metafields (articles/pages/blogs), where the raw
 * `seoTitle`/`seoDescription` metafield-alias objects (each `{ value }`) land on the record. The
 * editable value sits at `seoTitle.value` / `seoDescription.value`, so the banner columns target
 * those dot-paths. Readonly is taken per-field from each object's schema.
 */
function buildVerbatimSeoMetafieldBannerGroup(
  seoTitleSchema: TSchema | undefined,
  seoDescriptionSchema: TSchema | undefined,
): TableViewBannerGroup {
  const titleReadonly = seoTitleSchema?.[X_SCRATCH_READONLY] === true;
  const descriptionReadonly = seoDescriptionSchema?.[X_SCRATCH_READONLY] === true;
  return {
    kind: 'banner-group',
    name: 'SEO',
    cols: [
      { kind: 'col', path: 'seoTitle.value', name: 'Title', readonly: titleReadonly || undefined },
      { kind: 'col', path: 'seoDescription.value', name: 'Description', readonly: descriptionReadonly || undefined },
    ],
  };
}

/** Build a TableViewCol from a field ID and its TypeBox schema. */
function buildCol(fieldId: string, fieldSchema: TSchema): TableViewCol {
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;
  // Hide named system fields and Relay connection objects (`{ edges, nodes, pageInfo }`). The
  // latter are to-many relations we don't pull (e.g. `blogs.articles`, `articles.comments`),
  // so they'd otherwise render as an empty/confusing JSON blob column (DEV-11049). The forward
  // side of each such relation is already surfaced as an FK on the child entity.
  const hidden = HIDDEN_FIELDS.has(fieldId) || isRelayConnectionObject(fieldSchema) || undefined;

  const col: TableViewCol = {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapType(fieldSchema),
    readonly: isReadonly || undefined,
    hidden,
  };

  // Detect structured objects and add subfields with a sensible default
  const countSubfields = detectCountSubfields(fieldSchema);
  if (countSubfields) {
    col.subfields = countSubfields;
    col.selectedSubfield = 0; // Default to showing count
    col.type = 'number';
    return col;
  }

  const moneySubfields = detectMoneySubfields(fieldSchema);
  if (moneySubfields) {
    col.subfields = moneySubfields;
    col.selectedSubfield = 0; // Default to showing amount
    col.type = 'number';
    return col;
  }

  // Entity-specific "pluck" (articles.author → name, products.category → fullName,
  // products.featuredImage → url): show a single inner leaf instead of the raw object,
  // but only when the field really is an object exposing that path.
  const pluck = PLUCK_SUBFIELD_BY_FIELD_NAME[fieldId];
  if (pluck) {
    const obj = unwrapToObject(fieldSchema);
    if (obj && objectHasProperty(obj, pluck.relativePath)) {
      col.subfields = [{ relativePath: pluck.relativePath, name: pluck.name, type: pluck.type }];
      col.selectedSubfield = 0;
      col.type = pluck.type;
      return col;
    }
  }

  return col;
}

/** Check if an object schema has a (top-level) property with the given name. */
function objectHasProperty(objSchema: TSchema, propName: string): boolean {
  const props = (objSchema as TSchema & { properties?: Record<string, TSchema> }).properties;
  return props ? propName in props : false;
}

/**
 * Collect the set of linked-table ids that a nested-object FK (NESTED_FOREIGN_KEY_COLS) will
 * actually emit for this entity — i.e. the config field is present in the schema. Used to
 * suppress an injected parent FK that would duplicate one of these verbatim relations.
 */
function collectNestedForeignKeyTargetTables(entityType: string, properties: Record<string, TSchema>): Set<string> {
  const targetTables = new Set<string>();
  for (const fieldId of Object.keys(properties)) {
    const nestedForeignKey = NESTED_FOREIGN_KEY_COLS[`${entityType}.${fieldId}`];
    if (nestedForeignKey) targetTables.add(nestedForeignKey.linkedTableId);
  }
  return targetTables;
}

/**
 * Detect a Relay/GraphQL connection object — one shaped like `{ edges, nodes, pageInfo }`. These
 * are to-many relation envelopes (e.g. `blogs.articles`, `article.comments`) that the connector
 * doesn't pull, so their column would only ever show an empty/confusing JSON blob.
 */
function isRelayConnectionObject(fieldSchema: TSchema): boolean {
  const obj = unwrapToObject(fieldSchema);
  if (!obj) return false;
  return objectHasProperty(obj, 'pageInfo') && (objectHasProperty(obj, 'edges') || objectHasProperty(obj, 'nodes'));
}

/**
 * Build a read-only foreign-key column pointing at `path` (a flat FK field or a plucked inner
 * id) and linking to `linkedTableId` (the target table's wsId). The column's `foreignKey` is
 * what `selectPlanFieldsFromTableView` reads to make the field a relation at the destination;
 * it's read-only because these links are structural (parent back-references / strip-on-update),
 * not values we publish edits back through.
 */
function buildForeignKeyCol(path: string, name: string, linkedTableId: string): TableViewCol {
  return {
    kind: 'col',
    path,
    name,
    type: 'string',
    readonly: true,
    // `linkedTableRemoteId` is the target table's full remote id array — for Shopify that's
    // `[entityType]` (see `ShopifyConnector.listTables`, `remoteId: [entityType]`), and every
    // `linkedTableId` here (nested-object targets and injected parent `entityType`s) IS that entity
    // type, so the array is the single-element `[linkedTableId]`.
    foreignKey: { linkedTableId, linkedTableRemoteId: [linkedTableId] },
  };
}
