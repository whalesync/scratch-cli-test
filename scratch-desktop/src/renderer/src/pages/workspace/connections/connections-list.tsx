import { ButtonSecondaryOutline } from '@/components/base/buttons';
import { Text12Medium, Text12Regular, Text13Medium, Text13Regular, Text16Medium } from '@/components/base/text';
import { ConnectorIcon } from '@/components/icons/ConnectorIcon';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { useConnectorAccounts } from '@/hooks/use-connector-accounts';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDataFolders } from '@/hooks/use-data-folders';
import { initiateDesktopOAuth } from '@/lib/oauth-helpers';
import { ActionIcon, Box, Menu, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { ConnectorAccount, DataFolder, DataFolderGroup, DataFolderOptions } from '@spinner/shared-types';
import { AuthType, ConnectorHealthStatus } from '@spinner/shared-types';
import { FolderIcon, FolderLockIcon, LinkIcon, PlusIcon, SettingsIcon, Trash2Icon, UnlinkIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { AdvancedFolderSettingsModal } from './advanced-folder-settings-modal';
import { ChooseTablesModal } from './choose-tables-modal';
import styles from './connections-dialog.module.css';
import { CreateConnectionModal } from './create-connection-modal';
import { RemoveConnectionModal } from './remove-connection-modal';
import { RemoveTableModal } from './remove-table-modal';
import { UpdateConnectionModal } from './update-connection-modal';

// ============================================================================
// Folder tree helpers
// ============================================================================

function getIntermediateSegments(folderPath: string, connectionName?: string): string[] {
  const segments = folderPath.replace(/^\//, '').split('/');
  const adjusted = connectionName && segments[0] === connectionName ? segments.slice(1) : segments;
  if (adjusted.length <= 1) return [];
  return adjusted.slice(0, -1);
}

interface FolderTreeNode {
  folders: DataFolder[];
  children: Map<string, FolderTreeNode>;
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
// ConnectionsList
// ============================================================================

interface ConnectionsListProps {
  workbookId: string;
  createModalOpened: boolean;
  onOpenCreateModal: () => void;
  onCloseCreateModal: () => void;
  onDataRefresh?: () => void;
  newConnectionId?: string | null;
  onNewConnectionConsumed?: () => void;
}

export function ConnectionsList({
  workbookId,
  createModalOpened,
  onOpenCreateModal,
  onCloseCreateModal,
  onDataRefresh,
  newConnectionId,
  onNewConnectionConsumed,
}: ConnectionsListProps) {
  const { connectorAccounts, isLoading: isLoadingConnections } = useConnectorAccounts(workbookId);
  const { dataFolderGroups, isLoading: isLoadingFolders } = useDataFolders(workbookId);
  const connectorAccountMap = useMemo(
    () => new Map((connectorAccounts ?? []).map((account) => [account.id, account])),
    [connectorAccounts],
  );

  const [chooseTablesAfterCreateOpened, { open: openChooseTablesAfterCreate, close: closeChooseTablesAfterCreate }] =
    useDisclosure(false);
  const [newlyCreatedAccount, setNewlyCreatedAccount] = useState<ConnectorAccount | null>(null);

  // Auto-open Choose Tables modal when returning from OAuth callback with a new connection
  const consumedConnectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!newConnectionId || isLoadingConnections || !connectorAccounts) return;
    if (consumedConnectionRef.current === newConnectionId) return;
    const account = connectorAccounts.find((ca) => ca.id === newConnectionId);
    if (account) {
      consumedConnectionRef.current = newConnectionId;
      setNewlyCreatedAccount(account);
      openChooseTablesAfterCreate();
      onNewConnectionConsumed?.();
    }
  }, [newConnectionId, isLoadingConnections, connectorAccounts, openChooseTablesAfterCreate, onNewConnectionConsumed]);

  const handleConnectionCreated = useCallback(
    (account: ConnectorAccount) => {
      setNewlyCreatedAccount(account);
      openChooseTablesAfterCreate();
    },
    [openChooseTablesAfterCreate],
  );

  const isLoading = isLoadingConnections || isLoadingFolders;

  const hasConnections =
    dataFolderGroups.length > 0 ||
    (connectorAccounts ?? []).some(
      (ca) => !dataFolderGroups.some((g) => g.dataFolders.some((f) => f.connectorAccountId === ca.id)),
    );

  return (
    <div className={styles.content}>
      {/* Create Connection Modal */}
      <CreateConnectionModal
        opened={createModalOpened}
        onClose={onCloseCreateModal}
        workbookId={workbookId}
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

      {/* Loading state */}
      {isLoading && (
        <Box py="xs">
          <Text12Regular c="var(--fg-muted)">Loading connections...</Text12Regular>
        </Box>
      )}

      {/* Empty state */}
      {!isLoading && !hasConnections && (
        <div className={styles.zeroState}>
          <div className={styles.zeroIcon}>
            <StyledLucideIcon Icon={LinkIcon} size="xl" c="var(--fg-primary)" />
          </div>
          <Text16Medium mb={6}>No connections yet</Text16Medium>
          <Text13Regular c="var(--fg-secondary)" mb="lg" style={{ maxWidth: 280, margin: '0 auto 22px' }}>
            Connect a service to see your data.
          </Text13Regular>
          <ButtonSecondaryOutline
            leftSection={<StyledLucideIcon Icon={PlusIcon} size="sm" />}
            onClick={onOpenCreateModal}
          >
            Connect service
          </ButtonSecondaryOutline>
        </div>
      )}

      {/* Service blocks */}
      {!isLoading &&
        [...dataFolderGroups]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((group) => {
            const connectorAccountId = group.dataFolders[0]?.connectorAccountId;
            const connectorAccount = connectorAccountId ? connectorAccountMap.get(connectorAccountId) : undefined;
            const key = connectorAccountId ? `${group.name}-${connectorAccountId}` : group.name;

            return (
              <ServiceBlock
                key={key}
                group={group}
                workbookId={workbookId}
                connectorAccount={connectorAccount}
                onDataRefresh={onDataRefresh}
              />
            );
          })}

      {/* Empty connector accounts (connected but no tables yet) */}
      {!isLoading &&
        (connectorAccounts ?? [])
          .filter((ca) => !dataFolderGroups.some((g) => g.dataFolders.some((f) => f.connectorAccountId === ca.id)))
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .map((ca) => (
            <EmptyServiceBlock
              key={ca.id}
              connectorAccount={ca}
              workbookId={workbookId}
              onDataRefresh={onDataRefresh}
            />
          ))}
    </div>
  );
}

// Need useState import
import { useState } from 'react';

// ============================================================================
// Service Block (card with header + table rows)
// ============================================================================

interface ServiceBlockProps {
  group: DataFolderGroup;
  workbookId: string;
  connectorAccount?: ConnectorAccount;
  onDataRefresh?: () => void;
}

function ServiceBlock({ group, workbookId, connectorAccount, onDataRefresh }: ServiceBlockProps) {
  const [chooseTablesOpen, { open: openChooseTables, close: closeChooseTables }] = useDisclosure(false);
  const [updateConnectionOpen, { open: openUpdateConnection, close: closeUpdateConnection }] = useDisclosure(false);
  const [removeConnectionOpen, { open: openRemoveConnection, close: closeRemoveConnection }] = useDisclosure(false);

  const folderTree = useMemo(() => buildFolderTree(group.dataFolders, group.name), [group.dataFolders, group.name]);
  const hasTables = group.dataFolders.length > 0;

  const isConnected = connectorAccount
    ? connectorAccount.healthStatus === ConnectorHealthStatus.OK || connectorAccount.healthStatus === null
    : true;

  const handleReauthorize = useCallback(async () => {
    if (!connectorAccount || connectorAccount.authType !== AuthType.OAUTH) return;
    try {
      const webUrl = (import.meta.env.VITE_SCRATCH_WEB_URL as string) || 'http://localhost:3000';
      await initiateDesktopOAuth(connectorAccount.service, {
        workbookId,
        redirectPrefix: webUrl,
        connectionMethod: 'OAUTH_SYSTEM',
        connectionName: connectorAccount.displayName,
        returnPage: `scratch://oauth-callback`,
        connectorAccountId: connectorAccount.id,
      });
    } catch (error) {
      console.debug('OAuth initiation failed:', error);
    }
  }, [connectorAccount, workbookId]);

  return (
    <>
      <div className={`${styles.serviceBlock} ${!isConnected ? styles.serviceBlockError : ''}`}>
        {/* Service header row */}
        <div className={`${styles.serviceRow} ${hasTables ? styles.serviceRowWithTables : ''}`}>
          <div className={styles.serviceIcon}>
            {group.service ? (
              <ConnectorIcon connector={group.service} size={28} p={0} />
            ) : (
              <StyledLucideIcon Icon={FolderIcon} size="md" c="var(--fg-secondary)" />
            )}
          </div>
          <div className={styles.serviceNameGroup}>
            <Text13Medium c="var(--fg-primary)">{group.name}</Text13Medium>
            <div className={`${styles.statusDot} ${isConnected ? styles.statusDotGreen : styles.statusDotRed}`} />
          </div>
          {!isConnected && <span className={styles.errorLabel}>Connection error</span>}
          {connectorAccount && (
            <ServiceActions
              connectorAccount={connectorAccount}
              isConnected={isConnected}
              onChooseTables={openChooseTables}
              onReauthorize={() => void handleReauthorize()}
              onEditConnection={openUpdateConnection}
              onRemove={openRemoveConnection}
            />
          )}
        </div>

        {/* Table rows */}
        <FolderTreeRenderer
          tree={folderTree}
          groupName={group.name}
          workbookId={workbookId}
          nested={false}
          onDataRefresh={onDataRefresh}
        />
      </div>

      {connectorAccount && (
        <>
          <ChooseTablesModal
            opened={chooseTablesOpen}
            onClose={closeChooseTables}
            workbookId={workbookId}
            connectorAccount={connectorAccount}
            onDataRefresh={onDataRefresh}
          />
          <UpdateConnectionModal
            opened={updateConnectionOpen}
            onClose={closeUpdateConnection}
            workbookId={workbookId}
            connectorAccount={connectorAccount}
          />
          <RemoveConnectionModal
            opened={removeConnectionOpen}
            onClose={closeRemoveConnection}
            connectorAccount={connectorAccount}
            workbookId={workbookId}
            onDataRefresh={onDataRefresh}
          />
        </>
      )}
    </>
  );
}

// ============================================================================
// Empty Service Block
// ============================================================================

interface EmptyServiceBlockProps {
  connectorAccount: ConnectorAccount;
  workbookId: string;
  onDataRefresh?: () => void;
}

function EmptyServiceBlock({ connectorAccount, workbookId, onDataRefresh }: EmptyServiceBlockProps) {
  const { data: metadata } = useConnectorsMetadata();
  const displayName = connectorAccount.displayName || getServiceName(metadata, connectorAccount.service);
  const [chooseTablesOpen, { open: openChooseTables, close: closeChooseTables }] = useDisclosure(false);
  const [updateConnectionOpen, { open: openUpdateConnection, close: closeUpdateConnection }] = useDisclosure(false);
  const [removeConnectionOpen, { open: openRemoveConnection, close: closeRemoveConnection }] = useDisclosure(false);

  const isConnected =
    connectorAccount.healthStatus === ConnectorHealthStatus.OK || connectorAccount.healthStatus === null;

  const handleReauthorize = useCallback(async () => {
    if (connectorAccount.authType !== AuthType.OAUTH) return;
    try {
      const webUrl = (import.meta.env.VITE_SCRATCH_WEB_URL as string) || 'http://localhost:3000';
      await initiateDesktopOAuth(connectorAccount.service, {
        workbookId,
        redirectPrefix: webUrl,
        connectionMethod: 'OAUTH_SYSTEM',
        connectionName: connectorAccount.displayName,
        returnPage: `scratch://oauth-callback`,
        connectorAccountId: connectorAccount.id,
      });
    } catch (error) {
      console.debug('OAuth initiation failed:', error);
    }
  }, [connectorAccount, workbookId]);

  return (
    <>
      <div className={`${styles.serviceBlock} ${!isConnected ? styles.serviceBlockError : ''}`}>
        <div className={styles.serviceRow}>
          <div className={styles.serviceIcon}>
            <ConnectorIcon connector={connectorAccount.service} size={28} p={0} />
          </div>
          <div className={styles.serviceNameGroup}>
            <Text13Medium c="var(--fg-primary)">{displayName}</Text13Medium>
            <div className={`${styles.statusDot} ${isConnected ? styles.statusDotGreen : styles.statusDotRed}`} />
          </div>
          {!isConnected && <span className={styles.errorLabel}>Connection error</span>}
          <ServiceActions
            connectorAccount={connectorAccount}
            isConnected={isConnected}
            onChooseTables={openChooseTables}
            onReauthorize={() => void handleReauthorize()}
            onEditConnection={openUpdateConnection}
            onRemove={openRemoveConnection}
          />
        </div>
        <div className={styles.emptyTablesRow}>
          <Text12Regular c="var(--fg-muted)">No tables linked yet.</Text12Regular>
        </div>
      </div>

      <ChooseTablesModal
        opened={chooseTablesOpen}
        onClose={closeChooseTables}
        workbookId={workbookId}
        connectorAccount={connectorAccount}
        onDataRefresh={onDataRefresh}
      />
      <UpdateConnectionModal
        opened={updateConnectionOpen}
        onClose={closeUpdateConnection}
        workbookId={workbookId}
        connectorAccount={connectorAccount}
      />
      <RemoveConnectionModal
        opened={removeConnectionOpen}
        onClose={closeRemoveConnection}
        connectorAccount={connectorAccount}
        workbookId={workbookId}
        onDataRefresh={onDataRefresh}
      />
    </>
  );
}

// ============================================================================
// Service Actions
// ============================================================================

interface ServiceActionsProps {
  connectorAccount: ConnectorAccount;
  isConnected: boolean;
  onChooseTables?: () => void;
  onReauthorize?: () => void;
  onEditConnection?: () => void;
  onRemove?: () => void;
}

function ServiceActions({
  connectorAccount,
  isConnected,
  onChooseTables,
  onReauthorize,
  onEditConnection,
  onRemove,
}: ServiceActionsProps) {
  const isOAuth = connectorAccount.authType === AuthType.OAUTH;

  if (!isConnected) {
    const failedPrimaryAction = isOAuth ? onReauthorize : onEditConnection;
    const failedPrimaryLabel = isOAuth ? 'Reconnect' : 'Edit settings';

    return (
      <div className={styles.rowActions}>
        <button className={styles.actionBtn} onClick={failedPrimaryAction}>
          {failedPrimaryLabel}
        </button>
        <Menu>
          <Menu.Target>
            <ActionIcon variant="subtle" size="sm">
              <StyledLucideIcon Icon={Trash2Icon} size="sm" />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<Trash2Icon size={16} />} onClick={onRemove} color="red">
              Remove connection
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>
    );
  }

  return (
    <div className={styles.rowActions}>
      <button className={styles.actionBtn} onClick={onChooseTables}>
        Choose tables
      </button>
      {isOAuth ? (
        <button className={styles.actionBtn} onClick={onReauthorize}>
          Reauthorize
        </button>
      ) : (
        <button className={styles.actionBtn} onClick={onEditConnection}>
          Edit settings
        </button>
      )}
      <Menu>
        <Menu.Target>
          <ActionIcon variant="subtle" size="sm">
            <StyledLucideIcon Icon={Trash2Icon} size="sm" />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<Trash2Icon size={16} />} onClick={onRemove} color="red">
            Remove connection
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}

// ============================================================================
// Table Actions
// ============================================================================

function TableActions({ onUnlink, onAdvancedSettings }: { onUnlink: () => void; onAdvancedSettings: () => void }) {
  return (
    <div className={styles.rowActions}>
      <Menu>
        <Menu.Target>
          <ActionIcon variant="subtle" size="sm" c="var(--fg-muted)">
            <StyledLucideIcon Icon={SettingsIcon} size="sm" />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<SettingsIcon size={16} />} onClick={onAdvancedSettings}>
            Advanced settings
          </Menu.Item>
          <Menu.Item leftSection={<UnlinkIcon size={16} />} onClick={onUnlink} color="red">
            Unlink table
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}

// ============================================================================
// Folder Tree Renderer
// ============================================================================

interface FolderTreeRendererProps {
  tree: FolderTreeNode;
  groupName: string;
  workbookId: string;
  nested: boolean;
  onDataRefresh?: () => void;
}

function FolderTreeRenderer({ tree, groupName, workbookId, nested, onDataRefresh }: FolderTreeRendererProps) {
  return (
    <>
      {Array.from(tree.children.entries()).map(([segName, childNode]) => (
        <IntermediateFolderGroup key={`${groupName}/${segName}`} name={segName}>
          <FolderTreeRenderer
            tree={childNode}
            groupName={groupName}
            workbookId={workbookId}
            nested
            onDataRefresh={onDataRefresh}
          />
        </IntermediateFolderGroup>
      ))}
      {tree.folders.map((folder) => (
        <DataFolderRow
          key={folder.id}
          folder={folder}
          workbookId={workbookId}
          nested={nested}
          onDataRefresh={onDataRefresh}
        />
      ))}
    </>
  );
}

function IntermediateFolderGroup({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <div className={styles.groupRow}>
        <Text12Medium c="var(--fg-muted)" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {name}
        </Text12Medium>
      </div>
      {children}
    </>
  );
}

// ============================================================================
// Data Folder Row
// ============================================================================

interface DataFolderRowProps {
  folder: DataFolder;
  workbookId: string;
  nested: boolean;
  onDataRefresh?: () => void;
}

function DataFolderRow({ folder, workbookId, nested, onDataRefresh }: DataFolderRowProps) {
  const [removeOpened, { open: openRemove, close: closeRemove }] = useDisclosure(false);
  const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
  const isReadOnly = (folder.options as DataFolderOptions | null)?.readOnly === true;

  return (
    <>
      <div className={`${styles.tableRow} ${nested ? styles.tableRowNested : ''}`}>
        {isReadOnly ? (
          <Tooltip label="Read-only — pull only, never published back" position="right">
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>
              <StyledLucideIcon Icon={FolderLockIcon} size={14} c="var(--fg-muted)" />
            </span>
          </Tooltip>
        ) : (
          <StyledLucideIcon Icon={FolderIcon} size={14} c="var(--fg-muted)" />
        )}
        <Text13Regular c="var(--fg-primary)" style={{ flex: 1 }} truncate>
          {folder.name}
        </Text13Regular>
        <TableActions onUnlink={openRemove} onAdvancedSettings={openSettings} />
      </div>
      <RemoveTableModal
        opened={removeOpened}
        onClose={closeRemove}
        folder={folder}
        workbookId={workbookId}
        onDataRefresh={onDataRefresh}
      />
      <AdvancedFolderSettingsModal
        opened={settingsOpened}
        onClose={closeSettings}
        folder={folder}
        workbookId={workbookId}
      />
    </>
  );
}
