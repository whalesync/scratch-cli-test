import { dataFolderApi } from '@/lib/api/data-folder';
import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { DataFolder, WorkbookId } from '@spinner/shared-types';
import { useState } from 'react';

interface DeleteAllRecordsModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
  workbookId: WorkbookId;
  onSuccess?: () => void;
}

export function DeleteAllRecordsModal({ opened, onClose, folder, workbookId, onSuccess }: DeleteAllRecordsModalProps) {
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: {
      confirmation: '',
    },
    validate: {
      confirmation: (value) => (value === 'DELETE' ? null : 'Type DELETE to confirm'),
    },
  });

  const handleDelete = async () => {
    if (form.values.confirmation !== 'DELETE') {
      form.setFieldError('confirmation', 'Type DELETE to confirm');
      return;
    }

    setLoading(true);
    try {
      // Use folder path if available, fallback to folder name
      // TODO: quick fix to unblock test. We probably just need path.
      await dataFolderApi.deleteAllRecords(workbookId, folder.path || folder.name);

      notifications.show({
        title: `Deleted all records in folder ${folder.name}`,
        message: 'Remote records will not be affected until published.',
        color: 'green',
      });

      onSuccess?.();
      onClose();
    } catch (error) {
      console.error(error);
      notifications.show({
        title: 'Error',
        message: 'Failed to delete records',
        color: 'red',
      });
    } finally {
      setLoading(false);
      form.reset();
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={`Delete all records in ${folder.name}?`}>
      <Stack>
        <Text size="sm">
          This will permanently delete all files in the <b>{folder.name}</b> folder. This action cannot be undone.
        </Text>

        <TextInput label="Type DELETE to confirm" placeholder="DELETE" {...form.getInputProps('confirmation')} />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button color="red" onClick={handleDelete} loading={loading} disabled={form.values.confirmation !== 'DELETE'}>
            Delete All
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
