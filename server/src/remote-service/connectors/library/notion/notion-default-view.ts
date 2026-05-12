import { Kind, TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  TableViewSubfield,
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
  'archived',
  'cover',
  'icon',
  'page_content',
];

// Fixed fields that should be hidden by default.
const HIDDEN_FIXED_FIELDS = new Set([
  'object', // Always 'page', never useful
  'parent', // Always the same database_id
  'in_trash',
  'public_url',
]);

// Fixed fields that are objects and should get subfields with id as default.
const USER_OBJECT_FIELDS = new Set(['created_by', 'last_edited_by']);

const USER_SUBFIELDS: TableViewSubfield[] = [{ relativePath: 'id', name: 'Id', type: 'string' }];

const PARENT_SUBFIELDS: TableViewSubfield[] = [{ relativePath: 'database_id', name: 'Database Id', type: 'string' }];

// ── Notion property type mapping ──

const NOTION_TYPE_MAP: Partial<Record<string, TablePropertyType>> = {
  number: 'number',
  checkbox: 'checkbox',
  url: 'url',
  email: 'string',
  phone_number: 'string',
  created_time: 'date',
  last_edited_time: 'date',
  date: 'object',
  title: 'object',
  rich_text: 'object',
  select: 'object',
  status: 'object',
  multi_select: 'object',
  people: 'object',
  files: 'object',
  formula: 'object',
  relation: 'object',
  rollup: 'object',
  created_by: 'object',
  last_edited_by: 'object',
  unique_id: 'object',
  verification: 'object',
};

// Property types that should get a subfield for the human-readable value.
const SELECT_TYPES = new Set(['select', 'status']);
const USER_PROPERTY_TYPES = new Set(['created_by', 'last_edited_by']);

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

  for (const [propName, propSchema] of Object.entries(propertyFields)) {
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

  inPriority.sort((a, b) => priorityIndex.get(a)! - priorityIndex.get(b)!);
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

  const col: TableViewCol = {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapFixedFieldType(fieldId, fieldSchema),
    hidden,
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

/** Build a TableViewCol for a Notion database property (under properties.*). */
function buildPropertyCol(propName: string, propSchema: TSchema | undefined): TableViewCol {
  // Unwrap Optional wrapper
  const inner = unwrapOptional(propSchema);
  const connectorDataType = inner?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
  const isReadonly = inner?.[X_SCRATCH_READONLY] === true;
  const type = connectorDataType ? (NOTION_TYPE_MAP[connectorDataType] ?? 'object') : undefined;

  const col: TableViewCol = {
    kind: 'col',
    path: `properties.${propName}`,
    name: propName,
    type,
    readonly: isReadonly || undefined,
  };

  // Select/status: show the name
  if (SELECT_TYPES.has(connectorDataType ?? '')) {
    col.subfields = [{ relativePath: 'name', name: 'Name', type: 'string' }];
    col.selectedSubfield = 0;
  }

  // User property types (created_by, last_edited_by on properties): show id
  if (USER_PROPERTY_TYPES.has(connectorDataType ?? '')) {
    col.subfields = [
      { relativePath: 'id', name: 'Id', type: 'string' },
      { relativePath: 'name', name: 'Name', type: 'string' },
    ];
    col.selectedSubfield = 0;
  }

  // Date properties: show start
  if (connectorDataType === 'date') {
    col.subfields = [{ relativePath: 'start', name: 'Start', type: 'date' }];
    col.selectedSubfield = 0;
  }

  return col;
}

/** Unwrap TypeBox Optional to get the inner schema. */
function unwrapOptional(schema: TSchema | undefined): TSchema | undefined {
  if (!schema) return undefined;
  // TypeBox Optional wraps with anyOf or stores inner schema directly
  // In practice the annotation keys are on the inner schema for Notion properties
  const anyOf = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (anyOf) {
    return anyOf.find((s) => s[Kind] !== 'Null') ?? schema;
  }
  return schema;
}
