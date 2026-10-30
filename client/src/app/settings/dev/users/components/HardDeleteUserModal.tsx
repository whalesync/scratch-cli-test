'use client';

import { ButtonDangerLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Book, Text13Regular } from '@/app/components/base/text';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { trackAdminHardDeleteUser } from '@/lib/posthog';
import { Code, Group, Modal, Stack, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';

/**
 * Type-to-confirm modal for the irreversible admin hard-delete of a user. The Delete button stays
 * disabled until the admin types the target user's email exactly, guarding against fat-finger deletes.
 */
export const HardDeleteUserModal = ({
  opened,
  onClose,
  user,
  onDeleted,
}: {
  opened: boolean;
  onClose: () => void;
  user: { id: string; name?: string; email?: string };
  /** Called after a successful delete so the parent can clear the now-defunct user from view. */
  onDeleted: () => void;
}) => {
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // Reset the typed confirmation whenever the modal (re)opens or the target user changes.
  useEffect(() => {
    if (opened) {
      setConfirmText('');
    }
  }, [opened, user.id]);

  // Confirm against the email when we have one, otherwise fall back to the user id.
  const confirmToken = user.email ?? user.id;
  const confirmTokenLabel = user.email ? 'email' : 'ID';
  const isConfirmed = confirmText.trim() === confirmToken;

  const handleDelete = async () => {
    if (!isConfirmed) return;
    try {
      setIsDeleting(true);
      const result = await scratchApiClient.devTools.hardDeleteUser(user.id);
      trackAdminHardDeleteUser(user.id);
      ScratchpadNotifications.success({
        title: 'User hard-deleted',
        message: `Removed ${result.deletedWorkbookCount} workbook(s)${
          result.organizationDeleted ? ' and their organization' : ''
        }.`,
      });
      onDeleted();
      onClose();
    } catch (error) {
      console.error('Failed to hard-delete user', error);
      ScratchpadNotifications.error({
        title: 'Failed to hard-delete user',
        message: 'The user was not deleted. See the console for details.',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Hard-delete user" centered size="md">
      <Stack gap="md">
        <Text13Regular>
          This permanently deletes <strong>{user.name ?? user.email ?? user.id}</strong> and tears down all of their
          workbooks, connection repos, jobs, and tokens. If they are the sole member of their organization, the
          organization is deleted too. This cannot be undone.
        </Text13Regular>
        <Stack gap="xs">
          <Text13Book c="var(--fg-secondary)">
            Type the user&apos;s {confirmTokenLabel} <Code>{confirmToken}</Code> to confirm:
          </Text13Book>
          <TextInput
            placeholder={confirmToken}
            value={confirmText}
            onChange={(e) => setConfirmText(e.currentTarget.value)}
            disabled={isDeleting}
            data-autofocus
          />
        </Stack>
        <Group justify="flex-end" mt="md">
          <ButtonSecondaryOutline onClick={onClose} disabled={isDeleting}>
            Cancel
          </ButtonSecondaryOutline>
          <ButtonDangerLight onClick={handleDelete} loading={isDeleting} disabled={!isConfirmed}>
            Delete user
          </ButtonDangerLight>
        </Group>
      </Stack>
    </Modal>
  );
};
