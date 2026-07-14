import { TSchema } from '@sinclair/typebox';
import {
  TablePropertyType,
  TableView,
  TableViewCol,
  TableViewSubfield,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import type { BaseJsonTableSpec } from '../../types';
import {
  AirtableDataType,
  X_SCRATCH_AIRTABLE_FIELD_ORDER,
  X_SCRATCH_AIRTABLE_LOOKUP_RESULT_TYPE,
} from './airtable-types';

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

// The key under which per-field schemas live on the Airtable record schema:
// `schema.properties.fields.properties.<fieldName>`. Also the path prefix on
// every field column (`fields.<fieldName>`).
const FIELDS_KEY = 'fields';

/**
 * Build a default TableView for an Airtable table — a PURE function of the spec.
 * Reads the per-field schemas (and their `x-scratch-*` annotations) off
 * `spec.schema` to order and type columns. The primary field — identified by
 * `spec.titlePath` (`fields.<primaryName>`) — appears first, followed by the
 * remaining fields in the schema's (Airtable-native) order.
 */
export function buildAirtableDefaultView(spec: BaseJsonTableSpec): TableView {
  const fieldsNode = readFieldsNode(spec);
  const fieldsSchema = fieldsNode?.properties ?? {};

  // Column order must be the TRUE Airtable field order. Object.keys can't be
  // trusted here: field names are user-controlled and can be numeric, which JS
  // hoists to the front. Schema-gen records the real order in the fields node's
  // x-scratch-airtable-field-order annotation; fall back to Object.keys only for
  // legacy schemas that predate it.
  const recordedFieldOrder = fieldsNode?.[X_SCRATCH_AIRTABLE_FIELD_ORDER] as string[] | undefined;
  const fieldNamesInNativeOrder = (recordedFieldOrder ?? Object.keys(fieldsSchema)).filter((name) =>
    Object.prototype.hasOwnProperty.call(fieldsSchema, name),
  );

  // Editorial rule: the primary field leads. Its identity comes from titlePath;
  // strip the leading `fields.` by prefix (dot-safe — a plain path split would
  // over-split a primary field name containing a literal `.`).
  const primaryFieldName = primaryFieldNameFromTitlePath(spec.titlePath);
  const orderedFieldNames =
    primaryFieldName && Object.prototype.hasOwnProperty.call(fieldsSchema, primaryFieldName)
      ? [primaryFieldName, ...fieldNamesInNativeOrder.filter((name) => name !== primaryFieldName)]
      : fieldNamesInNativeOrder;

  const cols: TableViewCol[] = orderedFieldNames.map((fieldName) => buildCol(fieldName, fieldsSchema[fieldName]));

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

/** Read the `fields` object node from `spec.schema.properties.fields` (carries both the per-field schemas and the field-order annotation). */
function readFieldsNode(spec: BaseJsonTableSpec): (TSchema & { properties?: Record<string, TSchema> }) | undefined {
  const topLevelProperties = (spec.schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};
  return topLevelProperties[FIELDS_KEY] as (TSchema & { properties?: Record<string, TSchema> }) | undefined;
}

/** Extract the primary field name from a `fields.<name>` title path (dot-safe). */
function primaryFieldNameFromTitlePath(titlePath: string | undefined): string | undefined {
  const prefix = `${FIELDS_KEY}.`;
  if (!titlePath || !titlePath.startsWith(prefix)) return undefined;
  return titlePath.slice(prefix.length);
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
 * Return the computed-field display transformer for an Airtable field from its
 * schema annotations, or undefined when the column should keep its typed
 * rendering. A field earns it when its value is an aiText wrapper, a numeric
 * result (which can arrive as `{ specialValue: "Infinity" }`), or a plain-text
 * computed scalar — and any of these may also arrive errored or as a lookup
 * array — the shapes that otherwise render as raw JSON or a broken numeric cell.
 *
 * The host type and (for formula/rollup/lookup) the result type are encoded in
 * `x-scratch-connector-data-type` (`"aiText"`, `"formula-number"`, …); a
 * `multipleLookupValues` field's result type lives in the dedicated
 * `x-scratch-airtable-lookup-result-type` annotation instead. This mirrors the
 * decision the raw `field.type` / `field.options.result.type` drove at pull time.
 */
function computedFieldDisplayTransformer(
  connectorDataType: string | undefined,
  fieldSchema: TSchema | undefined,
): NonNullable<TableViewCol['displayTransformer']> | undefined {
  if (!connectorDataType) return undefined;
  if (connectorDataType === (AirtableDataType.AI_TEXT as string)) return COMPUTED_FIELD_DISPLAY_TRANSFORMER;

  // Split "<host>" or "<host>-<resultType>" (formula/rollup/lookup carry a suffix).
  const dashIndex = connectorDataType.indexOf('-');
  const hostType = dashIndex > 0 ? connectorDataType.slice(0, dashIndex) : connectorDataType;
  let resultType: string | undefined = dashIndex > 0 ? connectorDataType.slice(dashIndex + 1) : undefined;
  // A lookup array's result type is not in the connector-data-type; read it from
  // its dedicated annotation.
  if (hostType === (AirtableDataType.MULTIPLE_LOOKUP_VALUES as string)) {
    resultType = fieldSchema?.[X_SCRATCH_AIRTABLE_LOOKUP_RESULT_TYPE] as string | undefined;
  }

  if (COMPUTED_WRAPPER_HOST_TYPES.has(hostType)) {
    if (
      resultType === (AirtableDataType.AI_TEXT as string) ||
      (resultType && TRANSFORMABLE_RESULT_TYPES.has(resultType))
    ) {
      return COMPUTED_FIELD_DISPLAY_TRANSFORMER;
    }
  }

  return undefined;
}

/** Build a TableViewCol for an Airtable field from its name and schema. */
function buildCol(fieldName: string, fieldSchema: TSchema | undefined): TableViewCol {
  const connectorDataType = fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;
  const displayTransformer = computedFieldDisplayTransformer(connectorDataType, fieldSchema);

  const col: TableViewCol = {
    kind: 'col',
    path: `fields.${fieldName}`,
    name: fieldName,
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
