import { Alert, Box, Center, Divider, Group, Loader, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ButtonPrimaryLight, ButtonSecondaryOutline } from '../components/base/buttons';
import { Text12Regular } from '../components/base/text';
import { UserMenu } from '../components/user-menu';
import { WorkspaceCard } from '../components/WorkspaceCard';
import { useWorkspaces } from '../hooks/use-workspaces';

export function HomePage() {
  const navigate = useNavigate();
  const {
    localWorkspaces,
    remoteWorkspaces,
    localFileCountById,
    localPathById,
    loading,
    error,
    handleDownloadAndOpen,
  } = useWorkspaces();

  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    const fetchVersion = async (): Promise<void> => {
      const version = await window.scratchDesktop.getAppVersion();
      setAppVersion(version);
    };
    void fetchVersion();
  }, []);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
          {localWorkspaces.length === 0 && remoteWorkspaces.length === 0 ? (
            <Text c="dimmed">No workspaces found.</Text>
          ) : (
            <>
              {localWorkspaces.map((ws) => (
                <WorkspaceCard
                  key={ws.id}
                  workspace={ws}
                  isDownloaded
                  localFileCount={localFileCountById.get(ws.id)}
                  localPath={localPathById.get(ws.id)}
                />
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
        justify="space-between"
        style={{ flexShrink: 0, borderTop: '1px solid var(--mantine-color-default-border)' }}
      >
        <UserMenu />
        {appVersion && <Text12Regular c="dimmed">v{appVersion}</Text12Regular>}
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
