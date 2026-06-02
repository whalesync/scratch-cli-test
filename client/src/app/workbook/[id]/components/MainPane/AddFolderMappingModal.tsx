'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import type { ComboboxItem } from '@mantine/core';
import { Group, Modal, Select, Stack, Text } from '@mantine/core';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';

interface FolderOption {
  id: string;
  name: string;
  path: string | null;
  connectorService: string | null;
}

interface AddFolderMappingModalProps {
  opened: boolean;
  onClose: () => void;
  onConfirm: (sourceId: string, destId: string) => void;
  allFolders: FolderOption[];
}

function buildGroupedOptions(folders: FolderOption[], excludeId: string | null) {
  const grouped: Record<string, { value: string; label: string; connectorService: string | null }[]> = {};
  const ungrouped: { value: string; label: string; connectorService: string | null }[] = [];

  for (const f of folders) {
    if (f.id === excludeId) continue;
    const item = { value: f.id, label: f.name, connectorService: f.connectorService };

    if (f.path) {
      const segments = f.path.split('/');
      // segments[0] is '' (before leading /), segments[1] is connector name — skip both
      const middle = segments.slice(2, -1);
      if (middle.length > 0) {
        const groupLabel = middle.join(' / ');
        (grouped[groupLabel] ??= []).push(item);
        continue;
      }
    }
    ungrouped.push(item);
  }

  const result: ({ group: string; items: typeof ungrouped } | (typeof ungrouped)[number])[] = [];
  if (ungrouped.length > 0) result.push(...ungrouped);
  for (const [group, items] of Object.entries(grouped)) {
    result.push({ group, items });
  }
  return result;
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
  const [prevOpened, setPrevOpened] = useState(opened);

  if (opened && !prevOpened) {
    setSourceId(null);
    setDestId(null);
  }
  if (opened !== prevOpened) {
    setPrevOpened(opened);
  }

  const getConnectorService = (id: string | null) => allFolders.find((f) => f.id === id)?.connectorService ?? null;

  const sourceConnectorService = getConnectorService(sourceId);
  const destConnectorService = getConnectorService(destId);

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
            data={buildGroupedOptions(allFolders, destId)}
            value={sourceId}
            onChange={setSourceId}
            renderOption={renderFolderOption}
            leftSection={
              sourceConnectorService ? <ConnectorIcon connector={sourceConnectorService} size={16} p={0} /> : undefined
            }
            searchable
          />
          <ArrowRight size={16} color="var(--mantine-color-dimmed)" style={{ marginBottom: 8, flexShrink: 0 }} />
          <Select
            label="Destination Folder"
            placeholder="Select destination"
            style={{ flex: 1 }}
            data={buildGroupedOptions(allFolders, sourceId)}
            value={destId}
            onChange={setDestId}
            renderOption={renderFolderOption}
            leftSection={
              destConnectorService ? <ConnectorIcon connector={destConnectorService} size={16} p={0} /> : undefined
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
