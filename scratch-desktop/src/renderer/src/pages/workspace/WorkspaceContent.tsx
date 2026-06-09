import { Box } from '@mantine/core';
import { Workspace } from '@spinner/shared-types';
import { History, ShieldCheck, Table, Unplug, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ReviewStat } from '../../../../shared/review-types';
import type { ValidationStat, ValidatorConfig } from '../../../../shared/validation-types';
import { trackOpenClaudeChatPanel, trackOpenConnectionsDialog } from '../../lib/posthog';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import type { WorkspaceConnection } from '../../types/local-files';
import { CenterTabBar } from './CenterTabBar';
import { ClaudeChatPanel } from './ClaudeChatPanel';
import { ConnectionsPanel } from './ConnectionsPanel';
import { FolderDataGrid } from './FolderDataGrid';
import { PublishHistoryPanel } from './PublishHistoryPanel';
import { ResizeHandle } from './ResizeHandle';
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
  /** Dev-only flag: when false, the center is just the data view (no chat tab). */
  claudeChatEnabled?: boolean;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 280;

export function WorkspaceContent({
  workspace,
  localPath,
  selectedFolderPath,
  setSelectedFolderPath,
  targetRecord,
  workspaceLevelDataInvalidationCounter,
  invalidateWorkspaceLevelData,
  onConnectionsChanged,
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
  claudeChatEnabled = false,
}: WorkspaceContentProps) {
  const showConnectionsPanel = useWorkspaceUiStore((s) => s.showConnectionsPanel);
  const setShowConnectionsPanel = useWorkspaceUiStore((s) => s.setShowConnectionsPanel);
  const showPublishHistoryPanel = useWorkspaceUiStore((s) => s.showPublishHistoryPanel);
  const setShowPublishHistoryPanel = useWorkspaceUiStore((s) => s.setShowPublishHistoryPanel);
  const showValidationPanel = useWorkspaceUiStore((s) => s.showValidationPanel);
  const setShowValidationPanel = useWorkspaceUiStore((s) => s.setShowValidationPanel);
  const activeCenterTab = useWorkspaceUiStore((s) => s.activeCenterTab);
  const setActiveCenterTab = useWorkspaceUiStore((s) => s.setActiveCenterTab);
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
      const willDeselect = selectedFolderPath === folderPath;
      setSelectedFolderPath(willDeselect ? null : folderPath);
      // Selecting a folder opens (and focuses) its grid tab next to chat.
      if (!willDeselect) setActiveCenterTab('data');
    },
    [selectedFolderPath, setSelectedFolderPath, setActiveCenterTab],
  );

  const handleSelectChatTab = useCallback(() => {
    setActiveCenterTab('chat');
    void trackOpenClaudeChatPanel(workspace.id);
  }, [setActiveCenterTab, workspace.id]);

  // Closing the data tab clears whatever it was showing and returns to chat.
  const handleCloseDataTab = useCallback(() => {
    setShowConnectionsPanel(false);
    setShowPublishHistoryPanel(false);
    setShowValidationPanel(false);
    setSelectedFolderPath(null);
    setActiveCenterTab('chat');
  }, [
    setShowConnectionsPanel,
    setShowPublishHistoryPanel,
    setShowValidationPanel,
    setSelectedFolderPath,
    setActiveCenterTab,
  ]);

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

  // Friendly name for the selected folder's tab (prefer the sidebar's folder
  // label; fall back to the path's last segment).
  const selectedFolderName = useMemo(() => {
    if (!selectedFolderPath) return null;
    const match = localFolders.find((folder) => folder.path === selectedFolderPath);
    if (match) return match.name;
    const segments = selectedFolderPath.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? selectedFolderPath;
  }, [selectedFolderPath, localFolders]);

  // The data tab shows the active center panel (precedence matches the render
  // conditional below) or, failing that, the selected folder's grid. `null`
  // label means there's nothing to show in a data tab — only chat exists.
  let dataTabLabel: string | null = null;
  let dataTabIcon: LucideIcon = Table;
  if (showValidationPanel && localPath) {
    dataTabLabel = 'Validation';
    dataTabIcon = ShieldCheck;
  } else if (showPublishHistoryPanel) {
    dataTabLabel = 'Publish history';
    dataTabIcon = History;
  } else if (showConnectionsPanel) {
    dataTabLabel = 'Connections';
    dataTabIcon = Unplug;
  } else if (selectedFolderName) {
    dataTabLabel = selectedFolderName;
    dataTabIcon = Table;
  }
  const hasDataTab = dataTabLabel !== null;

  // If the data tab vanished while it was active (folder deselected, panel
  // closed), fall back to chat so the store doesn't stay stuck on 'data'.
  useEffect(() => {
    if (!hasDataTab && activeCenterTab === 'data') {
      setActiveCenterTab('chat');
    }
  }, [hasDataTab, activeCenterTab, setActiveCenterTab]);

  // Render-time effective tab — avoids a blank frame on the tick before the
  // fallback effect above runs.
  const effectiveCenterTab = activeCenterTab === 'data' && !hasDataTab ? 'chat' : activeCenterTab;

  // The data-view content (grid or a connections/publish-history/validation
  // panel). Shared by the tabbed layout and the pre-download (no localPath) path.
  const dataViewContent =
    showValidationPanel && localPath ? (
      <ValidationPanel
        workspacePath={localPath}
        stats={validationStats ?? []}
        statsLoading={validationStatsLoading ?? false}
        configs={validationConfigs ?? []}
        configsLoading={validationConfigsLoading ?? false}
        onRefreshStats={onRefreshValidationStats ?? (() => undefined)}
        onNavigateToField={(folderPath, filename, fieldName) => {
          setShowValidationPanel(false);
          setSelectedFolderPath(folderPath);
          setActiveCenterTab('data');
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
      />
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
        onOpenConnectionsPanel={handleOpenConnectionsPanel}
        connectionsPanelOpen={showConnectionsPanel}
        onTogglePublishHistoryPanel={() => setShowPublishHistoryPanel(!showPublishHistoryPanel)}
        publishHistoryPanelOpen={showPublishHistoryPanel}
        onToggleValidationPanel={() => setShowValidationPanel(!showValidationPanel)}
        validationPanelOpen={showValidationPanel}
        validationStats={validationStats}
        reviewStats={reviewStats}
      />

      {/* Resize Handle */}
      <ResizeHandle onResizeStart={handleResizeStart} onResize={handleResize} onResizeEnd={handleResizeEnd} />

      {/* Center pane. When the (dev-only) chat feature is on and the workspace
          is downloaded, it's a Conductor-style tabbed surface: Chat is the main
          tab; selecting a folder opens its grid tab beside it. Otherwise it's
          just the data view directly. */}
      {localPath && claudeChatEnabled ? (
        <Box style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <CenterTabBar
            activeTab={effectiveCenterTab}
            onSelectChat={handleSelectChatTab}
            dataTabLabel={dataTabLabel}
            dataTabIcon={dataTabIcon}
            onSelectData={() => setActiveCenterTab('data')}
            onCloseData={handleCloseDataTab}
          />
          <Box style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {/* Chat stays mounted across tab switches so the conversation
                persists; we just hide it. */}
            <Box
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: effectiveCenterTab === 'chat' ? 'flex' : 'none',
              }}
            >
              <ClaudeChatPanel workspacePath={localPath} workspaceId={workspace.id} />
            </Box>
            {/* Data view is mounted only while active to avoid the grid
                measuring itself at zero height while hidden. */}
            {effectiveCenterTab === 'data' && hasDataTab && (
              <Box style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>{dataViewContent}</Box>
            )}
          </Box>
        </Box>
      ) : (
        <Box style={{ flex: 1, minWidth: 0, display: 'flex' }}>{dataViewContent}</Box>
      )}
    </Box>
  );
}
