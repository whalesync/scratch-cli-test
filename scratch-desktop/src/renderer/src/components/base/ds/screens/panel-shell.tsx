// Shared chrome for the workspace right-rail panels (Connections / Validation / Publish History /
// Settings). All four use the same container + header pattern in the real app: a bordered surface
// with a 0.5px divider, an icon + Text16Medium title on the left, and controls on the right.
// Not a /design-sync card itself (no story / not registered) — a building block for the panels.
import { Box, Group, Stack } from '@mantine/core';
import type { ReactNode } from 'react';
import { Text16Medium } from '../../text';

export function PanelShell({
  icon,
  title,
  actions,
  children,
  width = 980,
}: {
  icon: ReactNode;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  return (
    <Stack
      gap={0}
      style={{
        width,
        height: 600,
        background: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <Group
        justify="space-between"
        align="center"
        wrap="nowrap"
        px={14}
        py={8}
        style={{ borderBottom: '0.5px solid var(--fg-divider)', flexShrink: 0, minHeight: 46 }}
      >
        <Group gap={8} align="center" wrap="nowrap">
          {icon}
          <Text16Medium c="var(--fg-primary)">{title}</Text16Medium>
        </Group>
        {actions}
      </Group>
      <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</Box>
    </Stack>
  );
}
