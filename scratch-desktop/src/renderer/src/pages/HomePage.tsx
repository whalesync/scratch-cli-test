import { Alert, Box, Center, Divider, Group, Loader, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ButtonPrimaryLight, ButtonSecondaryOutline } from '../components/base/buttons';
import { UserMenu } from '../components/user-menu';
import { WorkspaceCard } from '../components/WorkspaceCard';
import { listLocalWorkspaces } from '../lib/local-workspaces';
import { logPerf } from '../lib/perf';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';

export function HomePage() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [downloadedWorkspaceIds, setDownloadedWorkspaceIds] = useState<Set<string>>(new Set());
  const [localFileCountById, setLocalFileCountById] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchWorkspaces = useCallback(async () => {
    const start = performance.now();
    try {
      setLoading(true);
      setError(null);
      const [data, localWorkspaces] = await Promise.all([workspacesApi.list(), listLocalWorkspaces()]);
      setWorkspaces(data);
      setDownloadedWorkspaceIds(new Set(localWorkspaces.map((workspace) => workspace.id)));
      setLocalFileCountById(new Map(localWorkspaces.map((w) => [w.id, w.fileCount])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    } finally {
      logPerf('homePage fetchWorkspaces', performance.now() - start);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleCreateWorkspace = useCallback(async () => {
    const name = newWorkspaceName.trim();
    if (!name) return;
    try {
      setCreating(true);
      setCreateError(null);
      const result = await window.scratchDesktop.createWorkspace(name);
      const parentFolder = await window.scratchDesktop.pickParentFolder();
      if (!parentFolder) {
        setCreateError('A local folder is required to set up the workspace.');
        return;
      }
      await window.scratchDesktop.initWorkspace(result.id, parentFolder);
      setCreateModalOpen(false);
      setNewWorkspaceName('');
      void navigate(`/workspace/${result.id}`);
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setCreating(false);
    }
  }, [newWorkspaceName, navigate]);

  const handleDownloadAndOpen = useCallback(
    async (workspace: Workspace) => {
      try {
        const parentFolder = await window.scratchDesktop.pickParentFolder();
        if (!parentFolder) return;

        await window.scratchDesktop.initWorkspace(workspace.id, parentFolder);
        notifications.show({
          title: 'Download complete',
          message: `${workspace.name || 'Workspace'} is now available locally.`,
          color: 'green',
        });
        void navigate(`/workspace/${workspace.id}`);
      } catch (err) {
        notifications.show({
          title: 'Download failed',
          message: err instanceof Error ? err.message : 'Failed to download workspace',
          color: 'red',
        });
      }
    },
    [navigate],
  );

  const localWorkspaces = useMemo(
    () => workspaces.filter((ws) => downloadedWorkspaceIds.has(ws.id)),
    [workspaces, downloadedWorkspaceIds],
  );
  const remoteWorkspaces = useMemo(
    () => workspaces.filter((ws) => !downloadedWorkspaceIds.has(ws.id)),
    [workspaces, downloadedWorkspaceIds],
  );

  if (loading) {
    return (
      <Center h="100%">
        <Loader size="sm" />
      </Center>
    );
  }

  if (error) {
    return (
      <Stack p="xl">
        <Alert color="red" title="Error">
          {error}
        </Alert>
      </Stack>
    );
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Stack px="xl" pb="xl" gap="md" w="100%" maw={{ base: '100%', md: '60%' }} mx="auto">
          <Group pt="xl" pb="md" justify="space-between" style={{ flexShrink: 0 }}>
            <Title order={2}>Your Workspaces</Title>
            <ButtonPrimaryLight
              leftSection={<Plus size={12} />}
              size="xs"
              onClick={() => {
                setNewWorkspaceName('');
                setCreateError(null);
                setCreateModalOpen(true);
              }}
            >
              New Workspace
            </ButtonPrimaryLight>
          </Group>
          {workspaces.length === 0 ? (
            <Text c="dimmed">No workspaces found.</Text>
          ) : (
            <>
              {localWorkspaces.map((ws) => (
                <WorkspaceCard key={ws.id} workspace={ws} isDownloaded localFileCount={localFileCountById.get(ws.id)} />
              ))}
              {localWorkspaces.length > 0 && remoteWorkspaces.length > 0 && <Divider />}
              {remoteWorkspaces.map((ws) => (
                <WorkspaceCard
                  key={ws.id}
                  workspace={ws}
                  isDownloaded={false}
                  onClick={() => void handleDownloadAndOpen(ws)}
                />
              ))}
            </>
          )}
        </Stack>
      </Box>

      <Group
        h={40}
        px="md"
        justify="flex-start"
        style={{ flexShrink: 0, borderTop: '1px solid var(--mantine-color-default-border)' }}
      >
        <UserMenu />
      </Group>

      <Modal
        opened={createModalOpen}
        onClose={() => !creating && setCreateModalOpen(false)}
        title={creating ? 'Creating Workspace...' : 'New Workspace'}
        size="sm"
        closeOnClickOutside={!creating}
        closeOnEscape={!creating}
        withCloseButton={!creating}
        centered
      >
        {creating ? (
          <Center py="xl">
            <Loader size="sm" />
          </Center>
        ) : (
          <Stack gap="md">
            <TextInput
              label="Workspace name"
              placeholder="My Workspace"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newWorkspaceName.trim()) {
                  void handleCreateWorkspace();
                }
              }}
              autoFocus
            />
            {createError && (
              <Alert color="red" title="Error">
                {createError}
              </Alert>
            )}
            <Group justify="flex-end">
              <ButtonSecondaryOutline onClick={() => setCreateModalOpen(false)}>Cancel</ButtonSecondaryOutline>
              <ButtonPrimaryLight onClick={() => void handleCreateWorkspace()} disabled={!newWorkspaceName.trim()}>
                Create
              </ButtonPrimaryLight>
            </Group>
          </Stack>
        )}
      </Modal>
    </Box>
  );
}
