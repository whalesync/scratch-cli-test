'use client';

import { ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Regular, Text16Medium, TextMono12Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useFolderFileList } from '@/hooks/use-folder-file-list';
import { genericApiApi } from '@/lib/api/generic-api';
import { Box, Group, Stack } from '@mantine/core';
import type { DataFolder, WorkbookId } from '@spinner/shared-types';
import { FolderIcon, RefreshCw } from 'lucide-react';
import { useState } from 'react';

interface TableDetailProps {
  folder: DataFolder;
  workbookId: WorkbookId;
}

export function TableDetail({ folder, workbookId }: TableDetailProps) {
  const { isLoading, files, dirtyCount } = useFolderFileList(workbookId, folder.id);
  const [isReprobing, setIsReprobing] = useState(false);

  const handleReprobe = async () => {
    setIsReprobing(true);
    try {
      const result = await genericApiApi.reprobe(workbookId, folder.id);
      if (!result.applied) {
        ScratchpadNotifications.warning({
          title: 'Re-probe needs confirmation',
          message: 'The record ID path changed — confirm in the data folder settings before applying.',
          autoClose: false,
        });
        return;
      }
      const added = result.diff.schemaFieldsAdded.length;
      const removed = result.diff.schemaFieldsRemoved.length;
      const summary =
        added === 0 && removed === 0
          ? 'No changes detected.'
          : `${added} field${added === 1 ? '' : 's'} added, ${removed} removed.`;
      ScratchpadNotifications.success({ title: 'Re-probe applied', message: summary });
    } catch (e) {
      ScratchpadNotifications.error({
        title: 'Re-probe failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setIsReprobing(false);
    }
  };

  return (
    <Box p="lg">
      <Stack gap="lg">
        <Group gap="md" justify="space-between" align="flex-start">
          <Group gap="md">
            <Box p="sm" style={{ backgroundColor: 'var(--bg-selected)', borderRadius: 8 }}>
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
          {folder.connectorService === 'GENERIC_API' && (
            <ButtonSecondaryOutline onClick={handleReprobe} disabled={isReprobing}>
              <Group gap={4} wrap="nowrap">
                <RefreshCw size={14} /> {isReprobing ? 'Re-probing…' : 'Re-probe'}
              </Group>
            </ButtonSecondaryOutline>
          )}
        </Group>

        <Stack gap="sm">
          <Group justify="space-between">
            <Text13Regular c="var(--fg-secondary)">Records</Text13Regular>
            <TextMono12Regular>{isLoading ? '...' : files.length}</TextMono12Regular>
          </Group>

          <Group justify="space-between">
            <Text13Regular c="var(--fg-secondary)">Changed</Text13Regular>
            <TextMono12Regular c={dirtyCount > 0 ? 'var(--mantine-color-orange-6)' : undefined}>
              {isLoading ? '...' : dirtyCount}
            </TextMono12Regular>
          </Group>
        </Stack>
      </Stack>
    </Box>
  );
}
