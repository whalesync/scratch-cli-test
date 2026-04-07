'use client';

import { ActionIconThreeDots } from '@/app/components/base/action-icons';
import { ButtonPrimaryLight } from '@/app/components/base/buttons';
import { OpenInDesktopButton } from '@/app/components/open-in-desktop-button';
import { Text12Medium, Text12Regular, Text13Regular } from '@/app/components/base/text';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { TextTitle2 } from '@/app/components/base/text';
import { SidebarFooter } from '@/app/workbook/[id]/components/Sidebar/SidebarFooter';
import { ChevronToggle, INDENT_PX } from '@/app/workbook/[id]/components/Sidebar/tree-node-primitives';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useWorkbook } from '@/hooks/use-workbook';
import { Box, Collapse, Group, Menu, ScrollArea, Stack, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { ConnectorAccount, DataFolder, DataFolderGroup, WorkbookId } from '@spinner/shared-types';
import { FolderIcon, PlusIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { AdvancedFolderSettingsModal } from '@/app/workbook/[id]/components/shared/AdvancedFolderSettingsModal';
import { ChooseTablesModal } from '@/app/workbook/[id]/components/shared/ChooseTablesModal';
import { CreateConnectionModal } from '@/app/workbook/[id]/components/shared/CreateConnectionModal';
import { RemoveConnectionModal } from '@/app/workbook/[id]/components/shared/RemoveConnectionModal';
import { RemoveTableModal } from '@/app/workbook/[id]/components/shared/RemoveTableModal';
import { UpdateConnectionModal } from '@/app/workbook/[id]/components/shared/UpdateConnectionModal';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { initiateOAuth } from '@/utils/oauth';
import { AuthType } from '@spinner/shared-types';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

const MAX_SIDEBAR_WIDTH = 500;

// ============================================================================
// Folder tree helpers (mirrored from TreeNode.tsx for this standalone page)
// ============================================================================

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

/** Recursively collect all intermediate node IDs from a folder tree. */
function collectIntermediateNodeIds(tree: FolderTreeNode, idPrefix: string, out: string[]): void {
  for (const [segName, childNode] of tree.children.entries()) {
    const childId = `${idPrefix}/${segName}`;
    out.push(`intermediate-${childId}`);
    collectIntermediateNodeIds(childNode, childId, out);
  }
}

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
// Local expand/collapse state hook
// ============================================================================

function useExpandedNodes() {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback((nodeIds: string[]) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      for (const id of nodeIds) next.add(id);
      return next;
    });
  }, []);

  return { expandedNodes, toggleNode, expandAll };
}

// ============================================================================
// Page
// ============================================================================

export default function ConnectionsPage() {
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const openWorkbook = useWorkbookUIStore((state) => state.openWorkbook);
  const closeWorkbook = useWorkbookUIStore((state) => state.closeWorkbook);

  // Set the active workbook in the store so shared modals (AdvancedFolderSettings, etc.) work
  useEffect(() => {
    openWorkbook({ workbookId });
    return () => {
      closeWorkbook();
    };
  }, [workbookId, openWorkbook, closeWorkbook]);

  const { workbook } = useWorkbook(workbookId);
  const { connectorAccounts, isLoading: isLoadingConnections } = useConnectorAccounts(workbookId);
  const { dataFolderGroups, isLoading: isLoadingFolders } = useDataFolders(workbookId);
  const { metadata } = useConnectorsMetadata();
  const { expandedNodes, toggleNode, expandAll } = useExpandedNodes();
  const hasExpandedInitially = useRef(false);

  // Connect service modal state
  const [connectionModalOpened, { open: openConnectionModal, close: closeConnectionModal }] = useDisclosure(false);
  const [chooseTablesAfterCreateOpened, { open: openChooseTablesAfterCreate, close: closeChooseTablesAfterCreate }] =
    useDisclosure(false);
  const [newlyCreatedAccount, setNewlyCreatedAccount] = useState<ConnectorAccount | null>(null);

  const handleConnectionCreated = useCallback(
    (account: ConnectorAccount) => {
      setNewlyCreatedAccount(account);
      openChooseTablesAfterCreate();
    },
    [openChooseTablesAfterCreate],
  );

  const isLoading = isLoadingConnections || isLoadingFolders;

  // Expand all nodes once data is available
  useEffect(() => {
    if (isLoading || hasExpandedInitially.current) return;
    hasExpandedInitially.current = true;

    const nodeIds: string[] = [];

    for (const group of dataFolderGroups) {
      nodeIds.push(`connection-${group.name}`);
      const tree = buildFolderTree(group.dataFolders, group.name);
      collectIntermediateNodeIds(tree, group.name, nodeIds);
    }

    // Empty connector accounts not in any group
    for (const ca of connectorAccounts ?? []) {
      if (!dataFolderGroups.some((g) => g.dataFolders.some((f) => f.connectorAccountId === ca.id))) {
        nodeIds.push(`connection-empty-${ca.id}`);
      }
    }

    expandAll(nodeIds);
  }, [isLoading, dataFolderGroups, connectorAccounts, expandAll]);

  return (
    <Stack gap={0} h="100vh" style={{ backgroundColor: 'var(--bg-base)' }}>
      {/* Header — full width */}
      <Group
        justify="space-between"
        align="flex-start"
        wrap="nowrap"
        px="md"
        py="md"
        style={{ flexShrink: 0, borderBottom: '1px solid var(--fg-divider)' }}
      >
        <Box>
          <TextTitle2>Connections</TextTitle2>
          {workbook && (
            <Text13Regular c="var(--fg-secondary)" mt={4}>
              {workbook.name}
            </Text13Regular>
          )}
        </Box>
        <Group gap="sm" wrap="nowrap">
          <OpenInDesktopButton
            webPathForDeepLink={`/workspace/${workbookId}/connections`}
            section="workspace_connections"
            variant="outline"
          >
            Back to Scratch Desktop
          </OpenInDesktopButton>
          <ButtonPrimaryLight leftSection={<StyledLucideIcon Icon={PlusIcon} size="sm" />} onClick={openConnectionModal}>
            Connect service
          </ButtonPrimaryLight>
        </Group>
      </Group>

      {/* Create Connection Modal */}
      <CreateConnectionModal
        opened={connectionModalOpened}
        onClose={closeConnectionModal}
        workbookId={workbookId}
        returnUrl={`/workspace/${workbookId}/connections`}
        onConnectionCreated={handleConnectionCreated}
      />

      {/* Choose Tables Modal (after creating connection) */}
      {newlyCreatedAccount && (
        <ChooseTablesModal
          opened={chooseTablesAfterCreateOpened}
          onClose={() => {
            closeChooseTablesAfterCreate();
            setNewlyCreatedAccount(null);
          }}
          workbookId={workbookId}
          connectorAccount={newlyCreatedAccount}
        />
      )}

      {/* Tree + footer constrained to sidebar width */}
      <Stack
        gap={0}
        style={{
          flex: 1,
          width: MAX_SIDEBAR_WIDTH,
          maxWidth: '100%',
          minHeight: 0,
        }}
      >
        <ScrollArea style={{ flex: 1 }}>
          <Stack gap={0} pb="sm" pt="xs">
            {isLoading && (
              <Box px="sm" py="xs">
                <Text12Regular c="var(--fg-muted)">Loading connections...</Text12Regular>
              </Box>
            )}

            {!isLoading && dataFolderGroups.length === 0 && (
              <Box px="sm" py="xs">
                <Text12Regular c="var(--fg-muted)">No connections yet.</Text12Regular>
              </Box>
            )}

            {!isLoading &&
              dataFolderGroups.map((group) => {
                // Find the connector account for this group (match by service + name)
                const connectorAccount = (connectorAccounts ?? []).find(
                  (ca) => ca.displayName === group.name || getServiceName(metadata, ca.service) === group.name,
                );

                return (
                  <ConnectionTreeNode
                    key={group.name}
                    group={group}
                    workbookId={workbookId}
                    connectorAccount={connectorAccount}
                    expandedNodes={expandedNodes}
                    toggleNode={toggleNode}
                  />
                );
              })}

            {/* Show empty connector accounts (connected but no tables yet) */}
            {!isLoading &&
              (connectorAccounts ?? [])
                .filter(
                  (ca) => !dataFolderGroups.some((g) => g.dataFolders.some((f) => f.connectorAccountId === ca.id)),
                )
                .map((ca) => (
                  <EmptyConnectionTreeNode
                    key={ca.id}
                    connectorAccount={ca}
                    workbookId={workbookId}
                    expandedNodes={expandedNodes}
                    toggleNode={toggleNode}
                  />
                ))}
          </Stack>
        </ScrollArea>

        <SidebarFooter hideBorder />
      </Stack>
    </Stack>
  );
}

// ============================================================================
// Connection Tree Node (top-level, like ConnectionNode in FileTree)
// ============================================================================

interface ConnectionTreeNodeProps {
  group: DataFolderGroup;
  workbookId: WorkbookId;
  connectorAccount?: ConnectorAccount;
  expandedNodes: Set<string>;
  toggleNode: (nodeId: string) => void;
}

function ConnectionTreeNode({ group, workbookId, connectorAccount, expandedNodes, toggleNode }: ConnectionTreeNodeProps) {
  const nodeId = `connection-${group.name}`;
  const isExpanded = expandedNodes.has(nodeId);
  const [chooseTablesOpen, { open: openChooseTables, close: closeChooseTables }] = useDisclosure(false);
  const [updateConnectionOpen, { open: openUpdateConnection, close: closeUpdateConnection }] = useDisclosure(false);
  const [removeConnectionOpen, { open: openRemoveConnection, close: closeRemoveConnection }] = useDisclosure(false);
  const setWorkbookError = useWorkbookUIStore((state) => state.setWorkbookError);

  const folderTree = useMemo(() => buildFolderTree(group.dataFolders, group.name), [group.dataFolders, group.name]);

  const isConnected = connectorAccount
    ? connectorAccount.healthStatus === 'OK' || connectorAccount.healthStatus === null
    : true;

  const handleReauthorize = useCallback(async () => {
    if (!connectorAccount || connectorAccount.authType !== AuthType.OAUTH) return;
    try {
      await initiateOAuth(connectorAccount.service, {
        workbookId,
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
    }
  }, [connectorAccount, workbookId, setWorkbookError]);

  const handleToggle = useCallback(() => {
    toggleNode(nodeId);
  }, [toggleNode, nodeId]);

  const handleChevronClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      handleToggle();
    },
    [handleToggle],
  );

  const handleRowKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleToggle();
      }
    },
    [handleToggle],
  );

  return (
    <>
      <UnstyledButton
        component="div"
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={handleRowKeyDown}
        px="sm"
        py={4}
        style={{ width: '100%', backgroundColor: 'transparent' }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap" justify="space-between">
          <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <ChevronToggle isExpanded={isExpanded} onClick={handleChevronClick} />

            {group.service ? (
              <ConnectorIcon connector={group.service} size={16} p={0} />
            ) : (
              <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-secondary)" />
            )}

            <Text12Medium c="var(--fg-primary)" truncate style={{ fontWeight: 600 }}>
              {group.name}
            </Text12Medium>

            <HealthStatusDot isConnected={isConnected} />
          </Group>

          {connectorAccount && (
            <ConnectionMenu
              connectorAccount={connectorAccount}
              onChooseTables={openChooseTables}
              onReauthorize={handleReauthorize}
              onEditConnection={openUpdateConnection}
              onRemove={openRemoveConnection}
            />
          )}
        </Group>
      </UnstyledButton>

      <Collapse in={isExpanded}>
        <FolderTreeRenderer
          tree={folderTree}
          depth={1}
          groupName={group.name}
          workbookId={workbookId}
          expandedNodes={expandedNodes}
          toggleNode={toggleNode}
        />
      </Collapse>

      {connectorAccount && (
        <>
          <ChooseTablesModal
            opened={chooseTablesOpen}
            onClose={closeChooseTables}
            workbookId={workbookId}
            connectorAccount={connectorAccount}
          />
          <UpdateConnectionModal
            opened={updateConnectionOpen}
            onClose={closeUpdateConnection}
            connectorAccount={connectorAccount}
          />
          <RemoveConnectionModal
            opened={removeConnectionOpen}
            onClose={closeRemoveConnection}
            connectorAccount={connectorAccount}
            workbookId={workbookId}
          />
        </>
      )}
    </>
  );
}

// ============================================================================
// Empty Connection Tree Node (connected account with no tables)
// ============================================================================

interface EmptyConnectionTreeNodeProps {
  connectorAccount: ConnectorAccount;
  workbookId: WorkbookId;
  expandedNodes: Set<string>;
  toggleNode: (nodeId: string) => void;
}

function EmptyConnectionTreeNode({ connectorAccount, workbookId, expandedNodes, toggleNode }: EmptyConnectionTreeNodeProps) {
  const { metadata } = useConnectorsMetadata();
  const setWorkbookError = useWorkbookUIStore((state) => state.setWorkbookError);
  const nodeId = `connection-empty-${connectorAccount.id}`;
  const isExpanded = expandedNodes.has(nodeId);
  const displayName = connectorAccount.displayName || getServiceName(metadata, connectorAccount.service);
  const [chooseTablesOpen, { open: openChooseTables, close: closeChooseTables }] = useDisclosure(false);
  const [updateConnectionOpen, { open: openUpdateConnection, close: closeUpdateConnection }] = useDisclosure(false);
  const [removeConnectionOpen, { open: openRemoveConnection, close: closeRemoveConnection }] = useDisclosure(false);

  const isConnected = connectorAccount.healthStatus === 'OK' || connectorAccount.healthStatus === null;

  const handleReauthorize = useCallback(async () => {
    if (connectorAccount.authType !== AuthType.OAUTH) return;
    try {
      await initiateOAuth(connectorAccount.service, {
        workbookId,
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
    }
  }, [connectorAccount, workbookId, setWorkbookError]);

  const handleToggle = useCallback(() => {
    toggleNode(nodeId);
  }, [toggleNode, nodeId]);

  const handleChevronClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      handleToggle();
    },
    [handleToggle],
  );

  const handleRowKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleToggle();
      }
    },
    [handleToggle],
  );

  return (
    <>
      <UnstyledButton
        component="div"
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={handleRowKeyDown}
        px="sm"
        py={4}
        style={{ width: '100%', backgroundColor: 'transparent' }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap" justify="space-between">
          <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <ChevronToggle isExpanded={isExpanded} onClick={handleChevronClick} />
            <ConnectorIcon connector={connectorAccount.service} size={16} p={0} />
            <Text12Medium c="var(--fg-primary)" truncate style={{ fontWeight: 600 }}>
              {displayName}
            </Text12Medium>
            <HealthStatusDot isConnected={isConnected} />
          </Group>

          <ConnectionMenu
            connectorAccount={connectorAccount}
            onChooseTables={openChooseTables}
            onReauthorize={handleReauthorize}
            onEditConnection={openUpdateConnection}
            onRemove={openRemoveConnection}
          />
        </Group>
      </UnstyledButton>

      <Collapse in={isExpanded}>
        <Box py={4} style={{ width: `calc(100% - ${INDENT_PX * 2}px)`, marginLeft: INDENT_PX * 2 }} px="sm">
          <Text12Regular c="var(--fg-muted)">No tables linked yet.</Text12Regular>
        </Box>
      </Collapse>

      <ChooseTablesModal
        opened={chooseTablesOpen}
        onClose={closeChooseTables}
        workbookId={workbookId}
        connectorAccount={connectorAccount}
      />
      <UpdateConnectionModal
        opened={updateConnectionOpen}
        onClose={closeUpdateConnection}
        connectorAccount={connectorAccount}
      />
      <RemoveConnectionModal
        opened={removeConnectionOpen}
        onClose={closeRemoveConnection}
        connectorAccount={connectorAccount}
        workbookId={workbookId}
      />
    </>
  );
}

// ============================================================================
// Health Status Dot
// ============================================================================

function HealthStatusDot({ isConnected }: { isConnected: boolean }) {
  return (
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
  expandedNodes: Set<string>;
  toggleNode: (nodeId: string) => void;
}

function FolderTreeRenderer({ tree, depth, groupName, workbookId, expandedNodes, toggleNode }: FolderTreeRendererProps) {
  return (
    <>
      {Array.from(tree.children.entries()).map(([segName, childNode]) => {
        const nodeId = `intermediate-${groupName}/${segName}`;
        return (
          <IntermediateFolderNode
            key={nodeId}
            name={segName}
            nodeId={nodeId}
            depth={depth}
            expandedNodes={expandedNodes}
            toggleNode={toggleNode}
          >
            <FolderTreeRenderer
              tree={childNode}
              depth={depth + 1}
              groupName={groupName}
              workbookId={workbookId}
              expandedNodes={expandedNodes}
              toggleNode={toggleNode}
            />
          </IntermediateFolderNode>
        );
      })}
      {tree.folders.map((folder) => (
        <DataFolderNode key={folder.id} folder={folder} depth={depth} workbookId={workbookId} />
      ))}
    </>
  );
}

// ============================================================================
// Intermediate Folder Node (collapsible path segment)
// ============================================================================

interface IntermediateFolderNodeProps {
  name: string;
  nodeId: string;
  depth: number;
  expandedNodes: Set<string>;
  toggleNode: (nodeId: string) => void;
  children: ReactNode;
}

function IntermediateFolderNode({ name, nodeId, depth, expandedNodes, toggleNode, children }: IntermediateFolderNodeProps) {
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
        }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap">
          <ChevronToggle isExpanded={isExpanded} />
          <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-secondary)" />
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
// Data Folder Node (leaf — the actual table/folder with context menu)
// ============================================================================

interface DataFolderNodeProps {
  folder: DataFolder;
  depth: number;
  workbookId: WorkbookId;
}

function DataFolderNode({ folder, depth, workbookId }: DataFolderNodeProps) {
  const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
  const [removeOpened, { open: openRemove, close: closeRemove }] = useDisclosure(false);

  return (
    <>
      <Group
        gap={6}
        wrap="nowrap"
        justify="space-between"
        px="sm"
        py={4}
        style={{
          width: `calc(100% - ${INDENT_PX * depth}px)`,
          marginLeft: INDENT_PX * depth,
        }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          {/* Spacer matching chevron width to align with folders above */}
          <Box style={{ width: 20, flexShrink: 0 }} />
          <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-secondary)" />
          <Text12Regular c="var(--fg-primary)" truncate>
            {folder.name}
          </Text12Regular>
        </Group>
        <DataFolderMenu onAdvancedSettings={openSettings} onUnlink={openRemove} />
      </Group>
      <AdvancedFolderSettingsModal opened={settingsOpened} onClose={closeSettings} folder={folder} />
      <RemoveTableModal opened={removeOpened} onClose={closeRemove} folder={folder} workbookId={workbookId} />
    </>
  );
}

// ============================================================================
// Menus
// ============================================================================

function stopPropagation(e: MouseEvent) {
  e.stopPropagation();
}

interface ConnectionMenuProps {
  connectorAccount: ConnectorAccount;
  onChooseTables?: () => void;
  onReauthorize?: () => void;
  onEditConnection?: () => void;
  onRemove?: () => void;
}

function ConnectionMenu({ connectorAccount, onChooseTables, onReauthorize, onEditConnection, onRemove }: ConnectionMenuProps) {
  const isOAuth = connectorAccount.authType === AuthType.OAUTH;

  return (
    <Box onClick={stopPropagation}>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIconThreeDots size="sm" />
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={onChooseTables}>Choose tables</Menu.Item>
          {isOAuth ? (
            <Menu.Item onClick={onReauthorize}>Reauthorize</Menu.Item>
          ) : (
            <Menu.Item onClick={onEditConnection}>Edit settings</Menu.Item>
          )}
          <Menu.Divider />
          <Menu.Item color="red" onClick={onRemove}>
            Remove
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Box>
  );
}

function DataFolderMenu({ onAdvancedSettings, onUnlink }: { onAdvancedSettings: () => void; onUnlink: () => void }) {
  return (
    <Box onClick={stopPropagation}>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIconThreeDots size="sm" />
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={onAdvancedSettings}>Advanced settings</Menu.Item>
          <Menu.Divider />
          <Menu.Item color="red" onClick={onUnlink}>
            Unlink this table
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Box>
  );
}
