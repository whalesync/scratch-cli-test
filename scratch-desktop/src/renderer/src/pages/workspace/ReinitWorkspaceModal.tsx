import { Center, Group, Loader, Modal, Stack } from '@mantine/core';
import { useEffect, useState } from 'react';
import { ButtonPrimaryLight, ButtonSecondaryOutline } from '../../components/base/buttons';
import { Text13Regular } from '../../components/base/text';
import { parentDirectoryPath } from '../../lib/parent-path';

type Phase = 'confirm' | 'reinitializing' | 'error';

interface ReinitWorkspaceModalProps {
  opened: boolean;
  workbookId: string;
  localPath: string;
  /**
   * Why the CLI asked for a re-clone (from the `workspace_needs_reinit` event).
   * `'structure_changed'` (DEV-9698) tailors the copy to a server-side folder
   * restructure; anything else falls back to the legacy "older version" wording.
   */
  reason?: string;
  onClose: () => void;
  onReinitialized: () => void;
}

export function ReinitWorkspaceModal({
  opened,
  workbookId,
  localPath,
  reason,
  onClose,
  onReinitialized,
}: ReinitWorkspaceModalProps) {
  const [phase, setPhase] = useState<Phase>('confirm');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (opened) {
      setPhase('confirm');
      setError(null);
    }
  }, [opened]);

  const handleReinitialize = async (): Promise<void> => {
    setPhase('reinitializing');
    setError(null);
    try {
      const parentDir = parentDirectoryPath(localPath);
      await window.scratchDesktop.initWorkspace(workbookId, parentDir, { force: true });
      onReinitialized();
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : 'Failed to reinitialize workspace');
    }
  };

  const isReinitializing = phase === 'reinitializing';

  return (
    <Modal
      opened={opened}
      onClose={isReinitializing ? () => undefined : onClose}
      title="Reinitialize workspace"
      size="md"
      closeOnClickOutside={!isReinitializing}
      closeOnEscape={!isReinitializing}
      withCloseButton={!isReinitializing}
    >
      <Stack gap="md">
        {phase === 'confirm' && (
          <>
            <Text13Regular>
              {reason === 'structure_changed'
                ? "This workspace's folder structure changed on the server and needs to be re-synced."
                : 'This workspace was created on an older version of Scratch and needs to be reinitialized.'}
            </Text13Regular>
            <Text13Regular c="dimmed">
              Edits you&apos;ve staged for publish are backed up on disk first. To keep any other in-progress changes,
              accept or publish them before re-syncing.
            </Text13Regular>
            <Group justify="flex-end" gap="sm">
              <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
              <ButtonPrimaryLight onClick={() => void handleReinitialize()}>Reinitialize workspace</ButtonPrimaryLight>
            </Group>
          </>
        )}

        {phase === 'reinitializing' && (
          <Center py="xl">
            <Stack align="center" gap="sm">
              <Loader size="sm" />
              <Text13Regular c="dimmed">Reinitializing workspace… this may take a moment.</Text13Regular>
            </Stack>
          </Center>
        )}

        {phase === 'error' && (
          <>
            <Text13Regular c="var(--mantine-color-red-6)">{error}</Text13Regular>
            <Group justify="flex-end" gap="sm">
              <ButtonSecondaryOutline onClick={onClose}>Close</ButtonSecondaryOutline>
              <ButtonPrimaryLight onClick={() => void handleReinitialize()}>Try again</ButtonPrimaryLight>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
