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
  const [fileName, setFileName] = useState('');
  const [useTemplate, setUseTemplate] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (opened) {
      setFileName('');
      setUseTemplate(true);
    }
  }, [opened]);

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
          placeholder="e.g., config.json"
          value={fileName}
          onChange={(e) => setFileName(e.currentTarget.value)}
          data-autofocus
        />
        <Checkbox
          label="Use Template"
          checked={useTemplate}
          onChange={(e) => setUseTemplate(e.currentTarget.checked)}
        />
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
