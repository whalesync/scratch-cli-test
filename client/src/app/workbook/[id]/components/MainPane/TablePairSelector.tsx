import { Text12Regular, Text13Medium } from '@/app/components/base/text';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Badge, Group, Menu, UnstyledButton } from '@mantine/core';
import { ArrowRight, ChevronDown, Plus } from 'lucide-react';

interface FolderPairSummary {
  id: string;
  sourceId: string;
  destId: string;
  fieldMappingCount: number;
  sourceConnectorService?: string | null;
  destConnectorService?: string | null;
}

interface TablePairSelectorProps {
  folderPairs: FolderPairSummary[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onAddPair: () => void;
  getFolderName: (id: string) => string;
}

function FolderLabel({ name, connectorService }: { name: string; connectorService?: string | null }) {
  return (
    <Group gap={4} wrap="nowrap">
      {connectorService && <ConnectorIcon connector={connectorService} size={16} p={0} />}
      <Text13Medium>{name}</Text13Medium>
    </Group>
  );
}

export function TablePairSelector({
  folderPairs,
  selectedIndex,
  onSelect,
  onAddPair,
  getFolderName,
}: TablePairSelectorProps) {
  const activePair = folderPairs[selectedIndex];

  const validMappingCount = activePair?.fieldMappingCount ?? 0;

  return (
    <Menu position="bottom-start" withinPortal width="target">
      <Menu.Target>
        <UnstyledButton
          px="sm"
          py={6}
          style={{
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 'var(--mantine-radius-sm)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 400,
          }}
        >
          <Text12Regular c="dimmed">FOLDERS</Text12Regular>
          {activePair && activePair.sourceId && activePair.destId ? (
            <Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
              <FolderLabel
                name={getFolderName(activePair.sourceId)}
                connectorService={activePair.sourceConnectorService}
              />
              <ArrowRight size={14} color="var(--mantine-color-dimmed)" />
              <FolderLabel name={getFolderName(activePair.destId)} connectorService={activePair.destConnectorService} />
            </Group>
          ) : (
            <Text13Medium style={{ flex: 1 }}>{activePair ? 'New folder mapping' : 'Select table'}</Text13Medium>
          )}
          {validMappingCount > 0 && (
            <Badge size="xs" variant="light" color="blue">
              {validMappingCount}
            </Badge>
          )}
          <StyledLucideIcon Icon={ChevronDown} size="sm" c="dimmed" />
        </UnstyledButton>
      </Menu.Target>

      <Menu.Dropdown>
        {folderPairs.map((pair, index) => {
          const mappingCount = pair.fieldMappingCount;
          return (
            <Menu.Item
              key={pair.id}
              onClick={() => onSelect(index)}
              bg={index === selectedIndex ? 'var(--mantine-color-blue-light)' : undefined}
            >
              <Group gap="sm" wrap="nowrap">
                {pair.sourceId && pair.destId ? (
                  <Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
                    <FolderLabel name={getFolderName(pair.sourceId)} connectorService={pair.sourceConnectorService} />
                    <ArrowRight size={14} color="var(--mantine-color-dimmed)" />
                    <FolderLabel name={getFolderName(pair.destId)} connectorService={pair.destConnectorService} />
                  </Group>
                ) : (
                  <Text13Medium style={{ flex: 1 }}>New folder mapping</Text13Medium>
                )}
                {mappingCount > 0 && (
                  <Badge size="xs" variant="light" color="blue">
                    {mappingCount}
                  </Badge>
                )}
              </Group>
            </Menu.Item>
          );
        })}
        <Menu.Divider />
        <Menu.Item leftSection={<StyledLucideIcon Icon={Plus} size="sm" />} onClick={onAddPair}>
          Add folder mapping
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
