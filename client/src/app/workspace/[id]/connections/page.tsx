'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ButtonSecondaryOutline } from '@/app/components/base/buttons';
import {
  Text12Medium,
  Text12Regular,
  Text13Medium,
  Text13Regular,
  Text16Medium,
  TextTitle2,
} from '@/app/components/base/text';
import { AdvancedFolderSettingsModal } from '@/app/workbook/[id]/components/shared/AdvancedFolderSettingsModal';
import { ChooseTablesModal } from '@/app/workbook/[id]/components/shared/ChooseTablesModal';
import { CreateConnectionModal } from '@/app/workbook/[id]/components/shared/CreateConnectionModal';
import { RemoveConnectionModal } from '@/app/workbook/[id]/components/shared/RemoveConnectionModal';
import { RemoveTableModal } from '@/app/workbook/[id]/components/shared/RemoveTableModal';
import { UpdateConnectionModal } from '@/app/workbook/[id]/components/shared/UpdateConnectionModal';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useWorkbook } from '@/hooks/use-workbook';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { initiateOAuth } from '@/utils/oauth';
import { RouteUrls } from '@/utils/route-urls';
import { UserButton } from '@clerk/nextjs';
import { Box } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { ConnectorAccount, DataFolder, DataFolderGroup, WorkbookId } from '@spinner/shared-types';
import { AuthType } from '@spinner/shared-types';
import { FolderIcon, LinkIcon, PlusIcon, SettingsIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import styles from './connections-page.module.css';

// ============================================================================
// Folder tree helpers
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
// Page
// ============================================================================

export default function ConnectionsPage() {
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const openWorkbook = useWorkbookUIStore((state) => state.openWorkbook);
  const closeWorkbook = useWorkbookUIStore((state) => state.closeWorkbook);

  useEffect(() => {
    openWorkbook({ workbookId });
    return () => {
      closeWorkbook();
    };
  }, [workbookId, openWorkbook, closeWorkbook]);

  useWorkbook(workbookId);
  const { connectorAccounts, isLoading: isLoadingConnections } = useConnectorAccounts(workbookId);
  const { dataFolderGroups, isLoading: isLoadingFolders } = useDataFolders(workbookId);
  const { metadata } = useConnectorsMetadata();

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

  const hasConnections =
    dataFolderGroups.length > 0 ||
    (connectorAccounts ?? []).some(
      (ca) => !dataFolderGroups.some((g) => g.dataFolders.some((f) => f.connectorAccountId === ca.id)),
    );

  return (
    <div style={{ backgroundColor: 'var(--bg-base)', minHeight: '100vh' }}>
      <div className={styles.page}>
        {/* Top bar */}
        <div className={styles.topBar}>
          <TextTitle2>Connections</TextTitle2>
          <ButtonSecondaryOutline
            leftSection={<StyledLucideIcon Icon={PlusIcon} size="sm" />}
            onClick={openConnectionModal}
          >
            Connect service
          </ButtonSecondaryOutline>
        </div>

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
              onClick={openConnectionModal}
            >
              Connect service
            </ButtonSecondaryOutline>
          </div>
        )}

        {/* Service blocks */}
        {!isLoading &&
          dataFolderGroups.map((group) => {
            const connectorAccount = (connectorAccounts ?? []).find(
              (ca) => ca.displayName === group.name || getServiceName(metadata, ca.service) === group.name,
            );

            return (
              <ServiceBlock
                key={group.name}
                group={group}
                workbookId={workbookId}
                connectorAccount={connectorAccount}
              />
            );
          })}

        {/* Empty connector accounts (connected but no tables yet) */}
        {!isLoading &&
          (connectorAccounts ?? [])
            .filter((ca) => !dataFolderGroups.some((g) => g.dataFolders.some((f) => f.connectorAccountId === ca.id)))
            .map((ca) => <EmptyServiceBlock key={ca.id} connectorAccount={ca} workbookId={workbookId} />)}
      </div>

      {/* Sticky bottom bar */}
      <BottomBar />
    </div>
  );
}

// ============================================================================
// Service Block (card with header + table rows)
// ============================================================================

interface ServiceBlockProps {
  group: DataFolderGroup;
  workbookId: WorkbookId;
  connectorAccount?: ConnectorAccount;
}

function ServiceBlock({ group, workbookId, connectorAccount }: ServiceBlockProps) {
  const [chooseTablesOpen, { open: openChooseTables, close: closeChooseTables }] = useDisclosure(false);
  const [updateConnectionOpen, { open: openUpdateConnection, close: closeUpdateConnection }] = useDisclosure(false);
  const [removeConnectionOpen, { open: openRemoveConnection, close: closeRemoveConnection }] = useDisclosure(false);
  const setWorkbookError = useWorkbookUIStore((state) => state.setWorkbookError);

  const folderTree = useMemo(() => buildFolderTree(group.dataFolders, group.name), [group.dataFolders, group.name]);
  const hasTables = group.dataFolders.length > 0;

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
              onReauthorize={handleReauthorize}
              onEditConnection={openUpdateConnection}
              onRemove={openRemoveConnection}
            />
          )}
        </div>

        {/* Table rows (always expanded) */}
        <FolderTreeRenderer tree={folderTree} groupName={group.name} workbookId={workbookId} nested={false} />
      </div>

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
// Empty Service Block (connected account with no tables)
// ============================================================================

interface EmptyServiceBlockProps {
  connectorAccount: ConnectorAccount;
  workbookId: WorkbookId;
}

function EmptyServiceBlock({ connectorAccount, workbookId }: EmptyServiceBlockProps) {
  const { metadata } = useConnectorsMetadata();
  const setWorkbookError = useWorkbookUIStore((state) => state.setWorkbookError);
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
            onReauthorize={handleReauthorize}
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
// Service Actions (hover-to-reveal inline buttons)
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
    return (
      <div className={styles.rowActions}>
        <button className={styles.actionBtn} onClick={onReauthorize}>
          Reconnect
        </button>
        <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={onRemove}>
          Remove
        </button>
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
      <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

// ============================================================================
// Table Actions (hover-to-reveal inline buttons)
// ============================================================================

function TableActions({ onAdvancedSettings, onUnlink }: { onAdvancedSettings: () => void; onUnlink: () => void }) {
  return (
    <div className={styles.rowActions}>
      <button className={styles.actionBtn} onClick={onAdvancedSettings}>
        Advanced settings
      </button>
      <button className={`${styles.actionBtn} ${styles.actionBtnDanger}`} onClick={onUnlink}>
        Unlink table
      </button>
    </div>
  );
}

// ============================================================================
// Folder Tree Renderer (recursive, always expanded)
// ============================================================================

interface FolderTreeRendererProps {
  tree: FolderTreeNode;
  groupName: string;
  workbookId: WorkbookId;
  nested: boolean;
}

function FolderTreeRenderer({ tree, groupName, workbookId, nested }: FolderTreeRendererProps) {
  return (
    <>
      {Array.from(tree.children.entries()).map(([segName, childNode]) => (
        <IntermediateFolderGroup key={`${groupName}/${segName}`} name={segName}>
          <FolderTreeRenderer tree={childNode} groupName={groupName} workbookId={workbookId} nested />
        </IntermediateFolderGroup>
      ))}
      {tree.folders.map((folder) => (
        <DataFolderRow key={folder.id} folder={folder} workbookId={workbookId} nested={nested} />
      ))}
    </>
  );
}

// ============================================================================
// Intermediate Folder Group (static group header row)
// ============================================================================

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
// Data Folder Row (table leaf)
// ============================================================================

interface DataFolderRowProps {
  folder: DataFolder;
  workbookId: WorkbookId;
  nested: boolean;
}

function DataFolderRow({ folder, workbookId, nested }: DataFolderRowProps) {
  const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
  const [removeOpened, { open: openRemove, close: closeRemove }] = useDisclosure(false);

  return (
    <>
      <div className={`${styles.tableRow} ${nested ? styles.tableRowNested : ''}`}>
        <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-muted)" />
        <Text13Regular c="var(--fg-primary)" style={{ flex: 1 }} truncate>
          {folder.name}
        </Text13Regular>
        <TableActions onAdvancedSettings={openSettings} onUnlink={openRemove} />
      </div>
      <AdvancedFolderSettingsModal opened={settingsOpened} onClose={closeSettings} folder={folder} />
      <RemoveTableModal opened={removeOpened} onClose={closeRemove} folder={folder} workbookId={workbookId} />
    </>
  );
}

// ============================================================================
// Bottom Bar
// ============================================================================

function BottomBar() {
  const { user, clerkUser } = useScratchPadUser();
  const displayName = user?.name || clerkUser?.firstName || clerkUser?.username || 'User';

  return (
    <div className={styles.bottomBar}>
      <div className={styles.bottomBarInner}>
        <Link href={RouteUrls.settingsPageUrl} className={styles.settingsLink}>
          <StyledLucideIcon Icon={SettingsIcon} size="sm" />
          <Text13Regular c="inherit">Settings</Text13Regular>
        </Link>
        <div className={styles.userPill}>
          <StyledLucideIcon Icon={UserIcon} size="sm" />
          <Text13Regular c="inherit">{displayName}</Text13Regular>
          {/* Invisible Clerk UserButton overlay */}
          <Box pos="absolute" top={0} left={0} w="100%" h="100%" style={{ zIndex: 10, opacity: 0, overflow: 'hidden' }}>
            <UserButton
              appearance={{
                elements: {
                  rootBox: { width: '100%', height: '100%' },
                  userButtonTrigger: { width: '100%', height: '100%', cursor: 'pointer' },
                },
              }}
            />
          </Box>
        </div>
      </div>
    </div>
  );
}
