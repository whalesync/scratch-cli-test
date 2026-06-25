import { ButtonPrimarySolid, ButtonSecondaryGhost } from '@/components/base/buttons';
import { Text12Regular, Text13Regular, TextTitle2 } from '@/components/base/text';
import { useConfirmModal } from '@/components/ConfirmModal';
import { TextFileEditorModal } from '@/components/TextFileEditorModal';
import { scratchApiClient } from '@/lib/scratch-api-client';
import { ActionIcon, Box, Group, Loader, Modal, Stack, TextInput, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { DataFolder, WorkbookId } from '@spinner/shared-types';
import { ChevronRightIcon, FilePlusIcon, FileTextIcon, FolderIcon, FolderPlusIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

type GitEntry = Awaited<ReturnType<typeof scratchApiClient.git.listRepoFiles>>[number];

export interface ScratchFolderModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  folder: DataFolder;
}

/**
 * Path-based browser for a standalone scratch folder (DEV-10424). Lists files AND subdirectories from
 * the scratch repo (`git.listRepoFiles` with `useScratchRepo`, on `main`), descends into subfolders,
 * opens files in a plain-text editor, and creates nested files/folders — all via the same server REST
 * API the web uses (no local-disk/CLI-sync path).
 */
export function ScratchFolderModal({ opened, onClose, workbookId, folder }: ScratchFolderModalProps) {
  const folderGitPath = folder.path?.replace(/^\//, '') ?? '';
  const [subPath, setSubPath] = useState('');
  const [entries, setEntries] = useState<GitEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [openFile, setOpenFile] = useState<GitEntry | null>(null);
  const { confirm, confirmModal } = useConfirmModal();

  const gitFolder = subPath ? `${folderGitPath}/${subPath}` : folderGitPath;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await scratchApiClient.git.listRepoFiles(workbookId, 'main', gitFolder, undefined, undefined, true);
      // Hide dotfiles (e.g. the .gitkeep placeholder that keeps an empty folder in git).
      setEntries(res.filter((entry) => !entry.name.startsWith('.')));
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Failed to load folder',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [workbookId, gitFolder]);

  useEffect(() => {
    if (opened) {
      setNewFileName('');
      setNewFolderName('');
      void refresh();
    }
  }, [opened, refresh]);

  const { dirs, files } = useMemo(
    () => ({
      dirs: entries.filter((entry) => entry.type === 'directory'),
      files: entries.filter((entry) => entry.type === 'file'),
    }),
    [entries],
  );

  const crumbs = subPath ? subPath.split('/') : [];

  const handleNewFile = useCallback(async () => {
    const name = newFileName.trim();
    if (!name) return;
    const relName = subPath ? `${subPath}/${name}` : name;
    try {
      await scratchApiClient.files.createFile(workbookId, { name: relName, parentFolderId: folder.id, content: '' });
      setNewFileName('');
      await refresh();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Could not create file',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [newFileName, subPath, workbookId, folder.id, refresh]);

  const handleNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const relPath = subPath ? `${subPath}/${name}` : name;
    try {
      await scratchApiClient.dataFolders.createScratchSubfolder(folder.id, relPath, workbookId);
      setNewFolderName('');
      await refresh();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Could not create folder',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [newFolderName, subPath, workbookId, folder.id, refresh]);

  const handleDelete = useCallback(
    async (file: GitEntry) => {
      const ok = await confirm(`Delete "${file.name}"? This cannot be undone.`, {
        title: 'Delete file',
        confirmLabel: 'Delete',
      });
      if (!ok) return;
      try {
        await scratchApiClient.files.deleteFileByPath(workbookId, file.path);
        await refresh();
      } catch (err) {
        notifications.show({
          color: 'red',
          title: 'Could not delete file',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [workbookId, refresh, confirm],
  );

  return (
    <>
      <Modal opened={opened} onClose={onClose} title={<TextTitle2>{folder.name}</TextTitle2>} size="md" padding="md">
        <Stack gap="sm">
          {/* Breadcrumb */}
          <Group gap={4} wrap="nowrap">
            <UnstyledButton onClick={() => setSubPath('')}>
              <Text12Regular c={subPath ? 'var(--mantine-color-blue-6)' : 'var(--fg-muted)'}>
                {folder.name}
              </Text12Regular>
            </UnstyledButton>
            {crumbs.map((segment, index) => (
              <Group key={index} gap={2} wrap="nowrap">
                <ChevronRightIcon size={12} />
                <UnstyledButton onClick={() => setSubPath(crumbs.slice(0, index + 1).join('/'))}>
                  <Text12Regular c={index === crumbs.length - 1 ? 'var(--fg-muted)' : 'var(--mantine-color-blue-6)'}>
                    {segment}
                  </Text12Regular>
                </UnstyledButton>
              </Group>
            ))}
          </Group>

          {/* New file / folder */}
          <Group gap="xs" wrap="nowrap">
            <TextInput
              flex={1}
              size="xs"
              placeholder="New file (e.g. post.md)"
              value={newFileName}
              onChange={(e) => setNewFileName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleNewFile();
              }}
            />
            <ButtonPrimarySolid
              size="compact-sm"
              leftSection={<FilePlusIcon size={14} />}
              disabled={!newFileName.trim()}
              onClick={() => void handleNewFile()}
            >
              File
            </ButtonPrimarySolid>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <TextInput
              flex={1}
              size="xs"
              placeholder="New folder"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleNewFolder();
              }}
            />
            <ButtonPrimarySolid
              size="compact-sm"
              leftSection={<FolderPlusIcon size={14} />}
              disabled={!newFolderName.trim()}
              onClick={() => void handleNewFolder()}
            >
              Folder
            </ButtonPrimarySolid>
          </Group>

          {/* Contents */}
          {loading ? (
            <Group justify="center" p="md">
              <Loader size="sm" />
            </Group>
          ) : dirs.length === 0 && files.length === 0 ? (
            <Text12Regular c="dimmed" ta="center" py="md">
              This folder is empty.
            </Text12Regular>
          ) : (
            <Stack gap={2}>
              {dirs.map((dir) => (
                <UnstyledButton
                  key={dir.path}
                  onClick={() => setSubPath(subPath ? `${subPath}/${dir.name}` : dir.name)}
                >
                  <Group gap={6} wrap="nowrap">
                    <FolderIcon size={14} />
                    <Text13Regular truncate>{dir.name}</Text13Regular>
                  </Group>
                </UnstyledButton>
              ))}
              {files.map((file) => (
                <Group key={file.path} gap="xs" wrap="nowrap" justify="space-between">
                  <UnstyledButton flex={1} onClick={() => setOpenFile(file)}>
                    <Group gap={6} wrap="nowrap">
                      <FileTextIcon size={14} />
                      <Text13Regular truncate>{file.name}</Text13Regular>
                    </Group>
                  </UnstyledButton>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    aria-label="Delete file"
                    onClick={() => void handleDelete(file)}
                  >
                    <Trash2Icon size={14} />
                  </ActionIcon>
                </Group>
              ))}
            </Stack>
          )}

          <Box>
            <Group justify="flex-end">
              <ButtonSecondaryGhost size="compact-sm" onClick={onClose}>
                Close
              </ButtonSecondaryGhost>
            </Group>
          </Box>
        </Stack>
      </Modal>

      <TextFileEditorModal
        opened={openFile !== null}
        onClose={() => setOpenFile(null)}
        workbookId={workbookId}
        filePath={openFile?.path ?? ''}
        title={openFile?.name ?? ''}
        onFileSaved={() => void refresh()}
      />
      {confirmModal}
    </>
  );
}
