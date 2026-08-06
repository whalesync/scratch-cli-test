'use client';

import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { ApiQuotaDialog } from '@/app/workbook/[id]/components/Sidebar/ApiQuotaDialog';
import { BreakGlassCredentialsModal } from '@/app/workbook/[id]/components/modals/BreakGlassCredentialsModal';
import { CreateSchemaModal } from '@/app/workbook/[id]/components/modals/CreateSchemaModal';
import { GitFileBrowserModal } from '@/app/workbook/[id]/components/modals/GitFileBrowserModal';
import { GitGcModal } from '@/app/workbook/[id]/components/modals/GitGcModal';
import { GitGraphModal } from '@/app/workbook/[id]/components/modals/GitGraphModal';
import { GitIndexModal } from '@/app/workbook/[id]/components/modals/GitIndexModal';
import { GitObjectCountsModal } from '@/app/workbook/[id]/components/modals/GitObjectCountsModal';
import { MoveRepoModal } from '@/app/workbook/[id]/components/modals/MoveRepoModal';
import { RepairRepoModal } from '@/app/workbook/[id]/components/modals/RepairRepoModal';
import type { ContextMenuItem } from '@/app/workbook/[id]/components/shared/ContextMenu';
import { useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useGitActions } from '@/hooks/use-git-actions';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { initiateOAuth } from '@/utils/oauth';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { AuthType, type WorkbookId } from '@spinner/shared-types';
import {
  ActivityIcon,
  CloudCogIcon,
  CopyIcon,
  DatabaseIcon,
  FileCodeIcon,
  GitGraphIcon,
  GitMergeIcon,
  InfoIcon,
  KeyRoundIcon,
  MoveIcon,
  ScissorsIcon,
  SettingsIcon,
  TableIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

/**
 * Minimal connection info needed to build the connection menu.
 * Both `ConnectorAccount` and `AdminWorkbookConnectionDto` (with authType added) satisfy this.
 */
export interface ConnectionMenuTarget {
  id: string;
  displayName: string;
  service: string;
  repoPath: string;
  /** When provided, the menu shows Reauthorize/Edit Connection items. */
  authType?: string;
}

export interface UseConnectionMenuOptions {
  /** Extra items prepended to the menu (e.g. "Pull All Tables"). */
  extraItemsBefore?: ContextMenuItem[];
  /** Extra items after auth row, before divider (e.g. "Show hidden files"). */
  extraItemsAfter?: ContextMenuItem[];
  /** Called when OAuth reauthorization starts. */
  onReauthorizeStart?: () => void;
  /** Called when OAuth reauthorization ends. */
  onReauthorizeEnd?: () => void;
  /**
   * Full ConnectorAccount for modals that require it (ChooseTablesModal, RemoveConnectionModal, etc.).
   * When omitted those modals are not rendered and their menu items are hidden.
   */
  fullConnectorAccount?: import('@spinner/shared-types').ConnectorAccount;
}

export function useConnectionMenu(
  workbookId: WorkbookId,
  connection: ConnectionMenuTarget,
  options: UseConnectionMenuOptions = {},
) {
  const { extraItemsBefore, extraItemsAfter, onReauthorizeStart, onReauthorizeEnd, fullConnectorAccount } = options;

  const { isDevToolsEnabled } = useDevTools();
  const { metadata } = useConnectorsMetadata();
  const schemaCreationSupported = !!metadata?.[connection.service]?.supportsSchemaCreation;
  const setWorkbookError = useWorkbookUIStore((state) => state.setWorkbookError);
  const git = useGitActions();

  // Local UI state for modals not in useGitActions
  const [gitGraphOpen, setGitGraphOpen] = useState(false);
  const [gitFileBrowserOpen, setGitFileBrowserOpen] = useState(false);
  const [moveRepoOpen, setMoveRepoOpen] = useState(false);
  const [repairRepoOpen, setRepairRepoOpen] = useState(false);

  // Connection-specific modal state
  const [chooseTablesOpened, { open: openChooseTables, close: closeChooseTables }] = useDisclosure(false);
  const [removeModalOpened, { open: openRemoveModal, close: closeRemoveModal }] = useDisclosure(false);
  const [updateConnectionModalOpened, { open: openUpdateConnectionModal, close: closeUpdateConnectionModal }] =
    useDisclosure(false);
  const [apiQuotaOpened, { open: openApiQuota, close: closeApiQuota }] = useDisclosure(false);
  const [breakGlassOpened, { open: openBreakGlass, close: closeBreakGlass }] = useDisclosure(false);
  const [createSchemaOpened, { open: openCreateSchema, close: closeCreateSchema }] = useDisclosure(false);
  const { open: openResetConnectionDialog, dialogProps: resetConnectionDialogProps } = useConfirmDialog();

  // --- Handlers ---

  const cId = connection.id;
  const cName = connection.displayName || cId;

  const handleResetConnection = () => {
    openResetConnectionDialog({
      title: 'Reset Connection',
      message:
        'This will delete all data folders and the git repository for this connection. Any unpublished changes will be lost. This action cannot be undone.',
      confirmLabel: 'Reset',
      variant: 'danger',
      onConfirm: async () => {
        try {
          await scratchApiClient.connectorAccounts.reset(workbookId, cId);
          window.location.reload();
        } catch {
          notifications.show({ title: 'Error', message: 'Failed to reset connection', color: 'red' });
        }
      },
    });
  };

  const handleCopyGitCloneCommand = async () => {
    try {
      const { gitCloneCommand } = await scratchApiClient.devTools.getConnectionGitUrl(cId);
      await navigator.clipboard.writeText(gitCloneCommand);
      notifications.show({
        title: 'Copied',
        message: 'Git clone command copied to clipboard',
        color: 'green',
      });
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to copy git clone command', color: 'red' });
    }
  };

  const handleReauthorize = async () => {
    if (connection.authType !== AuthType.OAUTH) return;
    onReauthorizeStart?.();
    try {
      await initiateOAuth(connection.service, {
        workbookId,
        // Absolute exit URL the OAuth callback forwards the result to (the token-exchange page).
        resultForwardUrl: `${window.location.protocol}//${window.location.host}/oauth/callback-step-2`,
        // TODO(DEV-10734): remove — unused; only sent to satisfy the still-required schema field.
        // https://linear.app/whalesync/issue/DEV-10734
        redirectPrefix: 'TODO(DEV-10734): Remove Unused parameter',
        connectionMethod: 'OAUTH_SYSTEM',
        connectionName: connection.displayName,
        // Still used: /oauth/callback-step-2 reads this for the in-app landing after connect.
        returnPage: window.location.pathname,
        connectorAccountId: cId,
      });
    } catch (error) {
      console.error('OAuth initiation failed:', error);
      setWorkbookError({
        description: `Failed to reauthorize connection to ${connection.displayName}. Please try again.`,
        cause: error as Error,
      });
    } finally {
      onReauthorizeEnd?.();
    }
  };

  // --- Git submenu children ---

  const gitChildren: ContextMenuItem[] = [
    { label: 'Git Graph', icon: GitGraphIcon, devtool: true, onClick: () => setGitGraphOpen(true) },
    { label: 'Git File Browser', icon: FileCodeIcon, devtool: true, onClick: () => setGitFileBrowserOpen(true) },
    {
      label: 'Manual Rebase',
      icon: GitMergeIcon,
      devtool: true,
      onClick: () => void git.handleRebase(workbookId, cId),
      disabled: git.isRebasing,
    },
    {
      label: 'Run Git GC (Standard)',
      icon: GitGraphIcon,
      devtool: true,
      onClick: () => void git.handleRunGc(workbookId, false, cId),
      disabled: git.isGcing,
    },
    {
      label: 'Run Git GC (Aggressive)',
      icon: Trash2Icon,
      devtool: true,
      onClick: () => void git.handleRunGc(workbookId, true, cId),
      disabled: git.isGcing,
    },
    {
      label: 'Repo Info',
      icon: InfoIcon,
      devtool: true,
      onClick: () => void git.handleGetObjectCounts(workbookId, cId),
      disabled: git.isLoadingObjectCounts,
    },
    ...(connection.repoPath
      ? [
          { label: 'Move Repo', icon: MoveIcon, devtool: true, onClick: () => setMoveRepoOpen(true) },
          {
            label: 'Diagnose / Repair Repo',
            icon: WrenchIcon,
            devtool: true,
            onClick: () => setRepairRepoOpen(true),
          },
        ]
      : []),
    {
      label: 'Copy Git Clone Command',
      icon: CopyIcon,
      devtool: true,
      onClick: () => void handleCopyGitCloneCommand(),
    },
    { type: 'divider' as const },
    {
      label: 'Build Index',
      icon: GitGraphIcon,
      devtool: true,
      onClick: () => void git.handleBuildIndex(workbookId, cId),
      disabled: git.isBuildingIndex,
    },
    {
      label: 'View Index',
      icon: GitGraphIcon,
      devtool: true,
      onClick: () => void git.handleViewIndex(workbookId, cId),
    },
    { type: 'divider' as const },
    {
      label: 'Build Publish Plan',
      icon: GitGraphIcon,
      devtool: true,
      onClick: () => void git.handleBuildPublishPlan(workbookId, cId, cName),
      disabled: git.isBuildingPublishPlan,
    },
    {
      label: 'Strip Connection Prefix',
      icon: ScissorsIcon,
      devtool: true,
      onClick: () => void git.handleStripPrefix(workbookId, cId),
    },
  ];

  const gitSubmenu: ContextMenuItem[] = isDevToolsEnabled
    ? [{ type: 'submenu' as const, label: 'Git', icon: GitGraphIcon, devtool: true, children: gitChildren }]
    : [];

  // --- Build items ---

  // Every connection gets "Edit Connection" (rename, credential re-entry for
  // API-key connectors, extras-backed settings like Google Sheets' spreadsheet
  // URLs for OAuth connectors); OAuth additionally gets "Reauthorize".
  const authItem: ContextMenuItem[] =
    connection.authType !== undefined && fullConnectorAccount
      ? [
          ...(connection.authType === AuthType.OAUTH
            ? [{ label: 'Reauthorize', icon: CloudCogIcon, onClick: handleReauthorize }]
            : []),
          { label: 'Edit Connection', icon: SettingsIcon, onClick: openUpdateConnectionModal },
        ]
      : [];

  const items: ContextMenuItem[] = [
    ...(extraItemsBefore ?? []),
    ...(fullConnectorAccount ? [{ label: 'Choose tables', icon: TableIcon, onClick: openChooseTables }] : []),
    { label: 'View API Quota', icon: ActivityIcon, onClick: openApiQuota },
    ...authItem,
    ...(extraItemsAfter ?? []),
    { type: 'divider' as const },
    ...gitSubmenu,
    ...(fullConnectorAccount ? [{ label: 'Remove', icon: Trash2Icon, onClick: openRemoveModal, delete: true }] : []),
    ...(isDevToolsEnabled
      ? [
          { label: 'Reset Connection', icon: Trash2Icon, devtool: true, delete: true, onClick: handleResetConnection },
          { label: 'Break glass', icon: KeyRoundIcon, devtool: true, onClick: openBreakGlass },
          {
            label: 'Create tables and fields',
            icon: DatabaseIcon,
            devtool: true,
            onClick: openCreateSchema,
            disabled: !schemaCreationSupported,
          },
          // Connector code version snapshotted onto this account at creation (DEV-10302).
          // Dev-tools-only, non-interactive footer label — a generic scalar, no connector branching.
          ...(fullConnectorAccount
            ? [
                { type: 'divider' as const },
                { type: 'label' as const, label: `Connector version: ${fullConnectorAccount.version}` },
              ]
            : []),
        ]
      : []),
  ];

  // --- Modals ---
  // Lazy-import the connection-specific modals only when fullConnectorAccount is provided
  // to avoid pulling ChooseTablesModal etc. into admin page bundles.

  const modals: ReactNode = (
    <>
      <ConfirmDialog {...resetConnectionDialogProps} />
      <GitGraphModal
        opened={gitGraphOpen}
        onClose={() => setGitGraphOpen(false)}
        workbookId={workbookId}
        connectorAccountId={cId}
      />
      <GitFileBrowserModal
        opened={gitFileBrowserOpen}
        onClose={() => setGitFileBrowserOpen(false)}
        workbookId={workbookId}
        connectorAccountId={cId}
      />
      <GitGcModal opened={git.gcModalOpen} onClose={() => git.setGcModalOpen(false)} data={git.gcData} />
      <GitObjectCountsModal
        opened={git.objectCountsModalOpen}
        onClose={() => git.setObjectCountsModalOpen(false)}
        data={git.objectCountsData}
        repoPath={connection.repoPath}
      />
      {connection.repoPath && (
        <MoveRepoModal
          opened={moveRepoOpen}
          onClose={() => setMoveRepoOpen(false)}
          connectorAccountId={cId}
          currentRepoPath={connection.repoPath}
        />
      )}
      {connection.repoPath && (
        <RepairRepoModal
          opened={repairRepoOpen}
          onClose={() => setRepairRepoOpen(false)}
          connectorAccountId={cId}
          connectionName={cName}
        />
      )}
      <GitIndexModal opened={git.indexModalOpen} onClose={() => git.setIndexModalOpen(false)} data={git.indexData} />
      <ApiQuotaDialog
        opened={apiQuotaOpened}
        onClose={closeApiQuota}
        workbookId={workbookId}
        connectionId={cId}
        connectionName={cName}
      />
      <BreakGlassCredentialsModal
        opened={breakGlassOpened}
        onClose={closeBreakGlass}
        workbookId={workbookId}
        connectionId={cId}
        connectionName={cName}
      />
      <CreateSchemaModal
        opened={createSchemaOpened}
        onClose={closeCreateSchema}
        workbookId={workbookId}
        connectorAccountId={cId}
        service={connection.service}
      />
    </>
  );

  return {
    items,
    modals,
    // Expose for callers that need to render connection-specific modals separately
    chooseTablesOpened,
    closeChooseTables,
    removeModalOpened,
    closeRemoveModal,
    updateConnectionModalOpened,
    closeUpdateConnectionModal,
  };
}
