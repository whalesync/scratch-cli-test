'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useConnectorAccount } from '@/hooks/use-connector-account';
import { useDataFolders } from '@/hooks/use-data-folders';
import { Box, Group } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { ConnectorAccount, WorkbookId } from '@spinner/shared-types';
import { DownloadIcon, PlusIcon } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChooseTablesModal } from '../shared/ChooseTablesModal';
import { CreateConnectionModal } from '../shared/CreateConnectionModal';
import { DebugMenu } from './DebugMenu';

interface FilesSubToolbarProps {
  workbookId: string;
}

export function FilesSubToolbar({ workbookId }: FilesSubToolbarProps) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { pullFolders, workbook } = useActiveWorkbook();
  const { dataFolderGroups } = useDataFolders(workbookId as WorkbookId);

  const searchParams = useSearchParams();
  const newConnectionId = searchParams.get('newConnectionId');
  const { connectorAccount: oauthAccount } = useConnectorAccount(
    newConnectionId ? workbookId : undefined,
    newConnectionId ?? undefined,
  );
  const hasOpenedOAuthModal = useRef(false);

  const hasLinkedFolders = useMemo(() => {
    return dataFolderGroups.some((group) => group.dataFolders.some((folder) => folder.connectorAccountId !== null));
  }, [dataFolderGroups]);

  // Connection modal state
  const [connectionModalOpened, { open: openConnectionModal, close: closeConnectionModal }] = useDisclosure(false);

  // Choose tables modal state (opened after creating a connection)
  const [chooseTablesOpened, { open: openChooseTables, close: closeChooseTables }] = useDisclosure(false);
  const [newlyCreatedAccount, setNewlyCreatedAccount] = useState<ConnectorAccount | null>(null);

  // Open table picker after OAuth connection redirect
  useEffect(() => {
    if (oauthAccount && !hasOpenedOAuthModal.current) {
      hasOpenedOAuthModal.current = true;
      setNewlyCreatedAccount(oauthAccount);
      openChooseTables();
      const url = new URL(window.location.href);
      url.searchParams.delete('newConnectionId');
      router.replace(url.pathname + url.search);
    }
  }, [oauthAccount, openChooseTables, router]);

  const [isPulling, setIsPulling] = useState(false);

  const handlePullAll = useCallback(async () => {
    setIsPulling(true);
    await pullFolders();
    setIsPulling(false);
  }, [pullFolders]);

  const handleConnectionCreated = useCallback(
    (account: ConnectorAccount) => {
      setNewlyCreatedAccount(account);
      openChooseTables();
    },
    [openChooseTables],
  );

  return (
    <Box
      px="sm"
      py={6}
      style={{
        borderBottom: '1px solid var(--fg-divider)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
      }}
    >
      <Group gap="xs">
        <ButtonPrimaryLight size="compact-sm" leftSection={<PlusIcon size={12} />} onClick={openConnectionModal}>
          Connect service
        </ButtonPrimaryLight>
        <ButtonSecondaryOutline
          size="compact-sm"
          leftSection={<DownloadIcon size={12} />}
          onClick={handlePullAll}
          loading={isPulling}
          disabled={!hasLinkedFolders}
        >
          Pull all
        </ButtonSecondaryOutline>

        <DebugMenu workbookId={workbookId as WorkbookId} workbookVersion={workbook?.version} />
      </Group>

      {/* Connection Modal */}
      <CreateConnectionModal
        opened={connectionModalOpened}
        onClose={closeConnectionModal}
        workbookId={workbookId}
        returnUrl={`/workbook/${workbookId}/files`}
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
          workbookId={params.id as WorkbookId}
          connectorAccount={newlyCreatedAccount}
        />
      )}
    </Box>
  );
}
