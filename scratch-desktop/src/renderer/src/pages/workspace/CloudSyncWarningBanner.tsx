import { Alert, Group, Modal, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { ButtonPrimaryLight, ButtonSecondaryGhost } from '../../components/base/buttons';
import { Text13Regular, TextMono12Regular } from '../../components/base/text';
import { CloudSyncWarning } from '../../lib/local-workspaces';
import { trackWorkspaceCloudSyncDetected } from '../../lib/posthog';

interface CloudSyncWarningBannerProps {
  workspaceId: string;
  workspaceName: string;
  localPath: string;
  warning: CloudSyncWarning;
  onMoved: () => void;
}

export function CloudSyncWarningBanner({
  workspaceId,
  workspaceName,
  localPath,
  warning,
  onMoved,
}: CloudSyncWarningBannerProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    void trackWorkspaceCloudSyncDetected(workspaceId, warning.provider, 'open');
  }, [workspaceId, warning.provider]);

  const handleMove = async (): Promise<void> => {
    setConfirmOpen(false);
    setMoving(true);
    try {
      const parentFolder = await window.scratchDesktop.pickParentFolder();
      if (!parentFolder) {
        return;
      }
      await window.scratchDesktop.removeWorkspace(workspaceId);
      await window.scratchDesktop.initWorkspace(workspaceId, parentFolder);
      notifications.show({
        title: 'Workspace moved',
        message: `${workspaceName || 'Workspace'} is now at ${parentFolder}.`,
        color: 'green',
      });
      onMoved();
    } catch (err) {
      notifications.show({
        title: 'Move failed',
        message: err instanceof Error ? err.message : 'Failed to move workspace',
        color: 'red',
      });
    } finally {
      setMoving(false);
    }
  };

  return (
    <>
      <Alert color="red" title={`This workspace is inside ${warning.providerLabel}`} radius={0}>
        <Stack gap="xs">
          <Text13Regular>
            Storing a Scratch workspace inside {warning.providerLabel} isn&apos;t supported and can lead to lost or
            corrupted edits — {warning.providerLabel} re-syncs files in the background while Scratch is using them,
            which can leave the workspace in a broken state. Move it to a folder that isn&apos;t synced (for example,{' '}
            <TextMono12Regular span>~/Scratch</TextMono12Regular>).
          </Text13Regular>
          <TextMono12Regular c="dimmed">{localPath}</TextMono12Regular>
          <Group gap="xs">
            <ButtonPrimaryLight onClick={() => setConfirmOpen(true)} loading={moving}>
              Move workspace…
            </ButtonPrimaryLight>
            <ButtonSecondaryGhost onClick={() => void window.scratchDesktop.showInFolder(localPath)}>
              Show in Finder
            </ButtonSecondaryGhost>
          </Group>
        </Stack>
      </Alert>
      <Modal opened={confirmOpen} onClose={() => setConfirmOpen(false)} title="Move workspace?" centered size="md">
        <Stack gap="md">
          <Text13Regular>
            Moving will remove the local copy of this workspace and re-download it at a new location.
            <strong> Publish any pending edits first</strong> — unreviewed and unpublished changes will be lost.
          </Text13Regular>
          <Group justify="flex-end" gap="xs">
            <ButtonSecondaryGhost onClick={() => setConfirmOpen(false)}>Cancel</ButtonSecondaryGhost>
            <ButtonPrimaryLight onClick={() => void handleMove()} loading={moving}>
              Choose new location
            </ButtonPrimaryLight>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
