'use client';

import { Box, Button, Code, Group, Modal, Stack, Title } from '@mantine/core';
import { GitGcResponse } from '@spinner/shared-types';

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
          <Code block style={{ whiteSpace: 'pre-wrap' }}>
            {data.statsBefore}
          </Code>
        </Box>

        <Box>
          <Title order={5} mb="xs">
            Repository Statistics After GC
          </Title>
          <Code block style={{ whiteSpace: 'pre-wrap' }}>
            {data.statsAfter}
          </Code>
        </Box>

        <Group justify="flex-end" mt="md">
          <Button onClick={onClose}>Close</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
