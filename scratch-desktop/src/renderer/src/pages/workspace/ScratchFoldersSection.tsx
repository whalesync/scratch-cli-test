import { useConfirmModal } from '@/components/ConfirmModal';
import { Text12Regular, Text13Medium } from '@/components/base/text';
import { scratchApiClient } from '@/lib/scratch-api-client';
import { ActionIcon, Box, Group, Stack, TextInput, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { DataFolder, Workspace } from '@spinner/shared-types';
import { FolderPlusIcon, StickyNoteIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ScratchFolderModal } from './ScratchFolderModal';

export interface ScratchFoldersSectionProps {
  workspace: Workspace;
  /** Refetch the workspace (and its dataFolders) after a create/delete. */
  onChanged: () => void;
}

/**
 * Sidebar section listing standalone "scratch" folders (DEV-10424) — DataFolders with no connector.
 * Connector-less, so create/delete and the per-folder file operations all go through the server REST
 * API (the same endpoints the web client uses), never the local-disk/CLI-sync path.
 */
export function ScratchFoldersSection({ workspace, onChanged }: ScratchFoldersSectionProps) {
  const workbookId = workspace.id;
  const scratchFolders = useMemo(
    () => (workspace.dataFolders ?? []).filter((f) => f.connectorAccountId == null),
    [workspace.dataFolders],
  );
  const [openFolder, setOpenFolder] = useState<DataFolder | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const { confirm, confirmModal } = useConfirmModal();

  const handleCreateFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      // Omitting connectorAccountId/tableId tells the server to create a standalone scratch folder.
      await scratchApiClient.dataFolders.create({ name, workbookId });
      setNewName('');
      setAdding(false);
      onChanged();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Could not create folder',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteFolder = async (folder: DataFolder) => {
    // Deleting a scratch folder is permanent (it removes the folder and all its files), so gate it
    // behind a confirmation — matches the web client's RemoveTableModal.
    const ok = await confirm(`Permanently delete "${folder.name}" and all of its files? This cannot be undone.`, {
      title: 'Delete folder',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await scratchApiClient.dataFolders.delete(folder.id);
      onChanged();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Could not delete folder',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Box px="sm" pb="xs">
      <Group justify="space-between" wrap="nowrap" py={4}>
        <Group gap={6} wrap="nowrap">
          <StickyNoteIcon size={14} />
          <Text13Medium>Scratch</Text13Medium>
        </Group>
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label="New scratch folder"
          onClick={() => setAdding((value) => !value)}
        >
          <FolderPlusIcon size={14} />
        </ActionIcon>
      </Group>

      {adding && (
        <TextInput
          size="xs"
          mb={4}
          placeholder="Folder name"
          value={newName}
          autoFocus
          disabled={busy}
          onChange={(e) => setNewName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreateFolder();
            if (e.key === 'Escape') {
              setAdding(false);
              setNewName('');
            }
          }}
        />
      )}

      {scratchFolders.length === 0 ? (
        <Text12Regular c="dimmed" px={2}>
          No scratch folders yet.
        </Text12Regular>
      ) : (
        <Stack gap={0}>
          {scratchFolders.map((folder) => (
            <Group key={folder.id} gap="xs" wrap="nowrap" justify="space-between">
              <UnstyledButton flex={1} onClick={() => setOpenFolder(folder)}>
                <Text12Regular truncate>{folder.name}</Text12Regular>
              </UnstyledButton>
              <ActionIcon
                variant="subtle"
                color="red"
                size="sm"
                aria-label="Delete folder"
                onClick={() => void handleDeleteFolder(folder)}
              >
                <Trash2Icon size={14} />
              </ActionIcon>
            </Group>
          ))}
        </Stack>
      )}

      {openFolder && (
        <ScratchFolderModal opened onClose={() => setOpenFolder(null)} workbookId={workbookId} folder={openFolder} />
      )}
      {confirmModal}
    </Box>
  );
}
