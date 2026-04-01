import { Box, Stack } from '@mantine/core';
import { useCallback, useState } from 'react';
import { Workspace } from '../../types/workspace';
import { ResizeHandle } from './ResizeHandle';
import { WorkspaceSidebar } from './WorkspaceSidebar';

interface WorkspaceContentProps {
  workspace: Workspace;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 280;

export function WorkspaceContent({ workspace }: WorkspaceContentProps) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = useCallback(() => {
    setIsResizing(true);
  }, []);

  const handleResize = useCallback((deltaX: number) => {
    setSidebarWidth((prev) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, prev + deltaX)));
  }, []);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

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
        width={sidebarWidth}
        minWidth={MIN_SIDEBAR_WIDTH}
        maxWidth={MAX_SIDEBAR_WIDTH}
      />

      {/* Resize Handle */}
      <ResizeHandle onResizeStart={handleResizeStart} onResize={handleResize} onResizeEnd={handleResizeEnd} />

      {/* Main Content Area */}
      <Stack
        gap={0}
        style={{
          flex: 1,
          minWidth: 0,
          backgroundColor: 'var(--bg-base)',
          border: '0.5px solid var(--fg-divider)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{/* Content will be loaded here */}</Box>
      </Stack>
    </Box>
  );
}
