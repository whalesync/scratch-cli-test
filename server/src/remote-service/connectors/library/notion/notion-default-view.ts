import { Kind, TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  TableViewSubfield,
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';

// ── Top-level fixed fields ──

// Priority order for the fixed (non-property) fields that appear on every Notion page.
const FIXED_FIELD_PRIORITY: string[] = [
  'id',
  'url',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'in_trash',
  'cover',
  'icon',
  'page_content',
];

// Fixed fields that should be hidden by default.
const HIDDEN_FIXED_FIELDS = new Set([
  'object', // Always 'page', never useful
  'parent', // Always the same database_id
  'archived', // Legacy trash flag (absent under 2026-03-11+); superseded by in_trash, which is shown instead
  'is_archived', // Distinct 2026-03-11 archive flag; in_trash is the shown trash column
  'public_url',
]);

// Fixed fields that are objects and should get subfields with id as default.
const USER_OBJECT_FIELDS = new Set(['created_by', 'last_edited_by']);

const USER_SUBFIELDS: TableViewSubfield[] = [{ relativePath: 'id', name: 'Id', type: 'string' }];

const PARENT_SUBFIELDS: TableViewSubfield[] = [{ relativePath: 'database_id', name: 'Database Id', type: 'string' }];

// ── Notion property subfield mapping ──

// Property types that should get a subfield for the human-readable value.
const SELECT_TYPES = new Set(['select', 'status']);
const USER_PROPERTY_TYPES = new Set(['created_by', 'last_edited_by']);

// Property types whose inner value is a Notion rich-text array. These columns
// carry a declarative `displayTransformer` (JSONPath `$[*].plain_text`, concat)
// that the renderer runs to flatten the spans to plain text. The `type:
// 'richtext'` we set is now only a cosmetic hint — flattening is driven by the
// transformer, not the type. The stored value stays the verbatim array.
const RICH_TEXT_TYPES = new Set(['title', 'rich_text']);

/**
 * Build a default TableView for a Notion database.
 * The schema has fixed top-level fields (id, url, etc.) and a dynamic `properties` object
 * containing the database's user-defined columns.
 */
export function buildNotionDefaultView(schema: TSchema): TableView {
  const topLevel: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const cols: TableViewCol[] = [];

  // 1. Properties columns first — these are what the user cares about
  const propertiesSchema = topLevel['properties'];
  const propertyFields: Record<string, TSchema> =
    (propertiesSchema as TSchema & { properties?: Record<string, TSchema> })?.properties ?? {};

  // Order properties: title property first, then the rest in schema order
  const orderedProps = orderProperties(propertyFields);

  for (const [propName, propSchema] of orderedProps) {
    cols.push(buildPropertyCol(propName, propSchema));
  }

  // 2. Fixed fields after properties, in priority order
  const fixedFieldIds = Object.keys(topLevel).filter((k) => k !== 'properties');
  const sortedFixed = sortFixedFields(fixedFieldIds);

  for (const fieldId of sortedFixed) {
    cols.push(buildFixedCol(fieldId, topLevel[fieldId]));
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/**
 * Order properties so the title property comes first.
 * Finds the title by connector data type ('title') or by name ('Name', 'Title').
 */
function orderProperties(propertyFields: Record<string, TSchema>): [string, TSchema][] {
  const entries = Object.entries(propertyFields);
  const titleIdx = entries.findIndex(([name, schema]) => {
    // The envelope object carries the annotation directly; TypeBox's Optional
    // modifier is transparent (no anyOf wrapper), so we read it off the schema.
    const dataType = schema[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
    if (dataType === 'title') return true;
    const lowerName = name.toLowerCase();
    return lowerName === 'name' || lowerName === 'title';
  });

  if (titleIdx <= 0) return entries; // already first or not found
  const [titleEntry] = entries.splice(titleIdx, 1);
  return [titleEntry, ...entries];
}

/** Sort fixed fields: priority fields first (in defined order), then the rest in schema order. */
function sortFixedFields(fieldIds: string[]): string[] {
  const priorityIndex = new Map(FIXED_FIELD_PRIORITY.map((f, i) => [f, i]));
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

/** Format a snake_case field name as Title Case. */
function formatFieldName(fieldId: string): string {
  return fieldId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Map a fixed top-level field to a TablePropertyType. */
function mapFixedFieldType(fieldId: string, fieldSchema: TSchema | undefined): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;
  const format = (fieldSchema as TSchema & { format?: string }).format;
  if (format === 'date-time') return 'date';
  if (format === 'uri') return 'url';
  const kind = fieldSchema[Kind] as string | undefined;
  if (kind === 'Boolean') return 'checkbox';
  if (kind === 'Object' || kind === 'Array' || kind === 'Union' || kind === 'Unknown') return 'object';
  return undefined;
}

/** Build a TableViewCol for a fixed top-level field. */
function buildFixedCol(fieldId: string, fieldSchema: TSchema | undefined): TableViewCol {
  const hidden = HIDDEN_FIXED_FIELDS.has(fieldId) || undefined;
  // Read-only system fields (created_time, last_edited_time, created_by,
  // last_edited_by, url) carry X_SCRATCH_READONLY on their schema node; mirror
  // buildPropertyCol so the grid renders them read-only.
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;

  const col: TableViewCol = {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapFixedFieldType(fieldId, fieldSchema),
    hidden,
    readonly: isReadonly || undefined,
  };

  // User objects: created_by, last_edited_by → default to showing id
  if (USER_OBJECT_FIELDS.has(fieldId)) {
    col.subfields = USER_SUBFIELDS;
    col.selectedSubfield = 0;
  }

  // parent → default to showing database_id
  if (fieldId === 'parent') {
    col.subfields = PARENT_SUBFIELDS;
    col.selectedSubfield = 0;
  }

  return col;
}

/**
 * Build a TableViewCol for a Notion database property.
 *
 * Each property is stored on disk as the raw Notion envelope
 * `{ id, type: <typeKey>, <typeKey>: value, ... }`. The column path drills
 * exactly one level past the envelope to `properties.<name>.<typeKey>` so the
 * grid renders the inner value (the email string, the multi_select array, the
 * formula/rollup inner object) instead of the envelope JSON. Subfields are
 * re-anchored relative to that drilled path. The annotations live on the outer
 * envelope object, which TypeBox's transparent Optional modifier preserves, so
 * we read them directly off `propSchema`.
 */
function buildPropertyCol(propName: string, propSchema: TSchema | undefined): TableViewCol {
  const connectorDataType = propSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
  const isReadonly = propSchema?.[X_SCRATCH_READONLY] === true;

  // Missing-type guard: without a connector data type we can't know the envelope
  // key to drill into, so fall back to the whole envelope (renders as JSON)
  // rather than emitting `properties.<name>.undefined` (a silent blank cell).
  if (!connectorDataType) {
    return {
      kind: 'col',
      path: `properties.${propName}`,
      name: propName,
      type: resolveInnerValueTablePropertyType(propSchema),
      readonly: isReadonly || undefined,
    };
  }

  // Inner value schema lives under the envelope key (== connector data type).
  const innerValueSchema = (propSchema?.properties as Record<string, TSchema> | undefined)?.[connectorDataType];

  const col: TableViewCol = {
    kind: 'col',
    path: `properties.${propName}.${connectorDataType}`,
    name: propName,
    type: RICH_TEXT_TYPES.has(connectorDataType) ? 'richtext' : resolveInnerValueTablePropertyType(innerValueSchema),
    readonly: isReadonly || undefined,
  };

  // Rich-text inner value is a Notion span array. Attach a declarative display
  // transformer so the renderer flattens it to plain_text without any
  // Notion-specific knowledge of its own. The column path is already drilled to
  // the array (properties.<name>.<typeKey>), so the expression is array-relative.
  if (RICH_TEXT_TYPES.has(connectorDataType)) {
    col.displayTransformer = {
      type: TransformerTypes.JSONPath,
      options: { expression: '$[*].plain_text', arrayHandling: 'concat' },
    };
  }

  // Select/status: the inner value is `{ id, name, color } | null` — show the name.
  if (SELECT_TYPES.has(connectorDataType)) {
    col.subfields = [{ relativePath: 'name', name: 'Name', type: 'string' }];
    col.selectedSubfield = 0;
  }

  // User property types (created_by, last_edited_by): inner value is the user
  // object — show id (with name as an alternative).
  if (USER_PROPERTY_TYPES.has(connectorDataType)) {
    col.subfields = [
      { relativePath: 'id', name: 'Id', type: 'string' },
      { relativePath: 'name', name: 'Name', type: 'string' },
    ];
    col.selectedSubfield = 0;
  }

  // Date properties: inner value is `{ start, end?, time_zone? } | null` — show start.
  if (connectorDataType === 'date') {
    col.subfields = [{ relativePath: 'start', name: 'Start', type: 'date' }];
    col.selectedSubfield = 0;
  }

  return col;
}

/**
 * Map a Notion property's inner value schema (the value under the envelope's
 * type key, e.g. the `email` value in `{ id, type, email }`) to a renderer
 * TablePropertyType. Resolves nullable unions to their non-null member so
 * scalar inner values (`email`, `number`, `url`) map to scalar types rather
 * than 'object'. Objects, arrays, and unknown inner values render as JSON.
 */
function resolveInnerValueTablePropertyType(schema: TSchema | undefined): TablePropertyType | undefined {
  if (!schema) return undefined;
  const format = (schema as TSchema & { format?: string }).format;
  if (format === 'date-time') return 'date';
  if (format === 'uri') return 'url';

  const kind = schema[Kind] as string | undefined;
  if (kind === 'Boolean') return 'checkbox';
  if (kind === 'Number' || kind === 'Integer') return 'number';
  if (kind === 'String') return 'string';
  if (kind === 'Union') {
    const anyOf = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
    const nonNull = anyOf?.find((s) => s[Kind] !== 'Null');
    return nonNull ? resolveInnerValueTablePropertyType(nonNull) : 'object';
  }
  return 'object';
}
