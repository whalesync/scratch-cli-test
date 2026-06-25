import { Text16Medium } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, Group, Stack } from '@mantine/core';
import { SettingsIcon } from 'lucide-react';
import { AutoDownloadSettings } from './settings/auto-download-settings';
import { WorkspacePermissionsSettings } from './settings/workspace-permissions-settings';

interface SettingsPanelProps {
  workbookId: string;
}

export function SettingsPanel({ workbookId }: SettingsPanelProps) {
  return (
    <Stack
      gap={0}
      style={{
        flex: 1,
        minWidth: 0,
        backgroundColor: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Group
        style={{
          borderBottom: '0.5px solid var(--fg-divider)',
          flexShrink: 0,
        }}
        px={14}
        py={8}
        align="center"
        justify="space-between"
      >
        <Group gap={8} align="center">
          <StyledLucideIcon Icon={SettingsIcon} size={16} c="var(--fg-secondary)" />
          <Text16Medium c="var(--fg-primary)">Workspace Settings</Text16Medium>
        </Group>
      </Group>

      {/* Content — one self-contained section per workspace-level settings area. */}
      <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }} py="sm">
        <Stack gap="xl">
          <AutoDownloadSettings workbookId={workbookId} />
          <WorkspacePermissionsSettings workbookId={workbookId} />
          {/* Additional workspace settings sections go here. */}
        </Stack>
      </Box>
    </Stack>
  );
}
