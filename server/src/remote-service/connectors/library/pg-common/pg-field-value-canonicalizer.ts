import { PostgresColumnType, X_SCRATCH_CONNECTOR_DATA_TYPE } from '@spinner/shared-types';
import type {
  FieldValueCanonicalizer,
  FieldValueCanonicalizerContext,
} from 'src/remote-service/connectors/field-value-canonicalization';
import {
  decimalTextNormalized,
  isoInstantTruncatedTo,
  numberRoundedToSignificantDigits,
  parsedJsonText,
} from 'src/remote-service/connectors/field-value-canonicalizers';

/**
 * Postgres / Supabase field-value canonicalizers (DEV-10556), shared by both
 * SQL connectors through `pg-common`.
 *
 * A SQL store returns what it was given for most columns — which is why
 * Supabase was the one audited destination that mostly converged — but it
 * re-RENDERS three column families on read-back, so the string the sync wrote
 * and the string the next pull stores never compare equal structurally:
 *
 * - `timestamp` / `timestamptz` / `date` (`PostgresColumnType.TIMESTAMP`): the
 *   driver parses the column into a JS `Date` and we store its ISO rendering
 *   (`2026-07-23T21:12:27.000Z`), while a source typically sends `…27Z` or
 *   `…27+00:00`. Compared as instants at millisecond precision. (A `date` column
 *   that receives a full timestamp genuinely loses the time of day — that is a
 *   schema problem, DEV-11086, deliberately NOT papered over here.)
 * - `NUMERIC` (float8/real/int…): float64 re-rendering (`0.30000000000000004` vs
 *   `0.3`). Compared at 15 significant digits.
 * - `NUMERIC_STRING` (numeric/decimal/bigint, returned as precision-preserving
 *   strings — DEV-10777): compared as normalised decimal text (`"1.50"` ≡ `1.5`),
 *   never through a float, so two bigints that differ only beyond float64
 *   precision stay different.
 * - `JSONB` / `json`: re-serialised by the server (key order, whitespace).
 *   A JSON string is parsed so both sides compare as values.
 *
 * Text, boolean and array columns round-trip verbatim and compare structurally.
 */

/** The canonicalizer for a column of `pgType`, or `undefined` for a column that compares structurally. */
export function pgFieldValueCanonicalizerForColumnType(pgTypeName: string): FieldValueCanonicalizer | undefined {
  switch (pgTypeName as PostgresColumnType) {
    case PostgresColumnType.TIMESTAMP:
      return isoInstantTruncatedTo('millisecond');
    case PostgresColumnType.NUMERIC:
      return numberRoundedToSignificantDigits(15);
    case PostgresColumnType.NUMERIC_STRING:
      return decimalTextNormalized();
    case PostgresColumnType.JSONB:
      return parsedJsonText();
    default:
      return undefined;
  }
}

/**
 * Registry hook (`resolveFieldValueCanonicalizer`) for the Postgres and Supabase
 * connectors: resolves the column's `PostgresColumnType` from the pull schema's
 * `x-scratch-connector-data-type` annotation (set by both connectors'
 * `fetchJsonTableSpec`).
 */
export function resolvePgFieldValueCanonicalizer(
  context: FieldValueCanonicalizerContext,
): FieldValueCanonicalizer | undefined {
  const pgType = context.fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as unknown;
  if (typeof pgType !== 'string') return undefined;
  return pgFieldValueCanonicalizerForColumnType(pgType);
}
