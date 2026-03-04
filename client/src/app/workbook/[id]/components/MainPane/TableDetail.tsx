'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text13Regular, Text16Medium, TextMono12Regular } from '@/app/components/base/text';
import { useFolderFileList } from '@/hooks/use-folder-file-list';
import { Box, Group, Stack } from '@mantine/core';
import type { DataFolder, WorkbookId } from '@spinner/shared-types';
import { FolderIcon } from 'lucide-react';
import { useMemo } from 'react';

interface TableDetailProps {
  folder: DataFolder;
  workbookId: WorkbookId;
}

export function TableDetail({ folder, workbookId }: TableDetailProps) {
  const { files, isLoading } = useFolderFileList(workbookId, folder.id);

  const stats = useMemo(() => {
    const fileItems = files.filter((f) => f.type === 'file');
    const dirtyCount = fileItems.filter((f) => f.status === 'modified' || f.status === 'added').length;

    return {
      totalFiles: fileItems.length,
      dirtyCount,
    };
  }, [files]);

  return (
    <Box p="lg">
      <Stack gap="lg">
        {/* Header */}
        <Group gap="md">
          <Box
            p="sm"
            style={{
              backgroundColor: 'var(--bg-selected)',
              borderRadius: 8,
            }}
          >
            <StyledLucideIcon Icon={FolderIcon} size="lg" c="var(--fg-secondary)" />
          </Box>

          <Stack gap={4}>
            <Text16Medium>{folder.name}</Text16Medium>
            {folder.path && (
              <TextMono12Regular c="var(--fg-muted)" style={{ fontSize: 11 }}>
                {folder.path}
              </TextMono12Regular>
            )}
          </Stack>
        </Group>

        {/* Stats */}
        <Stack gap="sm">
          <Group justify="space-between">
            <Text13Regular c="var(--fg-secondary)">Records</Text13Regular>
            <TextMono12Regular>{isLoading ? '...' : stats.totalFiles}</TextMono12Regular>
          </Group>

          <Group justify="space-between">
            <Text13Regular c="var(--fg-secondary)">Changed</Text13Regular>
            <TextMono12Regular c={stats.dirtyCount > 0 ? 'var(--mantine-color-orange-6)' : undefined}>
              {isLoading ? '...' : stats.dirtyCount}
            </TextMono12Regular>
          </Group>
        </Stack>
      </Stack>
    </Box>
  );
}
