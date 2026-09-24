import { Group, Loader, Stack } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Check, ChevronDown, CloudDownload, Download, ExternalLink, TriangleAlert } from 'lucide-react';
import { ButtonSecondaryGhost } from '../buttons';
import { StatusChip } from '../status-chip';

const meta: Meta<typeof StatusChip> = {
  title: 'Base/StatusChip',
  component: StatusChip,
};
export default meta;

type Story = StoryObj<typeof StatusChip>;

export const Default: Story = {
  args: { children: 'Pulling… 1/3', icon: <Loader size={12} color="currentColor" /> },
};

export const Tones: Story = {
  render: () => (
    <Group gap="xs">
      <StatusChip icon={<Loader size={12} color="currentColor" />}>Pulling… 1/3</StatusChip>
      <StatusChip tone="info">1 to review</StatusChip>
      <StatusChip tone="success" icon={<Check size={12} />}>
        Pull complete
      </StatusChip>
      <StatusChip tone="error" icon={<TriangleAlert size={12} />}>
        Pull failed
      </StatusChip>
    </Group>
  ),
};

/**
 * The reason the chip exists: in the workspace header a status chip sits inches away from
 * real actions, and a user reported clicking the wrong one. Status must not look like a
 * button — and while a pull runs, the actions it blocks must not sprout their own spinner.
 */
export const InWorkspaceToolbar: Story = {
  render: () => (
    <Stack gap="lg">
      <Group gap="xs" style={{ borderBottom: '1px solid var(--fg-divider)', height: 40 }}>
        <StatusChip icon={<Loader size={12} color="currentColor" />} tooltip="Show pull progress" onClick={() => {}}>
          Pulling… 1/3
        </StatusChip>
        <ButtonSecondaryGhost size="compact-xs" leftSection={<ExternalLink size={12} />}>
          Open in...
        </ButtonSecondaryGhost>
        <ButtonSecondaryGhost size="compact-xs" leftSection={<Download size={12} />} disabled>
          Re-download files
        </ButtonSecondaryGhost>
        <ButtonSecondaryGhost
          size="compact-xs"
          leftSection={<CloudDownload size={12} />}
          rightSection={<ChevronDown size={12} />}
          disabled
        >
          Pull all
        </ButtonSecondaryGhost>
        <StatusChip tone="info">1 to review</StatusChip>
      </Group>

      <Group gap="xs" style={{ borderBottom: '1px solid var(--fg-divider)', height: 40 }}>
        <StatusChip tone="success" icon={<Check size={12} />} tooltip="Show pull progress" onClick={() => {}}>
          Pull complete
        </StatusChip>
        <ButtonSecondaryGhost size="compact-xs" leftSection={<ExternalLink size={12} />}>
          Open in...
        </ButtonSecondaryGhost>
        <ButtonSecondaryGhost size="compact-xs" leftSection={<Download size={12} />}>
          Re-download files
        </ButtonSecondaryGhost>
        <ButtonSecondaryGhost
          size="compact-xs"
          leftSection={<CloudDownload size={12} />}
          rightSection={<ChevronDown size={12} />}
        >
          Pull all
        </ButtonSecondaryGhost>
        <StatusChip tone="info">1 to review</StatusChip>
      </Group>
    </Stack>
  ),
};
