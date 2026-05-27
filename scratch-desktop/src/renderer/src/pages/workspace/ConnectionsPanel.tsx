import { ButtonSecondaryOutline } from '@/components/base/buttons';
import { Text16Medium } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, Group, Stack } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { PlusIcon, UnplugIcon } from 'lucide-react';
import { ConnectionsList } from './connections/connections-list';

interface ConnectionsPanelProps {
  workbookId: string;
  onDataRefresh?: () => void;
  newConnectionId?: string | null;
  onNewConnectionConsumed?: () => void;
}

export function ConnectionsPanel({
  workbookId,
  onDataRefresh,
  newConnectionId,
  onNewConnectionConsumed,
}: ConnectionsPanelProps) {
  const [createModalOpened, { open: openCreateModal, close: closeCreateModal }] = useDisclosure(false);

  return (
    <Stack
      gap={0}
      style={{
        flex: 1,
        minWidth: 0,
        backgroundColor: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Group
        style={{
          borderBottom: '0.5px solid var(--fg-divider)',
          flexShrink: 0,
        }}
        px={14}
        py={8}
        align="center"
        justify="space-between"
      >
        <Group gap={8} align="center">
          <StyledLucideIcon Icon={UnplugIcon} size={16} c="var(--fg-secondary)" />
          <Text16Medium c="var(--fg-primary)">Connections</Text16Medium>
        </Group>
        <ButtonSecondaryOutline
          size="xs"
          leftSection={<StyledLucideIcon Icon={PlusIcon} size="sm" />}
          onClick={openCreateModal}
        >
          Connect service
        </ButtonSecondaryOutline>
      </Group>

      {/* Content */}
      <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }} py="sm">
        <ConnectionsList
          workbookId={workbookId}
          createModalOpened={createModalOpened}
          onOpenCreateModal={openCreateModal}
          onCloseCreateModal={closeCreateModal}
          onDataRefresh={onDataRefresh}
          newConnectionId={newConnectionId}
          onNewConnectionConsumed={onNewConnectionConsumed}
        />
      </Box>
    </Stack>
  );
}
