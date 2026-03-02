'use client';

import { Badge, Button, Group, Modal, Stack } from '@mantine/core';
import { GitObjectCountsResponse } from '@spinner/shared-types';
import { GitStatsViewer } from './GitStatsViewer';

interface GitObjectCountsModalProps {
  opened: boolean;
  onClose: () => void;
  data: GitObjectCountsResponse | null;
}

export function GitObjectCountsModal({ opened, onClose, data }: GitObjectCountsModalProps) {
  if (!data) return null;

  let gcStatusBadge = <Badge color="gray">GC Not running</Badge>;
  if (data.gcInProgress) {
    const mins = Math.max(0, Math.round((Date.now() - data.gcInProgress) / 60000));
    gcStatusBadge = (
      <Badge color="blue" variant="light">
        GC running since: {mins} min{mins !== 1 ? 's' : ''} ago
      </Badge>
    );
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Repo Info" size="md">
      <Stack>
        <Group>
          {gcStatusBadge}
          {data.engine && (
            <Badge color="violet" variant="light">
              Engine: {data.engine}
            </Badge>
          )}
        </Group>
        <GitStatsViewer stats={data.stats} />
        <Group justify="flex-end" mt="md">
          <Button onClick={onClose}>Close</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
