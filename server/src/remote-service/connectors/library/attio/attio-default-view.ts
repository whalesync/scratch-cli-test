import { Kind, TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
  X_SCRATCH_WRITE_ONCE,
} from '@spinner/shared-types';
import { attioExportLogicalType, buildAttioDisplayTransformer } from './attio-value-expressions';

// ── Top-level fixed fields ──

// Fixed fields that should be hidden by default.
// `parent_record_id` / `parent_object` are intentionally NOT hidden: a user
// must see and set them to create a list entry from the grid (createListEntry
// requires them). See the write-once note in attio-json-schema.ts.
const HIDDEN_FIXED_FIELDS = new Set(['web_url']);

// Fixed fields that are always readonly (system-generated, not editable via the API).
// `parent_record_id` / `parent_object` are NOT here: they are **write-once**
// (`x-scratch-write-once` in the schema) — editable on a new entry, read-only
// once it exists. `buildFixedCol` derives that flag from the schema.
const READONLY_FIXED_FIELDS = new Set(['id', 'created_at', 'web_url']);

// ── Attio attribute type mapping ──

const ATTIO_TYPE_MAP: Partial<Record<string, TablePropertyType>> = {
  text: 'string',
  number: 'number',
  checkbox: 'checkbox',
  currency: 'number',
  date: 'date',
  timestamp: 'date',
  rating: 'number',
  domain: 'url',
  'email-address': 'string',
  'phone-number': 'string',
  status: 'string',
  select: 'string',
  'record-reference': 'object',
  'actor-reference': 'object',
  location: 'object',
  'personal-name': 'object',
  interaction: 'object',
  'record-id': 'string',
};

// ── Hidden value fields ──

// System attributes that are not useful to show by default.
const HIDDEN_VALUE_FIELDS = new Set([
  'created_by',
  'categories',
  'record_id',
  'workspace_id',
  'object_id',
  'avatar_url',
  'twitter',
  'facebook',
  'linkedin',
  'angellist',
  'instagram',
]);

// ── Always-readonly value fields ──

const ALWAYS_READONLY_VALUE_FIELDS = new Set(['created_by', 'record_id', 'workspace_id', 'object_id']);

/**
 * Per-object display and metadata configuration for default views.
 */
export interface AttioObjectViewConfig {
  /** The key inside the schema that contains the attribute values (e.g. 'values' or 'entry_values'). */
  valuesKey: string;
  /** Attribute api_slug to show first (the title field). */
  titleField?: string;
  /** Attribute api_slugs to show right after id. */
  priorityFields?: string[];
}

/** View config for standard objects. */
export const OBJECT_VIEW_CONFIG: Record<string, AttioObjectViewConfig> = {
  companies: {
    valuesKey: 'values',
    titleField: 'name',
    priorityFields: ['domains', 'description', 'team'],
  },
  people: {
    valuesKey: 'values',
    titleField: 'name',
    priorityFields: ['email_addresses', 'phone_numbers', 'job_title', 'company'],
  },
  deals: {
    valuesKey: 'values',
    titleField: 'name',
    priorityFields: ['stage', 'value', 'owner', 'expected_close_date'],
  },
};

/** Default view config for lists (entry_values). */
export const LIST_VIEW_CONFIG: AttioObjectViewConfig = {
  valuesKey: 'entry_values',
};

/**
 * Build a default TableView for an Attio object (companies, people, deals) or list.
 *
 * Column order: title attribute -> id -> priority attributes -> remaining attributes
 * -> remaining fixed fields (created_at, web_url, ...).
 */
export function buildAttioDefaultView(schema: TSchema, config: AttioObjectViewConfig): TableView {
  const topLevel: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const cols: TableViewCol[] = [];

  // Discover value attributes under the valuesKey (e.g. 'values' or 'entry_values')
  const valuesSchema = topLevel[config.valuesKey];
  const valueFields: Record<string, TSchema> =
    (valuesSchema as TSchema & { properties?: Record<string, TSchema> })?.properties ?? {};

  // Order: title first, then priority fields, then the rest
  const orderedValues = orderValueFields(Object.entries(valueFields), config.titleField, config.priorityFields);

  // Build fixed fields
  const fixedFieldIds = Object.keys(topLevel).filter((k) => k !== config.valuesKey);
  const fixedCols = new Map<string, TableViewCol>();
  for (const fieldId of fixedFieldIds) {
    fixedCols.set(fieldId, buildFixedCol(fieldId, topLevel[fieldId]));
  }

  // === Assemble final column order ===

  // 1. Title attribute (if present)
  const valueCols: { name: string; col: TableViewCol }[] = [];
  for (const [attrSlug, attrSchema] of orderedValues) {
    valueCols.push({ name: attrSlug, col: buildValueCol(attrSlug, attrSchema, config.valuesKey) });
  }

  if (config.titleField && valueCols.length > 0 && valueCols[0].name === config.titleField) {
    const titleEntry = valueCols.shift();
    if (titleEntry) cols.push(titleEntry.col);
  }

  // 2. id fixed field right after title
  const idCol = fixedCols.get('id');
  if (idCol) {
    cols.push(idCol);
    fixedCols.delete('id');
  }

  // 3. Priority fields (already ordered at front after title was removed)
  const prioritySet = new Set(config.priorityFields ?? []);
  while (valueCols.length > 0 && prioritySet.has(valueCols[0].name)) {
    const next = valueCols.shift();
    if (next) cols.push(next.col);
  }

  // 4. Remaining value fields
  for (const { col } of valueCols) {
    cols.push(col);
  }

  // 5. Remaining fixed fields in priority order: created_at, then the rest
  const remainingFixedOrder = ['created_at', 'web_url', 'parent_record_id', 'parent_object'];
  for (const fieldId of remainingFixedOrder) {
    const fixedCol = fixedCols.get(fieldId);
    if (fixedCol) {
      cols.push(fixedCol);
      fixedCols.delete(fieldId);
    }
  }
  for (const [, col] of fixedCols) {
    cols.push(col);
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Move the title field and priority fields to the front of the list. */
function orderValueFields(
  entries: [string, TSchema][],
  titleField: string | undefined,
  priorityFields: string[] | undefined,
): [string, TSchema][] {
  const priority: string[] = [];
  if (titleField) priority.push(titleField);
  if (priorityFields) priority.push(...priorityFields);
  if (priority.length === 0) return entries;

  const entryMap = new Map(entries);
  const ordered: [string, TSchema][] = [];

  for (const name of priority) {
    const schema = entryMap.get(name);
    if (schema) {
      ordered.push([name, schema]);
      entryMap.delete(name);
    }
  }

  for (const [name, schema] of entries) {
    if (entryMap.has(name)) {
      ordered.push([name, schema]);
    }
  }

  return ordered;
}

/** Format a snake_case / kebab-case field name as Title Case. */
function formatFieldName(fieldId: string): string {
  return fieldId
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Map a fixed top-level field to a TablePropertyType. */
function mapFixedFieldType(fieldSchema: TSchema | undefined): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;
  const format = (fieldSchema as TSchema & { format?: string }).format;
  if (format === 'date-time') return 'date';
  if (format === 'uri') return 'url';
  const kind = fieldSchema[Kind] as string | undefined;
  if (kind === 'Boolean') return 'checkbox';
  if (kind === 'Number' || kind === 'Integer') return 'number';
  if (kind === 'Object' || kind === 'Array' || kind === 'Union' || kind === 'Unknown') return 'object';
  return undefined;
}

/** Resolve the type for an Attio attribute from its connector data type annotation. */
function mapValueType(connectorDataType: string | undefined): TablePropertyType | undefined {
  if (!connectorDataType) return undefined;
  return ATTIO_TYPE_MAP[connectorDataType];
}

/** Determine whether a value field should be hidden by default. */
function isHiddenValueField(attrSlug: string): boolean {
  return HIDDEN_VALUE_FIELDS.has(attrSlug);
}

/** Determine whether a value field is always readonly (system-generated). */
function isAlwaysReadonlyValueField(attrSlug: string): boolean {
  return ALWAYS_READONLY_VALUE_FIELDS.has(attrSlug);
}

/**
 * The id field is an object triple — `{ workspace_id, <container>_id, <record>_id }`
 * (objects: `object_id` / `record_id`; lists: `list_id` / `entry_id`). Return the
 * record's own id key so the `id` column can default to a subfield that renders
 * `rec_…` / `entry_…` instead of the raw `{ ... }` JSON. Returns undefined when
 * the schema isn't a recognizable id object (e.g. a plain string id).
 */
function idRecordSubfieldKey(idSchema: TSchema | undefined): string | undefined {
  const props = (idSchema as TSchema & { properties?: Record<string, TSchema> })?.properties;
  if (!props) return undefined;
  const keys = Object.keys(props);
  // Prefer the canonical record-id keys; otherwise fall back to the last
  // non-workspace key (the triple lists the record id last).
  for (const preferred of ['record_id', 'entry_id']) {
    if (keys.includes(preferred)) return preferred;
  }
  const nonWorkspaceKeys = keys.filter((k) => k !== 'workspace_id');
  return nonWorkspaceKeys.length > 0 ? nonWorkspaceKeys[nonWorkspaceKeys.length - 1] : undefined;
}

/** Build a TableViewCol for a fixed top-level field. */
function buildFixedCol(fieldId: string, fieldSchema: TSchema | undefined): TableViewCol {
  const hidden = HIDDEN_FIXED_FIELDS.has(fieldId) || undefined;
  const isReadonly = READONLY_FIXED_FIELDS.has(fieldId) || fieldSchema?.[X_SCRATCH_READONLY] === true;
  const isWriteOnce = fieldSchema?.[X_SCRATCH_WRITE_ONCE] === true;

  const col: TableViewCol = {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapFixedFieldType(fieldSchema),
    readonly: isReadonly || undefined,
    writeOnce: isWriteOnce || undefined,
    hidden,
  };

  // The id triple is an object; default to showing the record's own id as a
  // subfield (the column path is a plain object, so getByPath can drill it)
  // rather than rendering the whole `{ workspace_id, ... }` envelope as JSON.
  if (fieldId === 'id') {
    const recordIdKey = idRecordSubfieldKey(fieldSchema);
    if (recordIdKey) {
      col.subfields = [{ relativePath: recordIdKey, name: formatFieldName(recordIdKey), type: 'string' }];
      col.selectedSubfield = 0;
    }
  }

  return col;
}

/** Build a TableViewCol for an Attio attribute value field (under values.* or entry_values.*). */
function buildValueCol(attrSlug: string, attrSchema: TSchema | undefined, valuesKey: string): TableViewCol {
  const connectorDataType = attrSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
  const isReadonly = attrSchema?.[X_SCRATCH_READONLY] === true || isAlwaysReadonlyValueField(attrSlug);
  const isWriteOnce = attrSchema?.[X_SCRATCH_WRITE_ONCE] === true;
  const hidden = isHiddenValueField(attrSlug) || undefined;

  // Every Attio attribute is stored verbatim as a value array
  // (`[{ attribute_type, active_from, ..., <payload>: X }]`). A `displayTransformer`
  // flattens that array to the single scalar the user cares about so the grid
  // renders clean values instead of raw JSON. Display-only: the stored value
  // stays the verbatim array for edit / copy / publish.
  const displayTransformer = buildAttioDisplayTransformer(connectorDataType);

  const col: TableViewCol = {
    kind: 'col',
    path: `${valuesKey}.${attrSlug}`,
    name: formatFieldName(attrSlug),
    // With a displayTransformer attached, the column DISPLAYS the flattened
    // scalar string, so it must render through the grid's text cell — the only
    // cell kind that consults `displayTransformer`. A 'number' / 'checkbox' /
    // 'url' type hint would instead route to a cell kind that renders the raw
    // value array (NaN / empty / JSON) and ignore the transformer entirely.
    // Columns without a transformer (e.g. `interaction`) keep their mapped type.
    type: displayTransformer ? 'string' : mapValueType(connectorDataType),
    readonly: isReadonly || undefined,
    writeOnce: isWriteOnce || undefined,
    hidden,
  };

  if (displayTransformer) {
    col.displayTransformer = displayTransformer;
    // The render `type` above was forced to text for the grid, but the flattened
    // value is really a number / date / boolean / url. Declare that SEMANTIC type
    // as `logicalType` so sync / Live Export creates the destination field with
    // the right type and doesn't export the value as text (DEV-11040). Only
    // attach it when it actually differs from the rendered `type` (text-like
    // extractions like status / email are already 'string').
    const logicalType = attioExportLogicalType(connectorDataType);
    if (logicalType && logicalType !== col.type) col.logicalType = logicalType;
  }
  return col;
}
