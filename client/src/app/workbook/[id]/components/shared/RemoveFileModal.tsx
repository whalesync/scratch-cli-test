import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { FileRefEntity, WorkbookId } from '@spinner/shared-types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface RemoveFileModalProps {
  opened: boolean;
  onClose: () => void;
  file: FileRefEntity;
  workbookId: WorkbookId;
  onSuccess?: () => void;
}

export function RemoveFileModal({ opened, onClose, file, workbookId, onSuccess }: RemoveFileModalProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleRemove = async () => {
    setLoading(true);
    try {
      await scratchApiClient.files.deleteFileByPath(workbookId, file.path);
      onSuccess?.();
      onClose();
      router.refresh();
    } catch (error) {
      console.error('Failed to remove file:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Delete File" size="sm" centered>
      <Stack gap="md">
        <Text size="sm">
          Are you sure you want to delete{' '}
          <Text span fw={700}>
            {file.name}
          </Text>
          ? This action cannot be undone.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button color="red" onClick={handleRemove} loading={loading}>
            Delete
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
