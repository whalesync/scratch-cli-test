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
 * - `timestamp` / `timestamptz` (`PostgresColumnType.TIMESTAMP`): the driver
 *   parses the column into a JS `Date` and we store its ISO rendering
 *   (`2026-07-23T21:12:27.000Z`), while a source typically sends `…27Z` or
 *   `…27+00:00`. Compared as instants at millisecond precision.
 * - `date` (`PostgresColumnType.TIMESTAMP` with `format: 'date'`): pulled as the
 *   driver's verbatim `YYYY-MM-DD` (DEV-12576), while a source may send a date or
 *   a full date-time. Compared by the calendar date Postgres stores, which keeps
 *   the literal date and drops any time of day and offset — see
 *   {@link calendarDateAsPostgresDateColumnStoresIt}.
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

/**
 * An ISO date or date-time, capturing its leading calendar date. Anything else — a BC date, `infinity`, a non-ISO
 * spelling — doesn't match and compares structurally.
 */
const ISO_DATE_OR_DATE_TIME_WITH_LEADING_CALENDAR_DATE_PATTERN =
  /^(\d{4,}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/**
 * The `YYYY-MM-DD` a Postgres `date` column holds after a value is written to it. Postgres keeps the literal date of
 * an ISO date-time and discards the time of day AND the offset (`2026-06-30T23:30:00-05:00` → `2026-06-30`, not the
 * UTC day), so the date is read off the text rather than through a `Date`. Non-ISO strings and non-strings pass
 * through unchanged.
 */
export const calendarDateAsPostgresDateColumnStoresIt: FieldValueCanonicalizer = (value) => {
  if (typeof value !== 'string') return value;
  const isoDateOrDateTimeMatch = ISO_DATE_OR_DATE_TIME_WITH_LEADING_CALENDAR_DATE_PATTERN.exec(value.trim());
  return isoDateOrDateTimeMatch ? isoDateOrDateTimeMatch[1] : value;
};

/**
 * The canonicalizer for a column of `pgType`, or `undefined` for a column that compares structurally. `schemaFormat`
 * is the column's JSON-schema `format`, which tells a `date` column (`'date'`) from a timestamp in the shared
 * `TIMESTAMP` family.
 */
export function pgFieldValueCanonicalizerForColumnType(
  pgTypeName: string,
  schemaFormat?: string,
): FieldValueCanonicalizer | undefined {
  switch (pgTypeName as PostgresColumnType) {
    case PostgresColumnType.TIMESTAMP:
      return schemaFormat === 'date' ? calendarDateAsPostgresDateColumnStoresIt : isoInstantTruncatedTo('millisecond');
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
 * `fetchJsonTableSpec`), and its `format`.
 */
export function resolvePgFieldValueCanonicalizer(
  context: FieldValueCanonicalizerContext,
): FieldValueCanonicalizer | undefined {
  const pgType = context.fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as unknown;
  if (typeof pgType !== 'string') return undefined;
  return pgFieldValueCanonicalizerForColumnType(pgType, context.schemaField.format);
}
