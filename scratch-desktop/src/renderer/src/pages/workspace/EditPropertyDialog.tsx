import { ButtonPrimarySolid, ButtonSecondaryGhost } from '@/components/base/buttons';
import { Checkbox, Group, Modal, NativeSelect, Stack, TextInput } from '@mantine/core';
import type { TablePropertyType, TableViewCol } from '@spinner/shared-types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildColumnDefinitions } from '../../../../shared/schema-columns';
import type { ColumnDataType, ColumnDefinition } from '../../../../shared/schema-columns/types';

// ── Helpers ──

function mapDataTypeToPropertyType(dataType: ColumnDataType, format?: string): TablePropertyType | undefined {
  switch (dataType) {
    case 'string': {
      const f = format?.toLowerCase();
      if (f === 'date-time' || f === 'date') return 'date';
      if (f === 'uri' || f === 'url') return 'url';
      return 'string';
    }
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'object':
      return 'object';
    case 'array':
    case 'unknown':
      return undefined;
  }
}

const TYPE_OPTIONS = [
  { value: '', label: '(none)' },
  { value: 'string', label: 'string' },
  { value: 'richtext', label: 'richtext' },
  { value: 'number', label: 'number' },
  { value: 'date', label: 'date' },
  { value: 'url', label: 'url' },
  { value: 'checkbox', label: 'checkbox' },
  { value: 'object', label: 'object' },
];

// ── Component ──

interface EditPropertyDialogProps {
  opened: boolean;
  col: TableViewCol | null;
  schema: Record<string, unknown> | null;
  onSave: (original: TableViewCol, updated: TableViewCol) => void;
  onClose: () => void;
}

export function EditPropertyDialog({ opened, col, schema, onSave, onClose }: EditPropertyDialogProps) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [readonly, setReadonly] = useState(false);
  const [subfields, setSubfields] = useState<TableViewCol['subfields']>(undefined);

  // Build a map of schema column definitions keyed by path (id).
  const colDefMap = useMemo(() => {
    if (!schema) return new Map<string, ColumnDefinition>();
    const defs = buildColumnDefinitions(schema);
    const map = new Map<string, ColumnDefinition>();
    for (const def of defs) map.set(def.id, def);
    return map;
  }, [schema]);

  // Reset form state when the dialog opens with a new column.
  useEffect(() => {
    if (opened && col) {
      setPath(col.path);
      setName(col.name ?? '');
      setType(col.type ?? '');
      setReadonly(col.readonly ?? false);
      setSubfields(col.subfields);
    }
  }, [opened, col]);

  const applySchemaDefaults = useCallback(
    (newPath: string) => {
      const colDef = colDefMap.get(newPath);
      if (colDef) {
        setName(colDef.displayName);
        setType(mapDataTypeToPropertyType(colDef.dataType, colDef.format) ?? '');
        setReadonly(colDef.attributes.readOnly);
      }
    },
    [colDefMap],
  );

  const handlePathBlur = useCallback(() => {
    applySchemaDefaults(path);
  }, [applySchemaDefaults, path]);

  const handleSave = useCallback(() => {
    if (!col) return;
    const updated: TableViewCol = {
      kind: 'col',
      path,
      name: name || undefined,
      type: (type as TablePropertyType) || undefined,
      readonly: readonly || undefined,
      subfields,
      hidden: col.hidden,
      selectedSubfield: col.selectedSubfield,
    };
    onSave(col, updated);
    onClose();
  }, [col, path, name, type, readonly, subfields, onSave, onClose]);

  return (
    <Modal opened={opened} onClose={onClose} title="Edit Column" size="sm">
      <Stack gap="sm">
        <TextInput label="Path" value={path} onChange={(e) => setPath(e.currentTarget.value)} onBlur={handlePathBlur} />
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Uses path as label when empty"
        />
        <NativeSelect label="Type" value={type} onChange={(e) => setType(e.currentTarget.value)} data={TYPE_OPTIONS} />
        <Checkbox label="Readonly" checked={readonly} onChange={(e) => setReadonly(e.currentTarget.checked)} />
        <Group justify="flex-end" mt="sm">
          <ButtonSecondaryGhost onClick={onClose}>Cancel</ButtonSecondaryGhost>
          <ButtonPrimarySolid onClick={handleSave}>Save</ButtonPrimarySolid>
        </Group>
      </Stack>
    </Modal>
  );
}
