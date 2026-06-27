// Shared chrome for the desktop app's Settings pages — the 220px nav sidebar + the content area with
// a page header. Reproduces SettingsLayout + SettingsPageHeader. Not a /design-sync card itself.
import { Box, Group, Stack } from '@mantine/core';
import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, CreditCard, Settings as SettingsIcon, SlidersHorizontal, User } from 'lucide-react';
import type { ReactNode } from 'react';
import { Text12Medium, Text13Medium, Text13Regular, TextTitle4 } from '../../text';

const NAV: { label: string; icon: LucideIcon }[] = [
  { label: 'Billing', icon: CreditCard },
  { label: 'User', icon: User },
  { label: 'Application', icon: SlidersHorizontal },
];

function NavButton({ label, icon: Icon, active }: { label: string; icon: LucideIcon; active?: boolean }) {
  const color = active ? 'var(--fg-primary)' : 'var(--fg-secondary)';
  return (
    <Group
      gap={8}
      wrap="nowrap"
      px={12}
      py={8}
      style={{ width: '100%', background: active ? 'var(--bg-selected)' : 'transparent' }}
    >
      <Icon size={15} color={color} />
      <Text13Regular c={color}>{label}</Text13Regular>
    </Group>
  );
}

export function SettingsShell({
  active,
  pageIcon: PageIcon,
  pageTitle,
  children,
}: {
  active: string;
  pageIcon: LucideIcon;
  pageTitle: string;
  children: ReactNode;
}) {
  return (
    <Group
      gap={6}
      wrap="nowrap"
      align="stretch"
      p={6}
      style={{ width: 1100, height: 700, background: 'var(--bg-panel)', overflow: 'hidden' }}
    >
      {/* sidebar */}
      <Stack
        gap={0}
        style={{
          width: 220,
          flexShrink: 0,
          background: 'var(--bg-base)',
          border: '0.5px solid var(--fg-divider)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <Group gap={8} wrap="nowrap" px={12} py={10} style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
          <ArrowLeft size={15} color="var(--fg-muted)" />
          <SettingsIcon size={15} color="var(--fg-muted)" />
          <Text13Medium c="var(--fg-primary)">Settings</Text13Medium>
        </Group>
        <Box px={12} py={6}>
          <Text12Medium c="var(--fg-muted)" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
            Settings
          </Text12Medium>
        </Box>
        {NAV.map((n) => (
          <NavButton key={n.label} label={n.label} icon={n.icon} active={n.label === active} />
        ))}
      </Stack>
      {/* content */}
      <Stack
        gap={0}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'var(--bg-base)',
          border: '0.5px solid var(--fg-divider)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <Group gap={8} wrap="nowrap" px={16} py={12} style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
          <PageIcon size={16} color="var(--fg-secondary)" />
          <TextTitle4>{pageTitle}</TextTitle4>
        </Group>
        <Box style={{ flex: 1, overflow: 'auto', padding: 16 }}>{children}</Box>
      </Stack>
    </Group>
  );
}
