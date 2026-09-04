import { X_SCRATCH_READONLY, X_SCRATCH_REMOTE_FIELD_ID } from '@spinner/shared-types';
import type {
  FieldValueCanonicalizer,
  FieldValueCanonicalizerContext,
} from 'src/remote-service/connectors/field-value-canonicalization';

/**
 * Google Sheets field-value canonicalizers (DEV-10556).
 *
 * A Sheets cell holds exactly one scalar and has only ONE spelling of "empty":
 * the pull normalises an empty cell (`''` or absent in a ragged row) to `null`.
 * A Live Export sync, however, derives the destination value from the SOURCE
 * field's shape — a multi-select with no options joins to `''`, a null source
 * stays `null`, and an un-collapsed empty list is `[]` — so the re-derived
 * record and the stored record differ structurally on every empty cell and the
 * row re-publishes on every run.
 *
 * Sheets has no column types (only number formats + data validation), so a
 * multi-select column created by Live Export is indistinguishable in the pull
 * schema from any other TEXT column. Every writable data column therefore
 * canonicalises `undefined` / `null` / `''` / `[]` to `[]` — the empty
 * multi-select the sync derives, which reads naturally when a diff is logged.
 * (Canonical forms are compared, never written, so the spelling is cosmetic.)
 * Non-empty values pass through and compare structurally: the connector writes
 * RAW and reads UNFORMATTED_VALUE, so numbers, booleans and serial dates
 * already round-trip verbatim.
 *
 * The managed `scratch_id` column (`x-scratch-readonly`) declares nothing.
 */

/** The canonicalizer every writable Google Sheets data column declares. Exposed for tests. */
export const googleSheetsWritableColumnCanonicalizer: FieldValueCanonicalizer = (value) => {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value) && value.length === 0) return [];
  return value;
};

/**
 * Registry hook (`resolveFieldValueCanonicalizer`): a canonicalizer for each
 * writable data column of a sheet (every top-level property the schema
 * annotates with `x-scratch-remote-field-id` — the column header — that is not
 * marked read-only).
 */
export function resolveGoogleSheetsFieldValueCanonicalizer(
  context: FieldValueCanonicalizerContext,
): FieldValueCanonicalizer | undefined {
  if (context.fieldSchema?.[X_SCRATCH_READONLY] === true) return undefined;
  if (typeof context.fieldSchema?.[X_SCRATCH_REMOTE_FIELD_ID] !== 'string') return undefined;
  return googleSheetsWritableColumnCanonicalizer;
}
