import { Box, Group, Loader, Stack, Text } from '@mantine/core';
import { useEffect, useRef } from 'react';

interface LiveCommandOutputProps {
  output: string;
  running: boolean;
  exitCode: number | null;
  emptyMessage?: string;
}

export function LiveCommandOutput({
  output,
  running,
  exitCode,
  emptyMessage = 'Command output will appear here.',
}: LiveCommandOutputProps) {
  const outputRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!outputRef.current) {
      return;
    }

    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const statusLabel = running
    ? 'Running'
    : exitCode === null
      ? 'Ready'
      : exitCode === 0
        ? 'Completed'
        : `Exited ${exitCode}`;
  const statusColor = running ? 'blue' : exitCode === null ? 'dimmed' : exitCode === 0 ? 'green' : 'red';

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center">
        <Text size="sm" fw={600}>
          Command output
        </Text>
        <Group gap="xs" align="center">
          {running && <Loader size="xs" />}
          <Text size="xs" c={statusColor}>
            {statusLabel}
          </Text>
        </Group>
      </Group>

      <Box
        component="pre"
        ref={outputRef}
        p="sm"
        m={0}
        style={{
          minHeight: 320,
          maxHeight: 320,
          overflowY: 'auto',
          borderRadius: 8,
          border: '1px solid var(--mantine-color-gray-3)',
          background: 'var(--mantine-color-dark-9)',
          color: 'var(--mantine-color-gray-0)',
          fontFamily: 'var(--mantine-font-family-monospace)',
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {output || emptyMessage}
      </Box>
    </Stack>
  );
}
