import { TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  TableViewSubfield,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { AirtableDataType, AirtableFieldsV2, AirtableTableV2 } from './airtable-types';

// Airtable field types that map to specific TablePropertyType values.
const TYPE_MAP: Partial<Record<string, TablePropertyType>> = {
  [AirtableDataType.NUMBER]: 'number',
  [AirtableDataType.PERCENT]: 'number',
  [AirtableDataType.CURRENCY]: 'number',
  [AirtableDataType.DURATION]: 'number',
  [AirtableDataType.RATING]: 'number',
  [AirtableDataType.AUTO_NUMBER]: 'number',
  [AirtableDataType.COUNT]: 'number',
  [AirtableDataType.CHECKBOX]: 'checkbox',
  [AirtableDataType.DATE]: 'date',
  [AirtableDataType.DATE_TIME]: 'date',
  [AirtableDataType.CREATED_TIME]: 'date',
  [AirtableDataType.LAST_MODIFIED_TIME]: 'date',
  [AirtableDataType.URL]: 'url',
  [AirtableDataType.RICH_TEXT]: 'richtext',
  [AirtableDataType.MULTIPLE_ATTACHMENTS]: 'object',
  [AirtableDataType.MULTIPLE_RECORD_LINKS]: 'object',
  [AirtableDataType.MULTIPLE_SELECTS]: 'object',
  [AirtableDataType.MULTIPLE_COLLABORATORS]: 'object',
  [AirtableDataType.MULTIPLE_LOOKUP_VALUES]: 'object',
  [AirtableDataType.BARCODE]: 'object',
  [AirtableDataType.SINGLE_COLLABORATOR]: 'object',
  [AirtableDataType.CREATED_BY]: 'object',
  [AirtableDataType.LAST_MODIFIED_BY]: 'object',
};

// Formula/rollup/lookup result types that map to a known TablePropertyType.
// The connector data type for these is "formula-<resultType>", "rollup-<resultType>", etc.
const FORMULA_RESULT_TYPE_MAP: Partial<Record<string, TablePropertyType>> = {
  [AirtableDataType.NUMBER]: 'number',
  [AirtableDataType.PERCENT]: 'number',
  [AirtableDataType.CURRENCY]: 'number',
  [AirtableDataType.DURATION]: 'number',
  [AirtableDataType.RATING]: 'number',
  [AirtableDataType.AUTO_NUMBER]: 'number',
  [AirtableDataType.COUNT]: 'number',
  [AirtableDataType.CHECKBOX]: 'checkbox',
  [AirtableDataType.DATE]: 'date',
  [AirtableDataType.DATE_TIME]: 'date',
  [AirtableDataType.CREATED_TIME]: 'date',
  [AirtableDataType.LAST_MODIFIED_TIME]: 'date',
  [AirtableDataType.URL]: 'url',
  [AirtableDataType.RICH_TEXT]: 'richtext',
};

/**
 * Build a default TableView for an Airtable table.
 * Uses the table's field metadata to order and type columns. The primary field
 * appears first, followed by remaining fields in Airtable's native order.
 */
export function buildAirtableDefaultView(table: AirtableTableV2, fieldsSchema: Record<string, TSchema>): TableView {
  const cols: TableViewCol[] = [];

  // Order fields: primary field first, then the rest in Airtable order
  const ordered = orderFields(table.fields, table.primaryFieldId);

  for (const field of ordered) {
    const fieldSchema = fieldsSchema[field.name];
    cols.push(buildCol(field, fieldSchema));
  }

  // Add createdTime as a trailing column
  cols.push({
    kind: 'col',
    path: 'createdTime',
    name: 'Created Time',
    type: 'date',
    readonly: true,
  });

  return { name: 'Default', cols };
}

// Collaborator types that share the {id, email, name} shape.
const COLLABORATOR_TYPES = new Set<string>([
  AirtableDataType.SINGLE_COLLABORATOR,
  AirtableDataType.CREATED_BY,
  AirtableDataType.LAST_MODIFIED_BY,
  AirtableDataType.MULTIPLE_COLLABORATORS,
]);

const COLLABORATOR_SUBFIELDS: TableViewSubfield[] = [
  { relativePath: 'email', name: 'Email', type: 'string' },
  { relativePath: 'name', name: 'Name', type: 'string' },
  { relativePath: 'id', name: 'Id', type: 'string' },
];

// The declarative transformer that flattens Airtable's service-COMPUTED value
// shapes to clean display text: an aiText wrapper `{ state, value, isStale }` →
// its `value` (blank when empty), a numeric special-value wrapper
// `{ specialValue: "Infinity" | "NaN" }` → that string (a real result, shown, not
// blanked), a genuine error wrapper `{ error: "#ERROR!" }` → blank, a plain
// scalar → itself, and a `multipleLookupValues` array → the non-blank items
// joined. The renderer runs it through the generic, fail-closed applier in
// `@spinner/shared-types/transform`, so the frontend stays connector-agnostic.
// Display-only: these fields are all readonly, so the verbatim value on disk is
// untouched and nothing is lost by showing the flattened string.
const COMPUTED_FIELD_DISPLAY_TRANSFORMER: NonNullable<TableViewCol['displayTransformer']> = {
  type: 'computed-field',
  options: { valueKeys: ['value', 'specialValue'], blankOnKeys: ['error'] },
};

// Airtable result types whose value can arrive wrapped (aiText), errored, or as
// a numeric special value (`{ specialValue: "Infinity" }` from `1/0`) — i.e. the
// shapes the plain grid cell renders as raw JSON. A formula/rollup/lookup landing
// on one of these earns the computed-field transformer. Text and numeric results
// are both here: text renders as a string either way (lossless), and numeric
// results MUST route through the text cell so Infinity / NaN show instead of a
// broken number cell. Date / checkbox / url / richtext are deliberately excluded
// so their formatted cells (and link / markdown rendering) are preserved; a rare
// error object on those still shows raw.
const TRANSFORMABLE_RESULT_TYPES = new Set<string>([
  AirtableDataType.SINGLE_LINE_TEXT,
  AirtableDataType.MULTILINE_TEXT,
  AirtableDataType.EMAIL,
  AirtableDataType.PHONE_NUMBER,
  AirtableDataType.NUMBER,
  AirtableDataType.PERCENT,
  AirtableDataType.CURRENCY,
  AirtableDataType.DURATION,
  AirtableDataType.RATING,
  AirtableDataType.AUTO_NUMBER,
  AirtableDataType.COUNT,
]);

// Airtable field types that host a computed value which may be wrapped (aiText),
// errored, or arrive as an array (lookups). The result type decides whether the
// column earns a display transformer — see `computedFieldDisplayTransformer`.
const COMPUTED_WRAPPER_HOST_TYPES = new Set<string>([
  AirtableDataType.FORMULA,
  AirtableDataType.ROLLUP,
  AirtableDataType.LOOKUP,
  AirtableDataType.MULTIPLE_LOOKUP_VALUES,
]);

// ── Helpers ──

/** Order fields with the primary field first, then the rest in their original order. */
function orderFields(fields: AirtableFieldsV2[], primaryFieldId?: string): AirtableFieldsV2[] {
  if (!primaryFieldId) return fields;
  const primary = fields.find((f) => f.id === primaryFieldId);
  const rest = fields.filter((f) => f.id !== primaryFieldId);
  return primary ? [primary, ...rest] : fields;
}

/** Map an Airtable connector data type to a TablePropertyType. */
function mapType(connectorDataType: string | undefined): TablePropertyType | undefined {
  if (!connectorDataType) return undefined;

  // Direct match for simple types
  const direct = TYPE_MAP[connectorDataType];
  if (direct) return direct;

  // Formula/rollup/lookup types are like "formula-number", "rollup-dateTime"
  const dashIdx = connectorDataType.indexOf('-');
  if (dashIdx > 0) {
    const resultType = connectorDataType.slice(dashIdx + 1);
    return FORMULA_RESULT_TYPE_MAP[resultType];
  }

  return undefined;
}

/**
 * Return the computed-field display transformer for an Airtable field, or
 * undefined when the column should keep its typed rendering. A field earns it
 * when its stored value is an aiText wrapper, a numeric result (which can arrive
 * as `{ specialValue: "Infinity" }`), or a plain-text computed scalar — and any
 * of these may also arrive errored or as a lookup array — the shapes that
 * otherwise render as raw JSON or a broken numeric cell.
 */
function computedFieldDisplayTransformer(
  field: AirtableFieldsV2,
): NonNullable<TableViewCol['displayTransformer']> | undefined {
  const rawFieldType = field.type as AirtableDataType;
  if (rawFieldType === AirtableDataType.AI_TEXT) return COMPUTED_FIELD_DISPLAY_TRANSFORMER;

  if (COMPUTED_WRAPPER_HOST_TYPES.has(rawFieldType)) {
    const resultType = field.options?.result?.type as AirtableDataType | undefined;
    if (resultType === AirtableDataType.AI_TEXT || (resultType && TRANSFORMABLE_RESULT_TYPES.has(resultType))) {
      return COMPUTED_FIELD_DISPLAY_TRANSFORMER;
    }
  }

  return undefined;
}

/** Build a TableViewCol for an Airtable field. */
function buildCol(field: AirtableFieldsV2, fieldSchema: TSchema | undefined): TableViewCol {
  const connectorDataType = fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;
  const displayTransformer = computedFieldDisplayTransformer(field);

  const col: TableViewCol = {
    kind: 'col',
    path: `fields.${field.name}`,
    name: field.name,
    // A column with a displayTransformer DISPLAYS the flattened scalar string, so
    // it must render through the grid's text cell — the only cell kind that
    // consults `displayTransformer`. A mapped 'number' / 'object' type would
    // instead route to a cell that renders the raw wrapper/array and ignore the
    // transformer entirely. Columns without a transformer keep their mapped type.
    type: displayTransformer ? 'string' : mapType(connectorDataType),
    readonly: isReadonly || undefined,
  };

  if (displayTransformer) {
    // Computed fields (aiText / formula-of-text / lookup) are flattened by the
    // transformer; collaborator subfields don't apply to them.
    col.displayTransformer = displayTransformer;
    return col;
  }

  // Collaborator fields are objects with {id, email, name} — default to showing email
  if (connectorDataType && COLLABORATOR_TYPES.has(connectorDataType)) {
    col.subfields = COLLABORATOR_SUBFIELDS;
    col.selectedSubfield = 0;
  }

  return col;
}
