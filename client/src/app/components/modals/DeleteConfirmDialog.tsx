'use client';

import { Group, Modal, Stack, TextInput } from '@mantine/core';
import { ReactNode, useCallback, useState } from 'react';
import { ButtonDangerLight, ButtonSecondaryOutline } from '../base/buttons';
import { Text13Regular } from '../base/text';

interface DeleteConfirmDialogProps {
  opened: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  title: string;
  message: ReactNode;
  confirmPhrase: string;
  confirmLabel?: string;
}

export const DeleteConfirmDialog = ({
  opened,
  onClose,
  onConfirm,
  title,
  message,
  confirmPhrase,
  confirmLabel = 'Delete',
}: DeleteConfirmDialogProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [inputValue, setInputValue] = useState('');

  const isMatch = inputValue === confirmPhrase;

  const handleConfirm = async () => {
    if (!isMatch) return;
    try {
      setIsLoading(true);
      await onConfirm();
      onClose();
    } catch (error) {
      console.error('Confirm action failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setInputValue('');
    onClose();
  };

  return (
    <Modal opened={opened} onClose={handleClose} title={title} centered size="sm">
      <Stack gap="md">
        {typeof message === 'string' ? <Text13Regular>{message}</Text13Regular> : message}

        <TextInput
          label={
            <>
              Type <b>{confirmPhrase}</b> to confirm
            </>
          }
          placeholder={confirmPhrase}
          value={inputValue}
          onChange={(e) => setInputValue(e.currentTarget.value)}
          data-autofocus
        />

        <Group justify="flex-end" mt="md">
          <ButtonSecondaryOutline onClick={handleClose} disabled={isLoading}>
            Cancel
          </ButtonSecondaryOutline>
          <ButtonDangerLight onClick={handleConfirm} loading={isLoading} disabled={!isMatch}>
            {confirmLabel}
          </ButtonDangerLight>
        </Group>
      </Stack>
    </Modal>
  );
};

interface UseDeleteConfirmDialogOptions {
  title: string;
  message: ReactNode;
  confirmPhrase: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
}

interface UseDeleteConfirmDialogReturn {
  open: (options: UseDeleteConfirmDialogOptions) => void;
  dialogProps: DeleteConfirmDialogProps;
}

export const useDeleteConfirmDialog = (): UseDeleteConfirmDialogReturn => {
  const [opened, setOpened] = useState(false);
  const [options, setOptions] = useState<UseDeleteConfirmDialogOptions | null>(null);

  const open = useCallback((opts: UseDeleteConfirmDialogOptions) => {
    setOptions(opts);
    setOpened(true);
  }, []);

  const onClose = useCallback(() => {
    setOpened(false);
    setTimeout(() => setOptions(null), 200);
  }, []);

  const dialogProps: DeleteConfirmDialogProps = {
    opened,
    onClose,
    title: options?.title ?? '',
    message: options?.message ?? '',
    confirmPhrase: options?.confirmPhrase ?? '',
    confirmLabel: options?.confirmLabel,
    onConfirm: options?.onConfirm ?? (() => {}),
  };

  return { open, dialogProps };
};
