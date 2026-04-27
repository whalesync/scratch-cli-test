import { ButtonSecondaryOutline } from '@/components/base/buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, Group, Loader, Stack, UnstyledButton } from '@mantine/core';
import { Bug, LinkIcon, Settings, SettingsIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../../components/user-menu';
import { useDevTools } from '../../hooks/use-dev-tools';
import type { WorkspaceConnection } from '../../types/local-files';
import { Workspace } from '../../types/workspace';
import { FolderTree } from './FolderTree';
import { LocalFolder } from './WorkspaceContent';

interface WorkspaceSidebarProps {
  workspace: Workspace;
  workspaceConnections: WorkspaceConnection[];
  localFolders: LocalFolder[];
  isFoldersLoading: boolean;
  hasLoadedFoldersOnce: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  selectedFolderPath: string | null;
  onSelectFolder: (folderPath: string) => void;
  workspacePath: string | null;
  onDataRefresh: () => void;
}

export function WorkspaceSidebar({
  workspace,
  workspaceConnections,
  localFolders,
  isFoldersLoading,
  hasLoadedFoldersOnce,
  width,
  minWidth,
  maxWidth,
  selectedFolderPath,
  onSelectFolder,
  workspacePath,
  onDataRefresh,
}: WorkspaceSidebarProps) {
  const navigate = useNavigate();
  const { isDevToolsEnabled } = useDevTools();
  const showInitialLoader = isFoldersLoading && !hasLoadedFoldersOnce;

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
        {showInitialLoader ? (
          <Group justify="center" align="center" gap="sm">
            <Loader size="xs" />
            <Text12Regular c="dimmed" ta="center">
              Loading folders…
            </Text12Regular>
          </Group>
        ) : (
          <>
            {localFolders.length === 0 && (
              <Stack align="center" gap="xs" px="sm" py="xl">
                <Box style={{ opacity: 0.3 }}>
                  <StyledLucideIcon Icon={LinkIcon} size="lg" c="var(--fg-muted)" />
                </Box>
                <Text13Medium c="var(--fg-primary)">No connections yet</Text13Medium>
                <Text12Regular c="var(--fg-secondary)" ta="center" maw={200}>
                  Connect a service to see your data.
                </Text12Regular>
                <ButtonSecondaryOutline
                  size="xs"
                  mt={4}
                  leftSection={<StyledLucideIcon Icon={SettingsIcon} size="sm" />}
                  onClick={() => {
                    const webUrl = (import.meta.env.VITE_SCRATCH_WEB_URL as string) || 'http://localhost:3000';
                    void window.scratchAuth.openExternal(`${webUrl}/workspace/${workspace.id}/connections`);
                  }}
                >
                  Manage connections
                </ButtonSecondaryOutline>
              </Stack>
            )}
            <FolderTree
              workspaceId={workspace.id}
              dataFolders={workspace.dataFolders ?? []}
              workspaceConnections={workspaceConnections}
              localFolders={localFolders}
              selectedFolderPath={selectedFolderPath}
              onSelectFolder={onSelectFolder}
              workspacePath={workspacePath}
              isDevToolsEnabled={isDevToolsEnabled}
              onDataRefresh={onDataRefresh}
            />
          </>
        )}
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
          onClick={() => {
            const webUrl = (import.meta.env.VITE_SCRATCH_WEB_URL as string) || 'http://localhost:3000';
            void window.scratchAuth.openExternal(`${webUrl}/workspace/${workspace.id}/connections`);
          }}
        >
          <Group gap={8} wrap="nowrap">
            <Settings size={14} color="var(--fg-secondary)" />
            <Text13Regular c="var(--fg-secondary)">Manage Connections</Text13Regular>
          </Group>
        </UnstyledButton>

        {isDevToolsEnabled && (
          <UnstyledButton
            px="sm"
            py={8}
            style={{
              width: '100%',
            }}
            onClick={() => void navigate(`/workspace/${workspace.id}/debug`)}
          >
            <Group gap={8} wrap="nowrap">
              <Bug size={14} color="var(--mantine-color-devTool-9)" />
              <Text13Regular c="var(--mantine-color-devTool-9)">Debug</Text13Regular>
            </Group>
          </UnstyledButton>
        )}

        <UserMenu />
      </Box>
    </Stack>
  );
}
