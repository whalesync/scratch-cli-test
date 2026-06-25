import { Box } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Workspace } from '@spinner/shared-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ReviewStat } from '../../../../shared/review-types';
import type {
  RerunValidationScope,
  RerunValidationSummary,
  ValidationStat,
  ValidatorConfig,
} from '../../../../shared/validation-types';
import { trackOpenConnectionsDialog, trackRerunValidation } from '../../lib/posthog';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import type { WorkspaceConnection } from '../../types/local-files';
import { ConnectionsPanel } from './ConnectionsPanel';
import { FolderDataGrid } from './FolderDataGrid';
import { PublishHistoryPanel } from './PublishHistoryPanel';
import { ResizeHandle } from './ResizeHandle';
import { SettingsPanel } from './SettingsPanel';
import type { StartPullOptions } from './use-pull-tracker';
import { ValidationPanel } from './ValidationPanel';
import { WorkspaceSidebar } from './WorkspaceSidebar';

export interface LocalFolder {
  name: string;
  path: string;
  fileCount: number;
}

interface WorkspaceContentProps {
  workspace: Workspace;
  localPath: string | null;
  selectedFolderPath: string | null;
  setSelectedFolderPath: (path: string | null) => void;
  targetRecord?: { filename: string; trigger: string } | null;
  workspaceLevelDataInvalidationCounter: number;
  invalidateWorkspaceLevelData: () => void;
  onConnectionsChanged?: () => void;
  /** Show pull/download progress after a connection-flow save starts pull jobs (DEV-10421). */
  onPullJobsStarted?: () => void;
  /** Start a folder-scoped pull via the workspace's background tracker (DEV-10501). */
  onRequestFolderPull?: (options: StartPullOptions) => void;
  onPublishFile?: (relativePath: string) => void;
  activateGlobalFilter?: { kind: 'unreviewed' | 'unpublished' | 'has-problems'; trigger: number } | null;
  onActivateGlobalFilterConsumed?: () => void;
  onIndexingProgress?: (message: string | null) => void;
  validationStats?: ValidationStat[];
  validationStatsLoading?: boolean;
  validationConfigs?: ValidatorConfig[];
  validationConfigsLoading?: boolean;
  onRefreshValidationStats?: () => void;
  reviewStats?: ReviewStat[];
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 280;

/** Human-readable summary for the "rerun validation" completion toast. */
function rerunSummaryMessage(summary: RerunValidationSummary): string {
  const folders = `${summary.folders_revalidated} folder${summary.folders_revalidated === 1 ? '' : 's'}`;
  const problems =
    summary.errors === 0 && summary.warnings === 0
      ? 'no problems'
      : [
          summary.errors > 0 ? `${summary.errors} error${summary.errors === 1 ? '' : 's'}` : null,
          summary.warnings > 0 ? `${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}` : null,
        ]
          .filter(Boolean)
          .join(', ');
  const skipped = summary.skipped_folders > 0 ? ` (${summary.skipped_folders} skipped)` : '';
  return `Revalidated ${folders}: ${problems}${skipped}`;
}

/** Extract the folder path from a `[rerun] revalidating <folder>...` progress line. */
function parseRerunProgressFolder(line: string): string | null {
  const match = /^\[rerun] revalidating (.+?)\.\.\.\s*$/.exec(line);
  return match ? match[1] : null;
}

export function WorkspaceContent({
  workspace,
  localPath,
  selectedFolderPath,
  setSelectedFolderPath,
  targetRecord,
  workspaceLevelDataInvalidationCounter,
  invalidateWorkspaceLevelData,
  onConnectionsChanged,
  onPullJobsStarted,
  onRequestFolderPull,
  onPublishFile,
  activateGlobalFilter,
  onActivateGlobalFilterConsumed,
  onIndexingProgress,
  validationStats,
  validationStatsLoading,
  validationConfigs,
  validationConfigsLoading,
  onRefreshValidationStats,
  reviewStats,
}: WorkspaceContentProps) {
  const showConnectionsPanel = useWorkspaceUiStore((s) => s.showConnectionsPanel);
  const setShowConnectionsPanel = useWorkspaceUiStore((s) => s.setShowConnectionsPanel);
  const showPublishHistoryPanel = useWorkspaceUiStore((s) => s.showPublishHistoryPanel);
  const setShowPublishHistoryPanel = useWorkspaceUiStore((s) => s.setShowPublishHistoryPanel);
  const showValidationPanel = useWorkspaceUiStore((s) => s.showValidationPanel);
  const setShowValidationPanel = useWorkspaceUiStore((s) => s.setShowValidationPanel);
  const showSettingsPanel = useWorkspaceUiStore((s) => s.showSettingsPanel);
  const setShowSettingsPanel = useWorkspaceUiStore((s) => s.setShowSettingsPanel);
  const showField = useWorkspaceUiStore((s) => s.showField);
  const [searchParams, setSearchParams] = useSearchParams();

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [localFolders, setLocalFolders] = useState<LocalFolder[]>([]);
  const [isFoldersLoading, setIsFoldersLoading] = useState(false);
  const [hasLoadedFoldersOnce, setHasLoadedFoldersOnce] = useState(false);
  const [workspaceConnections, setWorkspaceConnections] = useState<WorkspaceConnection[]>([]);
  const folderLoadGeneration = useRef(0);

  const handleResizeStart = useCallback(() => {
    setIsResizing(true);
  }, []);

  const handleResize = useCallback((deltaX: number) => {
    setSidebarWidth((prev) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, prev + deltaX)));
  }, []);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

  const handleSelectFolder = useCallback(
    (folderPath: string) => {
      setSelectedFolderPath(selectedFolderPath === folderPath ? null : folderPath);
    },
    [selectedFolderPath, setSelectedFolderPath],
  );

  const [newConnectionId, setNewConnectionId] = useState<string | null>(null);

  // Open connections panel when returning from OAuth callback
  useEffect(() => {
    if (searchParams.get('openConnections') === 'true') {
      setShowConnectionsPanel(true);
      const connId = searchParams.get('newConnectionId') ?? null;
      if (connId) setNewConnectionId(connId);
      const next = new URLSearchParams(searchParams);
      next.delete('openConnections');
      next.delete('newConnectionId');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, setShowConnectionsPanel]);

  const handleOpenConnectionsPanel = useCallback(() => {
    setShowConnectionsPanel(true);
    void trackOpenConnectionsDialog(workspace.id);
  }, [workspace.id, setShowConnectionsPanel]);

  // Shared "rerun validation" action for all three scopes (folder / connector / workbook).
  // Re-runs every validator against the current index and refreshes stored results, then
  // refreshes the sidebar/panel counts. Non-destructive — unlike "Clear Index".
  const handleRerunValidation = useCallback(
    async (scope: RerunValidationScope) => {
      if (!localPath) return;
      const toastId = 'rerun-validation';
      const scopeLabel =
        scope.kind === 'connection'
          ? `connection "${scope.connection}"`
          : scope.kind === 'folder'
            ? 'folder'
            : 'workspace';
      const unsubscribe = window.scratchDesktop.onRerunValidationProgress((line) => {
        const folder = parseRerunProgressFolder(line);
        if (folder) {
          notifications.update({ id: toastId, message: `Revalidating ${folder}…`, loading: true, autoClose: false });
        }
      });
      notifications.show({ id: toastId, message: `Revalidating ${scopeLabel}…`, loading: true, autoClose: false });
      void trackRerunValidation(workspace.id, scope.kind);
      try {
        const summary = await window.scratchDesktop.rerunValidation(localPath, scope);
        notifications.update({
          id: toastId,
          loading: false,
          color: summary.errors > 0 ? 'red' : 'green',
          message: rerunSummaryMessage(summary),
          autoClose: 5000,
        });
        onRefreshValidationStats?.();
      } catch (error) {
        notifications.update({
          id: toastId,
          loading: false,
          color: 'red',
          message: `Revalidation failed: ${error instanceof Error ? error.message : String(error)}`,
          autoClose: 6000,
        });
      } finally {
        unsubscribe();
      }
    },
    [localPath, onRefreshValidationStats, workspace.id],
  );

  // Load local folders when workspace is downloaded
  useEffect(() => {
    if (!localPath) {
      folderLoadGeneration.current += 1;
      setLocalFolders([]);
      setWorkspaceConnections([]);
      setIsFoldersLoading(false);
      setHasLoadedFoldersOnce(false);
      return;
    }

    const generation = ++folderLoadGeneration.current;
    setIsFoldersLoading(true);

    void window.scratchFiles
      .listFolders(localPath)
      .then((folders) => {
        if (generation !== folderLoadGeneration.current) {
          return;
        }
        setLocalFolders(folders);
        setHasLoadedFoldersOnce(true);
      })
      .catch(() => {
        if (generation !== folderLoadGeneration.current) {
          return;
        }
        setLocalFolders([]);
        setHasLoadedFoldersOnce(true);
      })
      .finally(() => {
        if (generation !== folderLoadGeneration.current) {
          return;
        }
        setIsFoldersLoading(false);
      });

    void window.scratchFiles.workspaceConfig(localPath).then(
      (config) => {
        if (generation !== folderLoadGeneration.current) {
          return;
        }
        setWorkspaceConnections(config.connections);
      },
      (error: unknown) => {
        if (generation !== folderLoadGeneration.current) {
          return;
        }
        console.warn('[workspace] failed to load workspace config:', error);
        setWorkspaceConnections([]);
      },
    );
  }, [workspaceLevelDataInvalidationCounter, localPath]);

  // The data-view content: the selected folder's grid, or a
  // connections/publish-history/validation/settings panel.
  const dataViewContent =
    showValidationPanel && localPath ? (
      <ValidationPanel
        workspacePath={localPath}
        stats={validationStats ?? []}
        statsLoading={validationStatsLoading ?? false}
        configs={validationConfigs ?? []}
        configsLoading={validationConfigsLoading ?? false}
        onRefreshStats={onRefreshValidationStats ?? (() => undefined)}
        onRerunAll={() => void handleRerunValidation({ kind: 'workspace' })}
        onNavigateToField={(folderPath, filename, fieldName) => {
          setShowValidationPanel(false);
          setSelectedFolderPath(folderPath);
          // Defer showField so it runs after setSelectedFolderPath's
          // resetFolderState (which executes inside a React setState callback
          // and may be batched after this synchronous block).
          setTimeout(() => showField(filename, fieldName), 0);
        }}
      />
    ) : showPublishHistoryPanel ? (
      <PublishHistoryPanel workspaceId={workspace.id} workspacePath={localPath} />
    ) : showConnectionsPanel ? (
      <ConnectionsPanel
        workbookId={workspace.id}
        invalidateWorkspaceLevelData={onConnectionsChanged ?? invalidateWorkspaceLevelData}
        newConnectionId={newConnectionId}
        onNewConnectionConsumed={() => setNewConnectionId(null)}
        onPullJobsStarted={onPullJobsStarted}
      />
    ) : showSettingsPanel ? (
      <SettingsPanel workbookId={workspace.id} />
    ) : (
      <FolderDataGrid
        workspaceId={workspace.id}
        selectedFolderPath={selectedFolderPath}
        workspacePath={localPath}
        targetRecord={targetRecord}
        workspaceLevelDataInvalidationCounter={workspaceLevelDataInvalidationCounter}
        invalidateWorkspaceLevelData={invalidateWorkspaceLevelData}
        onPublishFile={onPublishFile}
        activateGlobalFilter={activateGlobalFilter}
        onActivateGlobalFilterConsumed={onActivateGlobalFilterConsumed}
        onIndexingProgress={onIndexingProgress}
      />
    );

  return (
    <Box
      style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        padding: 6,
        userSelect: isResizing ? 'none' : 'auto',
      }}
    >
      {/* Sidebar */}
      <WorkspaceSidebar
        workspace={workspace}
        workspaceConnections={workspaceConnections}
        localFolders={localFolders}
        isFoldersLoading={isFoldersLoading}
        hasLoadedFoldersOnce={hasLoadedFoldersOnce}
        width={sidebarWidth}
        minWidth={MIN_SIDEBAR_WIDTH}
        maxWidth={MAX_SIDEBAR_WIDTH}
        selectedFolderPath={selectedFolderPath}
        onSelectFolder={handleSelectFolder}
        workspacePath={localPath}
        invalidateWorkspaceLevelData={invalidateWorkspaceLevelData}
        onRequestFolderPull={onRequestFolderPull}
        onOpenConnectionsPanel={handleOpenConnectionsPanel}
        connectionsPanelOpen={showConnectionsPanel}
        onTogglePublishHistoryPanel={() => setShowPublishHistoryPanel(!showPublishHistoryPanel)}
        publishHistoryPanelOpen={showPublishHistoryPanel}
        onToggleValidationPanel={() => setShowValidationPanel(!showValidationPanel)}
        validationPanelOpen={showValidationPanel}
        onToggleSettingsPanel={() => setShowSettingsPanel(!showSettingsPanel)}
        settingsPanelOpen={showSettingsPanel}
        validationStats={validationStats}
        reviewStats={reviewStats}
        onRerunValidation={(scope) => void handleRerunValidation(scope)}
      />

      {/* Resize Handle */}
      <ResizeHandle onResizeStart={handleResizeStart} onResize={handleResize} onResizeEnd={handleResizeEnd} />

      {/* Right panel: validation, publish history, connections, settings, or data grid */}
      {dataViewContent}
    </Box>
  );
}
