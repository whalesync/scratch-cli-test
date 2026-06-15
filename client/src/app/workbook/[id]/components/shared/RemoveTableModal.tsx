'use client';

import { useDataFolders } from '@/hooks/use-data-folders';
import { useSyncStore } from '@/stores/sync-store';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import type { DataFolder, WorkbookId } from '@spinner/shared-types';
import { useMemo, useState } from 'react';

interface RemoveTableModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
  workbookId: WorkbookId;
  onSuccess?: () => void;
}

export function RemoveTableModal({ opened, onClose, folder, workbookId, onSuccess }: RemoveTableModalProps) {
  const { deleteFolder } = useDataFolders(workbookId);
  const syncs = useSyncStore((state) => state.syncs);
  const [loading, setLoading] = useState(false);

  const linkedSyncs = useMemo(
    () =>
      syncs.filter((sync) =>
        sync.syncTablePairs.some(
          (pair) => pair.sourceDataFolderId === folder.id || pair.destinationDataFolderId === folder.id,
        ),
      ),
    [syncs, folder.id],
  );

  const handleRemove = async () => {
    setLoading(true);
    try {
      await deleteFolder(folder.id);
      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Failed to remove table:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Unlink Table" size="sm" centered>
      <Stack gap="md">
        <Text size="sm">
          Are you sure you want to unlink &quot;{folder.name}&quot; from this workspace? This table and any pending
          changes will be removed, but the remote files will not be affected. You can relink this table in the future if
          needed.
        </Text>
        {linkedSyncs.length > 0 && (
          <Alert color="orange" variant="light">
            <Text size="sm">
              There {linkedSyncs.length === 1 ? 'is' : 'are'} still {linkedSyncs.length}{' '}
              {linkedSyncs.length === 1 ? 'sync' : 'syncs'} linked to this table which will no longer sync data after
              this table is removed.
            </Text>
          </Alert>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button color="red" onClick={handleRemove} loading={loading}>
            Unlink
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
