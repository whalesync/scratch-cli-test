'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { PulsingIcon } from '@/app/components/Icons/PulsingIcon';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { Text12Medium, Text12Regular, TextMono12Regular } from '@/app/components/base/text';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useFolderFileListPaginated } from '@/hooks/use-folder-file-list-paginated';
import { dataFolderApi } from '@/lib/api/data-folder';
import { filesApi } from '@/lib/api/files';
import { workbookApi } from '@/lib/api/workbook';
import { trackPullFilesFromSource } from '@/lib/posthog';
import { selectJobsForConnector, useActiveJobsStore } from '@/stores/active-jobs-store';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { Badge, Box, Collapse, Group, Stack, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IncrementalPullSupport,
  type ConnectorAccount,
  type DataFolder,
  type DataFolderGroup,
  type DataFolderId,
  type DataFolderOptions,
  type FileRefEntity,
  type WorkbookId,
} from '@spinner/shared-types';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CloudCogIcon,
  CloudDownloadIcon,
  DownloadIcon,
  Edit2Icon,
  EyeIcon,
  EyeOffIcon,
  FileJsonIcon,
  FilePlusIcon,
  FlaskRoundIcon,
  FolderIcon,
  FolderLockIcon,
  ImageIcon,
  InfoIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  RouteIcon,
  SettingsIcon,
  StickyNoteIcon,
  Trash2Icon,
  UnlinkIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import React, { useCallback, useMemo, useState, type MouseEvent } from 'react';
import useSWR from 'swr';
import { useShallow } from 'zustand/react/shallow';
import { AssetIndexModal } from '../modals/AssetIndexModal';
import { PublishPlansModal } from '../modals/PublishPlansModal';
import { TestTransformerModal } from '../modals/TestTransformerModal';
import { AdvancedFolderSettingsModal } from '../shared/AdvancedFolderSettingsModal';
import { ChooseTablesModal } from '../shared/ChooseTablesModal';
import { ConnectionContextMenu } from '../shared/ConnectionContextMenu';
import { ContextMenu, type ContextMenuItem } from '../shared/ContextMenu';
import { DataFolderInfoModal } from '../shared/DataFolderInfoModal';
import { DataFolderSchemaModal } from '../shared/DataFolderSchemaModal';
import { DeleteAllRecordsModal } from '../shared/DeleteAllRecordsModal';
import { NewFileModal } from '../shared/NewFileModal';
import { PullAssetsModal } from '../shared/PullAssetsModal';
import { PullScheduleModal } from '../shared/PullScheduleModal';
import { RemoveFileModal } from '../shared/RemoveFileModal';
import { RemoveTableModal } from '../shared/RemoveTableModal';
import { RenameFileModal } from '../shared/RenameFileModal';
import { ActiveDataFolderJobIndicator } from './ActiveDataFolderJobIndicator';

const SCRATCH_GROUP_NAME = 'Scratch';
const FILE_LIMIT = 200;
const INDENT_PX = 10;

/**
 * Builds the pull context-menu items for a single linked table based on its
 * server-computed {@link IncrementalPullSupport}.
 *
 * Incremental pull is the default action ("Pull this table"), with an explicit
 * "Pull this table - Full refresh" item that always forces a full pull. When incremental
 * pulls are not yet possible the incremental item is rendered disabled with a
 * distinct suffix — so the user knows whether configuring a last-modified field
 * would unlock it — and the full pull becomes the default (first) action. In that
 * case the full pull is the only valid option, so it is labelled plainly "Pull this
 * table" (no "- Full refresh" qualifier).
 */
function buildTablePullMenuItems(
  incrementalPullSupport: IncrementalPullSupport,
  icon: ContextMenuItem['icon'],
  onPullIncremental: () => void,
  onPullFull: () => void,
): ContextMenuItem[] {
  switch (incrementalPullSupport) {
    case IncrementalPullSupport.SUPPORTED:
      return [
        { label: 'Pull this table', icon, onClick: onPullIncremental },
        { label: 'Pull this table - Full refresh', icon, onClick: onPullFull },
      ];
    case IncrementalPullSupport.NEEDS_CONFIGURATION:
      // Full is the only valid pull here, so drop the "- Full refresh" qualifier — it is simply "the" pull.
      return [
        { label: 'Pull this table', icon, onClick: onPullFull },
        { label: 'Pull this table - Incremental (Needs Configuration)', icon, disabled: true },
      ];
    case IncrementalPullSupport.NOT_SUPPORTED:
    default:
      // Full is the only valid pull here, so drop the "- Full refresh" qualifier — it is simply "the" pull.
      return [
        { label: 'Pull this table', icon, onClick: onPullFull },
        { label: 'Pull this table - Incremental (Not Supported)', icon, disabled: true },
      ];
  }
}

// ============================================================================
// Intermediate folder helpers
// ============================================================================

/**
 * Extract all intermediate path segments from a folder path.
 * Handles both old format `/ConnectionName/schema/Table` and new format `/schema/Table`.
 * If connectionName is provided and the first segment matches, it is stripped (old format).
 * The last segment (table name) is always excluded.
 * Example old: `/Supabase1/public/tableA` → `["public"]`
 * Example new: `/public/tableA` → `["public"]`
 */
function getIntermediateSegments(folderPath: string, connectionName?: string): string[] {
  const segments = folderPath.replace(/^\//, '').split('/');
  const adjusted =
    connectionName && segments[0] === connectionName
      ? segments.slice(1) // old format: drop connection-name prefix
      : segments; // new format: use as-is
  if (adjusted.length <= 1) return [];
  return adjusted.slice(0, -1);
}

interface FolderTreeNode {
  folders: DataFolder[];
  children: Map<string, FolderTreeNode>;
}

/** Group a flat DataFolder[] into a tree based on intermediate path segments. */
function buildFolderTree(folders: DataFolder[], groupName: string): FolderTreeNode {
  const root: FolderTreeNode = { folders: [], children: new Map() };

  for (const folder of folders) {
    const segments = getIntermediateSegments(
      folder.path ?? `/${groupName}/${folder.name}`,
      folder.connectorDisplayName ?? groupName,
    );
    let node = root;
    for (const seg of segments) {
      let child = node.children.get(seg);
      if (!child) {
        child = { folders: [], children: new Map() };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.folders.push(folder);
  }

  return root;
}

// ============================================================================
// Intermediate Folder Node (collapsible path segment)
// ============================================================================

interface IntermediateFolderNodeProps {
  name: string;
  nodeId: string;
  depth: number;
  children: React.ReactNode;
}

function IntermediateFolderNode({ name, nodeId, depth, children }: IntermediateFolderNodeProps) {
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);
  const isExpanded = expandedNodes.has(nodeId);

  const handleToggle = useCallback(() => {
    toggleNode(nodeId);
  }, [toggleNode, nodeId]);

  return (
    <>
      <UnstyledButton
        onClick={handleToggle}
        px="sm"
        py={4}
        style={{
          width: `calc(100% - ${INDENT_PX * depth}px)`,
          marginLeft: INDENT_PX * depth,
          backgroundColor: 'transparent',
          // Reserve the same 3px the TableNode selection indicator uses, so
          // intermediate folders and tables align horizontally as siblings.
          // Intermediate folders aren't selectable, so this is always transparent.
          borderLeft: '3px solid transparent',
        }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap">
          <StyledLucideIcon Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-secondary)" />
          <StyledLucideIcon Icon={FolderIcon} size={14} c="var(--fg-secondary)" />
          <Text12Regular c="var(--fg-primary)" truncate>
            {name}
          </Text12Regular>
        </Group>
      </UnstyledButton>
      <Collapse in={isExpanded}>{children}</Collapse>
    </>
  );
}

// ============================================================================
// Folder Tree Renderer (recursive)
// ============================================================================

interface FolderTreeRendererProps {
  tree: FolderTreeNode;
  depth: number;
  groupName: string;
  workbookId: WorkbookId;
  /** Prefix of ancestor segment names for building unique node IDs */
  idPrefix: string;
}

function FolderTreeRenderer({ tree, depth, groupName, workbookId, idPrefix }: FolderTreeRendererProps) {
  // Merge intermediate folders and terminal tables into one list at each level
  // and sort alphabetically by name. Without this, intermediate folders would
  // always render before tables (purely from iteration order), which gives a
  // counter-intuitive sort for connectors that mix the two shapes — e.g.
  // Affinity has tenant-wide tables (Companies/People/Opportunities) at the
  // root *and* a "Lists/" intermediate folder containing user-created lists.
  type RenderEntry =
    | { kind: 'folder'; name: string; childNode: FolderTreeNode; index: number }
    | { kind: 'table'; name: string; folder: DataFolder; index: number };

  const entries: RenderEntry[] = [
    ...Array.from(tree.children.entries()).map(
      ([segName, childNode], index): RenderEntry => ({
        kind: 'folder',
        name: segName,
        childNode,
        index,
      }),
    ),
    ...tree.folders.map(
      (folder, index): RenderEntry => ({
        kind: 'table',
        name: folder.name,
        folder,
        index,
      }),
    ),
  ];
  entries.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'folder') {
          const childId = `${idPrefix}/${entry.name}`;
          const nodeId = `intermediate-${childId}`;
          const key = childId || `intermediate-${entry.index}`;
          return (
            <IntermediateFolderNode key={key} name={entry.name} nodeId={nodeId} depth={depth}>
              <FolderTreeRenderer
                tree={entry.childNode}
                depth={depth + 1}
                groupName={groupName}
                workbookId={workbookId}
                idPrefix={childId}
              />
            </IntermediateFolderNode>
          );
        }
        return (
          <TableNode
            key={entry.folder.id ?? `folder-${entry.index}`}
            folder={entry.folder}
            workbookId={workbookId}
            groupName={groupName}
            depth={depth}
          />
        );
      })}
    </>
  );
}

// ============================================================================
// Connection Node (top-level group)
// ============================================================================

interface ConnectionNodeProps {
  group: DataFolderGroup;
  workbookId: WorkbookId;
  connectorAccount?: ConnectorAccount;
}

export function ConnectionNode({ group, workbookId, connectorAccount }: ConnectionNodeProps) {
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);
  const showHiddenConnections = useWorkbookUIStore((state) => state.showHiddenConnections);
  const toggleHiddenFiles = useWorkbookUIStore((state) => state.toggleHiddenFiles);
  const { workbook, pullFolders, pullAssets } = useActiveWorkbook();
  const [isReauthorizing, setIsReauthorizing] = useState(false);

  // Targeted Zustand selector — only re-renders when THIS connector's jobs change
  const connectorJobsSelector = useCallback(
    (s: { activeJobs: import('@/types/server-entities/job').JobEntity[] }) => {
      if (!connectorAccount) return [];
      return selectJobsForConnector(s.activeJobs, connectorAccount.id, workbook?.dataFolders ?? []);
    },
    [connectorAccount, workbook?.dataFolders],
  );
  const connectorJobs = useActiveJobsStore(useShallow(connectorJobsSelector));

  const connectionId = connectorAccount?.id ?? group.dataFolders[0]?.connectorAccountId ?? group.name;
  const nodeId = `connection-${connectionId}`;
  const isExpanded = expandedNodes.has(nodeId);
  const isScratch = group.name === SCRATCH_GROUP_NAME;

  const visibleFolders = group.dataFolders;

  const folderTree = useMemo(() => buildFolderTree(visibleFolders, group.name), [visibleFolders, group.name]);

  const showHidden = connectorAccount ? showHiddenConnections.has(connectorAccount.id) : false;

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Publish V2 modal state
  const [publishV2ModalOpened, { close: closePublishV2Modal }] = useDisclosure(false);

  // Inline "Choose tables" link (separate from the context menu's modal)
  const [inlineChooseTablesOpen, { open: openChooseTables, close: closeInlineChooseTables }] = useDisclosure(false);

  // Pull handler - pull only the tables belonging to this connection
  const connectionFolderIds = useMemo(() => group.dataFolders.map((f) => f.id), [group.dataFolders]);
  // Incremental is the default pull; the backend safely falls back to a full pull
  // for any table that does not support incremental, so we can always request it.
  const handlePullAllIncremental = useCallback(async () => {
    await pullFolders(connectionFolderIds, { mode: 'incremental' });
  }, [pullFolders, connectionFolderIds]);
  const handlePullAllFull = useCallback(async () => {
    await pullFolders(connectionFolderIds, { mode: 'full' });
  }, [pullFolders, connectionFolderIds]);

  // Only offer the incremental "Pull All Tables" when at least one table in this
  // connection actually supports incremental pulls. If none do (e.g. the connector
  // itself has no incremental support, so every table is NOT_SUPPORTED), incremental
  // would just full-pull everything anyway — so we show a single plain "Pull All
  // Tables" that does a full pull, with no redundant "- Full refresh" qualifier.
  const anyTableSupportsIncrementalPull = useMemo(
    () => group.dataFolders.some((folder) => folder.incrementalPullSupport === IncrementalPullSupport.SUPPORTED),
    [group.dataFolders],
  );

  const [pullAssetsModalOpen, { open: openPullAssetsModal, close: closePullAssetsModal }] = useDisclosure(false);
  const handlePullAllAssetsConfirm = useCallback(
    async (options: { rehost: boolean }) => {
      await pullAssets(connectionFolderIds, options);
    },
    [pullAssets, connectionFolderIds],
  );

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleToggle = useCallback(() => {
    toggleNode(nodeId);
  }, [toggleNode, nodeId]);

  const handleThreeDotsClick = (e: MouseEvent) => {
    e.stopPropagation();
    // Position menu near the button
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ x: rect.right, y: rect.bottom });
  };

  // Connection status - use connectorAccount health if available
  const isConnected = connectorAccount
    ? connectorAccount.healthStatus === 'OK' || connectorAccount.healthStatus === null
    : true;

  return (
    <>
      <UnstyledButton
        onClick={handleToggle}
        onContextMenu={handleContextMenu}
        px="sm"
        py={4}
        style={{
          width: '100%',
          backgroundColor: 'transparent',
        }}
        __vars={{
          '--hover-bg': 'var(--mantine-color-gray-1)',
        }}
        styles={{
          root: {
            '&:hover': {
              backgroundColor: 'var(--hover-bg)',
            },
          },
        }}
      >
        <Group gap={6} wrap="nowrap" justify="space-between">
          <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <StyledLucideIcon
              Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon}
              size="sm"
              c="var(--fg-secondary)"
            />

            {/* Icon */}
            {isScratch ? (
              <StyledLucideIcon Icon={StickyNoteIcon} size="sm" c="var(--fg-secondary)" />
            ) : group.service ? (
              <ConnectorIcon connector={group.service} size={16} p={0} />
            ) : (
              <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-secondary)" />
            )}

            {/* Name */}
            <Text12Medium c="var(--fg-primary)" truncate style={{ fontWeight: 600 }}>
              {group.name}
            </Text12Medium>

            {/* Status dot - only on files page, immediately after name */}

            {isReauthorizing && <PulsingIcon Icon={CloudCogIcon} size={12} c="var(--mantine-color-yellow-6)" />}

            {!isScratch && !isReauthorizing && (
              <Tooltip label={isConnected ? 'Connected' : 'Disconnected'} position="right">
                <Box
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: isConnected ? 'var(--mantine-color-green-6)' : 'var(--mantine-color-red-6)',
                    flexShrink: 0,
                  }}
                />
              </Tooltip>
            )}
            {connectorJobs.length > 0 && <PulsingIcon Icon={ClockIcon} size={12} c="var(--mantine-color-blue-6)" />}
          </Group>

          {/* Right side items */}
          <Group gap={6} wrap="nowrap">
            {/* Three dots menu - for non-Scratch connections */}
            {!isScratch && connectorAccount && (
              <Box
                onClick={handleThreeDotsClick}
                style={{
                  padding: 2,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  opacity: 0.5,
                }}
                onMouseOver={(e) => {
                  (e.currentTarget as HTMLElement).style.opacity = '1';
                }}
                onMouseOut={(e) => {
                  (e.currentTarget as HTMLElement).style.opacity = '0.5';
                }}
              >
                <StyledLucideIcon Icon={MoreHorizontalIcon} size="sm" c="var(--fg-secondary)" />
              </Box>
            )}
          </Group>
        </Group>
      </UnstyledButton>

      <Collapse in={isExpanded}>
        <Stack gap={0} pl={INDENT_PX}>
          {visibleFolders.length === 0 ? (
            connectorAccount && (
              <Box pl={INDENT_PX * 2 + 34} py={4}>
                <UnstyledButton onClick={openChooseTables}>
                  <Text12Regular c="var(--mantine-color-blue-6)" style={{ cursor: 'pointer' }}>
                    Choose tables
                  </Text12Regular>
                </UnstyledButton>
              </Box>
            )
          ) : (
            <>
              <FolderTreeRenderer
                tree={folderTree}
                depth={0}
                groupName={group.name}
                workbookId={workbookId}
                idPrefix={connectionId}
              />
              {showHidden && connectorAccount && (
                <ScratchFolderNode workbookId={workbookId} connectorAccountId={connectorAccount.id} />
              )}
            </>
          )}
        </Stack>
      </Collapse>

      {/* Context Menu + Modals (always mounted so modal state survives menu close) */}
      {connectorAccount && !isScratch && (
        <ConnectionContextMenu
          connectorAccount={connectorAccount}
          workbookId={workbookId}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          extraItemsBefore={[
            ...(anyTableSupportsIncrementalPull
              ? [
                  { label: 'Pull All Tables', icon: CloudDownloadIcon, onClick: handlePullAllIncremental },
                  { label: 'Pull All Tables - Full refresh', icon: CloudDownloadIcon, onClick: handlePullAllFull },
                ]
              : [{ label: 'Pull All Tables', icon: CloudDownloadIcon, onClick: handlePullAllFull }]),
            { label: 'Pull All Assets', icon: ImageIcon, onClick: openPullAssetsModal },
          ]}
          extraItemsAfter={[
            {
              label: showHidden ? 'Hide hidden files' : 'Show hidden files',
              icon: showHidden ? EyeOffIcon : EyeIcon,
              onClick: () => {
                toggleHiddenFiles(connectorAccount.id);
                setContextMenu(null);
              },
            },
          ]}
          onReauthorizeStart={() => setIsReauthorizing(true)}
          onReauthorizeEnd={() => setIsReauthorizing(false)}
        />
      )}

      {/* Inline "Choose tables" modal (for empty folder state link) */}
      {connectorAccount && (
        <ChooseTablesModal
          opened={inlineChooseTablesOpen}
          onClose={closeInlineChooseTables}
          workbookId={workbookId}
          connectorAccount={connectorAccount}
        />
      )}

      {/* Test Publish V2 Modal */}
      {connectorAccount && (
        <PublishPlansModal opened={publishV2ModalOpened} onClose={closePublishV2Modal} workbookId={workbookId} />
      )}

      {/* Pull Assets Modal */}
      <PullAssetsModal
        opened={pullAssetsModalOpen}
        onClose={closePullAssetsModal}
        onConfirm={handlePullAllAssetsConfirm}
        title={`Pull All Assets — ${group.name}`}
      />
    </>
  );
}

// ============================================================================
// Table Node (folder within a connection)
// ============================================================================

interface TableNodeProps {
  folder: DataFolder;
  workbookId: WorkbookId;
  groupName: string;
  /**
   * Depth of this node in the folder tree, controlling its left indentation.
   * 0 = directly at the connection root (no enclosing intermediate folder),
   * 1 = nested under one intermediate folder, etc. Mirrors how
   * `IntermediateFolderNode` consumes the same `depth` from `FolderTreeRenderer`.
   */
  depth: number;
}

function TableNode({ folder, workbookId, depth }: TableNodeProps) {
  const router = useRouter();
  const pathname = usePathname();
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);
  const showHiddenConnections = useWorkbookUIStore((state) => state.showHiddenConnections);
  const { pullFolders, pullAssets } = useActiveWorkbook();
  const { isDevToolsEnabled } = useDevTools();

  const nodeId = `table-${folder.id}`;
  const isExpanded = expandedNodes.has(nodeId);

  // Check if this folder is currently selected (showing in the right panel)
  const encodedFolderPath = (folder.path ?? folder.name)
    .replace(/^\//, '')
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const urlFolderPath = `/workbook/${workbookId}/files/${encodedFolderPath}`;
  const isSelected = pathname === urlFolderPath;

  const showHidden = folder.connectorAccountId ? showHiddenConnections.has(folder.connectorAccountId) : false;

  // Lazy-load: only fetch file list when expanded
  const {
    files: allFiles,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    refreshFiles,
    dirtyCount: serverDirtyCount,
  } = useFolderFileListPaginated(workbookId, isExpanded ? folder.id : null, FILE_LIMIT);
  const files = useMemo(
    () => (showHidden ? allFiles : allFiles.filter((f) => !f.name.startsWith('.'))),
    [allFiles, showHidden],
  );

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Modal states
  const [newFileModalOpened, { open: openNewFileModal, close: closeNewFileModal }] = useDisclosure(false);
  const [removeModalOpened, { open: openRemoveModal, close: closeRemoveModal }] = useDisclosure(false);
  const [deleteAllModalOpened, { open: openDeleteAllModal, close: closeDeleteAllModal }] = useDisclosure(false);
  const [schemaModalOpened, { open: openSchemaModal, close: closeSchemaModal }] = useDisclosure(false);
  const [refreshSchemaModalOpened, { open: openRefreshSchemaModal, close: closeRefreshSchemaModal }] =
    useDisclosure(false);
  const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
  const [pullScheduleOpened, { open: openPullSchedule, close: closePullSchedule }] = useDisclosure(false);
  const [assetIndexOpened, { open: openAssetIndex, close: closeAssetIndex }] = useDisclosure(false);
  const [infoModalOpened, { open: openInfoModal, close: closeInfoModal }] = useDisclosure(false);

  // Pull handlers for this table. Incremental is the default; full is the explicit
  // opt-in. The backend falls back to a full pull when incremental isn't supported.
  const handlePullTableIncremental = async () => {
    try {
      await pullFolders([folder.id], { mode: 'incremental' });
    } catch (error) {
      console.error('Failed to pull table (incremental):', error);
    }
  };
  const handlePullTableFull = async () => {
    try {
      await pullFolders([folder.id], { mode: 'full' });
    } catch (error) {
      console.error('Failed to pull table (full):', error);
    }
  };

  // Pull assets for this table
  const [pullAssetsOpened, { open: openPullAssets, close: closePullAssets }] = useDisclosure(false);
  const handlePullAssetsConfirm = async (options: { rehost: boolean }) => {
    try {
      await pullAssets([folder.id], options);
    } catch (error) {
      console.error('Failed to pull assets:', error);
    }
  };

  // Download all files as ZIP
  const handleDownloadAll = async () => {
    setContextMenu(null);
    try {
      await filesApi.downloadFolder(workbookId, folder.id);
    } catch {
      notifications.show({ title: 'Download failed', message: 'Could not download files', color: 'red' });
    }
  };

  // Refresh handler for this table (just revalidate SWR)
  const handleRefreshTable = async () => {
    try {
      await refreshFiles();
    } catch (error) {
      console.error('Failed to refresh table:', error);
    }
  };

  // Limit files for display
  const { displayedFiles, dirtyCount } = useMemo(() => {
    const fileItems = files.filter((f): f is FileRefEntity => f.type === 'file');

    return {
      displayedFiles: fileItems,
      dirtyCount: serverDirtyCount,
    };
  }, [files, serverDirtyCount]);

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleThreeDotsClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ x: rect.right, y: rect.bottom });
  };

  // Chevron click: just toggle expand/collapse
  const handleChevronClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      toggleNode(nodeId);
    },
    [toggleNode, nodeId],
  );

  // Row click (folder name): navigate to folder detail AND expand if collapsed
  const handleRowClick = useCallback(() => {
    router.push(`/workbook/${workbookId}/files/${encodedFolderPath}`);
    // Also expand if not already expanded
    if (!isExpanded) {
      toggleNode(nodeId);
    }
  }, [router, workbookId, encodedFolderPath, isExpanded, toggleNode, nodeId]);

  return (
    <>
      <UnstyledButton
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
        px="sm"
        py={4}
        style={{
          width: `calc(100% - ${INDENT_PX * depth}px)`,
          marginLeft: INDENT_PX * depth,
          backgroundColor: isSelected ? 'var(--bg-selected)' : 'transparent',
          borderLeft: isSelected ? '3px solid var(--mantine-primary-color-filled)' : '3px solid transparent',
        }}
        __vars={{
          '--hover-bg': 'var(--mantine-color-gray-1)',
        }}
        styles={{
          root: {
            '&:hover': {
              backgroundColor: isSelected ? 'var(--bg-selected)' : 'var(--hover-bg)',
            },
          },
        }}
      >
        <Group gap={6} wrap="nowrap" justify="space-between">
          <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            {/* Chevron: separate click target for expand/collapse only */}
            <Box
              onClick={handleChevronClick}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                marginLeft: -4,
                marginRight: -4,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <StyledLucideIcon
                Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon}
                size="sm"
                c="var(--fg-secondary)"
              />
            </Box>
            {(folder.options as DataFolderOptions | null)?.readOnly ? (
              <Tooltip label="Read-only — pull only, never published back" position="right">
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <StyledLucideIcon Icon={FolderLockIcon} size={14} c="var(--fg-secondary)" />
                </span>
              </Tooltip>
            ) : (
              <StyledLucideIcon Icon={FolderIcon} size={14} c="var(--fg-secondary)" />
            )}
            <Text12Regular c="var(--fg-primary)" truncate>
              {folder.name}
            </Text12Regular>
          </Group>

          {/* Dirty badge when collapsed */}
          {!isExpanded && dirtyCount > 0 && (
            <Badge size="xs" variant="filled" color="orange">
              {dirtyCount}
            </Badge>
          )}

          {/* Active jobs badge */}
          {folder.lock && <ActiveDataFolderJobIndicator folder={folder} />}

          {/* Three dots menu */}
          <Box
            onClick={handleThreeDotsClick}
            style={{
              padding: 2,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              opacity: 0.5,
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = '1';
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = '0.5';
            }}
          >
            <StyledLucideIcon Icon={MoreHorizontalIcon} size="sm" c="var(--fg-secondary)" />
          </Box>
        </Group>
      </UnstyledButton>

      <Collapse in={isExpanded}>
        <Stack gap={0} pl={INDENT_PX * 2} pr="sm">
          {/* Loading state */}
          {isLoading && files.length === 0 && (
            <Box py={4} px="sm" style={{ marginLeft: INDENT_PX }}>
              <Group gap={6} wrap="nowrap">
                <Box style={{ width: 6, flexShrink: 0 }} />
                <Text12Regular c="dimmed">Loading...</Text12Regular>
              </Group>
            </Box>
          )}

          {/* File list */}
          {displayedFiles.map((file, fileIndex) => (
            <FileNode
              key={file.path ?? `file-${fileIndex}`}
              file={file}
              onSuccess={handleRefreshTable}
              linkedFolderId={folder.connectorAccountId ? folder.id : undefined}
            />
          ))}

          {/* Load more indicator */}
          {hasMore && (
            <Box py={4} px="sm" style={{ marginLeft: INDENT_PX }}>
              <Group gap={6} wrap="nowrap">
                <Box style={{ width: 6, flexShrink: 0 }} />
                <Text12Regular
                  c="var(--mantine-color-blue-6)"
                  style={{ cursor: isLoadingMore ? 'default' : 'pointer' }}
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    if (!isLoadingMore) loadMore();
                  }}
                >
                  {isLoadingMore ? 'Loading...' : 'Load more...'}
                </Text12Regular>
              </Group>
            </Box>
          )}

          {/* Empty state */}
          {!isLoading && displayedFiles.length === 0 && (
            <Box py={4} px="sm" style={{ marginLeft: INDENT_PX }}>
              <Group gap={6} wrap="nowrap">
                <Box style={{ width: 6, flexShrink: 0 }} />
                <Text12Regular c="dimmed">No files</Text12Regular>
              </Group>
            </Box>
          )}
        </Stack>
      </Collapse>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          opened={true}
          onClose={() => setContextMenu(null)}
          position={contextMenu}
          items={[
            ...buildTablePullMenuItems(
              folder.incrementalPullSupport,
              CloudDownloadIcon,
              handlePullTableIncremental,
              handlePullTableFull,
            ),
            { label: 'Download folder', icon: DownloadIcon, onClick: handleDownloadAll },
            {
              label: 'New File',
              icon: FilePlusIcon,
              onClick: () => {
                openNewFileModal();
                setContextMenu(null);
              },
            },
            { label: 'Get Info', icon: InfoIcon, onClick: openInfoModal },
            { label: 'View Schema', icon: FileJsonIcon, onClick: openSchemaModal },
            { label: 'Refresh Schema', icon: RefreshCwIcon, onClick: openRefreshSchemaModal },
            { label: 'Advanced Settings', icon: SettingsIcon, onClick: openSettings },
            { label: 'Pull Schedule', icon: ClockIcon, onClick: openPullSchedule },
            { label: 'Pull Assets', icon: ImageIcon, onClick: openPullAssets },
            ...(isDevToolsEnabled
              ? [{ label: 'Asset Index', icon: ImageIcon, onClick: openAssetIndex, devtool: true }]
              : []),
            { type: 'divider' },
            { label: 'Unlink this table', icon: UnlinkIcon, onClick: openRemoveModal, delete: true },
            { label: 'Delete all records', icon: Trash2Icon, onClick: openDeleteAllModal, delete: true },
          ]}
        />
      )}

      {/* New File Modal */}
      <NewFileModal opened={newFileModalOpened} onClose={closeNewFileModal} folder={folder} workbookId={workbookId} />

      {/* Remove Table Modal */}
      <RemoveTableModal opened={removeModalOpened} onClose={closeRemoveModal} folder={folder} workbookId={workbookId} />

      {/* Schema Modal */}
      <DataFolderSchemaModal opened={schemaModalOpened} onClose={closeSchemaModal} folder={folder} mode="view" />

      {/* Refresh Schema Modal */}
      <DataFolderSchemaModal
        opened={refreshSchemaModalOpened}
        onClose={closeRefreshSchemaModal}
        folder={folder}
        mode="refresh"
      />

      {/* Delete All Records Modal */}
      <DeleteAllRecordsModal
        opened={deleteAllModalOpened}
        onClose={closeDeleteAllModal}
        folder={folder}
        workbookId={workbookId}
        onSuccess={handleRefreshTable}
      />

      {/* Pull Schedule Modal */}
      <PullScheduleModal opened={pullScheduleOpened} onClose={closePullSchedule} folder={folder} />

      {/* Advanced Folder Settings Modal */}
      <AdvancedFolderSettingsModal opened={settingsOpened} onClose={closeSettings} folder={folder} />

      {/* Asset Index Modal */}
      <AssetIndexModal
        opened={assetIndexOpened}
        onClose={closeAssetIndex}
        workbookId={workbookId}
        dataFolderId={folder.id}
      />
      <PullAssetsModal
        opened={pullAssetsOpened}
        onClose={closePullAssets}
        onConfirm={handlePullAssetsConfirm}
        title={`Pull Assets — ${folder.name}`}
      />

      {/* Folder Info Modal */}
      <DataFolderInfoModal opened={infoModalOpened} onClose={closeInfoModal} folder={folder} />
    </>
  );
}

// ============================================================================
// File Node (individual file)
// ============================================================================

interface FileNodeProps {
  file: FileRefEntity;
  onSuccess?: () => void;
  /** ID of the parent DataFolder if the file belongs to a linked (connector-backed) folder */
  linkedFolderId?: DataFolderId;
}

function FileNode({ file, onSuccess, linkedFolderId }: FileNodeProps) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { showSecretButton } = useDevTools();

  // Build the file path for the URL - encode each segment but keep slashes
  const filePath = file.path ?? file.name ?? '';
  const encodedPath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  const href = `/workbook/${params.id}/files/${encodedPath}`;

  // Check if this file is currently selected
  const isSelected = pathname.includes(`/files/${encodedPath}`);

  // Determine if file is dirty (modified)
  const isDirty = file.status === 'modified' || file.status === 'added' || file.status === 'deleted';
  const isDeleted = file.status === 'deleted';

  const isHiddenFile = file.name.startsWith('.');

  // Text color: always primary (the dot indicator is enough)
  const textColor = isDeleted ? 'var(--fg-secondary)' : 'var(--fg-primary)';

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Modals
  const [testTransformerOpened, { open: openTestTransformer, close: closeTestTransformer }] = useDisclosure(false);
  const [removeFileOpened, { open: openRemoveFile, close: closeRemoveFile }] = useDisclosure(false);
  const [renameFileOpened, { open: openRenameFile, close: closeRenameFile }] = useDisclosure(false);

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleThreeDotsClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ x: rect.right, y: rect.bottom });
  };

  const handlePullFromSource = useCallback(async () => {
    if (!linkedFolderId) return;
    try {
      const result = await dataFolderApi.pullFiles(linkedFolderId, params.id as WorkbookId, [file.path]);
      if (result?.jobId) {
        useActiveJobsStore.getState().trackJobIds([result.jobId]);
        useActiveJobsStore.getState().refreshJobs();
        ScratchpadNotifications.info({ message: 'Pulling file from source' });
        trackPullFilesFromSource(params.id as string, linkedFolderId);
      }
    } catch {
      ScratchpadNotifications.error({ message: 'Failed to pull file from source' });
    }
  }, [linkedFolderId, file.path, params.id]);

  const handleFileClick = () => {
    router.push(href);
  };

  return (
    <>
      <UnstyledButton
        onClick={handleFileClick}
        py={4}
        onContextMenu={handleContextMenu}
        style={{
          width: `calc(100% - ${INDENT_PX}px)`,
          marginLeft: INDENT_PX,
          paddingLeft: 'var(--mantine-spacing-sm)',
          paddingRight: 0,
          backgroundColor: isSelected ? 'var(--bg-selected)' : 'transparent',
          borderLeft: isSelected ? '3px solid var(--mantine-primary-color-filled)' : '3px solid transparent',
        }}
        __vars={{
          '--hover-bg': 'var(--mantine-color-gray-1)',
        }}
        styles={{
          root: {
            '&:hover': {
              backgroundColor: isSelected ? 'var(--bg-selected)' : 'var(--hover-bg)',
            },
          },
        }}
      >
        <Group gap={6} wrap="nowrap">
          {/* Dirty indicator (or spacer for alignment) */}
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
              color: isDeleted
                ? 'var(--mantine-color-red-6)'
                : file.status === 'added'
                  ? 'var(--mantine-color-green-6)'
                  : isDirty
                    ? 'var(--mantine-color-orange-6)'
                    : 'transparent',
            }}
          >
            {isDeleted ? '×' : file.status === 'added' ? '+' : isDirty ? '•' : ''}
          </Box>

          <TextMono12Regular c={textColor} truncate style={{ flex: 1, opacity: isHiddenFile ? 0.5 : 1 }}>
            {file.name}
          </TextMono12Regular>

          {/* Three dots menu */}
          <Box
            onClick={handleThreeDotsClick}
            style={{
              padding: 2,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              opacity: 0.5,
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = '1';
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = '0.5';
            }}
          >
            <StyledLucideIcon Icon={MoreHorizontalIcon} size="sm" c="var(--fg-secondary)" />
          </Box>
        </Group>
      </UnstyledButton>

      <ContextMenu
        opened={!!contextMenu}
        onClose={() => setContextMenu(null)}
        position={contextMenu ?? { x: 0, y: 0 }}
        items={[
          ...(showSecretButton && !isHiddenFile
            ? [{ label: 'Test Transformer', icon: FlaskRoundIcon, onClick: openTestTransformer }]
            : []),
          ...(linkedFolderId && !isHiddenFile
            ? [{ label: 'Pull from source', icon: RefreshCwIcon, onClick: () => void handlePullFromSource() }]
            : []),
          {
            label: 'Copy Path',
            icon: RouteIcon,
            onClick: () => void navigator.clipboard.writeText(`/${filePath}`),
          },
          ...(!isHiddenFile
            ? [
                { type: 'divider' as const },
                { label: 'Rename', icon: Edit2Icon, onClick: openRenameFile },
                { label: 'Delete', icon: Trash2Icon, onClick: openRemoveFile, delete: true },
              ]
            : []),
        ]}
      />

      <TestTransformerModal
        opened={testTransformerOpened}
        onClose={closeTestTransformer}
        workbookId={params.id as WorkbookId}
        file={file}
      />

      <RemoveFileModal
        opened={removeFileOpened}
        onClose={closeRemoveFile}
        workbookId={params.id as WorkbookId}
        file={file}
        onSuccess={onSuccess}
      />

      <RenameFileModal
        opened={renameFileOpened}
        onClose={closeRenameFile}
        workbookId={params.id as WorkbookId}
        file={file}
        onSuccess={(newName) => {
          onSuccess?.();
          // Update URL if the selected file was renamed
          if (isSelected) {
            const newEncodedPath = [...encodedPath.split('/').slice(0, -1), encodeURIComponent(newName)].join('/');
            router.push(`/workbook/${params.id}/files/${newEncodedPath}`);
          }
        }}
      />
    </>
  );
}

// ============================================================================
// Empty Connection Node (connector account without data folders)
// ============================================================================

interface EmptyConnectionNodeProps {
  connectorAccount: ConnectorAccount;
  workbookId: WorkbookId;
}

export function EmptyConnectionNode({ connectorAccount, workbookId }: EmptyConnectionNodeProps) {
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);
  const [isReauthorizing, setIsReauthorizing] = useState(false);

  const nodeId = `connection-${connectorAccount.id}`;
  const isExpanded = expandedNodes.has(nodeId);

  // Connection health status
  const isConnected = connectorAccount.healthStatus === 'OK' || connectorAccount.healthStatus === null;

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Inline "Choose tables" link (separate from the one inside ConnectionContextMenu)
  const [inlineChooseTablesOpened, { open: openInlineChooseTables, close: closeInlineChooseTables }] =
    useDisclosure(false);

  const handleToggle = useCallback(() => {
    toggleNode(nodeId);
  }, [toggleNode, nodeId]);

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleThreeDotsClick = (e: MouseEvent) => {
    e.stopPropagation();
    // Position menu near the button
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ x: rect.right, y: rect.bottom });
  };

  return (
    <>
      <UnstyledButton
        onClick={handleToggle}
        onContextMenu={handleContextMenu}
        px="sm"
        py={4}
        style={{
          width: '100%',
          backgroundColor: 'transparent',
        }}
        __vars={{
          '--hover-bg': 'var(--mantine-color-gray-1)',
        }}
        styles={{
          root: {
            '&:hover': {
              backgroundColor: 'var(--hover-bg)',
            },
          },
        }}
      >
        <Group gap={6} wrap="nowrap">
          <StyledLucideIcon Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-secondary)" />

          {/* Icon */}
          <ConnectorIcon connector={connectorAccount.service} size={16} p={0} />

          {/* Name */}
          <Text12Medium c="var(--fg-primary)" truncate style={{ fontWeight: 600 }}>
            {connectorAccount.displayName}
          </Text12Medium>

          {/* Status dot - immediately after name */}
          {isReauthorizing ? (
            <PulsingIcon Icon={CloudCogIcon} size={12} c="var(--mantine-color-yellow-6)" />
          ) : (
            <Tooltip label={isConnected ? 'Connected' : 'Connection error'} position="right">
              <Box
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: isConnected ? 'var(--mantine-color-green-6)' : 'var(--mantine-color-red-6)',
                  flexShrink: 0,
                }}
              />
            </Tooltip>
          )}

          {/* Spacer */}
          <Box style={{ flex: 1 }} />

          {/* Three dots menu */}
          <Box
            onClick={handleThreeDotsClick}
            style={{
              padding: 2,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              opacity: 0.5,
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = '1';
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = '0.5';
            }}
          >
            <StyledLucideIcon Icon={MoreHorizontalIcon} size="sm" c="var(--fg-secondary)" />
          </Box>
        </Group>
      </UnstyledButton>

      {/* Expanded content - show "Choose tables" link */}
      <Collapse in={isExpanded}>
        <Box pl={INDENT_PX * 3 + 34} py={4}>
          <UnstyledButton onClick={openInlineChooseTables}>
            <Text12Regular c="var(--mantine-color-blue-6)" style={{ cursor: 'pointer' }}>
              Choose tables
            </Text12Regular>
          </UnstyledButton>
        </Box>
      </Collapse>

      {/* Context Menu + Modals (always mounted so modal state survives menu close) */}
      <ConnectionContextMenu
        connectorAccount={connectorAccount}
        workbookId={workbookId}
        position={contextMenu}
        onClose={() => setContextMenu(null)}
        onReauthorizeStart={() => setIsReauthorizing(true)}
        onReauthorizeEnd={() => setIsReauthorizing(false)}
      />

      {/* Inline Choose Tables Modal (for the link inside the collapsed area) */}
      <ChooseTablesModal
        opened={inlineChooseTablesOpened}
        onClose={closeInlineChooseTables}
        workbookId={workbookId}
        connectorAccount={connectorAccount}
      />
    </>
  );
}

// ============================================================================
// ScratchFolderNode — virtual .scratch folder shown per-connection
// when "Show hidden files" is enabled. Reads from the dirty branch so that
// publish-plans and other CLI-written metadata are visible.
// ============================================================================

interface ScratchFolderNodeProps {
  workbookId: WorkbookId;
  connectorAccountId: string;
}

function ScratchFolderNode({ workbookId, connectorAccountId }: ScratchFolderNodeProps) {
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);
  const nodeId = `scratch-folder-${connectorAccountId}`;
  const isExpanded = expandedNodes.has(nodeId);

  const { data: entries, isLoading } = useSWR(
    isExpanded ? ['repo-files', workbookId, '.scratch', connectorAccountId] : null,
    () => workbookApi.listRepoFiles(workbookId, 'dirty', '.scratch', connectorAccountId),
  );

  return (
    <>
      <UnstyledButton
        onClick={() => toggleNode(nodeId)}
        px="sm"
        py={4}
        style={{ width: '100%', backgroundColor: 'transparent' }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap">
          <StyledLucideIcon Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-secondary)" />
          <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-muted)" />
          <Text12Regular c="var(--fg-muted)" style={{ fontStyle: 'italic' }}>
            .scratch
          </Text12Regular>
        </Group>
      </UnstyledButton>

      <Collapse in={isExpanded}>
        <Stack gap={0}>
          {(isLoading || !entries) && (
            <Box py={4} px="sm" style={{ marginLeft: INDENT_PX * 2 }}>
              <Text12Regular c="var(--fg-muted)">Loading…</Text12Regular>
            </Box>
          )}
          {!isLoading && entries && entries.length === 0 && (
            <Box py={4} px="sm" style={{ marginLeft: INDENT_PX * 2 }}>
              <Text12Regular c="var(--fg-muted)">No schema files</Text12Regular>
            </Box>
          )}
          {entries?.map((entry) =>
            entry.type === 'directory' ? (
              <ScratchSubdirNode
                key={entry.path}
                workbookId={workbookId}
                connectorAccountId={connectorAccountId}
                path={entry.path}
                name={entry.name}
                depth={1}
              />
            ) : (
              <ScratchFileRow
                key={entry.path}
                name={entry.name}
                path={entry.path}
                depth={1}
                workbookId={workbookId}
                connectorAccountId={connectorAccountId}
              />
            ),
          )}
        </Stack>
      </Collapse>
    </>
  );
}

function ScratchFileRow({
  name,
  path,
  depth,
  workbookId,
  connectorAccountId,
}: {
  name: string;
  path: string;
  depth: number;
  workbookId: WorkbookId;
  connectorAccountId: string;
}) {
  const pathname = usePathname();
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const href = `/workbook/${workbookId}/scratch/${encodedPath}?connectorAccountId=${encodeURIComponent(connectorAccountId)}`;
  const isSelected = pathname.startsWith(`/workbook/${workbookId}/scratch/${encodedPath}`);

  return (
    <Link href={href} style={{ textDecoration: 'none' }}>
      <UnstyledButton
        px="sm"
        py={4}
        style={{
          marginLeft: INDENT_PX * depth,
          width: `calc(100% - ${INDENT_PX * depth}px)`,
          backgroundColor: isSelected ? 'var(--mantine-color-gray-2)' : 'transparent',
        }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap">
          <Box style={{ width: 20, flexShrink: 0 }} />
          <StyledLucideIcon Icon={FileJsonIcon} size="sm" c="var(--fg-muted)" />
          <TextMono12Regular c="var(--fg-muted)" truncate style={{ fontStyle: 'italic' }}>
            {name}
          </TextMono12Regular>
        </Group>
      </UnstyledButton>
    </Link>
  );
}

function ScratchSubdirNode({
  workbookId,
  connectorAccountId,
  path,
  name,
  depth,
}: {
  workbookId: WorkbookId;
  connectorAccountId: string;
  path: string;
  name: string;
  depth: number;
}) {
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);
  const nodeId = `scratch-subdir-${connectorAccountId}-${path}`;
  const isExpanded = expandedNodes.has(nodeId);

  const { data: entries, isLoading } = useSWR(
    isExpanded ? ['repo-files', workbookId, path, connectorAccountId] : null,
    () => workbookApi.listRepoFiles(workbookId, 'dirty', path, connectorAccountId),
  );

  return (
    <>
      <UnstyledButton
        onClick={() => toggleNode(nodeId)}
        px="sm"
        py={4}
        style={{
          marginLeft: INDENT_PX * depth,
          width: `calc(100% - ${INDENT_PX * depth}px)`,
          backgroundColor: 'transparent',
        }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap">
          <Box style={{ display: 'flex', alignItems: 'center', width: 20, height: 20, flexShrink: 0 }}>
            <StyledLucideIcon
              Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon}
              size="sm"
              c="var(--fg-secondary)"
            />
          </Box>
          <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-muted)" />
          <Text12Regular c="var(--fg-muted)" truncate style={{ fontStyle: 'italic' }}>
            {name}
          </Text12Regular>
        </Group>
      </UnstyledButton>

      <Collapse in={isExpanded}>
        <Stack gap={0}>
          {(isLoading || !entries) && (
            <Box py={4} px="sm" style={{ marginLeft: INDENT_PX * (depth + 1) }}>
              <Text12Regular c="var(--fg-muted)">Loading…</Text12Regular>
            </Box>
          )}
          {entries?.map((entry) =>
            entry.type === 'directory' ? (
              <ScratchSubdirNode
                key={entry.path}
                workbookId={workbookId}
                connectorAccountId={connectorAccountId}
                path={entry.path}
                name={entry.name}
                depth={depth + 1}
              />
            ) : (
              <ScratchFileRow
                key={entry.path}
                name={entry.name}
                path={entry.path}
                depth={depth + 1}
                workbookId={workbookId}
                connectorAccountId={connectorAccountId}
              />
            ),
          )}
        </Stack>
      </Collapse>
    </>
  );
}
