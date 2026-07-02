import { scratchApiClient } from '@/lib/scratch-api-client';
import { Alert, Box, Center, Group, Loader, Modal, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Workspace } from '@spinner/shared-types';
import { isConnectionError as isServerConnectionError } from '@spinner/shared-types/api-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ButtonPrimaryLight } from '../components/base/buttons';
import { Text13Regular, TextMono12Regular } from '../components/base/text';
import { ServerConnectionSplash } from '../components/ServerConnectionSplash';
import { useReviewStats } from '../hooks/use-review-stats';
import { useValidation } from '../hooks/use-validation';
import { CloudSyncWarning, listLocalWorkspaces } from '../lib/local-workspaces';
import { parentDirectoryPath } from '../lib/parent-path';
import {
  trackAutoDownloadCompleted,
  trackDeepLinkProcessed,
  trackPublishAll,
  trackPublishConnector,
  trackPublishSingleRecord,
  trackPullAll,
  trackRedownloadWorkspace,
} from '../lib/posthog';
import { setScratchApiActiveWorkspacePath } from '../lib/scratch-api-client';
import { useWorkspaceUiStore } from '../stores/workspace-ui-store';
import { CloudSyncWarningBanner } from './workspace/CloudSyncWarningBanner';
import { PublishChangesModal } from './workspace/PublishChangesModal';
import { PullProgressModal } from './workspace/PullProgressModal';
import { ReinitWorkspaceModal } from './workspace/ReinitWorkspaceModal';
import { buildApprovedPublishBreakdown } from './workspace/review-publish-breakdown';
import type { SingleConnectionPublishTarget } from './workspace/single-connection-publish-target';
import {
  resolveSingleRecordPublishTarget,
  type SingleRecordPublishTarget,
} from './workspace/single-record-publish-target';
import { usePullTracker, type StartPullOptions } from './workspace/use-pull-tracker';
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
  // DEV-10596: when set, the publish modal opens in single-connection mode for
  // this connector. Mutually exclusive with `singleRecordPublish`.
  const [singleConnectionPublish, setSingleConnectionPublish] = useState<SingleConnectionPublishTarget | null>(null);
  // Whether the pull-progress detail modal is open. The pull itself is tracked by
  // `pullTracker` (below) independently of this, so closing the modal never stops
  // the pull — the user can keep working while it runs. (DEV-10501)
  const [pullModalOpen, setPullModalOpen] = useState(false);
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
  // The currently-focused folder as a workspace-relative, POSIX path (no leading
  // slash), or null when nothing folder-scoped is selected (connections/publish/
  // validation/settings panels, or the workspace root itself). Its first segment
  // is the connection/service directory the user opened. Used to scope the
  // "Open in Claude/Codex" deep-link prompt to the right service folder
  // (DEV-10502).
  const selectedFolderRelativePathWithinWorkspace = useMemo(() => {
    if (!selectedFolderPath || !localPath) return null;
    const normalizedWorkspaceRootPath = normalizeFsPath(localPath);
    const normalizedSelectedFolderPath = normalizeFsPath(selectedFolderPath);
    if (normalizedSelectedFolderPath === normalizedWorkspaceRootPath) return null;
    if (!normalizedSelectedFolderPath.startsWith(`${normalizedWorkspaceRootPath}/`)) return null;
    return normalizedSelectedFolderPath.slice(normalizedWorkspaceRootPath.length + 1);
  }, [selectedFolderPath, localPath]);
  const [deepLinkedPath, setDeepLinkedPath] = useState<DeepLinkedWorkspacePath | null>(null);
  const [workspaceLevelDataInvalidationCounter, setDataRefreshKey] = useState(0);
  const [watchingEnabled, setWatchingEnabled] = useState(true);
  const validation = useValidation(localPath, workspaceLevelDataInvalidationCounter);
  const reviewStats = useReviewStats(localPath, workspaceLevelDataInvalidationCounter);
  // Workspace-wide rollups of the per-folder review stats, for the header's
  // "N to review" signpost and the pending-to-publish count on "Publish all"
  // (DEV-10449). Derived from the already-subscribed stats — no extra fetch.
  const { totalUnreviewedCount, totalApprovedPendingPublishCount, approvedPublishBreakdown } = useMemo(() => {
    let unreviewed = 0;
    for (const stat of reviewStats.stats) {
      unreviewed += stat.unreviewed;
    }
    const breakdown = buildApprovedPublishBreakdown(reviewStats.stats);
    const approvedPendingPublish = breakdown.reduce((sum, connection) => sum + connection.total, 0);
    return {
      totalUnreviewedCount: unreviewed,
      totalApprovedPendingPublishCount: approvedPendingPublish,
      approvedPublishBreakdown: breakdown,
    };
  }, [reviewStats.stats]);
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

  // The Scratch sidebar section (DEV-10424) renders from `workspace.dataFolders`, which only changes
  // on a full workspace refetch — bumping the disk-backed data counter (`handleDataRefresh`) refreshes
  // the connector grid/validation/review data but never re-runs `fetchWorkspace`, so a created or
  // deleted scratch folder wouldn't appear/disappear until a window refocus. Silently refetch the
  // workspace after a scratch folder create/delete so the section updates immediately (DEV-10583).
  // `silent` avoids flashing the full-page loading spinner for what is just a sidebar edit.
  const handleScratchFoldersChanged = useCallback(() => {
    void fetchWorkspace({ silent: true });
  }, [fetchWorkspace]);

  // Background pull tracker: owns the poll → local-download → refresh lifecycle so
  // it keeps running even when the progress modal is closed. The user can browse
  // and edit records while a pull works in the background. (DEV-10501)
  const pullTracker = usePullTracker({
    workbookId: id ?? '',
    localPath,
    invalidateWorkspaceLevelData: handleDataRefresh,
  });
  const { startPull: startPullTracking, watchActivePulls: watchActivePullJobs, phase: pullPhase } = pullTracker;
  // Latest-tracker ref so the focus effect can attach to active pulls without
  // re-subscribing every render.
  const pullTrackerRef = useRef(pullTracker);
  pullTrackerRef.current = pullTracker;

  // Start a pull and surface its progress modal. The modal is dismissible — the
  // pull continues in the background once it's open.
  const handleStartPull = useCallback(
    (options: StartPullOptions) => {
      // Don't abandon an in-flight pull: starting a new one would clear the
      // tracked jobs and skip the running pull's post-completion local download.
      // The header "Pull all" button is already disabled while a pull runs; this
      // also gates the folder-tree "Pull this table" context-menu action (which
      // isn't disabled), surfacing the in-flight pull instead of replacing it.
      if (pullTrackerRef.current.isActive) {
        setPullModalOpen(true);
        notifications.show({
          title: 'Pull already in progress',
          message: 'Wait for the current pull to finish before starting another.',
          color: 'yellow',
        });
        return;
      }
      setPullModalOpen(true);
      void startPullTracking(options);
    },
    [startPullTracking],
  );

  // Once the tracker resets to idle (auto-dismiss after completion, or an explicit
  // dismiss), close the detail modal too.
  useEffect(() => {
    if (pullPhase === 'idle') {
      setPullModalOpen(false);
    }
  }, [pullPhase]);

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
        setSingleConnectionPublish(null);
        setSingleRecordPublish(resolved.target);
        setPublishModalOpen(true);
      } catch (err) {
        showResolveError(err instanceof Error ? err.message : 'Failed to resolve the record’s connection.');
      }
    },
    [localPath, workspace?.id],
  );

  // DEV-10596: open the publish modal scoped to one connector. The target is
  // already resolved by the FolderTree (its pure `resolveSingleConnectionPublishTarget`
  // null-guards the connector account id), so this just records the analytics
  // event and opens the modal, clearing any single-record target first.
  const handlePublishConnector = useCallback(
    (target: SingleConnectionPublishTarget) => {
      const workspaceId = workspace?.id;
      if (!localPath || !workspaceId) return;
      void trackPublishConnector(workspaceId, target.connectionId);
      setSingleRecordPublish(null);
      setSingleConnectionPublish(target);
      setPublishModalOpen(true);
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

        // If a pull lock exists, attach the background tracker to any active pull
        // jobs. This surfaces the ambient progress pill (not a blocking modal), so
        // the user can keep working. Pull locks can be stale (job finished but lock
        // wasn't cleared), so `watchActivePulls` is a no-op when there are no real
        // active jobs — in which case we fall through to the normal focus sync.
        if (snapshot.hasPullLock) {
          const attached = await pullTrackerRef.current.watchActivePulls();
          if (attached) {
            return;
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

  // DEV-10470: when the scheduled background auto-download finishes for the
  // workspace currently on screen, refresh the data under the user (and surface
  // conflicts) so the view reflects the freshly-downloaded data without a manual
  // "Re-download files" click. Other workspaces' events are ignored.
  useEffect(() => {
    if (!id) return;
    const unsubscribe = window.scratchDesktop.onAutoDownloadCompleted((event) => {
      if (event.workbookId !== id) return;
      void trackAutoDownloadCompleted(id, {
        status: event.status,
        filesChanged: event.filesChanged,
        conflictCount: event.conflictCount,
      });
      if (event.status === 'error') {
        // Stay quiet on background failures (network/auth) — a transient miss is
        // retried on the next hourly tick and shouldn't nag the user.
        console.debug('[workspace] scheduled auto-download failed:', event.message);
        return;
      }
      if (event.filesChanged === 0 && event.conflictCount === 0) {
        // `up_to_date` — the common hourly outcome. Nothing changed on disk, so
        // don't refetch the grid/validation/review-stats (or reconcile file-watch
        // roots) under the user; that would interrupt their work for no reason.
        return;
      }
      handleDataRefresh();
      if (event.conflictCount > 0) {
        notifications.show({
          title: 'Updated, with conflicts to resolve',
          message: `${event.conflictCount} local edit(s) conflict with newer server changes and were saved to unreviewed-changes.json.`,
          color: 'yellow',
          autoClose: false,
        });
      } else {
        notifications.show({
          title: 'Workspace updated',
          message: 'Automatically downloaded the latest data from Scratch.',
          color: 'green',
        });
      }
    });
    return unsubscribe;
  }, [id, handleDataRefresh]);

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
          setSingleConnectionPublish(null);
        }}
        workspaceName={workspace.name}
        workspaceId={workspace.id}
        localPath={localPath}
        invalidateWorkspaceLevelData={handleDataRefresh}
        currentFolderPath={selectedFolderPath}
        singleRecord={singleRecordPublish ?? undefined}
        singleConnection={singleConnectionPublish ?? undefined}
        onViewProblems={(folderPath) => {
          setPublishModalOpen(false);
          setSingleRecordPublish(null);
          setSingleConnectionPublish(null);
          setSelectedFolderPath(folderPath);
          gridFilterTriggerRef.current += 1;
          setGridFilterActivation({ kind: 'has-problems', trigger: gridFilterTriggerRef.current });
        }}
      />
      <PullProgressModal
        opened={pullModalOpen}
        onClose={() => {
          setPullModalOpen(false);
          // Closing while errored clears the failed state (and the header pill);
          // an in-flight or completed pull is left untouched.
          if (pullTracker.phase === 'error' || pullTracker.phase === 'download-error') {
            pullTracker.dismiss();
          }
        }}
        tracker={pullTracker}
      />
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
        selectedFolderRelativePath={selectedFolderRelativePathWithinWorkspace}
        isDownloaded={localPath !== null}
        downloading={downloading}
        reDownloading={reDownloading}
        publishingAll={publishModalOpen && !singleRecordPublish && !singleConnectionPublish}
        unreviewedCount={totalUnreviewedCount}
        approvedPendingPublishCount={totalApprovedPendingPublishCount}
        approvedPublishBreakdown={approvedPublishBreakdown}
        pull={pullTracker}
        onShowPullProgress={() => setPullModalOpen(true)}
        onDownload={() => void handleDownload()}
        onReDownload={() => void handleReDownload()}
        onPublishAll={() => {
          void trackPublishAll(workspace.id, {
            approvedPendingPublishCount: totalApprovedPendingPublishCount,
            unreviewedCount: totalUnreviewedCount,
          });
          // R3: "Publish all" is always workspace-wide — clear any single-record
          // or single-connection target.
          setSingleRecordPublish(null);
          setSingleConnectionPublish(null);
          setPublishModalOpen(true);
        }}
        onPullAll={(mode) => {
          void trackPullAll(workspace.id, mode);
          const modeLabel = mode === 'full' ? ' (Full)' : ' (Incremental)';
          handleStartPull({
            title: `Pull all${modeLabel} — ${workspace.name ?? 'workspace'}`,
            pullMode: mode,
            emptyStateMessage: 'No linked tables found in this workspace.',
          });
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
        onScratchFoldersChanged={handleScratchFoldersChanged}
        onConnectionsChanged={() => void handlePullAndRefresh()}
        onPullJobsStarted={() => {
          // DEV-10421: a connection-flow save kicked off pull jobs. Attach the
          // background tracker so the user sees download progress instead of it
          // running silently, and open the detail modal once we've confirmed there
          // are jobs to show. Materializing files locally needs a local workspace.
          if (!localPath) return;
          void watchActivePullJobs().then((attached) => {
            if (attached) setPullModalOpen(true);
          });
        }}
        onRequestFolderPull={handleStartPull}
        onRequestPublishConnector={handlePublishConnector}
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
