import { Box } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ValidationStat, ValidatorConfig } from '../../../../shared/validation-types';
import { trackOpenConnectionsDialog } from '../../lib/posthog';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import type { WorkspaceConnection } from '../../types/local-files';
import { Workspace } from '../../types/workspace';
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
  lastModified: number;
  totalSize: number;
}

interface WorkspaceContentProps {
  workspace: Workspace;
  localPath: string | null;
  selectedFolderPath: string | null;
  setSelectedFolderPath: (path: string | null) => void;
  targetRecord?: { filename: string; trigger: string } | null;
  dataRefreshKey: number;
  onDataRefresh: () => void;
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
  dataRefreshKey,
  onDataRefresh,
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
}: WorkspaceContentProps) {
  const showConnectionsPanel = useWorkspaceUiStore((s) => s.showConnectionsPanel);
  const setShowConnectionsPanel = useWorkspaceUiStore((s) => s.setShowConnectionsPanel);
  const showPublishHistoryPanel = useWorkspaceUiStore((s) => s.showPublishHistoryPanel);
  const setShowPublishHistoryPanel = useWorkspaceUiStore((s) => s.setShowPublishHistoryPanel);
  const showValidationPanel = useWorkspaceUiStore((s) => s.showValidationPanel);
  const setShowValidationPanel = useWorkspaceUiStore((s) => s.setShowValidationPanel);
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
  }, [dataRefreshKey, localPath]);

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
        onDataRefresh={onDataRefresh}
        onOpenConnectionsPanel={handleOpenConnectionsPanel}
        connectionsPanelOpen={showConnectionsPanel}
        onTogglePublishHistoryPanel={() => setShowPublishHistoryPanel(!showPublishHistoryPanel)}
        publishHistoryPanelOpen={showPublishHistoryPanel}
        onToggleValidationPanel={() => setShowValidationPanel(!showValidationPanel)}
        validationPanelOpen={showValidationPanel}
        validationStats={validationStats}
      />

      {/* Resize Handle */}
      <ResizeHandle onResizeStart={handleResizeStart} onResize={handleResize} onResizeEnd={handleResizeEnd} />

      {/* Right panel: validation, publish history, connections, or data grid */}
      {showValidationPanel && localPath ? (
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
          onDataRefresh={onConnectionsChanged ?? onDataRefresh}
          newConnectionId={newConnectionId}
          onNewConnectionConsumed={() => setNewConnectionId(null)}
        />
      ) : (
        <FolderDataGrid
          workspaceId={workspace.id}
          selectedFolderPath={selectedFolderPath}
          workspacePath={localPath}
          targetRecord={targetRecord}
          dataRefreshKey={dataRefreshKey}
          onDataRefresh={onDataRefresh}
          onPublishFile={onPublishFile}
          activateGlobalFilter={activateGlobalFilter}
          onActivateGlobalFilterConsumed={onActivateGlobalFilterConsumed}
          onIndexingProgress={onIndexingProgress}
        />
      )}
    </Box>
  );
}
