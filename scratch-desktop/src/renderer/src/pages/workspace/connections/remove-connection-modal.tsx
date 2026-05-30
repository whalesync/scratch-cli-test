import { useConnectorAccounts } from '@/hooks/use-connector-accounts';
import { useDataFolders } from '@/hooks/use-data-folders';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import type { ConnectorAccount } from '@spinner/shared-types';
import { useState } from 'react';

interface RemoveConnectionModalProps {
  opened: boolean;
  onClose: () => void;
  connectorAccount: ConnectorAccount;
  workbookId: string;
  invalidateWorkspaceLevelData?: () => void;
}

export function RemoveConnectionModal({
  opened,
  onClose,
  connectorAccount,
  workbookId,
  invalidateWorkspaceLevelData,
}: RemoveConnectionModalProps) {
  const { deleteConnectorAccount } = useConnectorAccounts(workbookId);
  const { refresh: refreshFolders } = useDataFolders(workbookId);
  const [loading, setLoading] = useState(false);

  const handleRemove = async () => {
    setLoading(true);
    try {
      await deleteConnectorAccount(connectorAccount.id);
      await refreshFolders();
      invalidateWorkspaceLevelData?.();
      onClose();
    } catch (error) {
      console.debug('Failed to remove connection:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Remove Connection" size="sm" centered>
      <Stack gap="md">
        <Text size="sm">
          Are you sure you want to remove the connection &quot;{connectorAccount.displayName}&quot;? This will also
          remove all linked tables and their local data.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button color="red" onClick={() => void handleRemove()} loading={loading}>
            Remove
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
