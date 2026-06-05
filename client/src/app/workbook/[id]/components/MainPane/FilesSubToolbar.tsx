'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useConnectorAccount } from '@/hooks/use-connector-account';
import { useDataFolders } from '@/hooks/use-data-folders';
import { Box, Group, Menu } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { ConnectorAccount, WorkbookId } from '@spinner/shared-types';
import { ChevronDownIcon, CloudDownloadIcon, PlusIcon } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChooseTablesModal } from '../shared/ChooseTablesModal';
import { CreateConnectionModal } from '../shared/CreateConnectionModal';

interface FilesSubToolbarProps {
  workbookId: string;
}

export function FilesSubToolbar({ workbookId }: FilesSubToolbarProps) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { pullFolders } = useActiveWorkbook();
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
  if (oauthAccount && !hasOpenedOAuthModal.current) {
    hasOpenedOAuthModal.current = true;
    setNewlyCreatedAccount(oauthAccount);
  }

  useEffect(() => {
    if (hasOpenedOAuthModal.current && oauthAccount) {
      openChooseTables();
      const url = new URL(window.location.href);
      url.searchParams.delete('newConnectionId');
      router.replace(url.pathname + url.search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once when oauthAccount first resolves
  }, [oauthAccount]);

  const [isPulling, setIsPulling] = useState(false);

  // Incremental is the default pull; the backend safely falls back to a full pull
  // for any table that does not support incremental. "Pull all (full)" forces a full.
  const handlePullAll = useCallback(
    async (mode: 'full' | 'incremental') => {
      setIsPulling(true);
      await pullFolders(undefined, { mode });
      setIsPulling(false);
    },
    [pullFolders],
  );

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
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ButtonSecondaryOutline
              size="compact-sm"
              leftSection={<CloudDownloadIcon size={12} />}
              rightSection={<ChevronDownIcon size={12} />}
              loading={isPulling}
              disabled={!hasLinkedFolders}
            >
              Pull all
            </ButtonSecondaryOutline>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<CloudDownloadIcon size={14} />} onClick={() => handlePullAll('incremental')}>
              Pull recent changes
            </Menu.Item>
            <Menu.Item leftSection={<CloudDownloadIcon size={14} />} onClick={() => handlePullAll('full')}>
              Full refresh
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
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
