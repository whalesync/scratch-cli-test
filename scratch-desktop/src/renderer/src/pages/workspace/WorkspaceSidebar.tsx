import { ButtonPrimaryLight } from '@/components/base/buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '@/components/base/text';
import { Badge, Box, Group, Loader, Stack, UnstyledButton } from '@mantine/core';
import { Workspace } from '@spinner/shared-types';
import {
  BugIcon,
  CheckIcon,
  CircleXIcon,
  LinkIcon,
  LucideIcon,
  PlugZapIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from 'lucide-react';
import { JSX, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ReviewStat } from '../../../../shared/review-types';
import type { ValidationStat } from '../../../../shared/validation-types';
import { UserMenu } from '../../components/user-menu';
import { useCurrentUser } from '../../hooks/use-current-user';
import { useDevTools } from '../../hooks/use-dev-tools';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import type { WorkspaceConnection } from '../../types/local-files';
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
  invalidateWorkspaceLevelData: () => void;
  onOpenConnectionsPanel?: () => void;
  connectionsPanelOpen?: boolean;
  onTogglePublishHistoryPanel?: () => void;
  publishHistoryPanelOpen?: boolean;
  onToggleValidationPanel?: () => void;
  validationPanelOpen?: boolean;
  validationStats?: ValidationStat[];
  reviewStats?: ReviewStat[];
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
  invalidateWorkspaceLevelData,
  onOpenConnectionsPanel,
  connectionsPanelOpen,
  onTogglePublishHistoryPanel,
  publishHistoryPanelOpen,
  onToggleValidationPanel,
  validationPanelOpen,
  validationStats,
  reviewStats,
}: WorkspaceSidebarProps) {
  const navigate = useNavigate();
  const { isDevToolsEnabled } = useDevTools();
  const { user } = useCurrentUser();
  const validateEnabled = useWorkspaceUiStore((s) => s.validateEnabled);
  const publishHistoryEnabled = true; // isExperimentEnabled('ENABLE_PUBLISH_HISTORY', user);
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

  // Parallel lookup map for review-state counts (powers the blue "Needs review"
  // and gray "Approved" folder-tree dots). Same `connection/folder_path` key
  // shape as `validationByFolder` so FolderTree can look both maps up with the
  // same `node.folder.name` key.
  const reviewByFolder = useMemo(() => {
    const map = new Map<string, { unreviewed: number; approved: number }>();
    if (reviewStats) {
      for (const s of reviewStats) {
        map.set(`${s.connection}/${s.folder_path}`, { unreviewed: s.unreviewed, approved: s.approved });
      }
    }
    return map;
  }, [reviewStats]);

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
      <Box style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }} py="xs">
        {showInitialLoader ? (
          <Group justify="center" align="center" gap="sm">
            <Loader size="xs" />
            <Text12Regular c="dimmed" ta="center">
              Loading folders…
            </Text12Regular>
          </Group>
        ) : (
          <>
            {localFolders.length === 0 && !connectionsPanelOpen && (
              <Stack align="center" justify="center" gap="sm" px="md" style={{ flex: 1, minHeight: 0 }}>
                <PlugZapIcon size={48} strokeWidth={1} />
                <Stack align="center" gap={4}>
                  <Text13Medium c="var(--fg-primary)">Your workspace is ready</Text13Medium>
                  <Text12Regular c="var(--fg-muted)" ta="center" maw={220} lh={1.4}>
                    Connect a service to pull your data into Scratch.
                  </Text12Regular>
                </Stack>
                <ButtonPrimaryLight
                  size="sm"
                  mt={4}
                  leftSection={<LinkIcon size={14} />}
                  onClick={onOpenConnectionsPanel}
                >
                  Connect service
                </ButtonPrimaryLight>
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
              invalidateWorkspaceLevelData={invalidateWorkspaceLevelData}
              validationByFolder={validateEnabled ? validationByFolder : undefined}
              reviewByFolder={reviewByFolder}
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
        {onOpenConnectionsPanel && (
          <MenuButton
            title="Connections"
            Icon={UnplugIcon}
            isSelected={connectionsPanelOpen}
            onClick={onOpenConnectionsPanel}
          />
        )}

        {onToggleValidationPanel && (
          <MenuButton
            title="Validation"
            Icon={ShieldCheckIcon}
            isSelected={validationPanelOpen}
            onClick={onToggleValidationPanel}
            rightLabel={
              !validateEnabled ? (
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
              )
            }
          />
        )}

        {/* Render only after user is loaded so the button doesn't flicker.
            Matches the "Connections (local UI)" toggle pattern: click swaps
            the central content area between the folder grid and the panel. */}
        {user && publishHistoryEnabled && onTogglePublishHistoryPanel && (
          <MenuButton
            title="Publish History"
            Icon={ScrollTextIcon}
            isSelected={publishHistoryPanelOpen}
            onClick={onTogglePublishHistoryPanel}
          />
        )}

        {isDevToolsEnabled && (
          <MenuButton
            devOnly
            onClick={() => void navigate(`/workspace/${workspace.id}/debug`)}
            Icon={BugIcon}
            title="Debug"
          />
        )}
        <UserMenu />
      </Box>
    </Stack>
  );
}

function MenuButton({
  title,
  onClick,
  Icon,
  isSelected,
  devOnly,
  rightLabel,
}: {
  title: string;
  onClick: () => void;
  Icon: LucideIcon;
  isSelected?: boolean;
  devOnly?: boolean;
  rightLabel?: JSX.Element;
}) {
  return (
    <UnstyledButton
      px="sm"
      py={8}
      w="100%"
      bg={isSelected ? 'var(--highlight-fill)' : undefined}
      c={devOnly ? 'var(--mantine-color-devTool-9)' : 'var(--fg-secondary)'}
      onClick={onClick}
    >
      <Group gap={8} wrap="nowrap" justify="space-between">
        <Icon size={14} />
        <Text13Regular flex={1}>{title}</Text13Regular>
        {rightLabel}
      </Group>
    </UnstyledButton>
  );
}
