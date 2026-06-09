'use client';

import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { Box, Stack } from '@mantine/core';
import type { Workspace } from '@spinner/shared-types';
import { usePathname } from 'next/navigation';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { FilesSubToolbar } from './MainPane/FilesSubToolbar';
import { ReviewSubToolbar } from './MainPane/ReviewSubToolbar';
import { Toolbar } from './MainPane/Toolbar';
import { ResizeHandle } from './shared/ResizeHandle';
import { WorkbookErrorAlert } from './shared/WorkbookErrorAlert';
import { FileTree, type FileTreeMode } from './Sidebar/FileTree';
import { NavTabs } from './Sidebar/NavTabs';
import { ProjectSwitcher } from './Sidebar/ProjectSwitcher';
import { SidebarFooter } from './Sidebar/SidebarFooter';
import { SyncsList } from './Sidebar/SyncsList';

interface WorkbookLayoutProps {
  workbook: Workspace;
  children: ReactNode;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 500;

export function WorkbookLayout({ workbook, children }: WorkbookLayoutProps) {
  const pathname = usePathname();
  const sidebarWidth = useWorkbookUIStore((state) => state.sidebarWidth);
  const setSidebarWidth = useWorkbookUIStore((state) => state.setSidebarWidth);

  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Determine sidebar mode from pathname — match only the top-level segment
  // after /workbook/{id}/ to avoid false matches on nested paths like
  // /workbook-repo/syncs/foo.json
  const sidebarMode = useMemo(() => {
    const segment = pathname.split('/').at(3);
    if (segment === 'syncs') return 'syncs';
    if (segment === 'review') return 'review';
    if (segment === 'runs') return 'runs';
    return 'files';
  }, [pathname]);

  const isFilesPage = pathname.split('/').at(3) === 'files';
  const isReviewPage = pathname.includes('/review');

  // File tree mode (only for files/review)
  const fileTreeMode: FileTreeMode = sidebarMode === 'review' ? 'review' : 'files';

  const handleResizeStart = useCallback(() => {
    setIsResizing(true);
  }, []);

  const handleResize = useCallback(
    (deltaX: number) => {
      setSidebarWidth(sidebarWidth + deltaX);
    },
    [sidebarWidth, setSidebarWidth],
  );

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

  return (
    <Box
      ref={containerRef}
      h="100vh"
      style={{
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--bg-panel)',
        userSelect: isResizing ? 'none' : 'auto',
      }}
    >
      {/* Main content area with sidebar and main pane */}
      <Box style={{ display: 'flex', flex: 1, minHeight: 0, padding: 6 }}>
        {/* Sidebar */}
        <Stack
          gap={0}
          style={{
            width: sidebarWidth,
            minWidth: MIN_SIDEBAR_WIDTH,
            maxWidth: MAX_SIDEBAR_WIDTH,
            backgroundColor: 'var(--bg-base)',
            border: '0.5px solid var(--fg-divider)',
            borderRadius: 4,
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {/* Project Switcher */}
          <ProjectSwitcher currentWorkbook={workbook} />

          {/* Navigation Tabs */}
          <NavTabs />

          {/* Sidebar Content */}
          <Box style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {sidebarMode === 'syncs' && <SyncsList workbookId={workbook.id} />}
            {(sidebarMode === 'files' || sidebarMode === 'review') && (
              <FileTree workbook={workbook} mode={fileTreeMode} />
            )}
            {/* Runs mode has no sidebar content */}
          </Box>

          {/* Sidebar Footer */}
          <SidebarFooter />
        </Stack>

        {/* Resize Handle */}
        <ResizeHandle onResizeStart={handleResizeStart} onResize={handleResize} onResizeEnd={handleResizeEnd} />

        {/* Main Pane */}
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
          {/* Toolbar — always rendered */}
          <Toolbar workbookId={workbook.id} />
          {/* Page-specific sub-toolbars */}
          {isFilesPage && <FilesSubToolbar workbookId={workbook.id} />}
          {isReviewPage && <ReviewSubToolbar workbookId={workbook.id} />}
          <WorkbookErrorAlert />
          {/* Content */}
          <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</Box>
        </Stack>
      </Box>
    </Box>
  );
}
