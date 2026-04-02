import { Alert, Box, Center, Loader, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { listLocalWorkspaces } from '../lib/local-workspaces';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';
import { WorkspaceContent } from './workspace/WorkspaceContent';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

  const handleDownload = useCallback(async () => {
    if (!workspace) return;

    try {
      setDownloading(true);
      const parentFolder = await window.scratchDesktop.pickParentFolder();
      if (!parentFolder) return;

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
    if (!workspace) return;

    const confirmed = window.confirm(
      'This will remove the local files only. The remote repo and remote workspace will stay. Continue?',
    );
    if (!confirmed) return;

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

  return (
    <Box h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
      <WorkspaceHeader
        workspace={workspace}
        isDownloaded={localPath !== null}
        downloading={downloading}
        onDownload={handleDownload}
        deleting={deleting}
        onDelete={handleDelete}
      />
      <WorkspaceContent workspace={workspace} localPath={localPath} />
    </Box>
  );
}
