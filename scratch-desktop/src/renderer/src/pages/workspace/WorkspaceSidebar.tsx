import { ButtonSecondaryOutline } from '@/components/base/buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Badge, Box, Group, Loader, Stack, UnstyledButton } from '@mantine/core';
import {
  Bug,
  CheckIcon,
  CircleXIcon,
  LinkIcon,
  ScrollTextIcon,
  Settings,
  SettingsIcon,
  ShieldCheck,
  TriangleAlertIcon,
  UnplugIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ValidationStat } from '../../../../shared/validation-types';
import { UserMenu } from '../../components/user-menu';
import { useCurrentUser } from '../../hooks/use-current-user';
import { useDevTools } from '../../hooks/use-dev-tools';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import type { WorkspaceConnection } from '../../types/local-files';
import { isExperimentEnabled } from '../../types/user';
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
  onOpenConnectionsPanel?: () => void;
  connectionsPanelOpen?: boolean;
  onTogglePublishHistoryPanel?: () => void;
  publishHistoryPanelOpen?: boolean;
  onToggleValidationPanel?: () => void;
  validationPanelOpen?: boolean;
  validationStats?: ValidationStat[];
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
  onOpenConnectionsPanel,
  connectionsPanelOpen,
  onTogglePublishHistoryPanel,
  publishHistoryPanelOpen,
  onToggleValidationPanel,
  validationPanelOpen,
  validationStats,
}: WorkspaceSidebarProps) {
  const navigate = useNavigate();
  const { isDevToolsEnabled } = useDevTools();
  const { user } = useCurrentUser();
  const validateEnabled = useWorkspaceUiStore((s) => s.validateEnabled);
  const publishHistoryEnabled = isExperimentEnabled('ENABLE_PUBLISH_HISTORY', user);
  const showInitialLoader = isFoldersLoading && !hasLoadedFoldersOnce;

  // Build a lookup map for validation counts keyed by "connection/folder_path".
  const validationByFolder = useMemo(() => {
    const map = new Map<string, { errors: number; warnings: number }>();
    if (validationStats) {
      for (const s of validationStats) {
        map.set(`${s.connection}/${s.folder_path}`, { errors: s.errors, warnings: s.warnings });
      }
    }
    return map;
  }, [validationStats]);

  const totalErrors = validationStats?.reduce((sum, s) => sum + s.errors, 0) ?? 0;
  const totalWarnings = validationStats?.reduce((sum, s) => sum + s.warnings, 0) ?? 0;

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
              validationByFolder={validateEnabled ? validationByFolder : undefined}
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
            <Text13Regular c="var(--fg-secondary)">Manage connections</Text13Regular>
          </Group>
        </UnstyledButton>

        {/* Render only after user is loaded so the button doesn't flicker.
            Matches the "Connections (local UI)" toggle pattern: click swaps
            the central content area between the folder grid and the panel. */}
        {user && publishHistoryEnabled && onTogglePublishHistoryPanel && (
          <UnstyledButton
            px="sm"
            py={8}
            style={{
              width: '100%',
              backgroundColor: publishHistoryPanelOpen ? 'var(--highlight-fill)' : undefined,
            }}
            onClick={onTogglePublishHistoryPanel}
          >
            <Group gap={8} wrap="nowrap">
              <ScrollTextIcon size={14} color="var(--fg-secondary)" />
              <Text13Regular c="var(--fg-secondary)">Publish History</Text13Regular>
            </Group>
          </UnstyledButton>
        )}

        {onToggleValidationPanel && (
          <UnstyledButton
            px="sm"
            py={8}
            style={{
              width: '100%',
              backgroundColor: validationPanelOpen ? 'var(--highlight-fill)' : undefined,
            }}
            onClick={onToggleValidationPanel}
          >
            <Group gap={8} wrap="nowrap" justify="space-between" style={{ flex: 1 }}>
              <Group gap={8} wrap="nowrap">
                <ShieldCheck size={14} color="var(--fg-secondary)" />
                <Text13Regular c="var(--fg-secondary)">Validation</Text13Regular>
              </Group>
              {!validateEnabled ? (
                <Badge size="xs" variant="light" color="gray" radius="sm">
                  off
                </Badge>
              ) : totalErrors === 0 && totalWarnings === 0 ? (
                <CheckIcon size={14} color="var(--mantine-color-green-6)" strokeWidth={1.5} />
              ) : (
                <Group gap={6} wrap="nowrap">
                  {totalErrors > 0 && (
                    <Group gap={2} wrap="nowrap">
                      <CircleXIcon size={12} color="var(--mantine-color-red-6)" strokeWidth={1.5} />
                      <Text12Regular c="var(--mantine-color-red-6)">{totalErrors}</Text12Regular>
                    </Group>
                  )}
                  {totalWarnings > 0 && (
                    <Group gap={2} wrap="nowrap">
                      <TriangleAlertIcon size={12} color="var(--mantine-color-orange-6)" strokeWidth={1.5} />
                      <Text12Regular c="var(--mantine-color-orange-6)">{totalWarnings}</Text12Regular>
                    </Group>
                  )}
                </Group>
              )}
            </Group>
          </UnstyledButton>
        )}

        {isDevToolsEnabled && onOpenConnectionsPanel && (
          <UnstyledButton
            px="sm"
            py={8}
            style={{
              width: '100%',
              backgroundColor: connectionsPanelOpen ? 'var(--highlight-fill)' : undefined,
            }}
            onClick={onOpenConnectionsPanel}
          >
            <Group gap={8} wrap="nowrap">
              <UnplugIcon size={14} color="var(--mantine-color-violet-6)" />
              <Text13Regular c="var(--mantine-color-violet-6)">Connections (local UI)</Text13Regular>
            </Group>
          </UnstyledButton>
        )}

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
