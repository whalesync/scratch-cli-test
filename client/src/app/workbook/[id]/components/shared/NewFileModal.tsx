'use client';

import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Button, Checkbox, Group, Modal, Stack, TextInput } from '@mantine/core';
import type { DataFolder, WorkbookId } from '@spinner/shared-types';
import { useEffect, useState } from 'react';

interface NewFileModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
  workbookId: WorkbookId;
  onSuccess?: () => void;
}

export function NewFileModal({ opened, onClose, folder, workbookId, onSuccess }: NewFileModalProps) {
  // Standalone "scratch" folders (DEV-10424) have no connector and no schema, so there is no
  // template to apply — the file is created as raw, empty bytes.
  const isScratch = folder.connectorAccountId == null;
  const [fileName, setFileName] = useState('');
  const [useTemplate, setUseTemplate] = useState(!isScratch);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (opened) {
      setFileName('');
      setUseTemplate(!isScratch);
    }
  }, [opened, isScratch]);

  const handleCreate = async () => {
    if (!fileName.trim()) return;

    setLoading(true);
    try {
      await scratchApiClient.dataFolders.createDataFolderFile(folder.id, fileName, useTemplate, workbookId);

      ScratchpadNotifications.success({
        title: 'File Created',
        message: `Created ${fileName}`,
      });
      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Failed to create file', error);
      ScratchpadNotifications.error({
        title: 'Creation Failed',
        message: 'Could not create file.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="New File" size="sm" centered>
      <Stack gap="md">
        <TextInput
          label="Name"
          placeholder={isScratch ? 'e.g., post.md' : 'e.g., config.json'}
          value={fileName}
          onChange={(e) => setFileName(e.currentTarget.value)}
          data-autofocus
        />
        {!isScratch && (
          <Checkbox
            label="Use Template"
            checked={useTemplate}
            onChange={(e) => setUseTemplate(e.currentTarget.checked)}
          />
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} loading={loading} disabled={!fileName.trim()}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
