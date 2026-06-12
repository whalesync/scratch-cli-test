'use client';

import { ButtonDangerLight, ButtonSecondaryGhost } from '@/app/components/base/buttons';
import { TextTitle4 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Card, Group, Stack, TextInput } from '@mantine/core';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { findDuplicateFieldNameIds, makeEmptyField, type EditorField, type EditorTable } from './create-schema-plan';
import { CreateSchemaFieldRow } from './CreateSchemaFieldRow';

interface CreateSchemaTableEditorProps {
  table: EditorTable;
  index: number;
  onChange: (updates: Partial<EditorTable>) => void;
  onRemove: () => void;
  canRemove: boolean;
  /** All table refs in the plan (including this one — self-referential FKs are allowed). */
  allTableRefs: { value: string; label: string }[];
  /** Existing tables (data folders) for this connector, prepopulating FK "existing table" pickers. */
  existingTableOptions: { value: string; label: string }[];
}

export function CreateSchemaTableEditor({
  table,
  index,
  onChange,
  onRemove,
  canRemove,
  allTableRefs,
  existingTableOptions,
}: CreateSchemaTableEditorProps) {
  const updateField = (fieldId: string, updates: Partial<EditorField>) => {
    onChange({ fields: table.fields.map((field) => (field.id === fieldId ? { ...field, ...updates } : field)) });
  };
  const addField = () => onChange({ fields: [...table.fields, makeEmptyField()] });
  const removeField = (fieldId: string) => onChange({ fields: table.fields.filter((field) => field.id !== fieldId) });

  const duplicateFieldNameIds = findDuplicateFieldNameIds(table.fields);

  return (
    <Card withBorder padding="md" radius="md" bg="var(--bg-panel)">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <TextTitle4>Table {index + 1}</TextTitle4>
          {canRemove && (
            <ButtonDangerLight
              size="xs"
              leftSection={<StyledLucideIcon Icon={Trash2Icon} size="sm" />}
              onClick={onRemove}
            >
              Remove table
            </ButtonDangerLight>
          )}
        </Group>

        <Group gap="sm" align="flex-end">
          <TextInput
            label="Table name"
            placeholder="e.g. Customers"
            value={table.name}
            onChange={(event) => onChange({ name: event.currentTarget.value })}
            style={{ flex: 1 }}
          />
          <TextInput
            label="Ref"
            description="Correlation handle for foreign keys"
            value={table.ref}
            onChange={(event) => onChange({ ref: event.currentTarget.value })}
            w={180}
          />
        </Group>

        <Stack gap="sm">
          {table.fields.map((field) => (
            <CreateSchemaFieldRow
              key={field.id}
              field={field}
              onChange={(updates) => updateField(field.id, updates)}
              onRemove={() => removeField(field.id)}
              siblingTableRefs={allTableRefs}
              allowForeignKeyRef
              existingTableOptions={existingTableOptions}
              hasDuplicateName={duplicateFieldNameIds.has(field.id)}
            />
          ))}
        </Stack>

        <Group>
          <ButtonSecondaryGhost
            size="xs"
            leftSection={<StyledLucideIcon Icon={PlusIcon} size="sm" />}
            onClick={addField}
          >
            Add field
          </ButtonSecondaryGhost>
        </Group>
      </Stack>
    </Card>
  );
}
