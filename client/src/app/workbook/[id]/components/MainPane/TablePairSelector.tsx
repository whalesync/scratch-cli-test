import { Text12Regular, Text13Medium } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Badge, Group, Menu, UnstyledButton } from '@mantine/core';
import { ChevronDown, Plus } from 'lucide-react';

interface FolderPairSummary {
  id: string;
  sourceId: string;
  destId: string;
  fieldMappingCount: number;
}

interface TablePairSelectorProps {
  folderPairs: FolderPairSummary[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onAddPair: () => void;
  getFolderName: (id: string) => string;
}

export function TablePairSelector({
  folderPairs,
  selectedIndex,
  onSelect,
  onAddPair,
  getFolderName,
}: TablePairSelectorProps) {
  const activePair = folderPairs[selectedIndex];

  const getPairLabel = (pair: FolderPairSummary) => {
    if (pair.sourceId && pair.destId) {
      return `${getFolderName(pair.sourceId)} \u2192 ${getFolderName(pair.destId)}`;
    }
    const blankCount = folderPairs.filter((p) => !p.sourceId || !p.destId).length;
    return blankCount > 1 ? `New folder mapping ${folderPairs.indexOf(pair) + 1}` : 'New folder mapping';
  };

  const validMappingCount = activePair?.fieldMappingCount ?? 0;

  return (
    <Menu position="bottom-start" withinPortal>
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
          }}
        >
          <Text12Regular c="dimmed">FOLDERS</Text12Regular>
          <Text13Medium>{activePair ? getPairLabel(activePair) : 'Select table'}</Text13Medium>
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
                <Text13Medium style={{ flex: 1 }}>{getPairLabel(pair)}</Text13Medium>
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
