import { Text13Medium } from '@/components/base/text';
import { useWorkspaces } from '@/hooks/use-workspaces';
import { Badge, Box, Loader, Menu, ScrollArea } from '@mantine/core';
import { Workspace } from '@spinner/shared-types';
import { ChevronDown, HardDriveDownload as DownloadIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { trackOpenWorkspace } from '../lib/posthog';

interface WorkspaceSwitcherProps {
  currentWorkspaceId: string;
  currentWorkspaceName: string | null;
}

export function WorkspaceSwitcher({ currentWorkspaceId, currentWorkspaceName }: WorkspaceSwitcherProps) {
  const navigate = useNavigate();
  const { localWorkspaces, remoteWorkspaces, downloadedWorkspaceIds, loading, handleDownloadAndOpen } = useWorkspaces();

  const handleSelect = (workspace: Workspace) => {
    if (workspace.id === currentWorkspaceId) return;
    if (downloadedWorkspaceIds.has(workspace.id)) {
      void trackOpenWorkspace(workspace.id);
      void navigate(`/workspace/${workspace.id}`);
    } else {
      void handleDownloadAndOpen(workspace);
    }
  };

  return (
    <Menu shadow="md" width={280} position="bottom-start">
      <Menu.Target>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <Text13Medium>{currentWorkspaceName || 'Untitled Workspace'}</Text13Medium>
          <ChevronDown size={14} color="var(--fg-muted)" />
        </Box>
      </Menu.Target>
      <Menu.Dropdown>
        {loading ? (
          <Box p="sm" style={{ display: 'flex', justifyContent: 'center' }}>
            <Loader size="xs" />
          </Box>
        ) : (
          <ScrollArea.Autosize mah={400}>
            {localWorkspaces.map((ws) => (
              <Menu.Item
                key={ws.id}
                onClick={() => handleSelect(ws)}
                bg={ws.id === currentWorkspaceId ? 'var(--highlight-fill)' : undefined}
                rightSection={
                  ws.id === currentWorkspaceId ? (
                    <Badge size="xs" color="yellow" variant="light">
                      Current
                    </Badge>
                  ) : null
                }
              >
                <Text13Medium lineClamp={1}>{ws.name || 'Untitled Workspace'}</Text13Medium>
              </Menu.Item>
            ))}
            {localWorkspaces.length > 0 && remoteWorkspaces.length > 0 && <Menu.Divider />}
            {remoteWorkspaces.map((ws) => (
              <Menu.Item
                key={ws.id}
                onClick={() => handleSelect(ws)}
                rightSection={<DownloadIcon size={14} color="var(--fg-muted)" />}
              >
                <Text13Medium lineClamp={1} c="dimmed">
                  {ws.name || 'Untitled Workspace'}
                </Text13Medium>
              </Menu.Item>
            ))}
            {localWorkspaces.length === 0 && remoteWorkspaces.length === 0 && (
              <Box p="sm">
                <Text13Medium c="dimmed">No workspaces found</Text13Medium>
              </Box>
            )}
          </ScrollArea.Autosize>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
