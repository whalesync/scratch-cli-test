'use client';

import { Text12Regular } from '@/app/components/base/text';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { useDataFolders } from '@/hooks/use-data-folders';
import type { DirtyFile } from '@/hooks/use-dirty-files';
import { useDirtyFiles } from '@/hooks/use-dirty-files';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { Badge, Box, Group, Loader, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import type { ConnectorAccount, Workbook } from '@spinner/shared-types';
import { RefreshCwIcon } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { ConnectionNode, EmptyConnectionNode } from './TreeNode';

export type FileTreeMode = 'files' | 'review';

interface FileTreeProps {
  workbook: Workbook;
  mode?: FileTreeMode;
}

export type { DirtyFile };

const SCRATCH_GROUP_NAME = 'Scratch';

export function FileTree({ workbook, mode = 'files' }: FileTreeProps) {
  const { dataFolderGroups, isLoading, refresh: refreshDataFolders } = useDataFolders(workbook.id);
  const { connectorAccounts } = useConnectorAccounts(workbook.id);
  const expandAll = useWorkbookUIStore((state) => state.expandAll);
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);

  // In review mode, fetch dirty files immediately
  const { dirtyFiles, isLoading: dirtyFilesLoading } = useDirtyFiles(mode === 'review' ? workbook.id : null);

  // Create a map of dirty file paths to their status for quick lookup
  const dirtyFilePaths = useMemo(() => {
    return new Map(dirtyFiles.map((f) => [f.path, f.status]));
  }, [dirtyFiles]);

  // Sort groups: Scratch first, then alphabetically by name
  const sortedGroups = useMemo(
    () =>
      [...dataFolderGroups].sort((a, b) => {
        if (a.name === SCRATCH_GROUP_NAME) return -1;
        if (b.name === SCRATCH_GROUP_NAME) return 1;
        return a.name.localeCompare(b.name);
      }),
    [dataFolderGroups],
  );

  // Create a map from connectorAccountId to ConnectorAccount for fast lookup
  const connectorAccountMap = useMemo(() => {
    const map = new Map<string, ConnectorAccount>();
    connectorAccounts?.forEach((account) => {
      map.set(account.id, account);
    });
    return map;
  }, [connectorAccounts]);

  // Find connector accounts that don't have any data folders yet
  const emptyConnectorAccounts = useMemo(() => {
    if (!connectorAccounts) return [];

    // Get the set of connector account IDs that have data folders
    const connectorIdsWithFolders = new Set<string>();
    dataFolderGroups.forEach((group) => {
      group.dataFolders.forEach((folder) => {
        if (folder.connectorAccountId) {
          connectorIdsWithFolders.add(folder.connectorAccountId);
        }
      });
    });

    // Return connector accounts that don't have any data folders
    return connectorAccounts.filter((account) => !connectorIdsWithFolders.has(account.id));
  }, [connectorAccounts, dataFolderGroups]);

  // Auto-expand all connection nodes on initial load
  useEffect(() => {
    if ((sortedGroups.length > 0 || emptyConnectorAccounts.length > 0) && expandedNodes.size === 0) {
      const allConnectionIds = [
        ...sortedGroups.map((group) => `connection-${group.name}`),
        ...emptyConnectorAccounts.map((account) => `connection-${account.displayName || account.id}`),
      ];
      expandAll(allConnectionIds);
    }
  }, [sortedGroups, emptyConnectorAccounts, expandedNodes.size, expandAll]);

  if (isLoading && dataFolderGroups.length === 0) {
    return (
      <Box p="md">
        <Box c="dimmed" fz="sm">
          Loading...
        </Box>
      </Box>
    );
  }

  // Determine which content to render
  let content: React.ReactNode;

  if (mode === 'review' && dirtyFilesLoading) {
    content = (
      <Box p="md" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Loader size={14} />
        <Text size="sm" c="dimmed">
          Loading edited files...
        </Text>
      </Box>
    );
  } else if (mode === 'review' && !dirtyFilesLoading && dirtyFiles.length === 0) {
    content = (
      <Box p="md">
        <Text size="sm">Nothing to review</Text>
        <Text size="sm" c="dimmed">
          Push changes from the CLI, run a sync, or edit files to see them here
        </Text>
      </Box>
    );
  } else {
    content = (
      <ScrollArea h="100%" type="auto">
        <Stack gap={0} py="xs">
          {/* Section title */}
          <Box px="sm" py={4} mb={4}>
            <Group justify="space-between" align="center">
              <Group gap={6} align="center">
                <Text12Regular
                  c="var(--fg-muted)"
                  style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.5px' }}
                >
                  {mode === 'review' ? 'Edited files' : 'All files'}
                </Text12Regular>
                {mode === 'review' && dirtyFiles.length > 0 && (
                  <Badge size="sm" variant="filled" color="orange" radius="xl">
                    {dirtyFiles.length}
                  </Badge>
                )}
              </Group>
              {mode !== 'review' && (
                <UnstyledButton onClick={refreshDataFolders} style={{ opacity: 0.4, padding: 2 }} title="Refresh">
                  <RefreshCwIcon size={12} />
                </UnstyledButton>
              )}
            </Group>
          </Box>

          {/* Data folder groups (connections with tables) */}
          {sortedGroups.map((group) => {
            // Find the connector account for this group (from first data folder)
            const connectorAccountId = group.dataFolders[0]?.connectorAccountId;
            const connectorAccount = connectorAccountId ? connectorAccountMap.get(connectorAccountId) : undefined;

            return (
              <ConnectionNode
                key={connectorAccountId ? `${group.name}-${connectorAccountId}` : group.name}
                group={group}
                workbookId={workbook.id}
                connectorAccount={connectorAccount}
                mode={mode}
                dirtyFilePaths={dirtyFilePaths}
              />
            );
          })}

          {/* Empty connector accounts (connections without tables yet) */}
          {mode === 'files' &&
            emptyConnectorAccounts.map((account) => (
              <EmptyConnectionNode key={account.id} connectorAccount={account} workbookId={workbook.id} />
            ))}
        </Stack>
      </ScrollArea>
    );
  }

  return <>{content}</>;
}
