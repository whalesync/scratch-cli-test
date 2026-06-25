import { Text12Book, Text13Medium, Text13Regular, TextTitle2 } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, Group, Stack } from '@mantine/core';
import { LucideIcon } from 'lucide-react';
import { ReactNode } from 'react';

interface SettingsPageHeaderProps {
  Icon: LucideIcon;
  title: string;
}

/** The icon + title header shown at the top of each Settings sub-page (Application, User, Billing). */
export function SettingsPageHeader({ Icon, title }: SettingsPageHeaderProps) {
  return (
    <Group px="md" py="sm" gap={8} style={{ borderBottom: '0.5px solid var(--fg-divider)', flexShrink: 0 }}>
      <StyledLucideIcon Icon={Icon} size="md" c="var(--fg-muted)" />
      <TextTitle2>{title}</TextTitle2>
    </Group>
  );
}

interface SettingsSectionProps {
  title: string;
  description?: string;
  hasBorder?: boolean;
  children: ReactNode;
}

/**
 * Titled section used across the Settings sub-pages — the desktop counterpart of the web client's
 * `ConfigSection`. A heading + optional description above an optionally-bordered content box.
 */
export function SettingsSection({ title, description, hasBorder = true, children }: SettingsSectionProps) {
  return (
    <Stack gap="xs">
      <Stack gap={2}>
        <Text13Medium>{title}</Text13Medium>
        {description && <Text12Book c="dimmed">{description}</Text12Book>}
      </Stack>
      <Box
        style={
          hasBorder
            ? { border: '0.5px solid var(--fg-divider)', borderRadius: 4, backgroundColor: 'var(--bg-base)' }
            : undefined
        }
      >
        {children}
      </Box>
    </Stack>
  );
}

interface SettingsInfoRowProps {
  label: string;
  children: ReactNode;
}

/** A label/value row for the read-only info sections (Application, User). */
export function SettingsInfoRow({ label, children }: SettingsInfoRowProps) {
  return (
    <Group px="12px" py="10px" justify="space-between" align="center" wrap="nowrap" gap="md">
      <Text13Regular c="var(--fg-secondary)">{label}</Text13Regular>
      {children}
    </Group>
  );
}
