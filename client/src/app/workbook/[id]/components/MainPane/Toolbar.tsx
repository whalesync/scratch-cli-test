'use client';

import { ButtonCompactDanger, ButtonCompactSecondary, IconButtonToolbar } from '@/app/components/base/buttons';
import { Text12Medium, Text12Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useConnectorAccount } from '@/hooks/use-connector-account';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useDirtyFiles } from '@/hooks/use-dirty-files';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { trackToggleDisplayMode } from '@/lib/posthog';
import { useLayoutManagerStore } from '@/stores/layout-manager-store';
import { useWorkbookEditorUIStore, WorkbookModals } from '@/stores/workbook-editor-store';
import { RouteUrls } from '@/utils/route-urls';
import { Box, Breadcrumbs, Group, Tooltip, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { ConnectorAccount, Workbook } from '@spinner/shared-types';
import { WorkbookId } from '@spinner/shared-types';
import {
  BugIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  DownloadIcon,
  MoonIcon,
  PlusIcon,
  RotateCcwIcon,
  SunIcon,
  TerminalIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PublishPlansModal } from '../modals/PublishPlansModal';
import { ChooseTablesModal } from '../shared/ChooseTablesModal';
import { ConnectToCLIModal } from '../shared/ConnectToCLIModal';
import { CreateConnectionModal } from '../shared/CreateConnectionModal';
import { DebugMenu } from './DebugMenu';

interface ToolbarProps {
  workbook: Workbook;
}

export function Toolbar({ workbook }: ToolbarProps) {
  const params = useParams<{ id: string; path?: string[] }>();
  const pathname = usePathname();
  const router = useRouter();
  const { discardAllChanges, pullFolders } = useActiveWorkbook();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { user } = useScratchPadUser();
  const openReportABugModal = useLayoutManagerStore((state) => state.openReportABugModal);
  const activeModal = useWorkbookEditorUIStore((state) => state.activeModal);
  const showModal = useWorkbookEditorUIStore((state) => state.showModal);
  const dismissModal = useWorkbookEditorUIStore((state) => state.dismissModal);
  const { dataFolderGroups } = useDataFolders(workbook.id);

  const searchParams = useSearchParams();
  const newConnectionId = searchParams.get('newConnectionId');
  const { connectorAccount: oauthAccount } = useConnectorAccount(
    newConnectionId ? workbook.id : undefined,
    newConnectionId ?? undefined,
  );
  const hasOpenedOAuthModal = useRef(false);

  const isReviewPage = pathname.includes('/review');
  const isFilesPage = pathname.includes('/files');
  const showBugReport = user?.experimentalFlags?.ENABLE_CREATE_BUG_REPORT;

  // Check if there are any linked data folders (folders with a connector account)
  const hasLinkedFolders = useMemo(() => {
    return dataFolderGroups.some((group) => group.dataFolders.some((folder) => folder.connectorAccountId !== null));
  }, [dataFolderGroups]);

  // Connection modal state
  const [connectionModalOpened, { open: openConnectionModal, close: closeConnectionModal }] = useDisclosure(false);

  // Choose tables modal state (opened after creating a connection)
  const [chooseTablesOpened, { open: openChooseTables, close: closeChooseTables }] = useDisclosure(false);
  const [newlyCreatedAccount, setNewlyCreatedAccount] = useState<ConnectorAccount | null>(null);

  // CLI modal state
  const [cliModalOpened, { open: openCLIModal, close: closeCLIModal }] = useDisclosure(false);

  // Publish V2 modal state
  const publishV2ModalOpened = activeModal?.type === WorkbookModals.PUBLISH_PLANS;
  const openPublishV2Modal = () => showModal({ type: WorkbookModals.PUBLISH_PLANS });
  const closePublishV2Modal = () => dismissModal(WorkbookModals.PUBLISH_PLANS);

  // Open table picker after OAuth connection redirect
  useEffect(() => {
    if (oauthAccount && !hasOpenedOAuthModal.current) {
      hasOpenedOAuthModal.current = true;
      setNewlyCreatedAccount(oauthAccount);
      openChooseTables();
      // Clean up the query param from the URL
      const url = new URL(window.location.href);
      url.searchParams.delete('newConnectionId');
      router.replace(url.pathname + url.search);
    }
  }, [oauthAccount, openChooseTables, router]);

  // Action states
  const [isPulling, setIsPulling] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);

  // Dirty files for review mode
  const { dirtyFiles, refresh: refreshDirtyFiles } = useDirtyFiles(isReviewPage ? workbook.id : null);

  // Confirm dialog
  const { open: openConfirmDialog, dialogProps } = useConfirmDialog();

  const handlePullAll = useCallback(async () => {
    setIsPulling(true);
    await pullFolders();
    setIsPulling(false);
  }, [pullFolders]);

  const handleDiscardAll = useCallback(() => {
    openConfirmDialog({
      title: 'Discard All Changes',
      message: 'Are you sure you want to discard all unpublished changes? This cannot be undone.',
      confirmLabel: 'Discard',
      variant: 'danger',
      onConfirm: async () => {
        setIsDiscarding(true);

        try {
          await discardAllChanges();
          refreshDirtyFiles();
          router.push(RouteUrls.workbookReviewPageUrl(workbook.id));
        } finally {
          setIsDiscarding(false);
        }
      },
    });
  }, [router, openConfirmDialog, discardAllChanges, workbook.id, refreshDirtyFiles]);

  const toggleColorScheme = () => {
    const newScheme = colorScheme === 'light' ? 'dark' : 'light';
    setColorScheme(newScheme);
    trackToggleDisplayMode(newScheme);
  };

  const handleConnectionCreated = useCallback(
    (account: ConnectorAccount) => {
      setNewlyCreatedAccount(account);
      openChooseTables();
    },
    [openChooseTables],
  );

  // Build breadcrumb from URL path
  // Path structure: TableName/file.json
  // - Workbook root links to /files or /review
  // - Table name (1st segment) links to folder page
  // - File name (2nd segment) links to the file
  const breadcrumbs = useMemo(() => {
    const items: { label: string; href: string }[] = [];

    // Add workbook root - use the appropriate base path
    const basePath = isReviewPage ? 'review' : 'files';
    items.push({
      label: workbook.name ?? 'Workbook',
      href: `/workbook/${params.id}/${basePath}`,
    });

    // Parse the path from URL if present
    if (params.path && params.path.length > 0) {
      const pathParts = params.path;

      pathParts.forEach((part, index) => {
        const decodedPart = decodeURIComponent(part);
        const currentPath = pathParts.slice(0, index + 1).join('/');

        items.push({
          label: decodedPart,
          href: `/workbook/${params.id}/${basePath}/${currentPath}`,
        });
      });
    }

    return items;
  }, [workbook.name, params.id, params.path, isReviewPage]);

  return (
    <Box
      h={40}
      px="sm"
      style={{
        borderBottom: '1px solid var(--fg-divider)',
        backgroundColor: 'var(--bg-selected)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      {/* Left: Breadcrumbs */}
      <Group gap="sm">
        <Breadcrumbs
          separator={<StyledLucideIcon Icon={ChevronRightIcon} size="sm" c="var(--fg-muted)" />}
          separatorMargin={4}
        >
          {breadcrumbs.map((item, index) => {
            const isLast = index === breadcrumbs.length - 1;

            if (isLast) {
              return (
                <Text12Medium key={item.href} c="var(--fg-primary)">
                  {item.label}
                </Text12Medium>
              );
            }

            return (
              <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
                <Text12Regular
                  c="var(--fg-secondary)"
                  style={{
                    cursor: 'pointer',
                  }}
                  __vars={{
                    '--hover-color': 'var(--fg-primary)',
                  }}
                >
                  {item.label}
                </Text12Regular>
              </Link>
            );
          })}
        </Breadcrumbs>
      </Group>

      {/* Right: Action buttons */}
      <Group gap="xs">
        {/* Files mode buttons */}
        {isFilesPage && (
          <>
            <ButtonCompactSecondary leftSection={<PlusIcon size={12} />} onClick={openConnectionModal}>
              Connect service
            </ButtonCompactSecondary>
            <ButtonCompactSecondary
              leftSection={<DownloadIcon size={12} />}
              onClick={handlePullAll}
              loading={isPulling}
              disabled={!hasLinkedFolders}
            >
              Pull all
            </ButtonCompactSecondary>
          </>
        )}

        {/* Review mode buttons */}
        {isReviewPage && dirtyFiles.length > 0 && (
          <>
            {/* <ButtonCompactPrimary
              leftSection={<CloudUploadIcon size={12} />}
              onClick={handlePublishAll}
              loading={isPublishing}
            >
              Publish all
            </ButtonCompactPrimary> */}
            <ButtonCompactSecondary onClick={openPublishV2Modal} leftSection={<CloudUploadIcon size={12} />}>
              Publish all
            </ButtonCompactSecondary>
            <ButtonCompactDanger
              leftSection={<RotateCcwIcon size={12} />}
              onClick={handleDiscardAll}
              loading={isDiscarding}
            >
              Discard all
            </ButtonCompactDanger>
          </>
        )}

        <Tooltip label="Connect to CLI" position="bottom">
          <IconButtonToolbar onClick={openCLIModal} aria-label="Connect to CLI">
            <StyledLucideIcon Icon={TerminalIcon} size="sm" />
          </IconButtonToolbar>
        </Tooltip>
        {showBugReport && (
          <Tooltip label="Report a bug" position="bottom">
            <IconButtonToolbar onClick={openReportABugModal} aria-label="Report a bug">
              <StyledLucideIcon Icon={BugIcon} size="sm" />
            </IconButtonToolbar>
          </Tooltip>
        )}
        <Tooltip label={colorScheme === 'light' ? 'Dark mode' : 'Light mode'} position="bottom">
          <IconButtonToolbar onClick={toggleColorScheme} aria-label="Toggle color scheme">
            <StyledLucideIcon Icon={colorScheme === 'light' ? MoonIcon : SunIcon} size="sm" />
          </IconButtonToolbar>
        </Tooltip>
        <DebugMenu workbookId={workbook.id as WorkbookId} />
      </Group>

      {/* Connection Modal */}
      <CreateConnectionModal
        opened={connectionModalOpened}
        onClose={closeConnectionModal}
        workbookId={workbook.id}
        returnUrl={`/workbook/${workbook.id}/files`}
        onConnectionCreated={handleConnectionCreated}
      />

      {/* Choose Tables Modal (after creating connection) */}
      {newlyCreatedAccount && (
        <ChooseTablesModal
          opened={chooseTablesOpened}
          onClose={() => {
            closeChooseTables();
            setNewlyCreatedAccount(null);
          }}
          workbookId={workbook.id as WorkbookId}
          connectorAccount={newlyCreatedAccount}
        />
      )}

      {/* CLI Modal */}
      <ConnectToCLIModal opened={cliModalOpened} onClose={closeCLIModal} workbookId={workbook.id} />

      <PublishPlansModal
        opened={publishV2ModalOpened}
        onClose={closePublishV2Modal}
        workbookId={workbook.id as WorkbookId}
      />

      {/* Confirm Dialog */}
      <ConfirmDialog {...dialogProps} />
    </Box>
  );
}
