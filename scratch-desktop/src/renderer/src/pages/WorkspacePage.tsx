import { ActionIcon, Alert, Box, Button, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { listLocalWorkspaces } from '../lib/local-workspaces';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkspace = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      const [data, localWorkspaces] = await Promise.all([workspacesApi.detail(id), listLocalWorkspaces()]);
      const localWorkspace = localWorkspaces.find((entry) => entry.id === id) ?? null;
      setWorkspace(data);
      setLocalPath(localWorkspace?.path ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const handleDownloadRecords = useCallback(async () => {
    if (!workspace) {
      return;
    }

    try {
      setDownloading(true);
      const parentFolder = await window.scratchDesktop.pickParentFolder();
      if (!parentFolder) {
        return;
      }

      await window.scratchDesktop.initWorkspace(workspace.id, parentFolder);
      const localWorkspaces = await listLocalWorkspaces();
      const localWorkspace = localWorkspaces.find((entry) => entry.id === workspace.id) ?? null;
      setLocalPath(localWorkspace?.path ?? null);
      notifications.show({
        title: 'Download complete',
        message: `${workspace.name || 'Workspace'} is now available locally.`,
        color: 'green',
      });
    } catch (err) {
      notifications.show({
        title: 'Download failed',
        message: err instanceof Error ? err.message : 'Failed to download records',
        color: 'red',
      });
    } finally {
      setDownloading(false);
    }
  }, [workspace]);

  const handleDelete = useCallback(async () => {
    if (!workspace) {
      return;
    }

    const confirmed = window.confirm(
      'This will remove the local files only. The remote repo and remote workspace will stay. Continue?',
    );
    if (!confirmed) {
      return;
    }

    try {
      setDeleting(true);
      await window.scratchDesktop.removeWorkspace(workspace.id);
      setLocalPath(null);
      notifications.show({
        title: 'Local copy deleted',
        message: `${workspace.name || 'Workspace'} was removed from this machine.`,
        color: 'green',
      });
    } catch (err) {
      notifications.show({
        title: 'Delete failed',
        message: err instanceof Error ? err.message : 'Failed to remove local workspace',
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  }, [workspace]);

  const handlePushChanges = useCallback(async () => {
    if (!workspace || !localPath) {
      return;
    }

    try {
      setPushing(true);
      await window.scratchDesktop.pushWorkspaceChanges(localPath);
      notifications.show({
        title: 'Push complete',
        message: `${workspace.name || 'Workspace'} changes were uploaded.`,
        color: 'green',
      });
    } catch (err) {
      notifications.show({
        title: 'Push failed',
        message: err instanceof Error ? err.message : 'Failed to push changes',
        color: 'red',
      });
    } finally {
      setPushing(false);
    }
  }, [localPath, workspace]);

  useEffect(() => {
    void fetchWorkspace();
  }, [fetchWorkspace]);

  if (loading) {
    return (
      <Center h="100%">
        <Loader size="sm" />
      </Center>
    );
  }

  if (error || !workspace) {
    return (
      <Stack p="xl">
        <Alert color="red" title="Error">
          {error || 'Workspace not found'}
        </Alert>
      </Stack>
    );
  }

  const folderCount = workspace.dataFolders?.length ?? 0;

  return (
    <Stack p="xl" gap="lg">
      <Group gap="sm">
        <ActionIcon variant="subtle" onClick={() => void navigate('/')}>
          <ArrowLeft size={18} />
        </ActionIcon>
        <Title order={2}>{workspace.name || 'Untitled Workspace'}</Title>
      </Group>

      <Group justify="space-between" align="flex-start">
        <Box>
          <Text size="sm" c="dimmed">
            Local copy: {localPath ? `Downloaded at ${localPath}` : 'Not downloaded'}
          </Text>
        </Box>

        {!localPath && (
          <Button onClick={() => void handleDownloadRecords()} loading={downloading}>
            Download
          </Button>
        )}

        {localPath && (
          <Group>
            <Button onClick={() => void handlePushChanges()} loading={pushing}>
              Push changes
            </Button>
            <Button color="red" variant="light" onClick={() => void handleDelete()} loading={deleting}>
              Delete
            </Button>
          </Group>
        )}
      </Group>

      <Box>
        <Text size="sm" c="dimmed">
          ID: {workspace.id}
        </Text>
        <Text size="sm" c="dimmed">
          Created: {new Date(workspace.createdAt).toLocaleDateString()}
        </Text>
        <Text size="sm" c="dimmed">
          Folders: {folderCount}
        </Text>
      </Box>

      {folderCount > 0 && (
        <Stack gap="xs">
          <Title order={4}>Data Folders</Title>
          {workspace.dataFolders?.map((df) => (
            <Group key={df.id} gap="xs">
              <Text size="sm" ff="monospace">
                {df.path || '/'}
              </Text>
              <Text size="xs" c="dimmed">
                {df.name}
              </Text>
              {df.connectorDisplayName && (
                <Text size="xs" c="dimmed">
                  ({df.connectorDisplayName})
                </Text>
              )}
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
