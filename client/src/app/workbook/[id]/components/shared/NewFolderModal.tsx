'use client';

import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useDataFolders } from '@/hooks/use-data-folders';
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import type { WorkbookId } from '@spinner/shared-types';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface NewFolderModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

/**
 * Create a standalone "scratch" folder (DEV-10424) — a top-level folder of raw files with no
 * connector. On success, navigates to the new (empty) folder.
 */
export function NewFolderModal({ opened, onClose, workbookId }: NewFolderModalProps) {
  const router = useRouter();
  const { createScratchFolder } = useDataFolders(workbookId);
  const [folderName, setFolderName] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (opened) {
      setFolderName('');
    }
  }, [opened]);

  const handleCreate = async () => {
    const name = folderName.trim();
    if (!name) return;

    setLoading(true);
    try {
      const folder = await createScratchFolder(name);
      ScratchpadNotifications.success({ title: 'Folder Created', message: `Created ${name}` });
      onClose();
      // Navigate to the new folder. DataFolder.path has a leading slash; the URL omits it.
      if (folder.path) {
        const encodedPath = folder.path.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
        router.push(`/workbook/${workbookId}/files/${encodedPath}`);
      }
    } catch (error) {
      console.error('Failed to create folder', error);
      ScratchpadNotifications.error({
        title: 'Creation Failed',
        message: error instanceof Error ? error.message : 'Could not create folder.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="New Folder" size="sm" centered>
      <Stack gap="md">
        <TextInput
          label="Name"
          placeholder="e.g., Drafts"
          value={folderName}
          onChange={(e) => setFolderName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate();
          }}
          data-autofocus
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} loading={loading} disabled={!folderName.trim()}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
