import { useDataFolders } from '@/hooks/use-data-folders';
import { dataFoldersApi } from '@/lib/data-folders-api';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import type { DataFolder } from '@spinner/shared-types';
import { useState } from 'react';

interface RemoveTableModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
  workbookId: string;
  invalidateWorkspaceLevelData?: () => void;
}

export function RemoveTableModal({
  opened,
  onClose,
  folder,
  workbookId,
  invalidateWorkspaceLevelData,
}: RemoveTableModalProps) {
  const { refresh } = useDataFolders(workbookId);
  const [loading, setLoading] = useState(false);

  const handleRemove = async () => {
    setLoading(true);
    try {
      await dataFoldersApi.delete(folder.id);
      await refresh();
      invalidateWorkspaceLevelData?.();
      onClose();
    } catch (error) {
      console.debug('Failed to remove table:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Unlink Table" size="sm" centered>
      <Stack gap="md">
        <Text size="sm">
          Are you sure you want to unlink &quot;{folder.name}&quot; from this workspace? This table will be removed from
          your workspace along with any pending changes, but the remote files will not be affected. You can relink this
          table in the future if needed.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button color="red" onClick={() => void handleRemove()} loading={loading}>
            Unlink
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
