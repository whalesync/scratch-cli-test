import { Text12Regular } from '@/app/components/base/text';
import { API_CONFIG } from '@/lib/api/config';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import type { FileRefEntity, WorkbookId } from '@spinner/shared-types';
import { useState } from 'react';

interface RenameFileModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  file: FileRefEntity;
  onSuccess?: (newName: string) => void;
}

export function RenameFileModal({ opened, onClose, workbookId, file, onSuccess }: RenameFileModalProps) {
  const setWorkbookError = useWorkbookUIStore((state) => state.setWorkbookError);

  const [newName, setNewName] = useState(file.name);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleClose = () => {
    setNewName(file.name);
    onClose();
  };

  const handleRename = async () => {
    if (!newName.trim() || newName === file.name) return;

    setIsSubmitting(true);
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.patch(
        `/workbooks/${workbookId}/files/by-path`,
        { name: newName.trim() },
        {
          params: { path: file.path },
        },
      );

      onSuccess?.(newName.trim());
      handleClose();
    } catch (error) {
      setWorkbookError({
        description: 'Failed to rename file.',
        cause: error as Error,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Only render if opened to ensure state resets properly
  if (!opened) return null;

  return (
    <Modal opened={opened} onClose={handleClose} title="Rename File" size="md">
      <Stack>
        <Text12Regular c="var(--fg-secondary)">
          Enter a new name for the file. The extension should be included if applicable.
        </Text12Regular>
        <TextInput
          label="File Name"
          value={newName}
          onChange={(e) => setNewName(e.currentTarget.value)}
          placeholder="e.g. data.json"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRename();
          }}
        />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleRename} loading={isSubmitting} disabled={!newName.trim() || newName === file.name}>
            Rename
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
