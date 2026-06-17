'use client';

import { ButtonSecondaryGhost, IconButtonGhost } from '@/app/components/base/buttons';
import { Text12Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import {
  Autocomplete,
  Card,
  Checkbox,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  TextInput,
} from '@mantine/core';
import { CREATE_FIELD_KINDS, MAX_NUMBER_PRECISION, type CreateFieldKind } from '@spinner/shared-types';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import {
  FIELD_KIND_LABELS,
  NUMBER_FORMATS,
  makeEmptyChoiceOption,
  type EditorChoiceOption,
  type EditorField,
  type NumberFieldFormat,
} from './create-schema-plan';

interface CreateSchemaFieldRowProps {
  field: EditorField;
  onChange: (updates: Partial<EditorField>) => void;
  onRemove: () => void;
  /** Sibling tables in the same plan, for foreign-key `{ ref }` targets. */
  siblingTableRefs: { value: string; label: string }[];
  /** False in "add fields to existing table" mode — `{ ref }` FKs are rejected there. */
  allowForeignKeyRef: boolean;
  /** Existing tables (data folders) for this connector, prepopulating the FK "existing table" picker. */
  existingTableOptions: { value: string; label: string }[];
  /** True when this field's name duplicates another field's name in the same table. */
  hasDuplicateName: boolean;
}

const KIND_OPTIONS = CREATE_FIELD_KINDS.map((kind) => ({ value: kind, label: FIELD_KIND_LABELS[kind] })).sort((a, b) =>
  a.label.localeCompare(b.label),
);

export function CreateSchemaFieldRow({
  field,
  onChange,
  onRemove,
  siblingTableRefs,
  allowForeignKeyRef,
  existingTableOptions,
  hasDuplicateName,
}: CreateSchemaFieldRowProps) {
  const updateOption = (optionId: string, updates: Partial<EditorChoiceOption>) => {
    onChange({ options: field.options.map((option) => (option.id === optionId ? { ...option, ...updates } : option)) });
  };
  const addOption = () => onChange({ options: [...field.options, makeEmptyChoiceOption()] });
  const removeOption = (optionId: string) =>
    onChange({ options: field.options.filter((option) => option.id !== optionId) });

  return (
    <Card withBorder padding="sm" radius="sm">
      <Stack gap="sm">
        <Group gap="sm" align="flex-end" wrap="nowrap">
          <TextInput
            label="Field name"
            placeholder="e.g. Title"
            value={field.name}
            onChange={(event) => onChange({ name: event.currentTarget.value })}
            error={hasDuplicateName ? 'Duplicate field name in this table' : undefined}
            disabled={field.isSourceRecordId}
            style={{ flex: 1 }}
          />
          <Select
            label="Data type"
            data={KIND_OPTIONS}
            value={field.kind}
            onChange={(value) => value && onChange({ kind: value as CreateFieldKind })}
            allowDeselect={false}
            disabled={field.isSourceRecordId}
            w={160}
          />
          {!field.isSourceRecordId && (
            <IconButtonGhost aria-label="Remove field" onClick={onRemove}>
              <StyledLucideIcon Icon={Trash2Icon} size="sm" c="var(--mantine-color-red-6)" />
            </IconButtonGhost>
          )}
        </Group>

        {field.isSourceRecordId && (
          <Text12Regular c="var(--fg-secondary)">
            Holds the source record&apos;s id so synced rows always reference their origin. This field is required and
            can&apos;t be removed or renamed.
          </Text12Regular>
        )}

        {renderKindInputs(
          field,
          onChange,
          { updateOption, addOption, removeOption },
          siblingTableRefs,
          allowForeignKeyRef,
          existingTableOptions,
        )}

        <Group gap="lg">
          <Checkbox
            label="Primary field"
            checked={field.isPrimary}
            onChange={(event) => onChange({ isPrimary: event.currentTarget.checked })}
          />
          <Checkbox
            label="Required"
            checked={field.required}
            onChange={(event) => onChange({ required: event.currentTarget.checked })}
          />
        </Group>
      </Stack>
    </Card>
  );
}

function renderKindInputs(
  field: EditorField,
  onChange: (updates: Partial<EditorField>) => void,
  optionHandlers: {
    updateOption: (optionId: string, updates: Partial<EditorChoiceOption>) => void;
    addOption: () => void;
    removeOption: (optionId: string) => void;
  },
  siblingTableRefs: { value: string; label: string }[],
  allowForeignKeyRef: boolean,
  existingTableOptions: { value: string; label: string }[],
) {
  switch (field.kind) {
    case 'text':
    case 'longText':
    case 'boolean':
    case 'url':
    case 'email':
    case 'phone':
      return null;
    case 'number':
      return (
        <Group gap="sm" align="flex-end">
          <NumberInput
            label="Precision"
            placeholder="optional"
            min={0}
            max={MAX_NUMBER_PRECISION}
            value={field.precision === '' ? '' : Number(field.precision)}
            onChange={(value) => onChange({ precision: value === '' ? '' : String(value) })}
            w={140}
          />
          <Select
            label="Format"
            data={NUMBER_FORMATS}
            value={field.format}
            onChange={(value) => value && onChange({ format: value as NumberFieldFormat })}
            allowDeselect={false}
            w={160}
          />
        </Group>
      );
    case 'date':
      return (
        <Checkbox
          label="Includes time"
          checked={field.includesTime}
          onChange={(event) => onChange({ includesTime: event.currentTarget.checked })}
        />
      );
    case 'select':
    case 'multiSelect':
      return (
        <Stack gap="xs">
          <Text12Regular c="var(--fg-secondary)">Options</Text12Regular>
          {field.options.map((option) => (
            <Group key={option.id} gap="xs" align="flex-end" wrap="nowrap">
              <TextInput
                placeholder="Option name"
                value={option.name}
                onChange={(event) => optionHandlers.updateOption(option.id, { name: event.currentTarget.value })}
                style={{ flex: 1 }}
              />
              <TextInput
                placeholder="Color (optional)"
                value={option.color}
                onChange={(event) => optionHandlers.updateOption(option.id, { color: event.currentTarget.value })}
                w={160}
              />
              <IconButtonGhost aria-label="Remove option" onClick={() => optionHandlers.removeOption(option.id)}>
                <StyledLucideIcon Icon={Trash2Icon} size="sm" c="var(--mantine-color-red-6)" />
              </IconButtonGhost>
            </Group>
          ))}
          <Group>
            <ButtonSecondaryGhost
              size="xs"
              leftSection={<StyledLucideIcon Icon={PlusIcon} size="sm" />}
              onClick={optionHandlers.addOption}
            >
              Add option
            </ButtonSecondaryGhost>
          </Group>
        </Stack>
      );
    case 'currency':
      return (
        <Group gap="sm" align="flex-end">
          <TextInput
            label="Currency code"
            placeholder="USD"
            maxLength={3}
            value={field.currencyCode}
            onChange={(event) => onChange({ currencyCode: event.currentTarget.value.toUpperCase() })}
            w={140}
          />
          <NumberInput
            label="Precision"
            placeholder="optional"
            min={0}
            max={MAX_NUMBER_PRECISION}
            value={field.precision === '' ? '' : Number(field.precision)}
            onChange={(value) => onChange({ precision: value === '' ? '' : String(value) })}
            w={140}
          />
        </Group>
      );
    case 'foreignKey':
      return (
        <Stack gap="xs">
          {allowForeignKeyRef && (
            <SegmentedControl
              data={[
                { value: 'existing', label: 'Existing remote table' },
                { value: 'ref', label: 'New table in this plan' },
              ]}
              value={field.foreignKeyTargetMode}
              onChange={(value) => onChange({ foreignKeyTargetMode: value as EditorField['foreignKeyTargetMode'] })}
            />
          )}
          {field.foreignKeyTargetMode === 'ref' && allowForeignKeyRef ? (
            <Select
              label="Target table"
              placeholder={siblingTableRefs.length ? 'Pick a table in this plan' : 'No other tables in this plan'}
              data={siblingTableRefs}
              value={field.foreignKeyRef || null}
              onChange={(value) => onChange({ foreignKeyRef: value ?? '' })}
              disabled={siblingTableRefs.length === 0}
            />
          ) : (
            <Autocomplete
              label="Existing remote table id"
              description="Pick a table from Scratch or type a remote id (use / for path segments)"
              placeholder="e.g. public/customers"
              data={existingTableOptions}
              value={field.foreignKeyExistingRemoteTableId}
              onChange={(value) => onChange({ foreignKeyExistingRemoteTableId: value })}
            />
          )}
          <Checkbox
            label="Allow multiple"
            checked={field.foreignKeyAllowMultiple}
            onChange={(event) => onChange({ foreignKeyAllowMultiple: event.currentTarget.checked })}
          />
        </Stack>
      );
    default:
      return null;
  }
}
