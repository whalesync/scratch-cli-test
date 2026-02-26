'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import type { ComboboxItem } from '@mantine/core';
import { Button, Checkbox, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import type { DataFolder, DataFolderId, TransformerConfig, TransformerType } from '@spinner/shared-types';
import { TRANSFORMER_TYPES, TransformerTypes } from '@spinner/shared-types';
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
  ...TRANSFORMER_TYPES.map((t) => ({ value: t.type, label: t.label })),
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
    currentConfig?.type === TransformerTypes.StringToNumber ? (currentConfig.options?.stripCurrency ?? false) : false,
  );
  const [parseInteger, setParseInteger] = useState(
    currentConfig?.type === TransformerTypes.StringToNumber ? (currentConfig.options?.parseInteger ?? false) : false,
  );
  const [referencedDataFolderId, setReferencedDataFolderId] = useState<DataFolderId | ''>(
    currentConfig?.type === TransformerTypes.SourceFkToDestFk || currentConfig?.type === TransformerTypes.LookupField
      ? currentConfig.options.referencedDataFolderId
      : '',
  );
  const [referencedFieldPath, setReferencedFieldPath] = useState(
    currentConfig?.type === TransformerTypes.LookupField ? currentConfig.options.referencedFieldPath : '',
  );

  // Sync form state whenever the modal opens
  useEffect(() => {
    if (opened) {
      setType(currentConfig?.type ?? '');
      setStripCurrency(
        currentConfig?.type === TransformerTypes.StringToNumber
          ? (currentConfig.options?.stripCurrency ?? false)
          : false,
      );
      setParseInteger(
        currentConfig?.type === TransformerTypes.StringToNumber
          ? (currentConfig.options?.parseInteger ?? false)
          : false,
      );
      setReferencedDataFolderId(
        currentConfig?.type === TransformerTypes.SourceFkToDestFk ||
          currentConfig?.type === TransformerTypes.LookupField
          ? currentConfig.options.referencedDataFolderId
          : ('' as DataFolderId | ''),
      );
      setReferencedFieldPath(
        currentConfig?.type === TransformerTypes.LookupField ? currentConfig.options.referencedFieldPath : '',
      );
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
      case TransformerTypes.StringToNumber:
        config = { type, options: { stripCurrency, parseInteger } };
        break;
      case TransformerTypes.SourceFkToDestFk:
        config = { type, options: { referencedDataFolderId: referencedDataFolderId as DataFolderId } };
        break;
      case TransformerTypes.LookupField:
        config = {
          type,
          options: { referencedDataFolderId: referencedDataFolderId as DataFolderId, referencedFieldPath },
        };
        break;
      case TransformerTypes.NotionToHtml:
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
    (type === TransformerTypes.SourceFkToDestFk && !referencedDataFolderId) ||
    (type === TransformerTypes.LookupField && (!referencedDataFolderId || !referencedFieldPath));

  return (
    <Modal opened={opened} onClose={onClose} title="Configure Transformer" size="md">
      <Stack gap="md">
        <Select
          label="Transformer Type"
          data={TRANSFORMER_OPTIONS}
          value={type}
          onChange={(val) => setType((val as TransformerType) || '')}
        />

        {type === TransformerTypes.StringToNumber && (
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

        {type === TransformerTypes.SourceFkToDestFk && (
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

        {type === TransformerTypes.LookupField && (
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
