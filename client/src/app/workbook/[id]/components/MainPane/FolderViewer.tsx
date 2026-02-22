'use client';

import { ButtonCompactSecondary } from '@/app/components/base/buttons';
import { Text12Regular, Text13Regular, TextMono12Regular } from '@/app/components/base/text';
import { useFolderFileList } from '@/hooks/use-folder-file-list';
import { Box, Group, SimpleGrid, Stack, TextInput, UnstyledButton } from '@mantine/core';
import type { DataFolderId, FileRefEntity, WorkbookId } from '@spinner/shared-types';
import { FileIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

const INITIAL_LIMIT = 300;
const COLUMN_COUNT = 3;

interface FolderViewerProps {
  workbookId: WorkbookId;
  folderId: DataFolderId;
  folderName?: string;
  mode?: 'files' | 'review';
}

export function FolderViewer({ workbookId, folderId, folderName, mode = 'files' }: FolderViewerProps) {
  const { files, isLoading } = useFolderFileList(workbookId, folderId);
  const [showAll, setShowAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Filter to only files, optionally filter to dirty only in review mode, apply search, and apply limit
  const { displayedFiles, totalCount, hasMore } = useMemo(() => {
    let fileItems = files.filter((f): f is FileRefEntity => f.type === 'file');

    // In review mode, only show dirty files
    if (mode === 'review') {
      fileItems = fileItems.filter((f) => f.status === 'modified' || f.status === 'added');
    }

    const total = fileItems.length;

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      fileItems = fileItems.filter((f) => f.name.toLowerCase().includes(query));
    }

    const limited = showAll ? fileItems : fileItems.slice(0, INITIAL_LIMIT);
    return {
      displayedFiles: limited,
      totalCount: total,
      hasMore: total > INITIAL_LIMIT && !showAll,
    };
  }, [files, showAll, mode, searchQuery]);

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
      {/* Header */}
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
          {totalCount} {totalCount === 1 ? 'file' : 'files'}
        </Text12Regular>
        {hasMore && (
          <ButtonCompactSecondary onClick={() => setShowAll(true)}>
            Load all ({totalCount - INITIAL_LIMIT} more)
          </ButtonCompactSecondary>
        )}
      </Group>

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
