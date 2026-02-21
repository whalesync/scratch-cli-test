'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import type { ComboboxItem } from '@mantine/core';
import { Button, Checkbox, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import type { DataFolder, DataFolderId, TransformerConfig, TransformerType } from '@spinner/shared-types';
import { useEffect, useState } from 'react';

interface TransformerConfigModalProps {
  opened: boolean;
  onClose: () => void;
  currentConfig: TransformerConfig | undefined;
  onSave: (config: TransformerConfig | undefined) => void;
  allFolders: DataFolder[];
}

const TRANSFORMER_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'string_to_number', label: 'String to Number' },
  { value: 'source_fk_to_dest_fk', label: 'Foreign Key Lookup' },
  { value: 'lookup_field', label: 'Lookup Field' },
  { value: 'notion_to_html', label: 'Notion to HTML' },
];

export function TransformerConfigModal({
  opened,
  onClose,
  currentConfig,
  onSave,
  allFolders,
}: TransformerConfigModalProps) {
  const [type, setType] = useState<TransformerType | ''>(currentConfig?.type ?? '');
  const [stripCurrency, setStripCurrency] = useState(
    currentConfig?.type === 'string_to_number' ? (currentConfig.options?.stripCurrency ?? false) : false,
  );
  const [parseInteger, setParseInteger] = useState(
    currentConfig?.type === 'string_to_number' ? (currentConfig.options?.parseInteger ?? false) : false,
  );
  const [referencedDataFolderId, setReferencedDataFolderId] = useState<DataFolderId | ''>(
    currentConfig?.type === 'source_fk_to_dest_fk' || currentConfig?.type === 'lookup_field'
      ? currentConfig.options.referencedDataFolderId
      : '',
  );
  const [referencedFieldPath, setReferencedFieldPath] = useState(
    currentConfig?.type === 'lookup_field' ? currentConfig.options.referencedFieldPath : '',
  );

  // Sync form state whenever the modal opens
  useEffect(() => {
    if (opened) {
      setType(currentConfig?.type ?? '');
      setStripCurrency(
        currentConfig?.type === 'string_to_number' ? (currentConfig.options?.stripCurrency ?? false) : false,
      );
      setParseInteger(
        currentConfig?.type === 'string_to_number' ? (currentConfig.options?.parseInteger ?? false) : false,
      );
      setReferencedDataFolderId(
        currentConfig?.type === 'source_fk_to_dest_fk' || currentConfig?.type === 'lookup_field'
          ? currentConfig.options.referencedDataFolderId
          : ('' as DataFolderId | ''),
      );
      setReferencedFieldPath(currentConfig?.type === 'lookup_field' ? currentConfig.options.referencedFieldPath : '');
    }
  }, [opened, currentConfig]);

  const handleSave = () => {
    if (!type) {
      onSave(undefined);
      onClose();
      return;
    }

    let config: TransformerConfig;
    switch (type) {
      case 'string_to_number':
        config = { type, options: { stripCurrency, parseInteger } };
        break;
      case 'source_fk_to_dest_fk':
        config = { type, options: { referencedDataFolderId: referencedDataFolderId as DataFolderId } };
        break;
      case 'lookup_field':
        config = {
          type,
          options: { referencedDataFolderId: referencedDataFolderId as DataFolderId, referencedFieldPath },
        };
        break;
      case 'notion_to_html':
        config = { type };
        break;
      default:
        return;
    }

    onSave(config);
    onClose();
  };

  const folderSelectData = allFolders.map((f) => ({
    value: f.id,
    label: f.name,
    connectorService: f.connectorService,
  }));

  const renderFolderOption = ({ option }: { option: ComboboxItem & { connectorService?: string | null } }) => (
    <Group gap="xs" wrap="nowrap">
      {option.connectorService && <ConnectorIcon connector={option.connectorService} size={16} p={0} />}
      <Text size="sm">{option.label}</Text>
    </Group>
  );

  const isSaveDisabled =
    (type === 'source_fk_to_dest_fk' && !referencedDataFolderId) ||
    (type === 'lookup_field' && (!referencedDataFolderId || !referencedFieldPath));

  return (
    <Modal opened={opened} onClose={onClose} title="Configure Transformer" size="md">
      <Stack gap="md">
        <Select
          label="Transformer Type"
          data={TRANSFORMER_OPTIONS}
          value={type}
          onChange={(val) => setType((val as TransformerType) || '')}
        />

        {type === 'string_to_number' && (
          <Stack gap="xs">
            <Checkbox
              label="Strip currency symbols ($, €, £, etc.)"
              checked={stripCurrency}
              onChange={(e) => setStripCurrency(e.currentTarget.checked)}
            />
            <Checkbox
              label="Parse as integer (truncate decimals)"
              checked={parseInteger}
              onChange={(e) => setParseInteger(e.currentTarget.checked)}
            />
          </Stack>
        )}

        {type === 'source_fk_to_dest_fk' && (
          <Select
            label="Referenced Folder"
            description="The folder containing the records referenced by this foreign key"
            placeholder="Select folder"
            data={folderSelectData}
            value={referencedDataFolderId}
            onChange={(val) => setReferencedDataFolderId((val || '') as DataFolderId | '')}
            renderOption={renderFolderOption}
            searchable
          />
        )}

        {type === 'lookup_field' && (
          <>
            <Select
              label="Referenced Folder"
              description="The folder containing the records referenced by this foreign key"
              placeholder="Select folder"
              data={folderSelectData}
              value={referencedDataFolderId}
              onChange={(val) => setReferencedDataFolderId((val || '') as DataFolderId | '')}
              renderOption={renderFolderOption}
              searchable
            />
            <TextInput
              label="Field Path"
              description="The field to extract from the referenced record (e.g. 'name' or 'company.displayName')"
              placeholder="e.g. name"
              value={referencedFieldPath}
              onChange={(e) => setReferencedFieldPath(e.currentTarget.value)}
            />
          </>
        )}

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaveDisabled}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
