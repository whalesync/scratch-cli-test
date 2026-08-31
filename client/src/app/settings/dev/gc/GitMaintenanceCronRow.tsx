'use client';

import { useGitMaintenance } from '@/hooks/use-git-maintenance';
import { Badge, Button, Code, Group, Stack, Switch, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ExternalLinkIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * The one-line entry for scratch-git's background GC on the Cron Jobs page, shaped like the
 * server cron rows: name + description, schedule, last run, action. The action here is the
 * on/off switch (persisted by scratch-git) and a link to the full page at `/settings/dev/gc`.
 * It is not a server cron — it runs inside scratch-git — which the description says.
 */
export function GitMaintenanceCronRow() {
  const { config, status, error, setEnabled } = useGitMaintenance({ includeTables: false });
  const [isSaving, setIsSaving] = useState(false);

  const handleToggle = async (enabled: boolean) => {
    setIsSaving(true);
    try {
      const updated = await setEnabled(enabled);
      notifications.show({
        title: updated.enabled ? 'Background GC enabled' : 'Background GC disabled',
        message: updated.enabled
          ? 'scratch-git will GC repos from its own loop; after-job GC calls are now no-ops.'
          : 'After-job GC calls run git gc again, as before.',
        color: updated.enabled ? 'green' : 'gray',
      });
    } catch (e) {
      notifications.show({ title: 'Error', message: `Failed to update the switch: ${String(e)}`, color: 'red' });
    } finally {
      setIsSaving(false);
    }
  };

  const lastTick = status?.lastTick ?? null;

  return (
    <Table.Tr>
      <Table.Td>
        <Stack gap={2}>
          <Code>git-maintenance (scratch-git)</Code>
          <Text size="xs" c="dimmed">
            Background repo GC inside scratch-git: quick pack step ≤ 1/h, full <Code>git gc</Code> ≤ 1/day. Not a server
            cron — the switch below controls it.
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Badge variant="light" color="gray">
          EVERY_MINUTE
        </Badge>
      </Table.Td>
      <Table.Td>
        {error ? (
          <Text size="xs" c="red">
            scratch-git unreachable
          </Text>
        ) : lastTick ? (
          <Text size="xs" c={lastTick.aborted ? 'red' : 'green'}>
            {new Date(lastTick.startedAtMs).toLocaleTimeString()} · {lastTick.reposScanned} repos · ran{' '}
            {lastTick.ran.length}
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Group gap="sm" wrap="nowrap">
          <Switch
            size="sm"
            checked={config?.enabled ?? false}
            disabled={isSaving || !!error || !config}
            onChange={(event) => void handleToggle(event.currentTarget.checked)}
            label={config?.enabled ? 'On' : 'Off'}
          />
          <Button
            size="xs"
            variant="default"
            component={Link}
            href="/settings/dev/gc"
            leftSection={<ExternalLinkIcon size={14} />}
          >
            Open
          </Button>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}
