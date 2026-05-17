'use client';

import { Text12Medium, Text12Regular } from '@/app/components/base/text';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useSchedules } from '@/hooks/use-schedules';
import { useSyncStore } from '@/stores/sync-store';
import { timeAgo } from '@/utils/helpers';
import { RouteUrls } from '@/utils/route-urls';
import { Box, Center, Group, Loader, Stack, Table, Text, Tooltip } from '@mantine/core';
import type { Schedule, ScheduleAction, WorkbookId } from '@spinner/shared-types';
import { AlertCircleIcon, CalendarIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { getScheduleLabel } from '../shared/SyncScheduleModal';

const getActionLabel = (action: ScheduleAction): string => {
  switch (action) {
    case 'PULL':
      return 'Full Pull (legacy)';
    case 'FULL_PULL':
      return 'Full Pull';
    case 'INCREMENTAL_PULL':
      return 'Incremental Pull';
    case 'PUBLISH':
      return 'Publish';
    case 'SYNC':
      return 'Sync';
    default:
      return action;
  }
};

const getActionColor = (action: ScheduleAction): string => {
  switch (action) {
    case 'PULL':
    case 'FULL_PULL':
      return 'var(--mantine-color-cyan-5)';
    case 'INCREMENTAL_PULL':
      return 'var(--mantine-color-blue-5)';
    case 'PUBLISH':
      return 'var(--mantine-color-green-5)';
    case 'SYNC':
      return 'var(--mantine-color-yellow-5)';
    default:
      return 'var(--mantine-color-gray-5)';
  }
};

/** Map a schedule action to the corresponding job type filter value used on the Recent runs page. */
const actionToJobType = (action: ScheduleAction): string => {
  switch (action) {
    case 'PULL':
    case 'FULL_PULL':
    case 'INCREMENTAL_PULL':
      return 'pull';
    case 'PUBLISH':
      return 'publish';
    case 'SYNC':
      return 'sync';
    default:
      return '';
  }
};

export function ScheduledRunsView() {
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const { schedules, isLoading, error } = useSchedules(workbookId);
  const syncs = useSyncStore((state) => state.syncs);
  const fetchSyncs = useSyncStore((state) => state.fetchSyncs);
  const { folders } = useDataFolders();

  useEffect(() => {
    if (syncs.length === 0) {
      fetchSyncs(workbookId);
    }
  }, [workbookId, syncs.length, fetchSyncs]);

  if (isLoading) {
    return (
      <Center h="100%">
        <Group gap="sm">
          <Loader size="sm" />
          <Text c="dimmed">Loading schedules...</Text>
        </Group>
      </Center>
    );
  }

  if (error) {
    return (
      <Center h="100%">
        <Stack align="center" gap="xs">
          <AlertCircleIcon size={24} color="var(--mantine-color-red-6)" />
          <Text c="red">Failed to load schedules</Text>
        </Stack>
      </Center>
    );
  }

  if (schedules.length === 0) {
    return (
      <Center h="100%">
        <Stack align="center" gap="xs">
          <CalendarIcon size={24} color="var(--mantine-color-gray-5)" />
          <Text c="dimmed">No scheduled runs</Text>
          <Text12Regular c="dimmed">
            Schedules will appear here when you configure automated syncs or pulls
          </Text12Regular>
        </Stack>
      </Center>
    );
  }

  return (
    <Stack h="100%" gap={0}>
      <Box
        h={48}
        px="md"
        style={{
          borderBottom: '1px solid var(--fg-divider)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        <Text12Regular c="dimmed">{schedules.length} schedules</Text12Regular>
      </Box>

      <Box style={{ flex: 1, overflow: 'auto' }}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: 60 }} />
              <Table.Th style={{ width: 80 }} />
              <Table.Th />
              <Table.Th style={{ width: 120 }} />
              <Table.Th style={{ width: 100 }}>Last run</Table.Th>
              <Table.Th style={{ width: 100 }}>Next run</Table.Th>
              <Table.Th style={{ width: 100 }} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                workbookId={workbookId}
                syncs={syncs}
                folders={folders}
              />
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </Stack>
  );
}

function ScheduleRow({
  schedule,
  workbookId,
  syncs,
  folders,
}: {
  schedule: Schedule;
  workbookId: WorkbookId;
  syncs: { id: string; displayName: string }[];
  folders: { id: string; name: string; path: string | null }[];
}) {
  const entityInfo = resolveEntity(schedule, workbookId, syncs, folders);

  const recentRunsParams: Record<string, string> = {
    type: actionToJobType(schedule.action),
  };
  if (schedule.action === 'SYNC') {
    recentRunsParams.syncId = schedule.entityId;
  } else {
    recentRunsParams.dataFolderId = schedule.entityId;
  }

  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: schedule.enabled ? 'var(--mantine-color-green-6)' : 'var(--mantine-color-gray-5)',
              flexShrink: 0,
            }}
          />
          <Text
            size="sm"
            style={{ color: schedule.enabled ? 'var(--mantine-color-green-6)' : 'var(--mantine-color-gray-5)' }}
          >
            {schedule.enabled ? 'ON' : 'OFF'}
          </Text>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm" fw={600} style={{ color: getActionColor(schedule.action) }}>
          {getActionLabel(schedule.action)}
        </Text>
      </Table.Td>
      <Table.Td>
        {entityInfo.href ? (
          <Link href={entityInfo.href} style={{ color: 'inherit', textDecoration: 'underline' }}>
            <Text12Regular>{entityInfo.name}</Text12Regular>
          </Link>
        ) : (
          <Text12Regular c="dimmed">{entityInfo.name}</Text12Regular>
        )}
      </Table.Td>
      <Table.Td>
        <Text12Regular>{getScheduleLabel(schedule.cronExpression)}</Text12Regular>
      </Table.Td>
      <Table.Td>
        {schedule.lastTriggeredAt ? (
          <Tooltip
            label={new Date(schedule.lastTriggeredAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          >
            <Text12Regular c="dimmed">{timeAgo(schedule.lastTriggeredAt)}</Text12Regular>
          </Tooltip>
        ) : (
          <Text12Regular c="dimmed">Never</Text12Regular>
        )}
      </Table.Td>
      <Table.Td>
        {schedule.enabled && schedule.nextRunAt ? (
          <Tooltip
            label={new Date(schedule.nextRunAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          >
            <Text12Regular c="dimmed">{timeAgo(schedule.nextRunAt)}</Text12Regular>
          </Tooltip>
        ) : (
          <Text12Medium c="dimmed">{'\u2014'}</Text12Medium>
        )}
      </Table.Td>
      <Table.Td>
        <Link href={RouteUrls.workbookRunsPageUrl(workbookId, recentRunsParams)} style={{ textDecoration: 'none' }}>
          <Text12Regular c="var(--fg-secondary)" style={{ textDecoration: 'underline', whiteSpace: 'nowrap' }}>
            Recent runs
          </Text12Regular>
        </Link>
      </Table.Td>
    </Table.Tr>
  );
}

function resolveEntity(
  schedule: Schedule,
  workbookId: string,
  syncs: { id: string; displayName: string }[],
  folders: { id: string; name: string; path: string | null }[],
): { name: string; href: string | null } {
  if (schedule.action === 'SYNC') {
    const sync = syncs.find((s) => s.id === schedule.entityId);
    return {
      name: sync?.displayName || schedule.entityId.slice(0, 8),
      href: `/workbook/${workbookId}/syncs/${schedule.entityId}`,
    };
  }

  // PULL or PUBLISH — entity is a DataFolder
  const folder = folders.find((f) => f.id === schedule.entityId);
  if (folder?.path) {
    return {
      name: folder.name,
      href: RouteUrls.workbookFilesFileUrl(workbookId, folder.path),
    };
  }
  return {
    name: folder?.name || schedule.entityId.slice(0, 8),
    href: null,
  };
}
