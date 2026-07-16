'use client';

import { ButtonCompactSecondary } from '@/app/components/base/buttons';
import { Text12Regular, Text13Regular, TextMono12Regular } from '@/app/components/base/text';
import { useFolderFileListPaginated } from '@/hooks/use-folder-file-list-paginated';
import { useReviewToolbarStore } from '@/stores/review-toolbar-store';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { Box, Group, SimpleGrid, Stack, TextInput, UnstyledButton } from '@mantine/core';
import type { DataFolderId, FileRefEntity, WorkbookId } from '@spinner/shared-types';
import { FileIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ScratchFolderBrowser } from './ScratchFolderBrowser';

const PAGE_SIZE = 200;
const COLUMN_COUNT = 3;

interface FolderViewerProps {
  workbookId: WorkbookId;
  folderId: DataFolderId;
  folderName?: string;
  mode?: 'files' | 'review';
  connectorAccountId?: string;
  /** DataFolder.path — present for scratch folders, which use a nested path browser (DEV-10424). */
  folderPath?: string;
}

export function FolderViewer({
  workbookId,
  folderId,
  folderName,
  mode = 'files',
  connectorAccountId,
  folderPath,
}: FolderViewerProps) {
  // Standalone scratch folders (no connector) browse files AND subdirectories from the scratch repo;
  // connector folders keep the flat record-grid view below.
  if (!connectorAccountId && folderPath && mode !== 'review') {
    return (
      <ScratchFolderBrowser
        workbookId={workbookId}
        folderId={folderId}
        folderPath={folderPath}
        folderName={folderName}
      />
    );
  }
  return (
    <FolderRecordGrid
      workbookId={workbookId}
      folderId={folderId}
      folderName={folderName}
      mode={mode}
      connectorAccountId={connectorAccountId}
    />
  );
}

function FolderRecordGrid({
  workbookId,
  folderId,
  folderName,
  mode = 'files',
  connectorAccountId,
}: Omit<FolderViewerProps, 'folderPath'>) {
  const {
    files: allFiles,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
  } = useFolderFileListPaginated(workbookId, folderId, PAGE_SIZE);
  const [searchQuery, setSearchQuery] = useState('');
  const setSummary = useReviewToolbarStore((state) => state.setSummary);
  const showHiddenConnections = useWorkbookUIStore((state) => state.showHiddenConnections);
  const showHidden = connectorAccountId ? showHiddenConnections.has(connectorAccountId) : false;

  // Filter hidden files (dotfiles) unless the user opted to show them
  const files = useMemo(
    () => (showHidden ? allFiles : allFiles.filter((f) => !f.name.startsWith('.'))),
    [allFiles, showHidden],
  );

  // Filter to only files, optionally filter to dirty only in review mode, apply search
  const displayedFiles = useMemo(() => {
    let fileItems = files.filter((f): f is FileRefEntity => f.type === 'file');

    // In review mode, only show dirty files
    if (mode === 'review') {
      fileItems = fileItems.filter((f) => f.status === 'modified' || f.status === 'added');
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      fileItems = fileItems.filter((f) => f.name.toLowerCase().includes(query));
    }

    return fileItems;
  }, [files, mode, searchQuery]);

  // In review mode, push the summary into the toolbar store
  useEffect(() => {
    if (mode === 'review') {
      const count = files.length;
      const summary = folderName
        ? `${folderName} - ${count}${hasMore ? '+' : ''} ${count === 1 && !hasMore ? 'file' : 'files'}`
        : null;
      setSummary(summary);
      return () => setSummary(null);
    }
  }, [mode, folderName, files.length, hasMore, setSummary]);

  if (isLoading && files.length === 0) {
    return (
      <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Text13Regular c="dimmed">Loading folder contents...</Text13Regular>
      </Box>
    );
  }

  if (displayedFiles.length === 0 && !searchQuery) {
    return (
      <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Text13Regular c="dimmed">This folder is empty</Text13Regular>
      </Box>
    );
  }

  return (
    <Stack h="100%" gap={0}>
      {/* Header (files mode only — in review mode the summary is in the toolbar) */}
      {mode !== 'review' && (
        <Group
          h={36}
          px="md"
          justify="space-between"
          style={{
            borderBottom: '0.5px solid var(--fg-divider)',
            flexShrink: 0,
            backgroundColor: 'var(--bg-base)',
          }}
        >
          <Text12Regular c="var(--fg-muted)">
            {folderName ? `${folderName} - ` : ''}
            {files.length.toLocaleString()}
            {hasMore ? '+' : ''} {files.length === 1 && !hasMore ? 'file' : 'files'}
          </Text12Regular>
          {hasMore && (
            <ButtonCompactSecondary onClick={loadMore} disabled={isLoadingMore}>
              {isLoadingMore ? 'Loading...' : 'Load more'}
            </ButtonCompactSecondary>
          )}
        </Group>
      )}

      {/* File grid */}
      <Box style={{ flex: 1, overflow: 'auto' }} p="md">
        {displayedFiles.length === 0 ? (
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Text13Regular c="dimmed">No files match &ldquo;{searchQuery}&rdquo;</Text13Regular>
          </Box>
        ) : (
          <SimpleGrid cols={COLUMN_COUNT} spacing="xs" verticalSpacing="xs">
            {displayedFiles.map((file) => (
              <FileCard key={file.path} file={file} workbookId={workbookId} mode={mode} />
            ))}
          </SimpleGrid>
        )}
      </Box>
      <Group
        h={36}
        px="md"
        justify="flex-end"
        style={{
          borderTop: '0.5px solid var(--fg-divider)',
          flexShrink: 0,
          backgroundColor: 'var(--bg-base)',
        }}
      >
        <TextInput
          size="xs"
          placeholder="Filter files..."
          leftSection={<SearchIcon size={12} />}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
        />
      </Group>
    </Stack>
  );
}

interface FileCardProps {
  file: FileRefEntity;
  workbookId: WorkbookId;
  mode?: 'files' | 'review';
}

function FileCard({ file, workbookId, mode = 'files' }: FileCardProps) {
  const encodedPath = file.path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const routeBase = mode === 'review' ? 'review' : 'files';
  const href = `/workbook/${workbookId}/${routeBase}/${encodedPath}`;

  // Determine if file is dirty
  const isDirty = file.status === 'modified' || file.status === 'added';
  const isDeleted = file.status === 'deleted';

  const indicatorColor = isDeleted
    ? 'var(--mantine-color-red-6)'
    : file.status === 'added'
      ? 'var(--mantine-color-green-6)'
      : 'var(--mantine-color-orange-6)';
  const indicatorSymbol = isDeleted ? '×' : file.status === 'added' ? '+' : '•';

  return (
    <Link href={href} style={{ textDecoration: 'none' }}>
      <UnstyledButton
        p="xs"
        style={{
          width: '100%',
          backgroundColor: 'var(--bg-panel)',
          borderRadius: 4,
          border: '1px solid var(--fg-divider)',
        }}
        styles={{
          root: {
            '&:hover': {
              backgroundColor: 'var(--bg-selected)',
            },
          },
        }}
      >
        <Group gap="xs" wrap="nowrap">
          {/* Dirty indicator */}
          {isDirty || isDeleted ? (
            <Box
              style={{
                width: 8,
                height: 8,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                fontWeight: 700,
                lineHeight: 1,
                color: indicatorColor,
              }}
            >
              {indicatorSymbol}
            </Box>
          ) : (
            <FileIcon size={12} color="var(--fg-muted)" style={{ flexShrink: 0 }} />
          )}
          <TextMono12Regular c="var(--fg-primary)" truncate style={{ flex: 1 }}>
            {file.name}
          </TextMono12Regular>
        </Group>
      </UnstyledButton>
    </Link>
  );
}
