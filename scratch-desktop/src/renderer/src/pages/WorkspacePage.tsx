import { Alert, Box, Center, Group, Loader, Modal, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ButtonPrimaryLight } from '../components/base/buttons';
import { Text13Regular, TextMono12Regular } from '../components/base/text';
import { ServerConnectionSplash } from '../components/ServerConnectionSplash';
import { API_CONFIG } from '../lib/api';
import { isServerConnectionError } from '../lib/is-server-connection-error';
import { jobApi } from '../lib/job-api';
import { listLocalWorkspaces } from '../lib/local-workspaces';
import { parentDirectoryPath } from '../lib/parent-path';
import { trackPublishAll, trackPullAll, trackRedownloadWorkspace } from '../lib/posthog';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';
import { PublishChangesModal } from './workspace/PublishChangesModal';
import { PullAllModal } from './workspace/PullAllModal';
import { PullInProgressModal } from './workspace/PullInProgressModal';
import { WorkspaceContent } from './workspace/WorkspaceContent';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';

function isNoConnectionsScratchmdError(message: string): boolean {
  return message.toLowerCase().includes('no connections found');
}

const FOCUS_SYNC_THROTTLE_MS = 10_000;

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [reDownloading, setReDownloading] = useState(false);
  const [localWorkspaceMissingModalOpen, setLocalWorkspaceMissingModalOpen] = useState(false);

  /** Last known local path after a successful registry sync; used to detect “had local → missing” on refresh. */
  const previousLocalPathRef = useRef<string | null>(null);

  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishFilePath, setPublishFilePath] = useState<string | null>(null);
  const [pullAllModalOpen, setPullAllModalOpen] = useState(false);
  const [pullInProgressModalOpen, setPullInProgressModalOpen] = useState(false);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [dataRefreshKey, setDataRefreshKey] = useState(0);
  const [watchingEnabled, setWatchingEnabled] = useState(true);
  const [validateEnabled, setValidateEnabled] = useState(false);
  const [gridFilterActivation, setGridFilterActivation] = useState<{
    kind: 'has-problems';
    trigger: number;
  } | null>(null);
  const gridFilterTriggerRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  // Non-null while a folder index is being rebuilt; drives the blocking modal that
  // prevents the user from triggering a second parallel reindex by switching folders.
  const [indexingProgress, setIndexingProgress] = useState<string | null>(null);

  const focusSyncBootAtRef = useRef(0);
  const lastFocusSyncAtRef = useRef(0);
  const previousFolderCountRef = useRef<number | null>(null);
  const previousConnectionCountRef = useRef<number | null>(null);
  const selectedFolderPathRef = useRef(selectedFolderPath);
  selectedFolderPathRef.current = selectedFolderPath;

  const fetchWorkspace = useCallback(
    async (options?: {
      silent?: boolean;
    }): Promise<
      | {
          localPath: string | null;
          serverDataFolderCount: number;
          connectionCount: number;
          hasPullLock: boolean;
        }
      | undefined
    > => {
      if (!id) {
        return undefined;
      }
      const silent = options?.silent ?? false;
      try {
        if (!silent) {
          setLoading(true);
          setError(null);
          setConnectionError(false);
        }
        const [data, localWorkspaces] = await Promise.all([workspacesApi.detail(id), listLocalWorkspaces()]);
        const localWorkspace = localWorkspaces.find((entry) => entry.id === id) ?? null;
        const nextLocalPath = localWorkspace?.path ?? null;

        if (previousLocalPathRef.current !== null && nextLocalPath === null) {
          setLocalWorkspaceMissingModalOpen(true);
        }
        previousLocalPathRef.current = nextLocalPath;

        setWorkspace(data);
        setLocalPath(nextLocalPath);
        const uniqueConnections = new Set((data.dataFolders ?? []).map((f) => f.connectorAccountId).filter(Boolean));
        return {
          localPath: nextLocalPath,
          serverDataFolderCount: data.dataFolders?.length ?? 0,
          connectionCount: uniqueConnections.size,
          hasPullLock: (data.dataFolders ?? []).some((f) => f.lock === 'pull'),
        };
      } catch (err) {
        if (!silent) {
          if (isServerConnectionError(err)) {
            setConnectionError(true);
            setError(null);
          } else {
            setConnectionError(false);
            setError(err instanceof Error ? err.message : 'Failed to load workspace');
          }
        } else {
          console.debug('[workspace] silent fetchWorkspace failed:', err);
        }
        return undefined;
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [id],
  );

  const handleDownload = useCallback(async () => {
    if (!workspace) return;

    try {
      setDownloading(true);
      const parentFolder = await window.scratchDesktop.pickParentFolder();
      if (!parentFolder) return;

      await window.scratchDesktop.initWorkspace(workspace.id, parentFolder);
      const localWorkspaces = await listLocalWorkspaces();
      const localWorkspace = localWorkspaces.find((entry) => entry.id === workspace.id) ?? null;
      const nextPath = localWorkspace?.path ?? null;
      setLocalPath(nextPath);
      previousLocalPathRef.current = nextPath;
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

  const handleDataRefresh = useCallback(() => {
    setDataRefreshKey((current) => current + 1);
  }, []);

  const handleToggleWatching = useCallback(async () => {
    if (!localPath) return;
    const next = !watchingEnabled;
    setWatchingEnabled(next);
    if (next) {
      const watched = await window.scratchDesktop.watchWorkspaceFiles(localPath);
      const folderNames = watched.map((p) => p.replace(localPath + '/', '')).join(', ');
      notifications.show({
        message: `Watching on${folderNames ? `: ${folderNames}` : ''}`,
        color: 'blue',
      });
    } else {
      await window.scratchDesktop.clearWorkspaceFileWatch();
      notifications.show({ message: 'Watching off', color: 'orange' });
    }
  }, [localPath, watchingEnabled]);

  const handleReDownload = useCallback(async () => {
    if (!localPath || reDownloading) return;
    try {
      setReDownloading(true);
      if (id) void trackRedownloadWorkspace(id);
      await window.scratchDesktop.pullWorkspaceChanges(localPath, { onDelete: 'keep' });
      handleDataRefresh();
      notifications.show({
        title: 'Workspace updated',
        message: 'Re-downloaded the latest file updates from Scratch.',
        color: 'green',
      });
    } catch (err) {
      notifications.show({
        title: 'Re-download failed',
        message: err instanceof Error ? err.message : 'Failed to re-download workspace files',
        color: 'red',
      });
    } finally {
      setReDownloading(false);
    }
  }, [handleDataRefresh, id, localPath, reDownloading]);

  useEffect(() => {
    focusSyncBootAtRef.current = performance.now();
  }, [id]);

  useEffect(() => {
    void fetchWorkspace().then((snapshot) => {
      if (snapshot) {
        previousFolderCountRef.current = snapshot.serverDataFolderCount;
        previousConnectionCountRef.current = snapshot.connectionCount;
      }
    });
  }, [fetchWorkspace]);

  const workspaceId = workspace?.id;

  useEffect(() => {
    if (!id || !workspaceId || workspaceId !== id) {
      return;
    }

    const handleWindowFocus = (): void => {
      const now = performance.now();
      if (now - focusSyncBootAtRef.current < 1500) {
        return;
      }
      if (now - lastFocusSyncAtRef.current < FOCUS_SYNC_THROTTLE_MS) {
        return;
      }
      lastFocusSyncAtRef.current = now;
      void (async () => {
        const snapshot = await fetchWorkspace({ silent: true });
        if (!snapshot?.localPath) {
          return;
        }

        // If a pull lock exists, verify there are actual active jobs before showing the modal.
        // Pull locks can be stale (job finished but lock wasn't cleared).
        if (snapshot.hasPullLock) {
          try {
            const activeJobs = await jobApi.getActiveJobs(workspaceId);
            const activePullJobs = activeJobs.filter(
              (j) => j.type === 'RefreshRecords' || j.type === 'pull-linked-folder-files',
            );
            if (activePullJobs.length > 0) {
              setPullInProgressModalOpen(true);
              return;
            }
          } catch {
            // If we can't check jobs, skip the modal rather than showing a false positive
          }
        }

        // Only pull when the server's folder or connection shape has actually changed.
        const prevFolderCount = previousFolderCountRef.current;
        const prevConnectionCount = previousConnectionCountRef.current;
        const folderCountChanged = prevFolderCount !== null && prevFolderCount !== snapshot.serverDataFolderCount;
        const connectionCountChanged = prevConnectionCount !== null && prevConnectionCount !== snapshot.connectionCount;
        previousFolderCountRef.current = snapshot.serverDataFolderCount;
        previousConnectionCountRef.current = snapshot.connectionCount;

        if (!folderCountChanged && !connectionCountChanged) {
          handleDataRefresh();
          return;
        }

        try {
          await window.scratchDesktop.pullWorkspaceChanges(snapshot.localPath, { onDelete: 'remove' });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isNoConnectionsScratchmdError(message) && snapshot.serverDataFolderCount > 0) {
            try {
              const parentDir = parentDirectoryPath(snapshot.localPath);
              await window.scratchDesktop.initWorkspace(workspaceId, parentDir, { force: true });
              const localWorkspaces = await listLocalWorkspaces();
              const pathAfterInit = localWorkspaces.find((entry) => entry.id === id)?.path ?? snapshot.localPath;
              setLocalPath(pathAfterInit);
              await window.scratchDesktop.pullWorkspaceChanges(pathAfterInit);
            } catch (recoveryErr) {
              console.debug('[workspace] focus sync recovery failed:', recoveryErr);
            }
          } else {
            console.debug('[workspace] focus pull failed:', err);
          }
        }
        handleDataRefresh();
      })();
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [id, workspaceId, fetchWorkspace, handleDataRefresh]);

  useEffect(() => {
    API_CONFIG.setActiveWorkspacePath(localPath);
    if (localPath) {
      window.scratchDesktop.logSession(localPath, 'start');
    }
    return () => {
      if (localPath) {
        window.scratchDesktop.logSession(localPath, 'end');
      }
      API_CONFIG.setActiveWorkspacePath(null);
    };
  }, [localPath]);

  useEffect(() => {
    if (!localPath || !watchingEnabled) {
      void window.scratchDesktop.clearWorkspaceFileWatch();
      return;
    }
    const unsubscribe = window.scratchDesktop.onWorkspaceFilesChanged((event) => {
      if (event.workspacePath !== localPath) return;
      if (event.source !== 'external') return;
      const currentFolder = selectedFolderPathRef.current;
      const affectedFolder = event.singleFile ? parentDirectoryPath(event.singleFile) : null;
      const changedFolders = affectedFolder ? [affectedFolder] : event.changedFolderPaths;
      if (currentFolder && changedFolders.some((f) => f === currentFolder)) {
        handleDataRefresh();
      }
    });
    void window.scratchDesktop.watchWorkspaceFiles(localPath).catch((error: unknown) => {
      console.debug('[workspace] failed to start workspace file watch:', error);
    });
    return () => {
      unsubscribe();
      void window.scratchDesktop.clearWorkspaceFileWatch();
    };
  }, [handleDataRefresh, localPath, watchingEnabled]);

  useEffect(() => {
    if (!localPath || !watchingEnabled) return;
    void window.scratchDesktop.watchWorkspaceFiles(localPath).catch((error: unknown) => {
      console.debug('[workspace] failed to reconcile workspace file watch roots:', error);
    });
  }, [dataRefreshKey, localPath, watchingEnabled]);

  // TODO: re-enable problem index preparation
  // useEffect(() => {
  //   if (!localPath || preparedIndexPathRef.current === localPath) return;
  //   preparedIndexPathRef.current = localPath;
  //   void window.scratchDesktop.prepareWorkspaceIndex(localPath).catch((error: unknown) => {
  //     preparedIndexPathRef.current = null;
  //     console.warn('[workspace] failed to prepare workspace index:', error);
  //   });
  // }, [localPath]);

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
      <Modal
        opened={indexingProgress !== null}
        onClose={() => undefined}
        title="Building folder index"
        centered
        closeOnClickOutside={false}
        closeOnEscape={false}
        withCloseButton={false}
      >
        <Stack gap="md">
          <Group gap="sm" wrap="nowrap">
            <Loader size="sm" />
            <Text13Regular c="dimmed">
              Rebuilding the index for this folder. This usually takes a few seconds.
            </Text13Regular>
          </Group>
          {indexingProgress && <TextMono12Regular c="dimmed">{indexingProgress}</TextMono12Regular>}
        </Stack>
      </Modal>
      <Modal
        opened={localWorkspaceMissingModalOpen}
        onClose={() => undefined}
        title="Local workspace not found"
        centered
        closeOnClickOutside={false}
        closeOnEscape={false}
        withCloseButton={false}
      >
        <Stack gap="md">
          <Text13Regular c="dimmed">
            The local workspace folder could not be found. It may have been moved or deleted outside Scratch.
          </Text13Regular>
          <ButtonPrimaryLight fullWidth onClick={() => void navigate('/')}>
            Return to dashboard
          </ButtonPrimaryLight>
        </Stack>
      </Modal>
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
        currentFolderPath={selectedFolderPath}
        onViewProblems={(folderPath) => {
          setPublishModalOpen(false);
          setPublishFilePath(null);
          setSelectedFolderPath(folderPath);
          gridFilterTriggerRef.current += 1;
          setGridFilterActivation({ kind: 'has-problems', trigger: gridFilterTriggerRef.current });
        }}
      />
      <PullAllModal
        opened={pullAllModalOpen}
        onClose={() => setPullAllModalOpen(false)}
        workspaceName={workspace.name}
        localPath={localPath}
        workspaceId={workspace.id}
        onDataRefresh={handleDataRefresh}
      />
      {localPath && (
        <PullInProgressModal
          opened={pullInProgressModalOpen}
          onClose={() => setPullInProgressModalOpen(false)}
          workbookId={workspace.id}
          localPath={localPath}
          onDataRefresh={handleDataRefresh}
        />
      )}
      <WorkspaceHeader
        workspace={workspace}
        localPath={localPath}
        isDownloaded={localPath !== null}
        downloading={downloading}
        reDownloading={reDownloading}
        pullingAll={pullAllModalOpen}
        publishingAll={publishModalOpen}
        onDownload={() => void handleDownload()}
        onReDownload={() => void handleReDownload()}
        onPublishAll={() => {
          void trackPublishAll(workspace.id);
          setPublishModalOpen(true);
        }}
        onPullAll={() => {
          void trackPullAll(workspace.id);
          setPullAllModalOpen(true);
        }}
        watchingEnabled={watchingEnabled}
        onToggleWatching={() => void handleToggleWatching()}
        validateEnabled={validateEnabled}
        onToggleValidate={() => setValidateEnabled((v) => !v)}
      />
      <WorkspaceContent
        workspace={workspace}
        localPath={localPath}
        selectedFolderPath={selectedFolderPath}
        onSelectFolder={setSelectedFolderPath}
        dataRefreshKey={dataRefreshKey}
        onDataRefresh={handleDataRefresh}
        onPublishFile={(relativePath: string) => {
          setPublishFilePath(relativePath);
          setPublishModalOpen(true);
        }}
        activateGlobalFilter={gridFilterActivation}
        onActivateGlobalFilterConsumed={() => setGridFilterActivation(null)}
        validateEnabled={validateEnabled}
        onIndexingProgress={setIndexingProgress}
      />
    </Box>
  );
}
