'use client';

import { ButtonSecondaryInline, IconButtonGhost } from '@/app/components/base/buttons';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Group, Text as MantineText, Stack, TextInput } from '@mantine/core';
import { ConnectorSettingDefinition } from '@spinner/shared-types';
import { PlusIcon, XIcon } from 'lucide-react';

/**
 * Shared machinery for `string-list` credential fields (repeatable text rows
 * with add/remove controls) — rendered by both the create-connection and
 * edit-connection modals. See ConnectorSettingDefinition: `required` means at
 * least one non-empty row, non-empty rows validate against `itemPattern`, and
 * on the wire the rows are either newline-joined into one string (OAuth
 * initiate options / userProvidedParams) or persisted verbatim as a `string[]`
 * under `extras[extrasKey]`.
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

/**
 * Repeatable text rows with add/remove controls. At least one row always
 * renders; non-empty rows validate live against the field's `itemPattern`.
 */
export function StringListCredentialField({
  field,
  rows,
  onChange,
}: {
  field: ConnectorSettingDefinition;
  rows: string[];
  onChange: (rows: string[]) => void;
}) {
  const rowValues = rows.length > 0 ? rows : [''];
  const rowPattern = field.itemPattern ? new RegExp(field.itemPattern) : undefined;
  return (
    <Stack gap={6}>
      <div>
        <MantineText size="sm" fw={500}>
          {field.label}
          {field.required && (
            <MantineText component="span" c="red">
              {' '}
              *
            </MantineText>
          )}
        </MantineText>
        {field.description && (
          <MantineText size="xs" c="dimmed">
            {field.description}
          </MantineText>
        )}
      </div>
      {rowValues.map((rowValue, rowIndex) => {
        const trimmedRowValue = rowValue.trim();
        const rowError =
          trimmedRowValue && rowPattern && !rowPattern.test(trimmedRowValue)
            ? (field.itemPatternDescription ?? "This value doesn't look right.")
            : undefined;
        return (
          // Rows have no identity beyond their position.
          <Group key={rowIndex} gap="xs" align="flex-start" wrap="nowrap">
            <TextInput
              style={{ flex: 1 }}
              placeholder={field.placeholder}
              value={rowValue}
              error={rowError}
              onChange={(e) => {
                const nextRowValues = [...rowValues];
                nextRowValues[rowIndex] = e.currentTarget.value;
                onChange(nextRowValues);
              }}
            />
            <IconButtonGhost
              aria-label={`Remove ${field.label} row`}
              disabled={rowValues.length === 1}
              onClick={() => onChange(rowValues.filter((_, otherRowIndex) => otherRowIndex !== rowIndex))}
            >
              <StyledLucideIcon Icon={XIcon} size="sm" />
            </IconButtonGhost>
          </Group>
        );
      })}
      <div>
        <ButtonSecondaryInline onClick={() => onChange([...rowValues, ''])}>
          <Group gap={4} align="center" wrap="nowrap">
            <StyledLucideIcon Icon={PlusIcon} size="sm" />
            Add another
          </Group>
        </ButtonSecondaryInline>
      </div>
    </Stack>
  );
}
