'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { Text13Medium } from '@/app/components/base/text';
import { Box, Group, Stack, Text } from '@mantine/core';
import type { DataFolder } from '@spinner/shared-types';
import { useMemo } from 'react';

interface SyncJsonReferencePanelProps {
  jsonContent: string;
  allFolders: DataFolder[];
}

export function SyncJsonReferencePanel({ jsonContent, allFolders }: SyncJsonReferencePanelProps) {
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

  if (referencedFolders.length === 0) return null;

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
      <Text13Medium mb="xs">Referenced Folders</Text13Medium>
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
    </Box>
  );
}
