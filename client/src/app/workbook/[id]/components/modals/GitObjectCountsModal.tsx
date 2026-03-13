'use client';

import { Text12Regular } from '@/app/components/base/text';
import { Badge, Button, Group, Modal, Stack } from '@mantine/core';
import { GitObjectCountsResponse } from '@spinner/shared-types';
import { useState } from 'react';
import { GitStatsViewer } from './GitStatsViewer';

interface GitObjectCountsModalProps {
  opened: boolean;
  onClose: () => void;
  data: GitObjectCountsResponse | null;
  repoPath?: string | null;
}

export function GitObjectCountsModal({ opened, onClose, data, repoPath }: GitObjectCountsModalProps) {
  const [now] = useState(() => Date.now());

  if (!data) return null;

  let gcStatusBadge = <Badge color="gray">GC Not running</Badge>;
  if (data.gcInProgress) {
    const mins = Math.max(0, Math.round((now - data.gcInProgress) / 60000));
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
        {repoPath && <Text12Regular c="var(--fg-secondary)">Path: {repoPath}</Text12Regular>}
        <GitStatsViewer stats={data.stats} />
        <Group justify="flex-end" mt="md">
          <Button onClick={onClose}>Close</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
