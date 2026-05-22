import { Box } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import type { WorkspaceConnection } from '../../types/local-files';
import { Workspace } from '../../types/workspace';
import { FolderDataGrid } from './FolderDataGrid';
import { ResizeHandle } from './ResizeHandle';
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
  targetRecord?: { filename: string; trigger: string } | null;
  dataRefreshKey: number;
  onDataRefresh: () => void;
  onPublishFile?: (relativePath: string) => void;
  activateGlobalFilter?: { kind: 'unreviewed' | 'unpublished' | 'has-problems'; trigger: number } | null;
  onActivateGlobalFilterConsumed?: () => void;
  validateEnabled?: boolean;
  onIndexingProgress?: (message: string | null) => void;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 280;

export function WorkspaceContent({
  workspace,
  localPath,
  targetRecord,
  dataRefreshKey,
  onDataRefresh,
  onPublishFile,
  activateGlobalFilter,
  onActivateGlobalFilterConsumed,
  validateEnabled = false,
  onIndexingProgress,
}: WorkspaceContentProps) {
  const selectedFolderPath = useWorkspaceUiStore((s) => s.selectedFolderPath);
  const setSelectedFolderPath = useWorkspaceUiStore((s) => s.setSelectedFolderPath);

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
      />

      {/* Resize Handle */}
      <ResizeHandle onResizeStart={handleResizeStart} onResize={handleResize} onResizeEnd={handleResizeEnd} />

      {/* Data grid — memoized so sidebar width changes don't re-render it */}
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
        validate={validateEnabled}
        onIndexingProgress={onIndexingProgress}
      />
    </Box>
  );
}
