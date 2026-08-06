import type { ConnectorSettingDefinition } from '@spinner/shared-types';

/**
 * Value/validation helpers for `string-list` credential fields (repeatable text
 * rows) — kept out of the component file for React Fast Refresh. Mirrors the
 * web client's StringListCredentialField helpers; see ConnectorSettingDefinition
 * for the contract (`required` = ≥1 non-empty row, rows validate against
 * `itemPattern`, newline-joined into one string on the wire, or persisted
 * verbatim as `string[]` under `extras[extrasKey]`).
 */

/** The trimmed, non-empty rows of a `string-list` credential field's value. */
export const nonEmptyStringListRows = (value: string | boolean | string[] | undefined): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((row) => row.trim()).filter((row) => row.length > 0);
};

/**
 * A `string-list` value is newline-joined into ONE string on the wire (OAuth
 * initiate options / userProvidedParams), so servers parse it exactly like a
 * `string` field. Non-list values pass through untouched.
 */
export const credentialFieldWireValue = (
  value: string | boolean | string[] | undefined,
): string | boolean | undefined => {
  return Array.isArray(value) ? nonEmptyStringListRows(value).join('\n') : value;
};

/**
 * First validation error for a credential field's current value, or null.
 * `string-list`: required = at least one non-empty row, and every non-empty row
 * must match `itemPattern`. Other types: required = non-empty value.
 */
export const credentialFieldValidationError = (
  field: ConnectorSettingDefinition,
  value: string | boolean | string[] | undefined,
): string | null => {
  if (field.type === 'string-list') {
    const rows = nonEmptyStringListRows(value);
    if (field.required && rows.length === 0) {
      return `${field.label}: add at least one entry.`;
    }
    if (field.itemPattern) {
      const rowPattern = new RegExp(field.itemPattern);
      const invalidRow = rows.find((row) => !rowPattern.test(row));
      if (invalidRow !== undefined) {
        return field.itemPatternDescription ?? `${field.label}: "${invalidRow}" doesn't look right.`;
      }
    }
    return null;
  }
  if (field.required && !value) {
    return `${field.label} is required.`;
  }
  return null;
};

/**
 * Read a `string-list` field's persisted rows back out of a ConnectorAccount's
 * `extras` JSON via the field's declared `extrasKey` (missing/foreign shapes →
 * `[]`). Lets the edit-connection modal prefill the rows with no connector
 * knowledge — the key comes from metadata, the values are the user's own input.
 */
export const stringListRowsFromAccountExtras = (
  field: ConnectorSettingDefinition,
  extras: Record<string, unknown> | null | undefined,
): string[] => {
  if (!field.extrasKey || !extras) return [];
  const storedRows = extras[field.extrasKey];
  if (!Array.isArray(storedRows)) return [];
  return storedRows.filter((row): row is string => typeof row === 'string');
};
