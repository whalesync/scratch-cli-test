import { scratchApiClient } from '@/lib/scratch-api-client';
import { Alert, Box, Center, Group, Loader, Modal, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Workspace } from '@spinner/shared-types';
import { isConnectionError as isServerConnectionError } from '@spinner/shared-types/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ButtonPrimaryLight } from '../components/base/buttons';
import { Text13Regular, TextMono12Regular } from '../components/base/text';
import { ServerConnectionSplash } from '../components/ServerConnectionSplash';
import { useReviewStats } from '../hooks/use-review-stats';
import { useValidation } from '../hooks/use-validation';
import { CloudSyncWarning, listLocalWorkspaces } from '../lib/local-workspaces';
import { parentDirectoryPath } from '../lib/parent-path';
import {
  trackDeepLinkProcessed,
  trackPublishAll,
  trackPublishSingleRecord,
  trackPullAll,
  trackRedownloadWorkspace,
} from '../lib/posthog';
import { setScratchApiActiveWorkspacePath } from '../lib/scratch-api-client';
import { useWorkspaceUiStore } from '../stores/workspace-ui-store';
import { CloudSyncWarningBanner } from './workspace/CloudSyncWarningBanner';
import { PublishChangesModal } from './workspace/PublishChangesModal';
import { PullAllModal } from './workspace/PullAllModal';
import { PullInProgressModal } from './workspace/PullInProgressModal';
import { ReinitWorkspaceModal } from './workspace/ReinitWorkspaceModal';
import {
  resolveSingleRecordPublishTarget,
  type SingleRecordPublishTarget,
} from './workspace/single-record-publish-target';
import { WorkspaceContent } from './workspace/WorkspaceContent';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';

function isNoConnectionsScratchmdError(message: string): boolean {
  return message.toLowerCase().includes('no connections found');
}

const FOCUS_SYNC_THROTTLE_MS = 10_000;

interface DeepLinkedWorkspacePath {
  folderPath: string;
  recordFilename: string | null;
  trigger: string;
}

function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function resolveDeepLinkedWorkspacePath(
  localPath: string,
  rawPath: string,
  trigger: string,
): DeepLinkedWorkspacePath | null {
  const normalizedLocalPath = normalizeFsPath(localPath);
  const normalizedRawPath = normalizeFsPath(rawPath);
  const relativePath =
    normalizedRawPath === normalizedLocalPath
      ? ''
      : normalizedRawPath.startsWith(`${normalizedLocalPath}/`)
        ? normalizedRawPath.slice(normalizedLocalPath.length + 1)
        : normalizedRawPath.replace(/^\/+/, '');

  if (!relativePath) {
    return null;
  }

  const segments = relativePath.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? '';
  const isRecordPath = /\.json$/i.test(lastSegment);
  const folderSegments = isRecordPath ? segments.slice(0, -1) : segments;
  if (folderSegments.length === 0) {
    return null;
  }

  return {
    folderPath: `${normalizedLocalPath}/${folderSegments.join('/')}`,
    recordFilename: isRecordPath ? lastSegment : null,
    trigger,
  };
}

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [cloudSyncWarning, setCloudSyncWarning] = useState<CloudSyncWarning | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [reDownloading, setReDownloading] = useState(false);
  const [localWorkspaceMissingModalOpen, setLocalWorkspaceMissingModalOpen] = useState(false);

  /** Last known local path after a successful registry sync; used to detect “had local → missing” on refresh. */
  const previousLocalPathRef = useRef<string | null>(null);

  const [publishModalOpen, setPublishModalOpen] = useState(false);
  // DEV-10413: when set, the publish modal opens in single-record mode for this
  // record. Null = the workspace-wide "Publish all" flow.
  const [singleRecordPublish, setSingleRecordPublish] = useState<SingleRecordPublishTarget | null>(null);
  // The "Pull all" mode also serves as the modal's open state (null = closed).
  const [pullAllMode, setPullAllMode] = useState<'full' | 'incremental' | null>(null);
  const [pullInProgressModalOpen, setPullInProgressModalOpen] = useState(false);
  const [reinitModalOpen, setReinitModalOpen] = useState(false);
  const [reinitReason, setReinitReason] = useState<string | undefined>(undefined);
  // selectedFolderPath lives in component state (not the Zustand store) so it
  // resets cleanly when this component remounts on workspace switch (see
  // `<WorkspacePage key={id} />` in App.tsx). Storing it in the module-level
  // store let an absolute path from the previous workspace leak into the next
  // one, which broke `path.relative(workspacePath, folderPath)` downstream.
  const [selectedFolderPath, setSelectedFolderPathInner] = useState<string | null>(null);
  const setCurrentWorkbookId = useWorkspaceUiStore((s) => s.setCurrentWorkbookId);
  const hydrateWorkbookSettings = useWorkspaceUiStore((s) => s.hydrateWorkbookSettings);
  const resetFolderState = useWorkspaceUiStore((s) => s.resetFolderState);
  const showConnectionsPanel = useWorkspaceUiStore((s) => s.showConnectionsPanel);
  const setShowConnectionsPanel = useWorkspaceUiStore((s) => s.setShowConnectionsPanel);
  const showPublishHistoryPanel = useWorkspaceUiStore((s) => s.showPublishHistoryPanel);
  const setShowPublishHistoryPanel = useWorkspaceUiStore((s) => s.setShowPublishHistoryPanel);
  const showValidationPanel = useWorkspaceUiStore((s) => s.showValidationPanel);
  const setShowValidationPanel = useWorkspaceUiStore((s) => s.setShowValidationPanel);
  const showSettingsPanel = useWorkspaceUiStore((s) => s.showSettingsPanel);
  const setShowSettingsPanel = useWorkspaceUiStore((s) => s.setShowSettingsPanel);
  const setSelectedFolderPath = useCallback(
    (path: string | null) => {
      if (selectedFolderPathRef.current === path) return;
      setSelectedFolderPathInner(path);
      // Mirror the old store action's side effect: clear per-folder state
      // (record/field selection, sort, filters, columns, page, diff view).
      resetFolderState();
      // Selecting a folder closes either central panel — same coupling as
      // the connections panel had before publish-history was added.
      if (path !== null) {
        setShowConnectionsPanel(false);
        setShowPublishHistoryPanel(false);
        setShowValidationPanel(false);
        setShowSettingsPanel(false);
      }
    },
    [
      resetFolderState,
      setShowConnectionsPanel,
      setShowPublishHistoryPanel,
      setShowValidationPanel,
      setShowSettingsPanel,
    ],
  );
  // Opening the connections panel clears the selected folder so the grid
  // returns to its empty state when the panel closes (preserves the
  // pre-rebase store behavior now that selectedFolderPath lives here).
  useEffect(() => {
    if (showConnectionsPanel) {
      setSelectedFolderPathInner(null);
    }
  }, [showConnectionsPanel]);
  // Opening the publish-history panel clears the selected folder for the
  // same reason — the grid empties when the panel closes again.
  useEffect(() => {
    if (showPublishHistoryPanel) {
      setSelectedFolderPathInner(null);
    }
  }, [showPublishHistoryPanel]);
  // Opening the validation panel clears the selected folder too.
  useEffect(() => {
    if (showValidationPanel) {
      setSelectedFolderPathInner(null);
    }
  }, [showValidationPanel]);
  // Opening the settings panel clears the selected folder too.
  useEffect(() => {
    if (showSettingsPanel) {
      setSelectedFolderPathInner(null);
    }
  }, [showSettingsPanel]);
  const [deepLinkedPath, setDeepLinkedPath] = useState<DeepLinkedWorkspacePath | null>(null);
  const [workspaceLevelDataInvalidationCounter, setDataRefreshKey] = useState(0);
  const [watchingEnabled, setWatchingEnabled] = useState(true);
  const validation = useValidation(localPath, workspaceLevelDataInvalidationCounter);
  const reviewStats = useReviewStats(localPath, workspaceLevelDataInvalidationCounter);
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
  const lastTrackedDeepLinkRef = useRef<string | null>(null);

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
        const [data, localWorkspaces] = await Promise.all([
          scratchApiClient.workspaces.detail(id),
          listLocalWorkspaces(),
        ]);
        const localWorkspace = localWorkspaces.find((entry) => entry.id === id) ?? null;
        const nextLocalPath = localWorkspace?.path ?? null;

        if (previousLocalPathRef.current !== null && nextLocalPath === null) {
          setLocalWorkspaceMissingModalOpen(true);
        }
        previousLocalPathRef.current = nextLocalPath;

        setWorkspace(data);
        setLocalPath(nextLocalPath);
        setCloudSyncWarning(localWorkspace?.cloudSyncWarning ?? null);
        void window.scratchPreferences.setCurrentWorkspaceId(id);
        const uniqueConnections = new Set((data.dataFolders ?? []).map((f) => f.connectorAccountId).filter(Boolean));
        return {
          localPath: nextLocalPath,
          serverDataFolderCount: data.dataFolders?.length ?? 0,
          connectionCount: uniqueConnections.size,
          hasPullLock: (data.dataFolders ?? []).some((f) => f.lock === 'pull'),
        };
      } catch (err) {
        // If the workspace is inaccessible (403 wrong account, 404 deleted), clear stored preference
        // and go back to the workspace picker.
        const axiosError = err as { response?: { status?: number } };
        if (axiosError?.response?.status === 403 || axiosError?.response?.status === 404) {
          void window.scratchPreferences.setCurrentWorkspaceId(null);
          void navigate('/');
          return undefined;
        }
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
    [id, navigate],
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

  // Ensure schema validation always runs by seeding an `enforce_schema` validator into every folder,
  // so a read-only field edited by the user surfaces as a warning in the Validation panel before they
  // publish. Best-effort, fire-and-forget; writes only under `.scratch/` so it never gates publish.
  // (DEV-10453.)
  const seedSchemaValidators = useCallback((path: string) => {
    void window.scratchFiles
      .ensureSchemaValidatorSeeded(path)
      .catch((err) => console.debug('[validation] auto-seed enforce_schema failed:', err));
  }, []);

  // DEV-10413: resolve a clicked record's workspace-relative CLI path into the
  // single-record publish target, then open the publish modal scoped to it.
  // The path normalization lives in a pure helper (unit-tested).
  const handlePublishSingleRecord = useCallback(
    async (cliPath: string) => {
      const workspaceId = workspace?.id;
      if (!localPath || !workspaceId) return;
      const showResolveError = (message: string) =>
        notifications.show({ color: 'red', title: 'Could not publish record', message });
      try {
        const cfg = await window.scratchFiles.workspaceConfig(localPath);
        const resolved = resolveSingleRecordPublishTarget(localPath, cliPath, cfg.connections);
        if (!resolved.ok) {
          showResolveError(resolved.error);
          return;
        }
        void trackPublishSingleRecord(workspaceId, resolved.target.connectionId);
        setSingleRecordPublish(resolved.target);
        setPublishModalOpen(true);
      } catch (err) {
        showResolveError(err instanceof Error ? err.message : 'Failed to resolve the record’s connection.');
      }
    },
    [localPath, workspace?.id],
  );

  const handlePullAndRefresh = useCallback(async () => {
    if (!localPath) return;
    try {
      const result = await window.scratchDesktop.pullWorkspaceChanges(localPath, { onDelete: 'remove' });
      // DEV-10523: unreviewed edits no longer block the pull — they're re-applied
      // user-wins. The narrow set that couldn't be re-applied is stashed; surface
      // it so the user knows their work is recoverable.
      if (result.status === 'blocked_conflict' || result.status === 'downloaded_with_stashed_conflicts') {
        notifications.show({
          title: 'Some local edits need attention',
          message:
            'Some local edits conflict with newer changes from the server and were saved to unreviewed-changes.json. Point your AI agent at the file to re-apply them.',
          color: 'yellow',
          autoClose: false,
        });
      }
    } catch (err) {
      console.debug('[workspace] connection-change pull failed:', err);
    }
    seedSchemaValidators(localPath);
    handleDataRefresh();
  }, [handleDataRefresh, localPath, seedSchemaValidators]);

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
      const result = await window.scratchDesktop.pullWorkspaceChanges(localPath, { onDelete: 'keep' });
      handleDataRefresh();
      // DEV-10523: clean connections still pulled; surface any edits that
      // couldn't be re-applied (saved to unreviewed-changes.json) instead of the
      // old all-or-nothing "N unreviewed records" block.
      if (result.status === 'blocked_conflict' || result.status === 'downloaded_with_stashed_conflicts') {
        const conflictCount =
          result.status === 'blocked_conflict' ? result.conflictCount : (result.stashedConflictPaths?.length ?? 0);
        notifications.show({
          title: 'Updated, with conflicts to resolve',
          message: `${conflictCount} local edit(s) conflict with newer server changes and were saved to unreviewed-changes.json. Point your AI agent at the file to re-apply them.`,
          color: 'yellow',
          autoClose: false,
        });
      } else {
        notifications.show({
          title: 'Workspace updated',
          message: 'Re-downloaded the latest file updates from Scratch.',
          color: 'green',
        });
      }
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

  // Hydrate per-workbook settings from electron-store on mount.
  useEffect(() => {
    if (!id) return;
    setCurrentWorkbookId(id);
    void window.scratchPreferences.getWorkbookSettings(id).then((settings) => {
      hydrateWorkbookSettings(settings);
    });
  }, [id, setCurrentWorkbookId, hydrateWorkbookSettings]);

  useEffect(() => {
    focusSyncBootAtRef.current = performance.now();
  }, [id]);

  useEffect(() => {
    void fetchWorkspace().then((snapshot) => {
      if (snapshot) {
        previousFolderCountRef.current = snapshot.serverDataFolderCount;
        previousConnectionCountRef.current = snapshot.connectionCount;
        if (snapshot.connectionCount === 0) {
          setShowConnectionsPanel(true);
        }
        if (snapshot.localPath) seedSchemaValidators(snapshot.localPath);
      }
    });
  }, [fetchWorkspace, setShowConnectionsPanel, seedSchemaValidators]);

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
            const activeJobs = await scratchApiClient.job.getActiveJobsByWorkbook(workspaceId);
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
    setScratchApiActiveWorkspacePath(localPath);
    if (localPath) {
      window.scratchDesktop.logSession(localPath, 'start');
    }
    return () => {
      if (localPath) {
        window.scratchDesktop.logSession(localPath, 'end');
      }
      setScratchApiActiveWorkspacePath(null);
    };
  }, [localPath]);

  useEffect(() => {
    const trigger = searchParams.get('_dl');
    const rawPath = searchParams.get('path');
    const source = searchParams.get('source') ?? undefined;
    if (!trigger) {
      setDeepLinkedPath(null);
      return;
    }

    if (!rawPath) {
      setDeepLinkedPath(null);
      if (workspace?.id && lastTrackedDeepLinkRef.current !== trigger) {
        lastTrackedDeepLinkRef.current = trigger;
        void trackDeepLinkProcessed({ workspaceId: workspace.id, targetType: 'workspace', source });
      }
      return;
    }

    if (!localPath) {
      setDeepLinkedPath(null);
      return;
    }

    const resolved = resolveDeepLinkedWorkspacePath(localPath, rawPath, trigger);
    setDeepLinkedPath(resolved);
    if (resolved) {
      setSelectedFolderPath(resolved.folderPath);
      if (workspace?.id && lastTrackedDeepLinkRef.current !== trigger) {
        lastTrackedDeepLinkRef.current = trigger;
        void trackDeepLinkProcessed({
          workspaceId: workspace.id,
          targetType: resolved.recordFilename ? 'record' : 'folder',
          source,
          pathDepth: resolved.folderPath
            .slice(normalizeFsPath(localPath).length + 1)
            .split('/')
            .filter(Boolean).length,
        });
      }
    }
  }, [localPath, searchParams, setSelectedFolderPath, workspace?.id]);

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
  }, [workspaceLevelDataInvalidationCounter, localPath, watchingEnabled]);

  useEffect(() => {
    if (!workspaceId) return;
    const unsubscribe = window.scratchDesktop.onWorkspaceNeedsReinit((event) => {
      if (localPath && event.workspacePath && event.workspacePath !== localPath) {
        // Refusal came from a different workspace's CLI call — ignore on this page.
        return;
      }
      setReinitReason(event.reason);
      setReinitModalOpen(true);
    });
    return unsubscribe;
  }, [workspaceId, localPath]);

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
          setSingleRecordPublish(null);
        }}
        workspaceName={workspace.name}
        workspaceId={workspace.id}
        localPath={localPath}
        invalidateWorkspaceLevelData={handleDataRefresh}
        currentFolderPath={selectedFolderPath}
        singleRecord={singleRecordPublish ?? undefined}
        onViewProblems={(folderPath) => {
          setPublishModalOpen(false);
          setSingleRecordPublish(null);
          setSelectedFolderPath(folderPath);
          gridFilterTriggerRef.current += 1;
          setGridFilterActivation({ kind: 'has-problems', trigger: gridFilterTriggerRef.current });
        }}
      />
      <PullAllModal
        opened={pullAllMode !== null}
        onClose={() => setPullAllMode(null)}
        workspaceName={workspace.name}
        localPath={localPath}
        workspaceId={workspace.id}
        pullMode={pullAllMode ?? undefined}
        invalidateWorkspaceLevelData={handleDataRefresh}
      />
      {localPath && (
        <PullInProgressModal
          opened={pullInProgressModalOpen}
          onClose={() => setPullInProgressModalOpen(false)}
          workbookId={workspace.id}
          localPath={localPath}
          invalidateWorkspaceLevelData={handleDataRefresh}
        />
      )}
      {localPath && (
        <ReinitWorkspaceModal
          opened={reinitModalOpen}
          workbookId={workspace.id}
          localPath={localPath}
          reason={reinitReason}
          onClose={() => setReinitModalOpen(false)}
          onReinitialized={() => {
            setReinitModalOpen(false);
            void fetchWorkspace();
            handleDataRefresh();
            notifications.show({
              title: 'Workspace reinitialized',
              message: 'Your workspace is ready to use again.',
              color: 'green',
            });
          }}
        />
      )}
      <WorkspaceHeader
        workspace={workspace}
        localPath={localPath}
        isDownloaded={localPath !== null}
        downloading={downloading}
        reDownloading={reDownloading}
        pullingAll={pullAllMode !== null}
        publishingAll={publishModalOpen}
        onDownload={() => void handleDownload()}
        onReDownload={() => void handleReDownload()}
        onPublishAll={() => {
          void trackPublishAll(workspace.id);
          // R3: "Publish all" is always workspace-wide — clear any single-record target.
          setSingleRecordPublish(null);
          setPublishModalOpen(true);
        }}
        onPullAll={(mode) => {
          void trackPullAll(workspace.id, mode);
          setPullAllMode(mode);
        }}
        watchingEnabled={watchingEnabled}
        onToggleWatching={() => void handleToggleWatching()}
      />
      {localPath && cloudSyncWarning && (
        <CloudSyncWarningBanner
          workspaceId={workspace.id}
          workspaceName={workspace.name ?? ''}
          localPath={localPath}
          warning={cloudSyncWarning}
          onMoved={() => {
            void fetchWorkspace();
            handleDataRefresh();
          }}
        />
      )}
      <WorkspaceContent
        workspace={workspace}
        localPath={localPath}
        selectedFolderPath={selectedFolderPath}
        setSelectedFolderPath={setSelectedFolderPath}
        targetRecord={
          deepLinkedPath?.recordFilename && deepLinkedPath.folderPath === selectedFolderPath
            ? { filename: deepLinkedPath.recordFilename, trigger: deepLinkedPath.trigger }
            : null
        }
        workspaceLevelDataInvalidationCounter={workspaceLevelDataInvalidationCounter}
        invalidateWorkspaceLevelData={handleDataRefresh}
        onConnectionsChanged={() => void handlePullAndRefresh()}
        onPullJobsStarted={() => {
          // DEV-10421: a connection-flow save kicked off pull jobs. Surface the
          // pull-in-progress modal so the user sees download progress instead of
          // it running silently. The modal downloads files locally on completion,
          // which needs a local workspace; without one there is nothing to show.
          if (localPath) setPullInProgressModalOpen(true);
        }}
        onPublishFile={(cliPath) => {
          // DEV-10413: open the publish modal scoped to just this record.
          void handlePublishSingleRecord(cliPath);
        }}
        activateGlobalFilter={gridFilterActivation}
        onActivateGlobalFilterConsumed={() => setGridFilterActivation(null)}
        onIndexingProgress={setIndexingProgress}
        validationStats={validation.stats}
        validationStatsLoading={validation.statsLoading}
        validationConfigs={validation.configs}
        validationConfigsLoading={validation.configsLoading}
        onRefreshValidationStats={validation.refreshStats}
        reviewStats={reviewStats.stats}
      />
    </Box>
  );
}
