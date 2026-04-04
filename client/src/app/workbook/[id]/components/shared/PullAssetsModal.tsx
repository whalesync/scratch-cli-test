'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Regular } from '@/app/components/base/text';
import { Checkbox, Group, Modal, Stack } from '@mantine/core';
import { useState } from 'react';

interface PullAssetsModalProps {
  opened: boolean;
  onClose: () => void;
  onConfirm: (options: { rehost: boolean }) => Promise<void>;
  title: string;
}

export const PullAssetsModal = ({ opened, onClose, onConfirm, title }: PullAssetsModalProps) => {
  const [rehost, setRehost] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleConfirm = async () => {
    try {
      setIsLoading(true);
      await onConfirm({ rehost });
      onClose();
    } catch (error) {
      console.error('Pull assets failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={title} centered size="sm">
      <Stack gap="md">
        <Text13Regular>
          Loads file metadata into Scratch for use during syncing or downloading to your local computer.
        </Text13Regular>

        <Checkbox
          label="Store copies in Scratch"
          checked={rehost}
          onChange={(e) => setRehost(e.currentTarget.checked)}
        />

        <Group justify="flex-end" mt="md">
          <ButtonSecondaryOutline onClick={onClose} disabled={isLoading}>
            Cancel
          </ButtonSecondaryOutline>
          <ButtonPrimaryLight onClick={handleConfirm} loading={isLoading}>
            Pull Assets
          </ButtonPrimaryLight>
        </Group>
      </Stack>
    </Modal>
  );
};
