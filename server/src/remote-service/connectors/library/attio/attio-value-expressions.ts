import { TableViewCol, TransformerTypes } from '@spinner/shared-types';
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
  currency: '$[0].value',
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
