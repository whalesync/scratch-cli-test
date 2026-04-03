import { Box } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
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
  selectedFolderPath: string | null;
  onSelectFolder: (folderPath: string | null) => void;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 280;

export function WorkspaceContent({ workspace, localPath, selectedFolderPath, onSelectFolder }: WorkspaceContentProps) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [localFolders, setLocalFolders] = useState<LocalFolder[]>([]);

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
      onSelectFolder(selectedFolderPath === folderPath ? null : folderPath);
    },
    [selectedFolderPath, onSelectFolder],
  );

  // Load local folders when workspace is downloaded
  useEffect(() => {
    if (!localPath) {
      setLocalFolders([]);
      return;
    }

    let cancelled = false;
    void window.scratchFiles.listFolders(localPath).then((folders) => {
      if (!cancelled) {
        setLocalFolders(folders);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [localPath]);

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
        localFolders={localFolders}
        width={sidebarWidth}
        minWidth={MIN_SIDEBAR_WIDTH}
        maxWidth={MAX_SIDEBAR_WIDTH}
        selectedFolderPath={selectedFolderPath}
        onSelectFolder={handleSelectFolder}
      />

      {/* Resize Handle */}
      <ResizeHandle onResizeStart={handleResizeStart} onResize={handleResize} onResizeEnd={handleResizeEnd} />

      {/* Data grid — memoized so sidebar width changes don't re-render it */}
      <FolderDataGrid selectedFolderPath={selectedFolderPath} workspacePath={localPath} />
    </Box>
  );
}
