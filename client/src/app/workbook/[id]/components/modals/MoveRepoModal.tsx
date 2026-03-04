'use client';

import { workbookApi } from '@/lib/api/workbook';
import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';

interface MoveRepoModalProps {
  opened: boolean;
  onClose: () => void;
  connectorAccountId: string;
  currentRepoPath: string;
  onSuccess?: () => void;
}

export function MoveRepoModal({ opened, onClose, connectorAccountId, currentRepoPath, onSuccess }: MoveRepoModalProps) {
  const [newPath, setNewPath] = useState(currentRepoPath);
  const [isMoving, setIsMoving] = useState(false);

  // Reset when modal opens
  useEffect(() => {
    if (opened) setNewPath(currentRepoPath);
  }, [opened, currentRepoPath]);

  const handleMove = async () => {
    const trimmed = newPath.trim();
    if (!trimmed || trimmed === currentRepoPath) return;
    setIsMoving(true);
    try {
      await workbookApi.moveRepo(connectorAccountId, trimmed);
      notifications.show({ title: 'Success', message: `Repo moved to ${trimmed}`, color: 'green' });
      onClose();
      onSuccess?.();
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to move repo', color: 'red' });
    } finally {
      setIsMoving(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Move Repository" size="md" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Current path:{' '}
          <Text span ff="monospace" fw={600}>
            {currentRepoPath}
          </Text>
        </Text>
        <TextInput
          label="New repo path"
          value={newPath}
          onChange={(e) => setNewPath(e.currentTarget.value)}
          placeholder="e.g. org/workbook/connection"
          styles={{ input: { fontFamily: 'monospace' } }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleMove();
          }}
          autoFocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={isMoving}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleMove()}
            loading={isMoving}
            disabled={!newPath.trim() || newPath.trim() === currentRepoPath}
          >
            Move
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
