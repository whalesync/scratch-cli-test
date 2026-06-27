// Faithful reproduction of the desktop app's "Choose tables" modal — step 1 of the connection table
// picker: a checkbox list of the connector's available tables. Self-contained; no IPC. From the real
// choose-tables-modal source (DEV-10592).
import { Box, Checkbox, Group, Stack } from '@mantine/core';
import { ButtonPrimaryLight, ButtonSecondaryInline, ButtonSecondaryOutline } from '../../buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '../../text';
import { ModalShell } from './modal-shell';

const TABLES = [
  { name: 'Blog Posts (Demo)', checked: true },
  { name: 'Recipes', checked: true },
  { name: 'Mackerels', checked: true },
  { name: 'Menu Items', checked: false },
  { name: 'Assets', checked: false },
];

export function ChooseTablesModal() {
  return (
    <ModalShell title="QA Webflow" width={600}>
      <Stack gap={16}>
        <Group justify="space-between" align="center">
          <Text13Regular c="var(--fg-muted)">
            Pick the tables from QA Webflow to make available in Scratch.
          </Text13Regular>
          <Group gap={12} align="center">
            <ButtonSecondaryInline>Select all</ButtonSecondaryInline>
            <Text12Regular c="var(--fg-muted)">Step 1 of 2</Text12Regular>
          </Group>
        </Group>
        <Box px={4} py={8} style={{ border: '0.5px solid var(--fg-divider)', borderRadius: 6 }}>
          <Box px={10} pb={6} pt={2}>
            <Text13Medium c="var(--fg-primary)">Collections</Text13Medium>
          </Box>
          <Stack gap={8} px={14}>
            {TABLES.map((t) => (
              <Checkbox key={t.name} label={t.name} defaultChecked={t.checked} />
            ))}
          </Stack>
        </Box>
        <Group justify="flex-end" gap={10}>
          <ButtonSecondaryOutline>Cancel</ButtonSecondaryOutline>
          <ButtonPrimaryLight>Next</ButtonPrimaryLight>
        </Group>
      </Stack>
    </ModalShell>
  );
}
