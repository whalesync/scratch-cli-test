import { Box, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { Bug, Folder, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../../components/user-menu';
import { Workspace } from '../../types/workspace';

interface WorkspaceSidebarProps {
  workspace: Workspace;
  width: number;
  minWidth: number;
  maxWidth: number;
}

export function WorkspaceSidebar({ workspace, width, minWidth, maxWidth }: WorkspaceSidebarProps) {
  const navigate = useNavigate();
  const folders = workspace.dataFolders ?? [];

  return (
    <Stack
      gap={0}
      style={{
        width,
        minWidth,
        maxWidth,
        backgroundColor: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {/* Folder tree */}
      <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }} py="xs">
        {folders.length === 0 && (
          <Text size="xs" c="dimmed" px="sm" py="xs">
            No connections yet
          </Text>
        )}
        {folders.map((folder) => (
          <UnstyledButton
            key={folder.id}
            px="sm"
            py={6}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Folder size={14} color="var(--fg-secondary)" />
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" c="var(--fg-primary)" truncate>
                {folder.path || '/'}
              </Text>
              {folder.connectorDisplayName && (
                <Text size="xs" c="dimmed" truncate>
                  {folder.connectorDisplayName}
                </Text>
              )}
            </Box>
          </UnstyledButton>
        ))}
      </Box>

      {/* Footer */}
      <Box
        py="xs"
        style={{
          borderTop: '1px solid var(--fg-divider)',
          flexShrink: 0,
        }}
      >
        <UnstyledButton
          px="sm"
          py={8}
          style={{
            width: '100%',
          }}
        >
          <Group gap={8} wrap="nowrap">
            <Settings size={14} color="var(--fg-secondary)" />
            <Text size="sm" c="var(--fg-secondary)">
              Manage Connections
            </Text>
          </Group>
        </UnstyledButton>

        <UnstyledButton
          px="sm"
          py={8}
          style={{
            width: '100%',
          }}
          onClick={() => void navigate(`/workspace/${workspace.id}/debug`)}
        >
          <Group gap={8} wrap="nowrap">
            <Bug size={14} color="var(--fg-secondary)" />
            <Text size="sm" c="var(--fg-secondary)">
              Debug
            </Text>
          </Group>
        </UnstyledButton>

        <UserMenu />
      </Box>
    </Stack>
  );
}
