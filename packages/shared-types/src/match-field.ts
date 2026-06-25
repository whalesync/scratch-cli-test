import { FieldTransformHints } from './transform-picker';

/**
 * Whether a field can be used as a record-matching (match key) field, and if not,
 * why. This is the static, schema-only mirror of the server's runtime
 * `deriveCanonicalMatchKey`: matching reduces each side's value to a canonical
 * primitive using the field's OWN connector-declared extraction transformer
 * (never the sync's copy transformers), so a field is usable when its value is
 * already a primitive OR it declares an extraction transformer that can produce
 * one. Shared by every UI that lets a user pick the match field, so a new
 * connector lights up across all of them just by declaring its hints.
 */
export type MatchFieldIncompatibilityReason = 'no-extractable-primitive';

export type MatchFieldCompatibility = { usable: true } | { usable: false; reason: MatchFieldIncompatibilityReason };

/** JSON-schema primitive types that are directly comparable as a match key. */
const PRIMITIVE_MATCH_FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer']);

/**
 * Decide whether a field can serve as a match key from its schema hints alone.
 *
 * This is a *necessary* check, not a *sufficient* one: a field may declare a
 * `suggestedTransformer` whose runtime output is still non-primitive, which the
 * server catches at sync time. The UI uses this to disable clearly-incompatible
 * options up front; the executor remains the authority.
 */
export function getMatchFieldCompatibility(field: FieldTransformHints | undefined): MatchFieldCompatibility {
  if (field?.type !== undefined && PRIMITIVE_MATCH_FIELD_TYPES.has(field.type)) {
    return { usable: true };
  }
  if (field?.suggestedTransformer !== undefined) {
    return { usable: true };
  }
  return { usable: false, reason: 'no-extractable-primitive' };
}

/** Human-readable explanation for why a field can't be used as a match key. */
export function describeMatchFieldIncompatibility(reason: MatchFieldIncompatibilityReason): string {
  switch (reason) {
    case 'no-extractable-primitive':
      return "This field's value isn't a plain text or number and has no way to extract one, so it can't be used to match records.";
  }
}
