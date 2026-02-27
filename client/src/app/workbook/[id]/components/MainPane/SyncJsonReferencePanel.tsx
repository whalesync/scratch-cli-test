'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { Text13Medium } from '@/app/components/base/text';
import { Box, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import type { DataFolder } from '@spinner/shared-types';
import { ClipboardCopy } from 'lucide-react';
import { useMemo } from 'react';

interface SyncJsonReferencePanelProps {
  jsonContent: string;
  allFolders: DataFolder[];
  hasLinkedFolders: boolean;
  aiContextCopying: boolean;
  onCopyAiContext: () => void;
}

export function SyncJsonReferencePanel({
  jsonContent,
  allFolders,
  hasLinkedFolders,
  aiContextCopying,
  onCopyAiContext,
}: SyncJsonReferencePanelProps) {
  const referencedFolders = useMemo(() => {
    try {
      const parsed = JSON.parse(jsonContent);
      if (!parsed?.tableMappings || !Array.isArray(parsed.tableMappings)) return [];

      const folderIds = new Set<string>();
      for (const tm of parsed.tableMappings) {
        if (typeof tm.sourceDataFolderId === 'string') folderIds.add(tm.sourceDataFolderId);
        if (typeof tm.destinationDataFolderId === 'string') folderIds.add(tm.destinationDataFolderId);
      }

      return Array.from(folderIds)
        .map((id) => {
          const folder = allFolders.find((f) => f.id === id);
          return { id, folder };
        })
        .filter((entry) => entry.folder);
    } catch {
      return [];
    }
  }, [jsonContent, allFolders]);

  return (
    <Box
      w={240}
      p="sm"
      style={{
        borderLeft: '1px solid var(--fg-divider)',
        flexShrink: 0,
        overflow: 'auto',
      }}
    >
      <Stack gap="md">
        <Tooltip
          label={
            hasLinkedFolders
              ? 'Copy workbook context for an AI agent'
              : 'Link at least one folder before using AI assist'
          }
        >
          <Box>
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<ClipboardCopy size={12} />}
              disabled={!hasLinkedFolders}
              loading={aiContextCopying}
              onClick={onCopyAiContext}
              fullWidth
            >
              Copy for AI
            </Button>
          </Box>
        </Tooltip>

        {referencedFolders.length > 0 && (
          <>
            <Text13Medium>Referenced Folders</Text13Medium>
            <Stack gap="xs">
              {referencedFolders.map(({ id, folder }) => (
                <Group key={id} gap="xs" wrap="nowrap">
                  <ConnectorIcon connector={folder!.connectorService} size={16} p={0} style={{ flexShrink: 0 }} />
                  <Box style={{ minWidth: 0 }}>
                    <Text size="xs" truncate>
                      {folder!.name}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace" truncate>
                      {id}
                    </Text>
                  </Box>
                </Group>
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Box>
  );
}
