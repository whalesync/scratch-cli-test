// Shared chrome for the desktop app's modal dialogs (Publish / Pull / Create Connection / Choose
// Tables). Reproduces the Mantine <Modal> frame: a centered rounded surface with a title + close
// button and a padded body. Not a /design-sync card itself — a building block for the modal screens.
import { Box, Group } from '@mantine/core';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { TextTitle3 } from '../../text';

export function ModalShell({ title, width = 600, children }: { title: string; width?: number; children: ReactNode }) {
  return (
    <Box
      style={{
        width,
        background: 'var(--bg-base)',
        borderRadius: 8,
        border: '0.5px solid var(--fg-divider)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        overflow: 'hidden',
      }}
    >
      <Group justify="space-between" align="center" px={20} pt={16} pb={8}>
        <TextTitle3>{title}</TextTitle3>
        <X size={18} color="var(--fg-muted)" />
      </Group>
      <Box px={20} pb={20} pt={4}>
        {children}
      </Box>
    </Box>
  );
}
