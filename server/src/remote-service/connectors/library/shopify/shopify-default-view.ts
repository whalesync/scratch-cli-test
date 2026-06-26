import { Kind, TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewBannerGroup,
  TableViewCol,
  TableViewSubfield,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';

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

  for (const fieldId of sorted) {
    const fieldSchema = properties[fieldId];
    if (fieldId === 'seo') {
      cols.push(buildSeoBannerGroup(fieldSchema));
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

/** Build a TableViewCol from a field ID and its TypeBox schema. */
function buildCol(fieldId: string, fieldSchema: TSchema): TableViewCol {
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;
  const hidden = HIDDEN_FIELDS.has(fieldId) || undefined;

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

  return col;
}
