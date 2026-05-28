import { Alert, Box, Center, Group, Loader, Modal, Stack, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import logoUrl from '../assets/logo-color.svg';
import { ButtonPrimaryLight, ButtonSecondaryGhost } from '../components/base/buttons';
import { Text12Medium, Text12Regular, Text13Regular, TextTitle1 } from '../components/base/text';
import { useConfirmModal } from '../components/ConfirmModal';
import { StyledLucideIcon } from '../components/icons/StyledLucideIcon';
import { ServerConnectionSplash } from '../components/ServerConnectionSplash';
import { UserMenu } from '../components/user-menu';
import {
  CloudWorkspaceCard,
  DownloadedWorkspaceCard,
  DownloadingWorkspaceCard,
  PendingWorkspaceCard,
} from '../components/WorkspaceCard';
import { useWorkspaces } from '../hooks/use-workspaces';
import {
  trackCancelPickParentFolder,
  trackCreateWorkspace,
  trackDownloadWorkspace,
  trackOpenWorkspace,
  trackRemoveLocalWorkspace,
} from '../lib/posthog';
import { Workspace } from '../types/workspace';

function getLocalSectionLabel(): string {
  const platform = window.electron?.process?.platform;
  return platform === 'darwin' ? 'On my Mac' : 'On this PC';
}

function getTrashName(): string {
  return window.electron?.process?.platform === 'win32' ? 'Recycle Bin' : 'Trash';
}

function getEnvironmentLabel(): string | null {
  const webUrl = (import.meta.env.VITE_SCRATCH_WEB_URL as string) || '';
  if (webUrl.includes('localhost')) return 'Dev';
  if (webUrl.includes('test.scratch.md')) return 'Test';
  return null;
}

function ZeroState({ onCreate }: { onCreate: () => void }) {
  return (
    <Box
      style={{
        position: 'relative',
        height: '100%',
        minHeight: 480,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        overflow: 'hidden',
      }}
    >
      <Stack align="center" gap="md" maw={420} style={{ textAlign: 'center', position: 'relative' }}>
        <Box
          style={{
            width: 96,
            height: 96,
            borderRadius: 22,
            background: 'var(--highlight-fill)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 6px 20px rgba(11,107,79,.18)',
            marginBottom: 8,
          }}
        >
          <img src={logoUrl} alt="Scratch" width={56} height={56} />
        </Box>
        <TextTitle1>Create your first workspace</TextTitle1>
        <Text13Regular c="dimmed">A workspace is a home for your synced folders and files.</Text13Regular>
        <ButtonPrimaryLight
          size="md"
          mt="sm"
          leftSection={<StyledLucideIcon Icon={Plus} size="sm" />}
          onClick={onCreate}
        >
          Create workspace
        </ButtonPrimaryLight>
      </Stack>
    </Box>
  );
}

function SectionLabel({ children, count }: { children: React.ReactNode; count: number }) {
  return (
    <Group gap={6} mt="md" mb={4} px={2}>
      <Text12Medium c="var(--fg-muted)" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {children}
      </Text12Medium>
      <Text12Regular c="var(--fg-muted)" style={{ opacity: 0.7 }}>
        · {count.toLocaleString()}
      </Text12Regular>
    </Group>
  );
}

function EmptySectionPlaceholder({ children, dense }: { children: React.ReactNode; dense?: boolean }) {
  return (
    <Box
      style={{
        border: '1px dashed var(--mantine-color-gray-3)',
        borderRadius: 10,
        padding: dense ? 12 : 18,
        textAlign: 'center',
        background: 'var(--bg-base)',
        marginBottom: 4,
        fontSize: dense ? 11 : undefined,
      }}
    >
      <Text12Regular c="var(--fg-muted)" style={dense ? { fontSize: 11 } : undefined}>
        {children}
      </Text12Regular>
    </Box>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const { localWorkspaces, remoteWorkspaces, loading, error, isConnectionError, fetchWorkspaces } = useWorkspaces();

  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void window.scratchDesktop.getAppVersion().then(setAppVersion);
  }, []);

  const homeFocusBootAtRef = useRef(performance.now());
  useEffect(() => {
    homeFocusBootAtRef.current = performance.now();
  }, []);

  useEffect(() => {
    const handleWindowFocus = (): void => {
      if (performance.now() - homeFocusBootAtRef.current < 1500) {
        return;
      }
      void fetchWorkspaces({ silent: true });
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [fetchWorkspaces]);

  // Track in-flight downloads keyed by workspace id so the card can transform in place.
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const { confirm, confirmModal } = useConfirmModal();

  const startDownload = useCallback(
    async (workspace: Workspace) => {
      try {
        const parentFolder = await window.scratchDesktop.pickParentFolder();
        if (!parentFolder) {
          void trackCancelPickParentFolder(workspace.id, 'download');
          return;
        }

        void trackDownloadWorkspace(workspace.id);
        setDownloadingIds((prev) => new Set(prev).add(workspace.id));
        await window.scratchDesktop.initWorkspace(workspace.id, parentFolder);
        void window.scratchPreferences.setCurrentWorkspaceId(workspace.id);
        void navigate(`/workspace/${workspace.id}`);
      } catch (err) {
        notifications.show({
          title: 'Download failed',
          message: err instanceof Error ? err.message : 'Failed to download workspace',
          color: 'red',
        });
      } finally {
        setDownloadingIds((prev) => {
          const next = new Set(prev);
          next.delete(workspace.id);
          return next;
        });
      }
    },
    [navigate],
  );

  const handleOpen = useCallback(
    (workspace: Workspace) => {
      void trackOpenWorkspace(workspace.id);
      void window.scratchPreferences.setCurrentWorkspaceId(workspace.id);
      void navigate(`/workspace/${workspace.id}`);
    },
    [navigate],
  );

  const handleRemove = useCallback(
    async (workspace: Workspace) => {
      const trashName = getTrashName();
      const confirmed = await confirm(
        `The local copy will be moved to the ${trashName}. The remote workspace will stay — you can re-download it later.`,
        { title: 'Remove local copy', confirmLabel: `Move to ${trashName}` },
      );
      if (!confirmed) return;
      void trackRemoveLocalWorkspace(workspace.id);
      setRemovingIds((prev) => new Set(prev).add(workspace.id));
      try {
        await window.scratchDesktop.removeWorkspace(workspace.id);
        notifications.show({
          title: 'Local copy removed',
          message: `${workspace.name || 'Workspace'} moved back to the cloud.`,
          color: 'green',
        });
        void fetchWorkspaces();
      } catch (err) {
        notifications.show({
          title: 'Remove failed',
          message: err instanceof Error ? err.message : 'Failed to remove local copy',
          color: 'red',
        });
      } finally {
        setRemovingIds((prev) => {
          const next = new Set(prev);
          next.delete(workspace.id);
          return next;
        });
      }
    },
    [confirm, fetchWorkspaces],
  );

  // Create-workspace modal
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleCreateContinue = useCallback(async () => {
    const name = newWorkspaceName.trim();
    if (!name) return;
    try {
      setCreating(true);
      setCreateError(null);
      const result = await window.scratchDesktop.createWorkspace(name);
      void trackCreateWorkspace(result.id);
      const parentFolder = await window.scratchDesktop.pickParentFolder();
      if (!parentFolder) {
        void trackCancelPickParentFolder(result.id, 'create');
        setCreateError('A local folder is required to set up the workspace.');
        return;
      }
      await window.scratchDesktop.initWorkspace(result.id, parentFolder);
      void window.scratchPreferences.setCurrentWorkspaceId(result.id);
      setCreateModalOpen(false);
      setNewWorkspaceName('');
      void navigate(`/workspace/${result.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setCreating(false);
    }
  }, [newWorkspaceName, navigate]);

  const visibleLocal = localWorkspaces;
  const visibleCloud = useMemo(
    () => remoteWorkspaces.filter((w) => !visibleLocal.some((l) => l.id === w.id)),
    [remoteWorkspaces, visibleLocal],
  );

  if (loading) {
    return (
      <Center h="100%">
        <Loader size="sm" />
      </Center>
    );
  }
  if (isConnectionError) return <ServerConnectionSplash />;
  if (error) {
    return (
      <Stack p="xl">
        <Alert color="red" title="Error">
          {error}
        </Alert>
      </Stack>
    );
  }

  const localLabel = getLocalSectionLabel();
  const showZeroState = visibleLocal.length === 0 && visibleCloud.length === 0;
  const openCreateModal = () => {
    setNewWorkspaceName('');
    setCreateError(null);
    setCreateModalOpen(true);
  };

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {confirmModal}
      <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {showZeroState ? (
          <ZeroState onCreate={openCreateModal} />
        ) : (
          <Stack px="xl" pb="xl" gap={0} w="100%" maw={{ base: '100%', md: '60%' }} mx="auto">
            <Group pt="xl" pb="md" justify="space-between" style={{ flexShrink: 0 }}>
              <TextTitle1>Your Workspaces</TextTitle1>
              <ButtonPrimaryLight
                leftSection={<StyledLucideIcon Icon={Plus} size="sm" />}
                size="sm"
                onClick={openCreateModal}
              >
                New Workspace
              </ButtonPrimaryLight>
            </Group>

            <SectionLabel count={visibleLocal.length}>{localLabel}</SectionLabel>
            {visibleLocal.length === 0 ? (
              <EmptySectionPlaceholder>Nothing downloaded yet. Pick one below to get started.</EmptySectionPlaceholder>
            ) : (
              visibleLocal.map((ws) =>
                removingIds.has(ws.id) ? (
                  <PendingWorkspaceCard key={ws.id} workspace={ws} label="Removing…" color="gray" />
                ) : downloadingIds.has(ws.id) ? (
                  <DownloadingWorkspaceCard key={ws.id} workspace={ws} label="Downloading…" />
                ) : (
                  <DownloadedWorkspaceCard
                    key={ws.id}
                    workspace={ws}
                    onOpen={() => handleOpen(ws)}
                    onRemove={() => void handleRemove(ws)}
                  />
                ),
              )
            )}

            <SectionLabel count={visibleCloud.length}>In the cloud</SectionLabel>
            {visibleCloud.length === 0 ? (
              <EmptySectionPlaceholder dense>You&apos;ve downloaded everything.</EmptySectionPlaceholder>
            ) : (
              <Box
                style={{
                  border: '1px dashed var(--mantine-color-gray-4)',
                  borderRadius: 10,
                  background: '#fbfbf9',
                  overflow: 'hidden',
                }}
              >
                {visibleCloud.map((ws, i) =>
                  downloadingIds.has(ws.id) ? (
                    <DownloadingWorkspaceCard key={ws.id} workspace={ws} inGroup label="Downloading…" />
                  ) : (
                    <CloudWorkspaceCard
                      key={ws.id}
                      workspace={ws}
                      onDownload={() => void startDownload(ws)}
                      inGroup
                      isFirst={i === 0}
                    />
                  ),
                )}
              </Box>
            )}
          </Stack>
        )}
      </Box>

      <Group
        h={40}
        px="md"
        justify="space-between"
        style={{ flexShrink: 0, borderTop: '1px solid var(--mantine-color-default-border)' }}
      >
        <UserMenu />
        {appVersion && (
          <Text12Regular c="dimmed">
            {getEnvironmentLabel() ? `${getEnvironmentLabel()} v${appVersion}` : `v${appVersion}`}
          </Text12Regular>
        )}
      </Group>

      <Modal
        opened={createModalOpen}
        onClose={() => !creating && setCreateModalOpen(false)}
        title="New workspace"
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
            <Text12Regular c="dimmed">Give it a name. You&apos;ll pick a download location next.</Text12Regular>
            <TextInput
              label="Name"
              placeholder="My workspace"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newWorkspaceName.trim()) {
                  void handleCreateContinue();
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
              <ButtonSecondaryGhost onClick={() => setCreateModalOpen(false)}>Cancel</ButtonSecondaryGhost>
              <ButtonPrimaryLight onClick={() => void handleCreateContinue()} disabled={!newWorkspaceName.trim()}>
                Continue →
              </ButtonPrimaryLight>
            </Group>
          </Stack>
        )}
      </Modal>
    </Box>
  );
}
