import { TablePropertyType, TableViewCol, TransformerTypes } from '@spinner/shared-types';
import { AttioAttributeType } from './attio-types';

/**
 * JSONPath expression to extract the primary scalar value from a single-element
 * Attio value array, keyed by attribute type. Each attribute type stores its
 * useful payload at a different key inside the array element object (Attio wraps
 * every value in `{ attribute_type, active_from, active_until, created_by_actor,
 * <payload key>: ... }`).
 *
 * Two layers share this one map so "where the displayable value lives" has a
 * single source of truth:
 *   - the schema's `x-scratch-virtual-fields` (sync editor) in attio-json-schema.ts
 *   - the default view's per-column `displayTransformer` (grid) via
 *     `buildAttioDisplayTransformer` below, consumed in attio-default-view.ts
 *
 * Types not listed here (e.g. `interaction`) are too complex for a simple
 * extraction and are left as raw arrays (rendered as JSON in the grid).
 */
export const ATTIO_VALUE_EXPRESSION: Partial<Record<AttioAttributeType, string>> = {
  text: '$[0].value',
  number: '$[0].value',
  checkbox: '$[0].value',
  // Attio stores a currency amount under `currency_value` (a decimal), NOT `value`.
  // Reading `$[0].value` silently dropped every currency field in the grid AND on
  // export (this expression is reused as the sync `toCore` extract). See DEV-11039.
  currency: '$[0].currency_value',
  date: '$[0].value',
  timestamp: '$[0].value',
  rating: '$[0].value',
  domain: '$[0].domain',
  'email-address': '$[0].email_address',
  'phone-number': '$[0].phone_number',
  status: '$[0].status.title',
  select: '$[0].option.title',
  'record-reference': '$[0].target_record_id',
  'actor-reference': '$[0].referenced_actor_id',
  location: '$[0].locality',
  'personal-name': '$[0].full_name',
};

/**
 * The SEMANTIC (logical) type of the scalar an attribute's {@link ATTIO_VALUE_EXPRESSION}
 * extracts — what the flattened value actually IS for sync / Live Export, as opposed
 * to how its grid cell is drawn.
 *
 * A value column with a display transformer must render through the grid text cell
 * (`type:'string'`), because that is the only cell kind that consults a
 * `displayTransformer` — see `buildValueCol` in attio-default-view.ts. But the
 * extracted value is frequently a number / date / boolean / url, and the export
 * layer (the transform picker and the create-schema plan generator) must see THAT
 * type so a numeric Attio field lands as a number column on the destination instead
 * of text (the driver of mass strict-destination rejection — DEV-11040).
 *
 * This map therefore describes the EXTRACTED scalar, which is why several types that
 * wrap a structured raw value (`location`, `personal-name`) resolve to `'string'`
 * here even though their raw value object is `'object'`: the transformer flattens
 * them to a plain string (`locality`, `full_name`). Relation types
 * (`record-reference`, `actor-reference`) are declared foreign keys and handled by
 * the plan generator's FK path, so their entry is a harmless fallback.
 */
const ATTIO_EXPORT_LOGICAL_TYPE: Partial<Record<AttioAttributeType, TablePropertyType>> = {
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
  'record-reference': 'string',
  'actor-reference': 'string',
  location: 'string',
  'personal-name': 'string',
};

/**
 * The semantic `logicalType` to declare on an Attio value column for sync / export,
 * for a column that carries a display transformer (so its render `type` was forced
 * to `'string'`). Returns `undefined` for a type with no mapping (no override).
 */
export function attioExportLogicalType(connectorDataType: string | undefined): TablePropertyType | undefined {
  if (!connectorDataType) return undefined;
  return ATTIO_EXPORT_LOGICAL_TYPE[connectorDataType as AttioAttributeType];
}

/**
 * Build a declarative `displayTransformer` for an Attio attribute's grid column
 * from its connector data type: a JSONPath that flattens the verbatim value
 * array to the single scalar the user cares about (e.g. `$[0].value` → the text,
 * `$[0].status.title` → the status label).
 *
 * The renderer runs it through the generic, fail-closed applier in
 * `@spinner/shared-types/transform` and falls back to the raw array on
 * `{ok:false}`, so the frontend needs no Attio-specific knowledge. Display-only:
 * the stored value stays the verbatim array for edit / copy / publish, preserving
 * round-trip fidelity.
 *
 * Returns `undefined` for types without an extraction expression (those columns
 * render the raw array as JSON).
 */
export function buildAttioDisplayTransformer(
  connectorDataType: string | undefined,
): TableViewCol['displayTransformer'] {
  if (!connectorDataType) return undefined;
  const expression = ATTIO_VALUE_EXPRESSION[connectorDataType as AttioAttributeType];
  if (!expression) return undefined;
  return { type: TransformerTypes.JSONPath, options: { expression, arrayHandling: 'first' } };
}
