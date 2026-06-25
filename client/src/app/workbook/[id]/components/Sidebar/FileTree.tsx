'use client';

import { Text12Regular } from '@/app/components/base/text';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useDirtyFiles } from '@/hooks/use-dirty-files';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { Badge, Box, Group, Loader, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { SCRATCH_GROUP_NAME, type ConnectorAccount, type FileDiffStatus, type Workspace } from '@spinner/shared-types';
import { RefreshCwIcon } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { ReviewConnectionNode } from './ReviewTreeNode';
import { ConnectionNode, EmptyConnectionNode } from './TreeNode';
import { WorkbookRepoNode } from './WorkbookRepoNode';

export type FileTreeMode = 'files' | 'review';

interface FileTreeProps {
  workbook: Workspace;
  mode?: FileTreeMode;
}

const EMPTY_DIRTY_PATHS: ReadonlyMap<string, FileDiffStatus> = new Map();

export function FileTree({ workbook, mode = 'files' }: FileTreeProps) {
  const { dataFolderGroups, isLoading, refresh: refreshDataFolders } = useDataFolders(workbook.id);
  const { connectorAccounts } = useConnectorAccounts(workbook.id);
  const { isAdmin } = useScratchPadUser();
  const expandAll = useWorkbookUIStore((state) => state.expandAll);
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);

  // In review mode, fetch dirty files immediately
  const {
    dirtyFiles,
    isLoading: dirtyFilesLoading,
    refresh: refreshDirtyFiles,
  } = useDirtyFiles(mode === 'review' ? workbook.id : null);

  // Bucket dirty files by connectorAccountId so each connection node only sees
  // its own files. Two connections can have folders with the same path (e.g.
  // /Companies under both Affinity and Attio) — without this scoping the
  // sidebar would show the same file as dirty under both connections.
  const dirtyFilesByConnection = useMemo(() => {
    const byConnection = new Map<string, Map<string, FileDiffStatus>>();
    for (const file of dirtyFiles) {
      let inner = byConnection.get(file.connectorAccountId);
      if (!inner) {
        inner = new Map();
        byConnection.set(file.connectorAccountId, inner);
      }
      inner.set(file.path, file.status);
    }
    return byConnection;
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

  // Total record count across every data folder in the workbook, for the status line at the bottom
  // of the tree. Git-sourced per-folder counts, so this can briefly lag local edits between refreshes.
  const totalRecordCount = useMemo(
    () =>
      dataFolderGroups.reduce(
        (groupSum, group) =>
          groupSum + group.dataFolders.reduce((folderSum, folder) => folderSum + folder.recordCount, 0),
        0,
      ),
    [dataFolderGroups],
  );
  const hasConnections = (connectorAccounts?.length ?? 0) > 0;

  // Auto-expand all connection nodes once, on the first render where connection
  // data is available. This must run at most once per mount: using
  // `expandedNodes.size === 0` alone as the trigger is wrong because that
  // condition is also true the instant a user collapses the *last* expanded
  // connection — which would silently re-expand everything (DEV bug: collapsing
  // the second of two connections re-opened the first). The ref guards against
  // that by marking initialization complete as soon as the data has loaded,
  // whether or not we actually expanded anything.
  const hasRunInitialConnectionAutoExpand = useRef(false);
  useEffect(() => {
    if (hasRunInitialConnectionAutoExpand.current) return;
    if (sortedGroups.length === 0 && emptyConnectorAccounts.length === 0) return; // wait for data to load
    hasRunInitialConnectionAutoExpand.current = true;
    // Respect any previously persisted expand/collapse state; only auto-expand
    // when the user has no saved state at all (e.g. a brand-new workbook).
    if (expandedNodes.size === 0) {
      const allConnectionIds = [
        ...sortedGroups.map((group) => `connection-${group.dataFolders[0]?.connectorAccountId ?? group.name}`),
        ...emptyConnectorAccounts.map((account) => `connection-${account.id}`),
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

  // Review mode: loading and empty states
  if (mode === 'review' && dirtyFilesLoading) {
    return (
      <Box p="md" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Loader size={14} />
        <Text size="sm" c="dimmed">
          Loading edited files...
        </Text>
      </Box>
    );
  }

  if (mode === 'review' && !dirtyFilesLoading && dirtyFiles.length === 0) {
    return (
      <Box p="md">
        <Text size="sm">Nothing to review</Text>
        <Text size="sm" c="dimmed">
          Push changes from the CLI, run a sync, or edit files to see them here
        </Text>
      </Box>
    );
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
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
              <UnstyledButton
                onClick={mode === 'review' ? refreshDirtyFiles : refreshDataFolders}
                style={{ opacity: 0.4, padding: 2 }}
                title="Refresh"
              >
                <RefreshCwIcon size={12} />
              </UnstyledButton>
            </Group>
          </Box>

          {/* Workspace repo browser (admin only) */}
          {mode === 'files' && isAdmin && <WorkbookRepoNode workbookId={workbook.id} />}

          {/* Data folder groups (connections with tables) */}
          {sortedGroups.map((group) => {
            const connectorAccountId = group.dataFolders[0]?.connectorAccountId;
            const connectorAccount = connectorAccountId ? connectorAccountMap.get(connectorAccountId) : undefined;
            const key = connectorAccountId ? `${group.name}-${connectorAccountId}` : group.name;

            if (mode === 'review') {
              // Scratch group has no connectorAccountId; its dirty files (none today) would
              // come from the workbook config repo and are not aggregated here.
              const groupDirtyPaths = connectorAccountId
                ? (dirtyFilesByConnection.get(connectorAccountId) ?? EMPTY_DIRTY_PATHS)
                : EMPTY_DIRTY_PATHS;
              return (
                <ReviewConnectionNode
                  key={key}
                  group={group}
                  workbookId={workbook.id}
                  connectorAccount={connectorAccount}
                  connectorAccountId={connectorAccountId ?? undefined}
                  dirtyFilePaths={groupDirtyPaths}
                />
              );
            }

            return (
              <ConnectionNode key={key} group={group} workbookId={workbook.id} connectorAccount={connectorAccount} />
            );
          })}

          {/* Empty connector accounts (connections without tables yet) — files mode only */}
          {mode === 'files' &&
            emptyConnectorAccounts.map((account) => (
              <EmptyConnectionNode key={account.id} connectorAccount={account} workbookId={workbook.id} />
            ))}
        </Stack>
      </ScrollArea>
      {mode === 'files' && hasConnections && (
        <Box px="sm" py={6} style={{ borderTop: '1px solid var(--fg-divider)', flexShrink: 0 }}>
          <Text12Regular c="var(--fg-muted)" ta="right">
            {totalRecordCount.toLocaleString()} record{totalRecordCount === 1 ? '' : 's'}
          </Text12Regular>
        </Box>
      )}
    </Box>
  );
}
