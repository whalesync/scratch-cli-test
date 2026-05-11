import { Group, Modal, Stack, Text } from '@mantine/core';
import { ReactNode, useCallback, useState } from 'react';
import { ButtonDangerLight, ButtonSecondaryGhost } from './base/buttons';

type ConfirmModalOptions = {
  title?: string;
  confirmLabel?: string;
  size?: string;
};

type ConfirmModalState = {
  body: ReactNode;
  title: string;
  confirmLabel: string;
  size: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function useConfirmModal(): {
  confirm: (body: ReactNode, options?: ConfirmModalOptions) => Promise<boolean>;
  confirmModal: React.ReactElement;
} {
  const [state, setState] = useState<ConfirmModalState | null>(null);

  const confirm = useCallback(
    (body: ReactNode, options?: ConfirmModalOptions): Promise<boolean> =>
      new Promise((resolve) => {
        setState({
          body,
          title: options?.title ?? 'Confirm',
          confirmLabel: options?.confirmLabel ?? 'Continue',
          size: options?.size ?? 'sm',
          onConfirm: () => {
            setState(null);
            resolve(true);
          },
          onCancel: () => {
            setState(null);
            resolve(false);
          },
        });
      }),
    [],
  );

  const confirmModal = (
    <Modal
      opened={state !== null}
      onClose={() => state?.onCancel()}
      title={state?.title ?? 'Confirm'}
      size={state?.size ?? 'sm'}
      withCloseButton={false}
    >
      <Stack gap="md">
        {typeof state?.body === 'string' ? <Text size="sm">{state.body}</Text> : state?.body}
        <Group justify="flex-end">
          <ButtonSecondaryGhost onClick={() => state?.onCancel()}>Cancel</ButtonSecondaryGhost>
          <ButtonDangerLight onClick={() => state?.onConfirm()}>{state?.confirmLabel}</ButtonDangerLight>
        </Group>
      </Stack>
    </Modal>
  );

  return { confirm, confirmModal };
}
