import { Group, Stack } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';
import {
  ButtonCompactDanger,
  ButtonCompactPrimary,
  ButtonCompactSecondary,
  ButtonDangerLight,
  ButtonPrimaryLight,
  ButtonPrimarySolid,
  ButtonSecondaryGhost,
  ButtonSecondaryInline,
  ButtonSecondaryOutline,
  ButtonSecondarySolid,
  ButtonWithDescription,
  DevToolButton,
  DevToolButtonGhost,
  IconButtonGhost,
  IconButtonOutline,
  IconButtonToolbar,
} from './buttons';

const meta: Meta = {
  title: 'Components/Buttons',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const Primary: Story = {
  render: () => (
    <Group>
      <ButtonPrimarySolid>Publish changes</ButtonPrimarySolid>
      <ButtonPrimaryLight>Publish changes</ButtonPrimaryLight>
    </Group>
  ),
};

export const Secondary: Story = {
  render: () => (
    <Group>
      <ButtonSecondarySolid>Accept all</ButtonSecondarySolid>
      <ButtonSecondaryOutline>Connect a service</ButtonSecondaryOutline>
      <ButtonSecondaryGhost>Cancel</ButtonSecondaryGhost>
      <ButtonSecondaryInline>Edit</ButtonSecondaryInline>
    </Group>
  ),
};

export const Danger: Story = {
  render: () => <ButtonDangerLight>Discard edits</ButtonDangerLight>,
};

export const IconButtons: Story = {
  render: () => (
    <Group>
      <IconButtonOutline>
        <Plus size={16} />
      </IconButtonOutline>
      <IconButtonGhost>
        <Plus size={16} />
      </IconButtonGhost>
      <IconButtonToolbar>
        <Plus size={14} />
      </IconButtonToolbar>
    </Group>
  ),
};

export const Compact: Story = {
  render: () => (
    <Group>
      <ButtonCompactPrimary>Pull</ButtonCompactPrimary>
      <ButtonCompactSecondary>Reset</ButtonCompactSecondary>
      <ButtonCompactDanger>Remove</ButtonCompactDanger>
    </Group>
  ),
};

export const DevTool: Story = {
  render: () => (
    <Group>
      <DevToolButton>Re-index workbook</DevToolButton>
      <DevToolButtonGhost>Dump state</DevToolButtonGhost>
    </Group>
  ),
};

export const WithDescription: Story = {
  render: () => (
    <ButtonWithDescription
      title="Connect a service"
      description="Pull a service's records into this workspace and keep them in sync."
    />
  ),
};

export const AllVariants: Story = {
  render: () => (
    <Stack gap="lg" align="flex-start">
      <Group>
        <ButtonPrimarySolid>Primary solid</ButtonPrimarySolid>
        <ButtonPrimaryLight>Primary light</ButtonPrimaryLight>
      </Group>
      <Group>
        <ButtonSecondarySolid>Secondary solid</ButtonSecondarySolid>
        <ButtonSecondaryOutline>Secondary outline</ButtonSecondaryOutline>
        <ButtonSecondaryGhost>Secondary ghost</ButtonSecondaryGhost>
      </Group>
      <Group>
        <ButtonDangerLight>Danger</ButtonDangerLight>
        <DevToolButton>Dev tool</DevToolButton>
      </Group>
      <Group>
        <ButtonCompactPrimary>Compact primary</ButtonCompactPrimary>
        <ButtonCompactSecondary>Compact secondary</ButtonCompactSecondary>
        <ButtonCompactDanger>Compact danger</ButtonCompactDanger>
      </Group>
    </Stack>
  ),
};
