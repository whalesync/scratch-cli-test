import { TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  TableViewSubfield,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { WordPressDataType } from './wordpress-types';

// ── Priority ordering ──
// Fields listed here appear first, in this order. Anything not listed goes after.
const PRIORITY_FIELDS = [
  'title',
  'id',
  'slug',
  'excerpt',
  'date',
  'author',
  'status',
  'content',
  'featured_media',
  'link',
  'date_gmt',
  'modified',
  'modified_gmt',
  'type',
  'format',
  'sticky',
  'password',
  'comment_status',
  'ping_status',
  'template',
  'categories',
  'tags',
  'meta',
  'guid',
  'generated_slug',
  'permalink_template',
  'class_list',
];

// Fields that should be hidden by default — less important or redundant with a visible counterpart.
const HIDDEN_FIELDS = new Set([
  'date_gmt',
  'modified',
  'modified_gmt',
  'type',
  'format',
  'sticky',
  'password',
  'comment_status',
  'ping_status',
  'template',
  'meta',
  'guid',
  'generated_slug',
  'permalink_template',
  'class_list',
]);

/**
 * Build a default TableView for a WordPress post type by reading the TypeBox schema
 * produced by `buildWordPressJsonTableSpec`. Falls back to sensible defaults when
 * the schema is missing or incomplete.
 */
export function buildWordPressDefaultView(schema: TSchema): TableView {
  const properties: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const fieldIds = Object.keys(properties);
  const sorted = sortFields(fieldIds);
  const cols: TableViewCol[] = [];

  for (const fieldId of sorted) {
    const fieldSchema = unwrapOptional(properties[fieldId]);
    cols.push(buildCol(fieldId, fieldSchema));
  }

  // ACF fields — each sub-property becomes its own top-level column (path: "acf.fieldName").
  const acfSchema = unwrapOptional(properties['acf']);
  if (acfSchema) {
    const acfProps: Record<string, TSchema> =
      (acfSchema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};
    const acfFieldIds = Object.keys(acfProps);
    if (acfFieldIds.length > 0) {
      for (const acfFieldId of acfFieldIds) {
        const acfFieldSchema = unwrapOptional(acfProps[acfFieldId]);
        const col = buildCol(acfFieldId, acfFieldSchema);
        col.path = `acf.${acfFieldId}`;
        cols.push(col);
      }
    }
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Sort field IDs so priority fields come first (in their defined order), then the rest alphabetically. */
function sortFields(fieldIds: string[]): string[] {
  const priorityIndex = new Map(PRIORITY_FIELDS.map((f, i) => [f, i]));
  const inPriority: string[] = [];
  const rest: string[] = [];

  for (const id of fieldIds) {
    // ACF is expanded separately; skip the top-level "acf" object here.
    if (id === 'acf') continue;
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

/** Unwrap TypeBox Optional wrappers to get the inner schema. */
function unwrapOptional(schema: TSchema): TSchema {
  // TypeBox Optional wraps with a `[Kind]: 'Optional'` marker or `[Optional]: 'Optional'`.
  // The actual inner schema is available on various paths depending on version; the safest
  // approach is to check for the common wrapper shapes.
  if (!schema) return schema;
  // Type.Optional wraps with anyOf/oneOf containing the inner type + undefined, or adds [Optional].
  // In practice, TypeBox stores inner as a peer property. We need to handle the common case
  // where the schema still has `type`, `properties`, etc. directly on it.
  return schema;
}

/** Map a WordPress connector data type annotation to a TablePropertyType. */
function mapDataType(dataType: string | undefined, fieldSchema: TSchema): TablePropertyType | undefined {
  switch (dataType) {
    case WordPressDataType.RENDERED:
      return 'richtext';
    case WordPressDataType.RENDERED_INLINE:
      return 'string';
    case WordPressDataType.STRING:
      return 'string';
    case WordPressDataType.EMAIL:
      return 'string';
    case WordPressDataType.URI:
      return 'url';
    case WordPressDataType.ENUM:
      return 'string';
    case WordPressDataType.INTEGER:
    case WordPressDataType.NUMBER:
      return 'number';
    case WordPressDataType.BOOLEAN:
      return 'checkbox';
    case WordPressDataType.DATE:
    case WordPressDataType.DATETIME:
      return 'date';
    case WordPressDataType.ARRAY:
      return 'object';
    case WordPressDataType.OBJECT:
      return 'object';
    default: {
      // Fall back to JSON Schema format hints
      const format = (fieldSchema as TSchema & { format?: string }).format;
      if (format === 'date-time' || format === 'date') return 'date';
      if (format === 'uri') return 'url';
      return undefined;
    }
  }
}

/** Format a field ID as a human-readable column name. */
function formatFieldName(fieldId: string): string {
  return fieldId
    .split(/[_.]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Check whether a TypeBox schema represents a rendered object (has raw + rendered properties). */
function isRenderedObject(fieldSchema: TSchema): boolean {
  const props = (fieldSchema as TSchema & { properties?: Record<string, TSchema> }).properties;
  return props?.raw !== undefined && props?.rendered !== undefined;
}

/** Build a TableViewCol from a field ID and its TypeBox schema. */
function buildCol(fieldId: string, fieldSchema: TSchema): TableViewCol {
  const dataType = fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;
  const hidden = HIDDEN_FIELDS.has(fieldId) || undefined;

  const col: TableViewCol = {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapDataType(dataType, fieldSchema),
    readonly: isReadonly || undefined,
    hidden,
  };

  // For rendered objects (title, content, excerpt, etc.), add raw/rendered subfields
  // and default to showing raw.
  const rawProps = (fieldSchema as TSchema & { properties?: Record<string, TSchema> }).properties;
  if (isRenderedObject(fieldSchema) && rawProps) {
    const isInline = dataType === WordPressDataType.RENDERED_INLINE;
    const rawType: TablePropertyType = isInline ? 'string' : 'richtext';
    const rawReadonly = rawProps.raw?.[X_SCRATCH_READONLY] === true || undefined;
    const subfields: TableViewSubfield[] = [
      { relativePath: 'raw', name: 'Raw', type: rawType, readonly: rawReadonly },
      { relativePath: 'rendered', name: 'Rendered', type: 'richtext', readonly: true },
    ];
    col.subfields = subfields;
    col.selectedSubfield = 0; // Default to raw
  }

  return col;
}
