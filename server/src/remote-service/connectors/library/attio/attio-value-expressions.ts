import { JSONPathArrayHandling, TablePropertyType, TableViewCol, TransformerTypes } from '@spinner/shared-types';
import { AttioAttributeType } from './attio-types';

/**
 * Path — INSIDE one element of an Attio value array — of the useful payload, keyed by
 * attribute type. Attio wraps every value in `{ attribute_type, active_from, active_until,
 * created_by_actor, <payload key>: ... }`, and each attribute type stores its payload at a
 * different key inside that element object.
 *
 * The full extraction expression is built by {@link attioValueJsonPathExpression}: `$[0].<path>`
 * for a single-valued attribute, `$[*].<path>` for a multi-valued (`is_multiselect`) one — a
 * multi-select, multiple emails/phones/domains, or a multi-record reference stores ONE ARRAY
 * ELEMENT PER VALUE, so extracting only `$[0]` silently dropped every value past the first
 * (DEV-11377).
 *
 * Three layers share this one map so "where the displayable value lives" has a single source
 * of truth:
 *   - the schema's `x-scratch-virtual-fields` (sync editor) in attio-json-schema.ts
 *   - the default view's per-column `displayTransformer` (grid) via
 *     `buildAttioDisplayTransformer` below, consumed in attio-default-view.ts
 *   - the default view's per-column `codec.toCore` (sync/export of multi-valued columns) via
 *     `buildAttioMultiValueToCoreCodec` below
 *
 * Types not listed here are too complex for a simple extraction and are left as raw arrays
 * (rendered as JSON in the grid).
 */
const ATTIO_VALUE_ELEMENT_PAYLOAD_PATH: Partial<Record<AttioAttributeType, string>> = {
  text: 'value',
  number: 'value',
  checkbox: 'value',
  // Attio stores a currency amount under `currency_value` (a decimal), NOT `value`.
  // Reading `$[0].value` silently dropped every currency field in the grid AND on
  // export (this expression is reused as the sync `toCore` extract). See DEV-11039.
  currency: 'currency_value',
  date: 'value',
  timestamp: 'value',
  rating: 'value',
  domain: 'domain',
  'email-address': 'email_address',
  'phone-number': 'phone_number',
  status: 'status.title',
  select: 'option.title',
  'record-reference': 'target_record_id',
  'actor-reference': 'referenced_actor_id',
  location: 'locality',
  'personal-name': 'full_name',
  // An `interaction` value (the computed `first/last/next email|calendar interaction`
  // fields) is `{ interaction_type, interacted_at, owner_actor, ... }`. The single
  // scalar a user cares about is WHEN it happened, so flatten to the `interacted_at`
  // timestamp. Read-only/system-managed (no write key). Before DEV-11052 this type
  // had no expression, so the grid showed raw JSON and Live Export downgraded it to
  // text ("Can't unpack this Attio object field"); it now flattens to a date.
  interaction: 'interacted_at',
};

/**
 * The JSONPath expression that extracts an attribute's payload from its verbatim value array:
 * the FIRST element's payload for a single-valued attribute (`$[0].<path>`), or EVERY
 * element's payload for a multi-valued one (`$[*].<path>`). Undefined for attribute types
 * with no simple extraction (their columns render the raw array as JSON).
 */
export function attioValueJsonPathExpression(
  connectorDataType: string | undefined,
  valueSelection: 'first-element' | 'every-element',
): string | undefined {
  if (!connectorDataType) return undefined;
  const payloadPathInsideElement = ATTIO_VALUE_ELEMENT_PAYLOAD_PATH[connectorDataType as AttioAttributeType];
  if (!payloadPathInsideElement) return undefined;
  return valueSelection === 'every-element' ? `$[*].${payloadPathInsideElement}` : `$[0].${payloadPathInsideElement}`;
}

/**
 * The SEMANTIC (logical) type of the scalar an attribute's extraction expression
 * ({@link attioValueJsonPathExpression}) extracts — what the flattened value actually IS
 * for sync / Live Export, as opposed to how its grid cell is drawn.
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
  // A `date` is a calendar day and stays date-only. A `timestamp` is a wall-clock instant, and only this hint
  // can say so: the export's plan field is the whole value array, which carries no JSON-Schema `format`, so
  // `'date'` here created date-only destination columns that dropped the time of day (DEV-12085).
  date: 'date',
  timestamp: 'datetime',
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
  // `interacted_at` is a wall-clock timestamp — export it as a time-bearing date column so a strict
  // destination gets a datetime field: not text (DEV-11052), and not date-only (DEV-12085). Mirrors `timestamp`.
  interaction: 'datetime',
};

/**
 * The semantic `logicalType` to declare on an Attio value column for sync / export,
 * for a column that carries a display transformer (so its render `type` was forced
 * to `'string'`). Returns `undefined` for a type with no mapping (no override).
 *
 * A MULTI-VALUED attribute always resolves to `'string'`: its exported value is the
 * array of extracted payload strings (comma-joined into a single-valued destination),
 * so a per-element semantic type like `url` or `number` would mistype the destination
 * column ("a, b, c" is not a url) — a multi-valued column lands as text.
 */
export function attioExportLogicalType(
  connectorDataType: string | undefined,
  isMultiValuedAttribute: boolean,
): TablePropertyType | undefined {
  if (!connectorDataType) return undefined;
  if (isMultiValuedAttribute) return 'string';
  return ATTIO_EXPORT_LOGICAL_TYPE[connectorDataType as AttioAttributeType];
}

/**
 * Build a declarative `displayTransformer` for an Attio attribute's grid column
 * from its connector data type: a JSONPath that flattens the verbatim value
 * array to what the user cares about — the single payload scalar for a
 * single-valued attribute (`$[0].value` → the text, `$[0].status.title` → the
 * status label), or the comma-joined payloads of EVERY element for a multi-valued
 * (`is_multiselect`) one (`$[*].option.title` → "Opt A, Opt B, Opt C"), so no
 * value past the first is hidden (DEV-11377).
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
  isMultiValuedAttribute: boolean,
): TableViewCol['displayTransformer'] {
  const expression = attioValueJsonPathExpression(
    connectorDataType,
    isMultiValuedAttribute ? 'every-element' : 'first-element',
  );
  if (!expression) return undefined;
  const arrayHandling: JSONPathArrayHandling = isMultiValuedAttribute ? 'join_comma' : 'first';
  return { type: TransformerTypes.JSONPath, options: { expression, arrayHandling } };
}

/**
 * Build the `codec.toCore` for a MULTI-VALUED (`is_multiselect`) Attio attribute's column:
 * a JSONPath that extracts every element's payload as an ARRAY (`$[*].option.title` →
 * `["Opt A", "Opt B"]`), declaring the column's true multi cardinality to the sync
 * transform picker — which then keeps the whole list (an array into a multi destination,
 * a comma-join into a text one) instead of exporting only the first value (DEV-11377).
 * The FK id-extraction path (`foreignKeyIdExtractionTransformer`) resolves the same
 * `toCore`, so a multi-record reference links EVERY referenced record.
 *
 * Single-valued columns deliberately get NO codec: their `displayTransformer` doubles as
 * the `toCore` via the resolver's derive-from-display fallback, exactly as before.
 * Returns `undefined` for types without an extraction expression.
 */
export function buildAttioMultiValueToCoreCodec(connectorDataType: string | undefined): TableViewCol['codec'] {
  const expression = attioValueJsonPathExpression(connectorDataType, 'every-element');
  if (!expression) return undefined;
  return { toCore: { type: TransformerTypes.JSONPath, options: { expression, arrayHandling: 'array' } } };
}
