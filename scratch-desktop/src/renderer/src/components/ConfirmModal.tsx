import { Group, Modal, Stack, Text } from '@mantine/core';
import { useCallback, useState } from 'react';
import { ButtonDangerLight, ButtonSecondaryGhost } from './base/buttons';

type ConfirmModalState = {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function useConfirmModal(): {
  confirm: (message: string) => Promise<boolean>;
  confirmModal: React.ReactElement;
} {
  const [state, setState] = useState<ConfirmModalState | null>(null);

  const confirm = useCallback(
    (message: string): Promise<boolean> =>
      new Promise((resolve) => {
        setState({
          message,
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
    <Modal opened={state !== null} onClose={() => state?.onCancel()} title="Confirm" size="sm" withCloseButton={false}>
      <Stack gap="md">
        <Text size="sm">{state?.message}</Text>
        <Group justify="flex-end">
          <ButtonSecondaryGhost onClick={() => state?.onCancel()}>Cancel</ButtonSecondaryGhost>
          <ButtonDangerLight onClick={() => state?.onConfirm()}>Continue</ButtonDangerLight>
        </Group>
      </Stack>
    </Modal>
  );

  return { confirm, confirmModal };
}
