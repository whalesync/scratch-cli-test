import { Checkbox, Select, Stack, Switch, TextInput, Textarea } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';

// Inputs, checkbox, and switch are stock Mantine components — their look comes entirely from the
// Scratch theme (square corners, neutral border, yellow focus ring, yellow checked/on state).
const meta: Meta = {
  title: 'Components/Inputs',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const TextFields: Story = {
  render: () => (
    <Stack gap="md" maw={360}>
      <TextInput label="Workspace name" defaultValue="Marketing site" />
      <TextInput label="API base URL" placeholder="https://api.example.com" />
      <Textarea
        label="Notes"
        autosize
        minRows={3}
        defaultValue="Records are stored as the verbatim response from the external service."
      />
      <Select label="Connection" data={['Airtable', 'Webflow', 'Notion']} defaultValue="Airtable" />
    </Stack>
  ),
};

export const Checkboxes: Story = {
  render: () => (
    <Stack gap="sm">
      <Checkbox label="Include schema files in publish" defaultChecked />
      <Checkbox label="Overwrite read-only fields" />
    </Stack>
  ),
};

export const Switches: Story = {
  render: () => (
    <Stack gap="sm">
      <Switch label="Auto re-download daily" defaultChecked />
      <Switch label="Sync the entire connection" />
    </Stack>
  ),
};
