'use client';

import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { ButtonCompactSecondary } from '@/app/components/base/buttons';
import { Text12Regular, Text13Regular, TextMono12Regular } from '@/app/components/base/text';
import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Box, Group, SimpleGrid, Stack, TextInput, UnstyledButton } from '@mantine/core';
import type { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { ChevronRightIcon, FileIcon, FilePlusIcon, FolderIcon, FolderPlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import useSWR from 'swr';

const COLUMN_COUNT = 3;

interface ScratchFolderBrowserProps {
  workbookId: WorkbookId;
  folderId: DataFolderId;
  /** DataFolder.path for the scratch folder (leading slash). */
  folderPath: string;
  folderName?: string;
}

/**
 * Path-based browser for a standalone scratch folder (DEV-10424). Lists files AND subdirectories from
 * the scratch repo (`git.listRepoFiles` with `useScratchRepo`, on `main`), lets the user descend into
 * subfolders, open a file in the editor, and create nested files/folders. Connector folders keep the
 * flat record-grid view in `FolderViewer` — this only renders for scratch folders.
 */
export function ScratchFolderBrowser({ workbookId, folderId, folderPath, folderName }: ScratchFolderBrowserProps) {
  const [subPath, setSubPath] = useState('');
  const [newFileName, setNewFileName] = useState('');
  const [newFolderName, setNewFolderName] = useState('');

  const folderGitPath = folderPath.replace(/^\//, '');
  const gitFolder = subPath ? `${folderGitPath}/${subPath}` : folderGitPath;

  const {
    data: entries,
    isLoading,
    mutate,
  } = useSWR(SWR_KEYS.files.scratchBrowse(workbookId, gitFolder), () =>
    scratchApiClient.git.listRepoFiles(workbookId, 'main', gitFolder, undefined, undefined, true),
  );

  const { dirs, files } = useMemo(() => {
    const visible = (entries ?? []).filter((entry) => !entry.name.startsWith('.'));
    return {
      dirs: visible.filter((entry) => entry.type === 'directory'),
      files: visible.filter((entry) => entry.type === 'file'),
    };
  }, [entries]);

  const crumbs = subPath ? subPath.split('/') : [];

  const handleNewFile = async () => {
    const name = newFileName.trim();
    if (!name) return;
    const relName = subPath ? `${subPath}/${name}` : name;
    try {
      await scratchApiClient.files.createFile(workbookId, { name: relName, parentFolderId: folderId, content: '' });
      setNewFileName('');
      await mutate();
    } catch (error) {
      // Surface server validation rejections (duplicate name, illegal/reserved chars, size cap, …).
      ScratchpadNotifications.error({
        title: 'Could not create file',
        message: error instanceof Error ? error.message : 'Failed to create file.',
      });
    }
  };

  const handleNewFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const relPath = subPath ? `${subPath}/${name}` : name;
    try {
      await scratchApiClient.dataFolders.createScratchSubfolder(folderId, relPath, workbookId);
      setNewFolderName('');
      await mutate();
    } catch (error) {
      ScratchpadNotifications.error({
        title: 'Could not create folder',
        message: error instanceof Error ? error.message : 'Failed to create folder.',
      });
    }
  };

  return (
    <Stack h="100%" gap={0}>
      {/* Breadcrumb header */}
      <Group
        h={36}
        px="md"
        gap={4}
        wrap="nowrap"
        style={{ borderBottom: '0.5px solid var(--fg-divider)', flexShrink: 0, backgroundColor: 'var(--bg-base)' }}
      >
        <UnstyledButton onClick={() => setSubPath('')}>
          <Text12Regular c={subPath ? 'var(--mantine-color-blue-6)' : 'var(--fg-muted)'}>
            {folderName ?? 'Scratch'}
          </Text12Regular>
        </UnstyledButton>
        {crumbs.map((segment, index) => (
          <Group key={index} gap={2} wrap="nowrap">
            <ChevronRightIcon size={12} color="var(--fg-muted)" />
            <UnstyledButton onClick={() => setSubPath(crumbs.slice(0, index + 1).join('/'))}>
              <Text12Regular c={index === crumbs.length - 1 ? 'var(--fg-muted)' : 'var(--mantine-color-blue-6)'}>
                {segment}
              </Text12Regular>
            </UnstyledButton>
          </Group>
        ))}
      </Group>

      {/* Contents */}
      <Box style={{ flex: 1, overflow: 'auto' }} p="md">
        {isLoading && !entries ? (
          <Text13Regular c="dimmed">Loading folder contents...</Text13Regular>
        ) : dirs.length === 0 && files.length === 0 ? (
          <Text13Regular c="dimmed">This folder is empty</Text13Regular>
        ) : (
          <SimpleGrid cols={COLUMN_COUNT} spacing="xs" verticalSpacing="xs">
            {dirs.map((dir) => (
              <UnstyledButton
                key={dir.path}
                p="xs"
                onClick={() => setSubPath(subPath ? `${subPath}/${dir.name}` : dir.name)}
                style={{
                  width: '100%',
                  backgroundColor: 'var(--bg-panel)',
                  borderRadius: 4,
                  border: '1px solid var(--fg-divider)',
                }}
                styles={{ root: { '&:hover': { backgroundColor: 'var(--bg-selected)' } } }}
              >
                <Group gap="xs" wrap="nowrap">
                  <FolderIcon size={12} color="var(--fg-muted)" style={{ flexShrink: 0 }} />
                  <TextMono12Regular c="var(--fg-primary)" truncate style={{ flex: 1 }}>
                    {dir.name}
                  </TextMono12Regular>
                </Group>
              </UnstyledButton>
            ))}
            {files.map((file) => {
              const encodedPath = file.path
                .split('/')
                .map((segment) => encodeURIComponent(segment))
                .join('/');
              return (
                // Render a single `<a>` (UnstyledButton as next/link) — nesting a <button> inside an
                // <a> is invalid DOM and triggers a React hydration error.
                <UnstyledButton
                  key={file.path}
                  component={Link}
                  href={`/workbook/${workbookId}/files/${encodedPath}`}
                  p="xs"
                  style={{
                    width: '100%',
                    backgroundColor: 'var(--bg-panel)',
                    borderRadius: 4,
                    border: '1px solid var(--fg-divider)',
                    textDecoration: 'none',
                  }}
                  styles={{ root: { '&:hover': { backgroundColor: 'var(--bg-selected)' } } }}
                >
                  <Group gap="xs" wrap="nowrap">
                    <FileIcon size={12} color="var(--fg-muted)" style={{ flexShrink: 0 }} />
                    <TextMono12Regular c="var(--fg-primary)" truncate style={{ flex: 1 }}>
                      {file.name}
                    </TextMono12Regular>
                  </Group>
                </UnstyledButton>
              );
            })}
          </SimpleGrid>
        )}
      </Box>

      {/* Create row */}
      <Group
        h={44}
        px="md"
        gap="sm"
        wrap="nowrap"
        style={{ borderTop: '0.5px solid var(--fg-divider)', flexShrink: 0, backgroundColor: 'var(--bg-base)' }}
      >
        <TextInput
          size="xs"
          flex={1}
          placeholder="New file (e.g. post.md)"
          value={newFileName}
          leftSection={<FilePlusIcon size={12} />}
          onChange={(e) => setNewFileName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleNewFile();
          }}
        />
        <ButtonCompactSecondary onClick={() => void handleNewFile()} disabled={!newFileName.trim()}>
          Add file
        </ButtonCompactSecondary>
        <TextInput
          size="xs"
          flex={1}
          placeholder="New folder"
          value={newFolderName}
          leftSection={<FolderPlusIcon size={12} />}
          onChange={(e) => setNewFolderName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleNewFolder();
          }}
        />
        <ButtonCompactSecondary onClick={() => void handleNewFolder()} disabled={!newFolderName.trim()}>
          Add folder
        </ButtonCompactSecondary>
      </Group>
    </Stack>
  );
}
