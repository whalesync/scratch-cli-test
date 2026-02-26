'use client';

import { Box, Button, Group, Modal, Stack, Title } from '@mantine/core';
import { GitGcResponse } from '@spinner/shared-types';
import { GitStatsViewer } from './GitStatsViewer';

interface GitGcModalProps {
  opened: boolean;
  onClose: () => void;
  data: GitGcResponse | null;
}

export function GitGcModal({ opened, onClose, data }: GitGcModalProps) {
  if (!data) return null;

  return (
    <Modal opened={opened} onClose={onClose} title="Git Garbage Collection Results" size="lg">
      <Stack>
        <Box>
          <Title order={5} mb="xs">
            Repository Statistics Before GC
          </Title>
          <GitStatsViewer stats={data.statsBefore} />
        </Box>

        <Box>
          <Title order={5} mb="xs">
            Repository Statistics After GC
          </Title>
          <GitStatsViewer stats={data.statsAfter} />
        </Box>

        <Group justify="flex-end" mt="md">
          <Button onClick={onClose}>Close</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
