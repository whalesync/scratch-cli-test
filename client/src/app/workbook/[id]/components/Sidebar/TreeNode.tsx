'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { PulsingIcon } from '@/app/components/Icons/PulsingIcon';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text12Medium, Text12Regular, TextMono12Regular } from '@/app/components/base/text';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useFolderFileList } from '@/hooks/use-folder-file-list';
import { useWorkbookActiveJobs } from '@/hooks/use-workbook-active-jobs';
import { useNewWorkbookUIStore } from '@/stores/new-workbook-ui-store';
import { useWorkbookEditorUIStore } from '@/stores/workbook-editor-store';
import { OAuthService } from '@/types/oauth';
import { fileMatchesFolder } from '@/utils/data-folder-helpers';
import { initiateOAuth } from '@/utils/oauth';
import { Badge, Box, Collapse, Group, Stack, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  AuthType,
  type ConnectorAccount,
  type DataFolder,
  type DataFolderGroup,
  type FileDiffStatus,
  type FileRefEntity,
  type WorkbookId,
} from '@spinner/shared-types';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CloudCogIcon,
  DownloadIcon,
  Edit2Icon,
  FileJsonIcon,
  FilePlusIcon,
  FlaskRoundIcon,
  FolderIcon,
  MoreHorizontalIcon,
  RocketIcon,
  RouteIcon,
  SettingsIcon,
  StickyNoteIcon,
  TableIcon,
  Trash2Icon,
  UnlinkIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { PublishPlansModal } from '../modals/PublishPlansModal';
import { TestTransformerModal } from '../modals/TestTransformerModal';
import { AdvancedFolderSettingsModal } from '../shared/AdvancedFolderSettingsModal';
import { ChooseTablesModal } from '../shared/ChooseTablesModal';
import { ContextMenu } from '../shared/ContextMenu';
import { DataFolderSchemaModal } from '../shared/DataFolderSchemaModal';
import { DeleteAllRecordsModal } from '../shared/DeleteAllRecordsModal';
import { NewFileModal } from '../shared/NewFileModal';
import { PullScheduleModal } from '../shared/PullScheduleModal';
import { RemoveConnectionModal } from '../shared/RemoveConnectionModal';
import { RemoveFileModal } from '../shared/RemoveFileModal';
import { RemoveTableModal } from '../shared/RemoveTableModal';
import { RenameFileModal } from '../shared/RenameFileModal';
import { UpdateConnectionModal } from '../shared/UpdateConnectionModal';
import { ActiveDataFolderJobIndicator } from './ActiveDataFolderJobIndicator';
import type { FileTreeMode } from './FileTree';

const SCRATCH_GROUP_NAME = 'Scratch';
const FILE_LIMIT = 100;
const INDENT_PX = 10;

// ============================================================================
// Connection Node (top-level group)
// ============================================================================

interface ConnectionNodeProps {
  group: DataFolderGroup;
  workbookId: WorkbookId;
  connectorAccount?: ConnectorAccount;
  mode?: FileTreeMode;
  dirtyFilePaths?: Map<string, FileDiffStatus>;
}

export function ConnectionNode({
  group,
  workbookId,
  connectorAccount,
  mode = 'files',
  dirtyFilePaths,
}: ConnectionNodeProps) {
  const expandedNodes = useNewWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useNewWorkbookUIStore((state) => state.toggleNode);
  const setWorkbookError = useWorkbookEditorUIStore((state) => state.setWorkbookError);
  const { workbook, pullFolders } = useActiveWorkbook();
  const { getJobsForConnector } = useWorkbookActiveJobs(workbookId);
  const [isReauthorizing, setIsReauthorizing] = useState(false);

  const connectorJobs = useMemo(() => {
    if (!connectorAccount) return [];
    return getJobsForConnector(connectorAccount.id, workbook?.dataFolders ?? []);
  }, [connectorAccount, workbook?.dataFolders, getJobsForConnector]);

  const nodeId = `connection-${group.name}`;
  const isExpanded = expandedNodes.has(nodeId);
  const isScratch = group.name === SCRATCH_GROUP_NAME;

  // In review mode, filter folders to only those with dirty files
  const visibleFolders = useMemo(() => {
    if (mode !== 'review' || !dirtyFilePaths || dirtyFilePaths.size === 0) return group.dataFolders;

    return group.dataFolders.filter((folder) => {
      if (!folder.path) return false;
      for (const dirtyPath of dirtyFilePaths.keys()) {
        if (fileMatchesFolder(folder.path, dirtyPath)) {
          return true;
        }
      }
      return false;
    });
  }, [mode, dirtyFilePaths, group.dataFolders]);

  const hasDirtyFiles = mode !== 'review' || visibleFolders.length > 0;

  // Calculate dirty count across all folders in this connection
  const totalDirtyCount = useMemo(() => {
    // This would need to aggregate from all folder file lists
    // For now, we'll show it at the table level only
    return 0;
  }, []);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Choose tables modal state
  const [chooseTablesOpened, { open: openChooseTables, close: closeChooseTables }] = useDisclosure(false);

  // Remove connection modal state
  const [removeModalOpened, { open: openRemoveModal, close: closeRemoveModal }] = useDisclosure(false);

  // Update connection modal state
  const [updateConnectionModalOpened, { open: openUpdateConnectionModal, close: closeUpdateConnectionModal }] =
    useDisclosure(false);

  // Publish V2 modal state
  const [publishV2ModalOpened, { open: openPublishV2Modal, close: closePublishV2Modal }] = useDisclosure(false);

  // Reauthorize handler (OAuth connections)
  const handleReauthorize = async () => {
    if (!connectorAccount || connectorAccount.authType !== AuthType.OAUTH) {
      return;
    }
    setIsReauthorizing(true);
    try {
      await initiateOAuth(connectorAccount.service as OAuthService, {
        workbookId: workbookId,
        redirectPrefix: `${window.location.protocol}//${window.location.host}`,
        connectionMethod: 'OAUTH_SYSTEM',
        connectionName: connectorAccount.displayName,
        returnPage: window.location.pathname,
        connectorAccountId: connectorAccount.id,
      });
    } catch (error) {
      console.error('OAuth initiation failed:', error);
      setWorkbookError({
        description: `Failed to reauthorize connection to ${connectorAccount.displayName}. Please try again.`,
        cause: error as Error,
      });
    } finally {
      setIsReauthorizing(false);
    }
  };

  // Pull handler - pull only the tables belonging to this connection
  const connectionFolderIds = useMemo(() => group.dataFolders.map((f) => f.id), [group.dataFolders]);
  const handlePullAll = useCallback(async () => {
    await pullFolders(connectionFolderIds);
  }, [pullFolders, connectionFolderIds]);

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

  // In review mode, hide connections with no dirty files
  if (mode === 'review' && !hasDirtyFiles) {
    return null;
  }

  return (
    <>
      <UnstyledButton
        onClick={handleToggle}
        onContextMenu={mode === 'files' ? handleContextMenu : undefined}
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

            {mode === 'files' && !isScratch && !isReauthorizing && (
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
            {/* Dirty badge when collapsed */}
            {!isExpanded && totalDirtyCount > 0 && (
              <Badge size="xs" variant="filled" color="orange">
                {totalDirtyCount}
              </Badge>
            )}

            {/* Three dots menu - only in files mode and for non-Scratch connections */}
            {mode === 'files' && !isScratch && connectorAccount && (
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
          {visibleFolders.length === 0
            ? mode === 'files' &&
              connectorAccount && (
                <Box pl={INDENT_PX * 2 + 34} py={4}>
                  <UnstyledButton onClick={openChooseTables}>
                    <Text12Regular c="var(--mantine-color-blue-6)" style={{ cursor: 'pointer' }}>
                      Choose tables
                    </Text12Regular>
                  </UnstyledButton>
                </Box>
              )
            : visibleFolders.map((folder) => (
                <TableNode
                  key={folder.id}
                  folder={folder}
                  workbookId={workbookId}
                  mode={mode}
                  dirtyFilePaths={dirtyFilePaths}
                  groupName={group.name}
                />
              ))}
        </Stack>
      </Collapse>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          opened={true}
          onClose={() => setContextMenu(null)}
          position={contextMenu}
          items={[
            { label: 'Pull All Tables', icon: DownloadIcon, onClick: handlePullAll },
            ...(connectorAccount && !isScratch
              ? [{ label: 'Choose tables', icon: TableIcon, onClick: openChooseTables }]
              : []),
            ...(connectorAccount
              ? [
                  connectorAccount.authType === AuthType.OAUTH
                    ? { label: 'Reauthorize', icon: CloudCogIcon, onClick: handleReauthorize }
                    : { label: 'Edit Connection', icon: SettingsIcon, onClick: openUpdateConnectionModal },
                ]
              : []),
            { type: 'divider' as const },
            ...(connectorAccount
              ? [
                  {
                    label: 'Test Publish V2',
                    icon: RocketIcon,
                    onClick: openPublishV2Modal,
                    color: 'var(--mantine-color-devTool-9)',
                  },
                ]
              : []),
            ...(connectorAccount && !isScratch
              ? [{ label: 'Remove', icon: Trash2Icon, onClick: openRemoveModal, delete: true }]
              : []),
          ]}
        />
      )}

      {/* Choose Tables Modal */}
      {connectorAccount && (
        <ChooseTablesModal
          opened={chooseTablesOpened}
          onClose={closeChooseTables}
          workbookId={workbookId}
          connectorAccount={connectorAccount}
        />
      )}

      {/* Remove Connection Modal */}
      {connectorAccount && (
        <RemoveConnectionModal
          opened={removeModalOpened}
          onClose={closeRemoveModal}
          connectorAccount={connectorAccount}
          workbookId={workbookId}
        />
      )}

      {/* Test Publish V2 Modal */}
      {connectorAccount && (
        <PublishPlansModal opened={publishV2ModalOpened} onClose={closePublishV2Modal} workbookId={workbookId} />
      )}

      {/* Update Connection Modal */}
      {connectorAccount && (
        <UpdateConnectionModal
          opened={updateConnectionModalOpened}
          onClose={closeUpdateConnectionModal}
          connectorAccount={connectorAccount}
        />
      )}
    </>
  );
}

// ============================================================================
// Table Node (folder within a connection)
// ============================================================================

interface TableNodeProps {
  folder: DataFolder;
  workbookId: WorkbookId;
  mode?: FileTreeMode;
  dirtyFilePaths?: Map<string, FileDiffStatus>;
  groupName: string;
}

function TableNode({ folder, workbookId, mode = 'files', dirtyFilePaths }: TableNodeProps) {
  const router = useRouter();
  const pathname = usePathname();
  const expandedNodes = useNewWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useNewWorkbookUIStore((state) => state.toggleNode);
  const { pullFolders } = useActiveWorkbook();

  const nodeId = `table-${folder.id}`;
  const isExpanded = expandedNodes.has(nodeId);

  // Check if this folder is currently selected (showing in the right panel)
  const routeBase = mode === 'review' ? 'review' : 'files';
  const encodedFolderPath = (folder.path ?? folder.name)
    .replace(/^\//, '')
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const urlFolderPath = `/workbook/${workbookId}/${routeBase}/${encodedFolderPath}`;
  const isSelected = pathname === urlFolderPath;

  const { files, isLoading, refreshFiles } = useFolderFileList(workbookId, folder.id);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Modal states
  const [newFileModalOpened, { open: openNewFileModal, close: closeNewFileModal }] = useDisclosure(false);
  const [removeModalOpened, { open: openRemoveModal, close: closeRemoveModal }] = useDisclosure(false);
  const [deleteAllModalOpened, { open: openDeleteAllModal, close: closeDeleteAllModal }] = useDisclosure(false);
  const [schemaModalOpened, { open: openSchemaModal, close: closeSchemaModal }] = useDisclosure(false);
  const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
  const [pullScheduleOpened, { open: openPullSchedule, close: closePullSchedule }] = useDisclosure(false);

  // Pull handler for this table
  const handlePullTable = async () => {
    try {
      await pullFolders([folder.id]);
    } catch (error) {
      console.error('Failed to pull table:', error);
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
  const { displayedFiles, hiddenCount, dirtyCount, hasAnyDirtyFiles } = useMemo(() => {
    let fileItems = files.filter((f): f is FileRefEntity => f.type === 'file');

    // In review mode, only show dirty files
    if (mode === 'review' && dirtyFilePaths) {
      fileItems = fileItems.filter((f) => dirtyFilePaths.has(f.path));
    }

    // Inject ghost nodes for dirty files not in the file list (e.g. deleted or not yet loaded)
    if (mode === 'review' && dirtyFilePaths && folder.path) {
      const existingPaths = new Set(fileItems.map((f) => f.path));

      dirtyFilePaths.forEach((status, dirtyPath) => {
        if (fileMatchesFolder(folder.path!, dirtyPath) && !existingPaths.has(dirtyPath)) {
          const parts = dirtyPath.split('/');
          const name = parts[parts.length - 1];
          fileItems.push({
            path: dirtyPath,
            name: name,
            type: 'file',
            status,
            content: '',
            parentFolderId: folder.id,
          } as FileRefEntity);
        }
      });

      // Re-sort if we added items
      fileItems.sort((a, b) => a.name.localeCompare(b.name));
    }

    const dirty = fileItems.filter(
      (f) => f.status === 'modified' || f.status === 'added' || f.status === 'deleted',
    ).length;
    const limited = fileItems.slice(0, FILE_LIMIT);
    const hidden = Math.max(0, fileItems.length - FILE_LIMIT);

    return {
      displayedFiles: limited,
      hiddenCount: hidden,
      dirtyCount: dirty,
      hasAnyDirtyFiles: fileItems.length > 0,
    };
  }, [files, mode, dirtyFilePaths, folder.id, folder.path]);

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
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
    const routeBase = mode === 'review' ? 'review' : 'files';
    router.push(`/workbook/${workbookId}/${routeBase}/${encodedFolderPath}`);
    // Also expand if not already expanded
    if (!isExpanded) {
      toggleNode(nodeId);
    }
  }, [mode, router, workbookId, encodedFolderPath, isExpanded, toggleNode, nodeId]);

  // In review mode, hide tables with no dirty files
  if (mode === 'review' && !hasAnyDirtyFiles && !isLoading) {
    return null;
  }

  return (
    <>
      <UnstyledButton
        onClick={handleRowClick}
        onContextMenu={mode === 'files' ? handleContextMenu : undefined}
        px="sm"
        py={4}
        style={{
          width: `calc(100% - ${INDENT_PX}px)`,
          marginLeft: INDENT_PX,
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
            <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-secondary)" />
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
          {displayedFiles.map((file) => (
            <FileNode key={file.path} file={file} mode={mode} onSuccess={handleRefreshTable} />
          ))}

          {/* Hidden count indicator - links to folder view */}
          {hiddenCount > 0 && (
            <Box py={4} px="sm" style={{ marginLeft: INDENT_PX }}>
              <Group gap={6} wrap="nowrap">
                <Box style={{ width: 6, flexShrink: 0 }} />
                <Link href={`/workbook/${workbookId}/files/${encodedFolderPath}`} style={{ textDecoration: 'none' }}>
                  <Text12Regular c="var(--mantine-color-blue-6)" style={{ cursor: 'pointer' }}>
                    {hiddenCount} more...
                  </Text12Regular>
                </Link>
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
            { label: 'Pull this table', icon: DownloadIcon, onClick: handlePullTable },
            {
              label: 'New File',
              icon: FilePlusIcon,
              onClick: () => {
                openNewFileModal();
                setContextMenu(null);
              },
            },
            { label: 'View Schema', icon: FileJsonIcon, onClick: openSchemaModal },
            { label: 'Advanced Settings', icon: SettingsIcon, onClick: openSettings },
            { label: 'Pull Schedule', icon: ClockIcon, onClick: openPullSchedule },
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

      {/* Schema Modal (dev tools only) */}
      <DataFolderSchemaModal opened={schemaModalOpened} onClose={closeSchemaModal} folder={folder} />

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
    </>
  );
}

// ============================================================================
// File Node (individual file)
// ============================================================================

interface FileNodeProps {
  file: FileRefEntity;
  mode?: FileTreeMode;
  onSuccess?: () => void;
}

function FileNode({ file, mode = 'files', onSuccess }: FileNodeProps) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { showSecretButton } = useDevTools();

  // Build the file path for the URL - encode each segment but keep slashes
  const filePath = file.path;
  const encodedPath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  // Use the appropriate route based on mode
  const routeBase = mode === 'review' ? 'review' : 'files';
  const href = `/workbook/${params.id}/${routeBase}/${encodedPath}`;

  // Check if this file is currently selected
  const isSelected = pathname.includes(`/${routeBase}/${encodedPath}`);

  // Determine if file is dirty (modified)
  const isDirty = file.status === 'modified' || file.status === 'added' || file.status === 'deleted';
  const isDeleted = file.status === 'deleted';

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

  const handleFileClick = () => {
    router.push(href);
  };

  return (
    <>
      <UnstyledButton
        onClick={handleFileClick}
        px="sm"
        py={4}
        onContextMenu={mode === 'files' ? handleContextMenu : undefined}
        style={{
          width: `calc(100% - ${INDENT_PX}px)`,
          marginLeft: INDENT_PX,
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

          <TextMono12Regular c={textColor} truncate style={{ flex: 1 }}>
            {file.name}
          </TextMono12Regular>

          {/* Three dots menu - only in files mode */}
          {mode === 'files' && (
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
      </UnstyledButton>

      <ContextMenu
        opened={!!contextMenu}
        onClose={() => setContextMenu(null)}
        position={contextMenu ?? { x: 0, y: 0 }}
        items={[
          ...(showSecretButton
            ? [{ label: 'Test Transformer', icon: FlaskRoundIcon, onClick: openTestTransformer }]
            : []),
          {
            label: 'Copy Path',
            icon: RouteIcon,
            onClick: () => void navigator.clipboard.writeText(`/${filePath}`),
          },
          { type: 'divider' },
          { label: 'Rename', icon: Edit2Icon, onClick: openRenameFile },
          { label: 'Delete', icon: Trash2Icon, onClick: openRemoveFile, delete: true },
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
            router.push(`/workbook/${params.id}/${routeBase}/${newEncodedPath}`);
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
  const expandedNodes = useNewWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useNewWorkbookUIStore((state) => state.toggleNode);
  const setWorkbookError = useWorkbookEditorUIStore((state) => state.setWorkbookError);
  const [isReauthorizing, setIsReauthorizing] = useState(false);

  const nodeId = `connection-${connectorAccount.displayName || connectorAccount.id}`;
  const isExpanded = expandedNodes.has(nodeId);

  // Connection health status
  const isConnected = connectorAccount.healthStatus === 'OK' || connectorAccount.healthStatus === null;

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Choose tables modal state
  const [chooseTablesOpened, { open: openChooseTables, close: closeChooseTables }] = useDisclosure(false);

  // Remove connection modal state
  const [removeModalOpened, { open: openRemoveModal, close: closeRemoveModal }] = useDisclosure(false);

  // Update connection modal state
  const [updateConnectionModalOpened, { open: openUpdateConnectionModal, close: closeUpdateConnectionModal }] =
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

  const handleReauthorize = async () => {
    if (connectorAccount.authType !== AuthType.OAUTH) {
      // Only necessary for OAuth connections
      return;
    }
    /*
     * This turns on a temporary overlay until the OAuth does the first redirect to the service
     * just in case the server is lagging when generating the OAuth URL.
     */
    setIsReauthorizing(true);

    try {
      await initiateOAuth(connectorAccount.service as OAuthService, {
        workbookId: workbookId,
        redirectPrefix: `${window.location.protocol}//${window.location.host}`,
        connectionMethod: 'OAUTH_SYSTEM',
        connectionName: connectorAccount.displayName,
        returnPage: window.location.pathname,
        // setting the connector ID is what makes this a reauthorization
        connectorAccountId: connectorAccount.id,
      });
      // The initiateOAuth function will redirect the user, so we don't need to do anything else here
    } catch (error) {
      console.error('OAuth initiation failed:', error);
      setWorkbookError({
        description: `Failed to reauthorize connection to ${connectorAccount.displayName}. Please try again.`,
        cause: error as Error,
      });
    } finally {
      setIsReauthorizing(false);
    }
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
          <UnstyledButton onClick={openChooseTables}>
            <Text12Regular c="var(--mantine-color-blue-6)" style={{ cursor: 'pointer' }}>
              Choose tables
            </Text12Regular>
          </UnstyledButton>
        </Box>
      </Collapse>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          opened={true}
          onClose={() => setContextMenu(null)}
          position={contextMenu}
          items={[
            { label: 'Choose tables', icon: TableIcon, onClick: openChooseTables },
            connectorAccount.authType === AuthType.OAUTH
              ? { label: 'Reauthorize', icon: CloudCogIcon, onClick: handleReauthorize }
              : { label: 'Edit Connection', icon: SettingsIcon, onClick: openUpdateConnectionModal },
            { type: 'divider' },
            { label: 'Remove', icon: Trash2Icon, onClick: openRemoveModal, delete: true },
          ]}
        />
      )}

      {/* Choose Tables Modal */}
      <ChooseTablesModal
        opened={chooseTablesOpened}
        onClose={closeChooseTables}
        workbookId={workbookId}
        connectorAccount={connectorAccount}
      />

      {/* Remove Connection Modal */}
      <RemoveConnectionModal
        opened={removeModalOpened}
        onClose={closeRemoveModal}
        connectorAccount={connectorAccount}
        workbookId={workbookId}
      />

      <UpdateConnectionModal
        opened={updateConnectionModalOpened}
        onClose={closeUpdateConnectionModal}
        connectorAccount={connectorAccount}
      />
    </>
  );
}
