// Faithful reproduction of the desktop app's "Create Connection" modal — the connector picker grid +
// name + API-key field. Self-contained; no IPC. From the real create-connection-modal source
// (DEV-10592). Connector logos are stand-in colored tiles (the app uses ConnectorIcon).
import { Box, Group, PasswordInput, SimpleGrid, Stack, TextInput, UnstyledButton } from '@mantine/core';
import { Check } from 'lucide-react';
import { ButtonPrimaryLight, ButtonSecondaryOutline } from '../../buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '../../text';
import { ModalShell } from './modal-shell';

const CONNECTORS = [
  { name: 'Airtable', color: '#FCB400', initial: 'A' },
  { name: 'Webflow', color: '#146EF5', initial: 'W', selected: true },
  { name: 'Notion', color: '#000000', initial: 'N' },
  { name: 'HubSpot', color: '#FF7A59', initial: 'H' },
  { name: 'Pipedrive', color: '#1A1A1A', initial: 'P' },
  { name: 'Google Sheets', color: '#0F9D58', initial: 'G' },
  { name: 'Attio', color: '#5B5BD6', initial: 'A' },
  { name: 'Affinity', color: '#1862FF', initial: 'A' },
  { name: 'Intercom', color: '#1F8DED', initial: 'I' },
];

function ConnectorTile({
  name,
  color,
  initial,
  selected,
}: {
  name: string;
  color: string;
  initial: string;
  selected?: boolean;
}) {
  return (
    <UnstyledButton
      style={{
        border: `0.5px solid ${selected ? 'var(--mantine-color-teal-4)' : 'var(--fg-divider)'}`,
        padding: '6px 8px',
        background: selected ? 'var(--mantine-color-teal-0)' : 'transparent',
        borderRadius: 6,
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap={8} wrap="nowrap">
          <Box
            style={{
              width: 20,
              height: 20,
              borderRadius: 4,
              background: color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
            }}
          >
            <Text12Regular c="#fff">{initial}</Text12Regular>
          </Box>
          <Text13Medium c="var(--fg-primary)">{name}</Text13Medium>
        </Group>
        {selected && <Check size={12} color="var(--mantine-color-teal-6)" />}
      </Group>
    </UnstyledButton>
  );
}

export function CreateConnectionModal() {
  return (
    <ModalShell title="Create Connection" width={600}>
      <Stack gap={12}>
        <Group justify="space-between" align="baseline">
          <Text13Medium c="var(--fg-primary)">App</Text13Medium>
          <Text12Regular c="var(--fg-muted)">Not finding your App? Bring your own API</Text12Regular>
        </Group>
        <SimpleGrid cols={3} spacing={8}>
          {CONNECTORS.map((c) => (
            <ConnectorTile key={c.name} {...c} />
          ))}
        </SimpleGrid>
        <TextInput label="Name" placeholder="Enter a name for your connection" defaultValue="My Webflow" />
        <Box>
          <Text13Regular c="var(--fg-primary)" style={{ marginBottom: 4 }}>
            Authentication Method
          </Text13Regular>
          <PasswordInput label="API Key" placeholder="Enter your Webflow API key" />
        </Box>
        <Group justify="flex-end" gap={10} mt={4}>
          <ButtonSecondaryOutline>Cancel</ButtonSecondaryOutline>
          <ButtonPrimaryLight>Create</ButtonPrimaryLight>
        </Group>
      </Stack>
    </ModalShell>
  );
}
