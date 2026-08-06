import { ButtonSecondaryInline, IconButtonGhost } from '@/components/base/buttons';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Group, Stack, Text, TextInput } from '@mantine/core';
import type { ConnectorSettingDefinition } from '@spinner/shared-types';
import { PlusIcon, XIcon } from 'lucide-react';

/**
 * Repeatable text rows with add/remove controls for `string-list` credential
 * fields (e.g. Google Sheets' spreadsheet URLs) — rendered by both the
 * create-connection and edit-connection modals. At least one row always
 * renders; non-empty rows validate live against the field's `itemPattern`.
 * Value/validation helpers live in credential-field-helpers.ts (Fast Refresh).
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
        <Text size="sm" fw={500}>
          {field.label}
          {field.required && (
            <Text component="span" c="red">
              {' '}
              *
            </Text>
          )}
        </Text>
        {field.description && (
          <Text size="xs" c="dimmed">
            {field.description}
          </Text>
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
