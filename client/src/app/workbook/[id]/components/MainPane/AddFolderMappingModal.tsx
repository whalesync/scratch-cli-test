'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import type { ComboboxItem } from '@mantine/core';
import { Group, Modal, Select, Stack, Text } from '@mantine/core';
import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';

interface FolderOption {
  id: string;
  name: string;
  connectorService: string | null;
}

interface AddFolderMappingModalProps {
  opened: boolean;
  onClose: () => void;
  onConfirm: (sourceId: string, destId: string) => void;
  allFolders: FolderOption[];
}

const renderFolderOption = ({ option }: { option: ComboboxItem & { connectorService?: string | null } }) => (
  <Group gap="xs" wrap="nowrap">
    {option.connectorService && <ConnectorIcon connector={option.connectorService} size={16} p={0} />}
    <Text size="sm">{option.label}</Text>
  </Group>
);

export function AddFolderMappingModal({ opened, onClose, onConfirm, allFolders }: AddFolderMappingModalProps) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [destId, setDestId] = useState<string | null>(null);

  useEffect(() => {
    if (opened) {
      setSourceId(null);
      setDestId(null);
    }
  }, [opened]);

  const getConnectorService = (id: string | null) => allFolders.find((f) => f.id === id)?.connectorService ?? null;

  const handleConfirm = () => {
    if (sourceId && destId) {
      onConfirm(sourceId, destId);
      onClose();
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Add a folder to sync" size="lg" centered>
      <Stack gap="lg" p="md">
        <Group align="flex-end" gap="sm" wrap="nowrap">
          <Select
            label="Source Folder"
            placeholder="Select source"
            style={{ flex: 1 }}
            data={allFolders
              .filter((f) => f.id !== destId)
              .map((f) => ({ value: f.id, label: f.name, connectorService: f.connectorService }))}
            value={sourceId}
            onChange={setSourceId}
            renderOption={renderFolderOption}
            leftSection={
              getConnectorService(sourceId) ? (
                <ConnectorIcon connector={getConnectorService(sourceId)!} size={16} p={0} />
              ) : undefined
            }
            searchable
          />
          <ArrowRight size={16} color="var(--mantine-color-dimmed)" style={{ marginBottom: 8, flexShrink: 0 }} />
          <Select
            label="Destination Folder"
            placeholder="Select destination"
            style={{ flex: 1 }}
            data={allFolders
              .filter((f) => f.id !== sourceId)
              .map((f) => ({ value: f.id, label: f.name, connectorService: f.connectorService }))}
            value={destId}
            onChange={setDestId}
            renderOption={renderFolderOption}
            leftSection={
              getConnectorService(destId) ? (
                <ConnectorIcon connector={getConnectorService(destId)!} size={16} p={0} />
              ) : undefined
            }
            searchable
          />
        </Group>

        <Group justify="flex-end" mt="md">
          <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
          <ButtonPrimaryLight onClick={handleConfirm} disabled={!sourceId || !destId}>
            Add mapping
          </ButtonPrimaryLight>
        </Group>
      </Stack>
    </Modal>
  );
}
