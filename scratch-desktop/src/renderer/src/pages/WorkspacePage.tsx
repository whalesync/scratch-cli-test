import { Alert, Box, Center, Loader, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ServerConnectionSplash } from '../components/ServerConnectionSplash';
import { isServerConnectionError } from '../lib/is-server-connection-error';
import { listLocalWorkspaces } from '../lib/local-workspaces';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';
import { PublishChangesModal } from './workspace/PublishChangesModal';
import { PullAllModal } from './workspace/PullAllModal';
import { WorkspaceContent } from './workspace/WorkspaceContent';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishFilePath, setPublishFilePath] = useState<string | null>(null);
  const [pullAllModalOpen, setPullAllModalOpen] = useState(false);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [dataRefreshKey, setDataRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState(false);

  const fetchWorkspace = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      setConnectionError(false);
      const [data, localWorkspaces] = await Promise.all([workspacesApi.detail(id), listLocalWorkspaces()]);
      const localWorkspace = localWorkspaces.find((entry) => entry.id === id) ?? null;
      setWorkspace(data);
      setLocalPath(localWorkspace?.path ?? null);
    } catch (err) {
      if (isServerConnectionError(err)) {
        setConnectionError(true);
        setError(null);
      } else {
        setConnectionError(false);
        setError(err instanceof Error ? err.message : 'Failed to load workspace');
      }
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
      notifications.show({
        title: 'Local copy deleted',
        message: `${workspace.name || 'Workspace'} was removed from this machine.`,
        color: 'green',
      });
      void navigate('/');
    } catch (err) {
      notifications.show({
        title: 'Delete failed',
        message: err instanceof Error ? err.message : 'Failed to remove local workspace',
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  }, [workspace, navigate]);

  const handleDataRefresh = useCallback(() => {
    setDataRefreshKey((current) => current + 1);
  }, []);

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

  if (connectionError) {
    return <ServerConnectionSplash />;
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
      <PublishChangesModal
        opened={publishModalOpen}
        onClose={() => {
          setPublishModalOpen(false);
          setPublishFilePath(null);
        }}
        workspaceName={workspace.name}
        localPath={localPath}
        onDataRefresh={handleDataRefresh}
        filterPath={publishFilePath}
      />
      <PullAllModal
        opened={pullAllModalOpen}
        onClose={() => setPullAllModalOpen(false)}
        workspaceName={workspace.name}
        localPath={localPath}
        onDataRefresh={handleDataRefresh}
      />
      <WorkspaceHeader
        workspace={workspace}
        localPath={localPath}
        selectedFolderPath={selectedFolderPath}
        isDownloaded={localPath !== null}
        downloading={downloading}
        onDownload={() => void handleDownload()}
        deleting={deleting}
        onDelete={() => void handleDelete()}
        onPublishAll={() => setPublishModalOpen(true)}
        onPullAll={() => setPullAllModalOpen(true)}
      />
      <WorkspaceContent
        workspace={workspace}
        localPath={localPath}
        selectedFolderPath={selectedFolderPath}
        onSelectFolder={setSelectedFolderPath}
        dataRefreshKey={dataRefreshKey}
        onPublishFile={(relativePath: string) => {
          setPublishFilePath(relativePath);
          setPublishModalOpen(true);
        }}
      />
    </Box>
  );
}
