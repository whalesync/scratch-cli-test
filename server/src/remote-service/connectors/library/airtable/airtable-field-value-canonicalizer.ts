import { X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY } from '@spinner/shared-types';
import type {
  FieldValueCanonicalizer,
  FieldValueCanonicalizerContext,
} from 'src/remote-service/connectors/field-value-canonicalization';
import {
  composeCanonicalizers,
  emptyAsNull,
  isoInstantTruncatedTo,
  numberRoundedToSignificantDigits,
} from 'src/remote-service/connectors/field-value-canonicalizers';
import { AirtableDataType } from './airtable-types';

/**
 * Airtable's field-value canonicalizers (DEV-10556 / DEV-11131).
 *
 * Airtable's read API OMITS an empty field from `record.fields` altogether — an
 * empty text cell, an unchecked checkbox, an empty multi-select / link / attachment
 * list, an unset number or date all simply have no key. The sync, however, writes
 * the empty value it derived (`""`, `false`, `[]`, `null`), so after the next pull
 * the stored record lacks the key while the re-derived record carries it, the two
 * differ structurally, and every record with at least one empty field re-publishes
 * on every run. Date fields add a second drift: Airtable renders what it stores
 * (`2026-03-14` for a date field, second-precision ISO for a date-time field), not
 * the string we sent.
 *
 * Every writable column therefore canonicalises "absent" and its own empty
 * spelling to `null`; date columns compare as instants at the precision Airtable
 * keeps; numeric columns tolerate float64 round-trip noise. Read-only / computed
 * columns (formula, rollup, lookup, count, created/modified time/by, autoNumber,
 * button, aiText, externalSyncSource) and the record envelope (`id`, `createdTime`)
 * declare nothing and compare structurally.
 */

const AIRTABLE_DATE_TIME_COMPARE_PRECISION = 'second' as const;

const MULTI_VALUE_TYPES: ReadonlySet<string> = new Set<string>([
  AirtableDataType.MULTIPLE_SELECTS,
  AirtableDataType.MULTIPLE_RECORD_LINKS,
  AirtableDataType.MULTIPLE_ATTACHMENTS,
  AirtableDataType.MULTIPLE_COLLABORATORS,
]);

const NUMERIC_TYPES: ReadonlySet<string> = new Set<string>([
  AirtableDataType.NUMBER,
  AirtableDataType.PERCENT,
  AirtableDataType.CURRENCY,
  AirtableDataType.RATING,
  AirtableDataType.DURATION,
]);

/**
 * The canonicalizer for a writable Airtable column of `airtableType`
 * (`AirtableDataType` value; `format` is the column's JSON-schema format, which
 * tells a date-only `dateTime` column apart from one with a time). Exposed for
 * tests; the registry hook below resolves both from the field's schema node.
 */
export function airtableFieldValueCanonicalizerForColumnType(
  airtableTypeName: string,
  format: string | undefined,
): FieldValueCanonicalizer {
  const airtableType = airtableTypeName as AirtableDataType;
  if (airtableType === AirtableDataType.CHECKBOX) {
    // An unchecked box is omitted on read and written as `false`.
    return emptyAsNull({ falseIsEmpty: true });
  }
  if (MULTI_VALUE_TYPES.has(airtableType)) {
    // An empty list is omitted on read and written as `[]`.
    return emptyAsNull({ emptyArrayIsEmpty: true });
  }
  if (NUMERIC_TYPES.has(airtableType)) {
    return composeCanonicalizers(numberRoundedToSignificantDigits(15), emptyAsNull());
  }
  if (airtableType === AirtableDataType.DATE || (airtableType === AirtableDataType.DATE_TIME && format === 'date')) {
    // A date-only column stores the calendar day: `2026-03-14T15:09:26.535Z` reads back as `2026-03-14`.
    return composeCanonicalizers(isoInstantTruncatedTo('day'), emptyAsNull());
  }
  if (airtableType === AirtableDataType.DATE_TIME) {
    return composeCanonicalizers(isoInstantTruncatedTo(AIRTABLE_DATE_TIME_COMPARE_PRECISION), emptyAsNull());
  }
  // Text-like and everything else writable: absent ≡ '' ≡ null.
  return emptyAsNull();
}

/**
 * Registry hook (`resolveFieldValueCanonicalizer`): a canonicalizer for each
 * writable `fields.<name>` column of an Airtable table (the pull schema annotates
 * every column with its Airtable type via `x-scratch-connector-data-type`, and
 * computed columns with `x-scratch-readonly`). The record envelope (`id`,
 * `fields`, `createdTime`) carries no type annotation and compares structurally.
 */
export function resolveAirtableFieldValueCanonicalizer(
  context: FieldValueCanonicalizerContext,
): FieldValueCanonicalizer | undefined {
  if (!context.fieldPath.startsWith('fields.')) return undefined;
  const airtableType = context.fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as unknown;
  if (typeof airtableType !== 'string') return undefined;
  if (context.fieldSchema?.[X_SCRATCH_READONLY] === true) return undefined;
  return airtableFieldValueCanonicalizerForColumnType(airtableType, context.schemaField.format);
}
