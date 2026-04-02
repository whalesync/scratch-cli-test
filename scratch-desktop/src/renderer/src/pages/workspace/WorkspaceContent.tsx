import { Box, Loader, Stack, Text } from '@mantine/core';
import { File } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { Workspace } from '../../types/workspace';
import { ResizeHandle } from './ResizeHandle';
import { WorkspaceSidebar } from './WorkspaceSidebar';

interface FileEntry {
  name: string;
  path: string;
  size: number;
  lastModified: number;
  extension: string;
  isJson: boolean;
}

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
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 280;

interface FileListPanelProps {
  selectedFolderPath: string | null;
  files: FileEntry[];
  loadingFiles: boolean;
  filesError: string | null;
}

const FileListPanel = memo(function FileListPanel({
  selectedFolderPath,
  files,
  loadingFiles,
  filesError,
}: FileListPanelProps) {
  return (
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
      <Box style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
        {!selectedFolderPath && (
          <Text size="sm" c="dimmed">
            Select a folder to view files
          </Text>
        )}
        {loadingFiles && <Loader size="sm" />}
        {filesError && (
          <Text size="sm" c="red">
            {filesError}
          </Text>
        )}
        {!loadingFiles && !filesError && selectedFolderPath && files.length === 0 && (
          <Text size="sm" c="dimmed">
            No files in this folder
          </Text>
        )}
        {!loadingFiles &&
          !filesError &&
          files.map((file) => (
            <Box
              key={file.path}
              py={4}
              px={8}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                borderRadius: 4,
              }}
            >
              <File size={14} color="var(--fg-secondary)" />
              <Text size="sm">{file.name}</Text>
            </Box>
          ))}
      </Box>
    </Stack>
  );
});

export function WorkspaceContent({ workspace, localPath }: WorkspaceContentProps) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [localFolders, setLocalFolders] = useState<LocalFolder[]>([]);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const handleResizeStart = useCallback(() => {
    setIsResizing(true);
  }, []);

  const handleResize = useCallback((deltaX: number) => {
    setSidebarWidth((prev) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, prev + deltaX)));
  }, []);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

  const handleSelectFolder = useCallback((folderPath: string) => {
    setSelectedFolderPath((prev) => (prev === folderPath ? null : folderPath));
  }, []);

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

  // Load files when a folder is selected
  useEffect(() => {
    if (!selectedFolderPath) {
      setFiles([]);
      return;
    }

    let cancelled = false;
    setLoadingFiles(true);
    setFilesError(null);

    window.scratchFiles
      .listFiles(selectedFolderPath, { offset: 0, limit: 500 })
      .then((result) => {
        if (!cancelled) {
          setFiles(result.files);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setFilesError(err instanceof Error ? err.message : 'Failed to list files');
          setFiles([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingFiles(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFolderPath]);

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

      {/* File list — memoized so sidebar width changes don't re-render it */}
      <FileListPanel
        selectedFolderPath={selectedFolderPath}
        files={files}
        loadingFiles={loadingFiles}
        filesError={filesError}
      />
    </Box>
  );
}
