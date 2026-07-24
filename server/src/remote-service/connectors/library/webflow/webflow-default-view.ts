import { Kind, TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewBannerGroup,
  TableViewCol,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';

// ── Collection items ──

// Unified priority for collection items — mixes fieldData and fixed fields.
// fieldData keys are prefixed with 'fieldData.' to distinguish them.
const COLLECTION_ITEM_PRIORITY: string[] = [
  'fieldData.name',
  'id',
  'fieldData.slug',
  'lastPublished',
  'lastUpdated',
  'createdOn',
];

const COLLECTION_ITEM_HIDDEN_FIELDS = new Set(['cmsLocaleId']);

// Fixed fields that are system-generated and cannot be edited via the API.
const COLLECTION_ITEM_READONLY_FIXED = new Set(['id', 'cmsLocaleId', 'lastPublished', 'lastUpdated', 'createdOn']);

// ── Assets: priority ordering ──

const ASSET_FIELD_PRIORITY: string[] = [
  'displayName',
  'id',
  'hostedUrl',
  'originalFileName',
  'contentType',
  'altText',
  'size',
  'createdOn',
  'lastUpdated',
];

const ASSET_HIDDEN_FIELDS = new Set(['siteId']);

// ── Pages: priority ordering ──

// Fields that get expanded into banner groups instead of flat columns.
const PAGES_BANNER_GROUP_FIELDS = new Set(['seo', 'openGraph']);

const PAGES_FIELD_PRIORITY: string[] = [
  'slug',
  'title',
  'id',
  'publishedPath',
  'archived',
  'draft',
  'createdOn',
  'lastUpdated',
];

const PAGES_HIDDEN_FIELDS = new Set(['parentId']);

/**
 * Build a default TableView for a Webflow collection, assets, pages, or orders table.
 *
 * - collection_items: fieldData properties expanded first (as `fieldData.<name>`),
 *   then fixed item-level fields in priority order.
 * - assets: flat fields in priority order.
 * - pages: flat fields + SEO / Open Graph banner groups.
 * - orders: a fixed, curated column list (the order schema is permissive, so
 *   columns are enumerated explicitly rather than derived from the schema).
 */
export function buildWebflowDefaultView(schema: TSchema, entityType: string): TableView {
  const topLevel: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  if (entityType === 'assets') {
    return { name: 'Default', cols: buildAssetCols(topLevel) };
  }

  if (entityType === 'pages') {
    return { name: 'Default', cols: buildPagesView(topLevel) };
  }

  if (entityType === 'orders') {
    return { name: 'Default', cols: buildOrderCols() };
  }

  return { name: 'Default', cols: buildCollectionItemCols(topLevel) };
}

// ── Orders ──

/**
 * A fixed, curated column set for the Ecommerce Orders table. The order schema is
 * permissive (`additionalProperties: true`), so — unlike the other entity types —
 * columns are enumerated here explicitly rather than derived from the schema. The
 * four shipping/comment columns are editable; everything else is read-only.
 */
function buildOrderCols(): TableViewCol[] {
  const ro = (path: string, name: string, type?: TablePropertyType): TableViewCol => ({
    kind: 'col',
    path,
    name,
    type,
    readonly: true,
  });
  const editable = (path: string, name: string, type?: TablePropertyType): TableViewCol => ({
    kind: 'col',
    path,
    name,
    type,
  });
  return [
    ro('orderId', 'Order Id'),
    ro('status', 'Status'),
    ro('customerInfo.email', 'Customer Email'),
    ro('customerInfo.fullName', 'Customer Name'),
    ro('purchasedItemsCount', 'Items', 'number'),
    ro('acceptedOn', 'Placed', 'date'),
    editable('comment', 'Comment'),
    editable('shippingProvider', 'Shipping Provider'),
    editable('shippingTracking', 'Shipping Tracking'),
    editable('shippingTrackingURL', 'Shipping Tracking URL', 'url'),
    ro('fulfilledOn', 'Fulfilled', 'date'),
  ];
}

// ── Collection items ──

function buildCollectionItemCols(topLevel: Record<string, TSchema>): TableViewCol[] {
  const fieldDataSchema = topLevel['fieldData'];
  const fieldDataProps: Record<string, TSchema> =
    (fieldDataSchema as TSchema & { properties?: Record<string, TSchema> })?.properties ?? {};

  // Build a unified list of all column keys, prefixed for fieldData
  const allKeys: string[] = [];
  for (const fieldName of Object.keys(fieldDataProps)) {
    allKeys.push(`fieldData.${fieldName}`);
  }
  for (const fieldId of Object.keys(topLevel)) {
    if (fieldId !== 'fieldData') allKeys.push(fieldId);
  }

  // Sort by unified priority
  const sorted = sortByPriority(allKeys, COLLECTION_ITEM_PRIORITY);

  const cols: TableViewCol[] = [];
  for (const key of sorted) {
    if (key.startsWith('fieldData.')) {
      const fieldName = key.slice('fieldData.'.length);
      cols.push(buildFieldDataCol(fieldName, fieldDataProps[fieldName]));
    } else {
      cols.push(buildCollectionFixedCol(key, topLevel[key]));
    }
  }

  return cols;
}

// ── Assets ──

function buildAssetCols(topLevel: Record<string, TSchema>): TableViewCol[] {
  const fieldIds = Object.keys(topLevel);
  const sorted = sortByPriority(fieldIds, ASSET_FIELD_PRIORITY);

  return sorted.map((fieldId) => buildAssetCol(fieldId, topLevel[fieldId]));
}

// ── Pages ──

function buildPagesView(topLevel: Record<string, TSchema>): (TableViewCol | TableViewBannerGroup)[] {
  // Collect flat fields (excluding those that become banner groups)
  const flatFieldIds = Object.keys(topLevel).filter((id) => !PAGES_BANNER_GROUP_FIELDS.has(id));
  const sorted = sortByPriority(flatFieldIds, PAGES_FIELD_PRIORITY);

  const cols: (TableViewCol | TableViewBannerGroup)[] = sorted.map((fieldId) =>
    buildPagesCol(fieldId, topLevel[fieldId]),
  );

  // Insert SEO banner group after the flat fields, before dates
  const seoSchema = unwrapOptional(topLevel['seo']);
  if (seoSchema) {
    const seoProps: Record<string, TSchema> =
      (seoSchema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};
    const seoCols: TableViewCol[] = Object.entries(seoProps).map(([key, schema]) => ({
      kind: 'col' as const,
      path: `seo.${key}`,
      name: formatCamelCaseName(key),
      type: mapFieldType(unwrapOptional(schema)),
    }));
    if (seoCols.length > 0) {
      // Insert before createdOn (or at end if not found)
      const insertIdx = cols.findIndex((c) => c.kind === 'col' && c.path === 'createdOn');
      const group: TableViewBannerGroup = { kind: 'banner-group', name: 'SEO', cols: seoCols };
      if (insertIdx >= 0) {
        cols.splice(insertIdx, 0, group);
      } else {
        cols.push(group);
      }
    }
  }

  // Insert Open Graph banner group after SEO
  const ogSchema = unwrapOptional(topLevel['openGraph']);
  if (ogSchema) {
    const ogProps: Record<string, TSchema> =
      (ogSchema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};
    const ogCols: TableViewCol[] = Object.entries(ogProps).map(([key, schema]) => {
      const inner = unwrapOptional(schema);
      return {
        kind: 'col' as const,
        path: `openGraph.${key}`,
        name: formatCamelCaseName(key),
        type: mapFieldType(inner),
      };
    });
    if (ogCols.length > 0) {
      const insertIdx = cols.findIndex((c) => c.kind === 'col' && c.path === 'createdOn');
      const group: TableViewBannerGroup = { kind: 'banner-group', name: 'Open Graph', cols: ogCols };
      if (insertIdx >= 0) {
        cols.splice(insertIdx, 0, group);
      } else {
        cols.push(group);
      }
    }
  }

  return cols;
}

// ── Column builders ──

function buildFieldDataCol(fieldName: string, fieldSchema: TSchema): TableViewCol {
  const inner = unwrapOptional(fieldSchema);
  const isReadonly = inner?.[X_SCRATCH_READONLY] === true;

  return {
    kind: 'col',
    path: `fieldData.${fieldName}`,
    name: formatCamelCaseName(fieldName),
    type: mapFieldType(inner),
    logicalType: unopinionatedExportTypeForCollectionItemField(inner),
    readonly: isReadonly || undefined,
  };
}

/** Build a col for a collection item fixed field (id, lastPublished, etc.). */
function buildCollectionFixedCol(fieldId: string, fieldSchema: TSchema | undefined): TableViewCol {
  const inner = unwrapOptional(fieldSchema);
  const hidden = COLLECTION_ITEM_HIDDEN_FIELDS.has(fieldId) || undefined;
  const isReadonly = COLLECTION_ITEM_READONLY_FIXED.has(fieldId) || inner?.[X_SCRATCH_READONLY] === true;

  return {
    kind: 'col',
    path: fieldId,
    name: formatCamelCaseName(fieldId),
    type: mapFieldType(inner),
    hidden,
    readonly: isReadonly || undefined,
  };
}

/** Build a col for an asset field. */
function buildAssetCol(fieldId: string, fieldSchema: TSchema | undefined): TableViewCol {
  const inner = unwrapOptional(fieldSchema);
  const hidden = ASSET_HIDDEN_FIELDS.has(fieldId) || undefined;
  const isReadonly = inner?.[X_SCRATCH_READONLY] === true;

  return {
    kind: 'col',
    path: fieldId,
    name: formatCamelCaseName(fieldId),
    type: mapFieldType(inner),
    hidden,
    readonly: isReadonly || undefined,
  };
}

/** Build a col for a pages field. */
function buildPagesCol(fieldId: string, fieldSchema: TSchema | undefined): TableViewCol {
  const inner = unwrapOptional(fieldSchema);
  const hidden = PAGES_HIDDEN_FIELDS.has(fieldId) || undefined;
  const isReadonly = inner?.[X_SCRATCH_READONLY] === true;

  return {
    kind: 'col',
    path: fieldId,
    name: formatCamelCaseName(fieldId),
    type: mapFieldType(inner),
    hidden,
    readonly: isReadonly || undefined,
  };
}

// ── Type mapping ──

function mapFieldType(schema: TSchema | undefined): TablePropertyType | undefined {
  if (!schema) return undefined;
  const format = (schema as TSchema & { format?: string }).format;
  if (format === 'date-time') return 'date';
  if (format === 'uri') return 'url';
  const kind = schema[Kind] as string | undefined;
  if (kind === 'Boolean') return 'checkbox';
  if (kind === 'Number' || kind === 'Integer') return 'number';
  if (kind === 'Array' || kind === 'Object') return 'object';
  return undefined;
}

/**
 * The WEAK, unopinionated SEMANTIC type to export a collection-item field as, when it isn't a clean
 * scalar the export can copy as-is (DEV-10937).
 *
 * A Webflow collection field whose value is an OBJECT or ARRAY (an Image, MultiImage, or Video Link
 * embed) — or an UNRECOGNIZED Webflow field type that lands as `Type.Unknown` (the Ecommerce SKU
 * `price`, `compare-at-price`, `sku-values`, `download-files`, `ec-sku-subscription-plan`,
 * `ec-sku-billing-method` fields, …) — can't be represented as a scalar. Live Export / sync would
 * otherwise emit a "Can't unpack this Webflow object field" / "Don't recognize Webflow field type"
 * planning warning and downgrade it to text anyway. Declaring that plain-text outcome up front as a
 * weak `logicalType: 'string'` maps the field cleanly to a text column with NO warning, without
 * touching the render `type` (the grid still draws these however `mapFieldType` says).
 *
 * Foreign-key fields (Reference / MultiReference) are exempt — they export as references, not text —
 * and so are clean scalars, whose own type already exports correctly (return `undefined` = "no
 * override; fall back to the render type / JSON primitive").
 */
function unopinionatedExportTypeForCollectionItemField(inner: TSchema | undefined): TablePropertyType | undefined {
  if (!inner) return undefined;
  // Foreign keys are exported as references (an array of them is a multi-value FK), never as text.
  if (inner[X_SCRATCH_FOREIGN_KEY_OPTIONS] !== undefined) return undefined;
  const jsonType = (inner as TSchema & { type?: string }).type;
  // `object` / `array` (structured), or no JSON `type` at all (Type.Unknown / a bare union) → weak text.
  if (jsonType === 'object' || jsonType === 'array' || jsonType === undefined) return 'string';
  return undefined;
}

// ── Helpers ──

/** Sort fields: priority fields first (in defined order), then the rest in schema order. */
function sortByPriority(fieldIds: string[], priority: string[]): string[] {
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
  return [...inPriority, ...rest];
}

/** Format a camelCase field name as Title Case (e.g., lastUpdated → Last Updated). */
function formatCamelCaseName(fieldId: string): string {
  // Insert space before each uppercase letter, then title-case
  return fieldId
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/** Unwrap TypeBox Optional to get the inner schema. */
function unwrapOptional(schema: TSchema | undefined): TSchema | undefined {
  if (!schema) return undefined;
  const anyOf = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (anyOf) {
    return anyOf.find((s) => s[Kind] !== 'Null') ?? schema;
  }
  return schema;
}
