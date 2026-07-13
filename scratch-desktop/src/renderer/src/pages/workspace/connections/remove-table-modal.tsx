import { useDataFolders } from '@/hooks/use-data-folders';
import { listLocalWorkspaces } from '@/lib/local-workspaces';
import { scratchApiClient } from '@/lib/scratch-api-client';
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
      await scratchApiClient.dataFolders.delete(folder.id);

      // DEV-10744: the server delete only removes the folder from the git repos;
      // the local workspace still holds the folder's record files and any
      // accepted-but-unpublished patches. Reconcile the local clone so those are
      // cleaned up — otherwise a later download re-anchors the pending edits of
      // the now-unlinked table into brand-new "create" records. This mirrors the
      // `scratchmd linked remove` CLI, which downloads right after the unlink.
      // Best-effort: a failure here must not block the unlink itself, and the
      // scheduled auto-download would reconcile eventually regardless.
      try {
        const localWorkspaces = await listLocalWorkspaces();
        const localPath = localWorkspaces.find((entry) => entry.id === workbookId)?.path ?? null;
        if (localPath) {
          await window.scratchDesktop.pullWorkspaceChanges(localPath, { onDelete: 'remove' });
        }
      } catch (reconcileError) {
        console.debug('Failed to reconcile local workspace after unlink:', reconcileError);
      }

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
