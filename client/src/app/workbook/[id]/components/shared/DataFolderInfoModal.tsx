'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { Text13Medium, TextMono9Regular } from '@/app/components/base/text';
import { useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useSyncStore } from '@/stores/sync-store';
import { Badge, Group, Modal, Stack } from '@mantine/core';
import type { DataFolder } from '@spinner/shared-types';

interface DataFolderInfoModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
}

const RELATIVE_RANGES: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 3600 * 24 * 365],
  ['month', 3600 * 24 * 30],
  ['week', 3600 * 24 * 7],
  ['day', 3600 * 24],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

function relativeTime(iso: string): string {
  const formatter = new Intl.RelativeTimeFormat('en', { style: 'long' });
  const secondsElapsed = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, seconds] of RELATIVE_RANGES) {
    if (seconds < Math.abs(secondsElapsed)) {
      return formatter.format(Math.round(secondsElapsed / seconds), unit);
    }
  }
  return 'just now';
}

export function DataFolderInfoModal({ opened, onClose, folder }: DataFolderInfoModalProps) {
  const { metadata } = useConnectorsMetadata();
  const supportsIncrementalPull = folder.connectorService
    ? Boolean(metadata?.[folder.connectorService]?.incrementalPull)
    : false;

  const syncs = useSyncStore((state) => state.syncs);
  const syncCount = syncs.filter((sync) =>
    sync.syncTablePairs.some(
      (pair) => pair.sourceDataFolderId === folder.id || pair.destinationDataFolderId === folder.id,
    ),
  ).length;

  const rows: { label: string; iso: string | null; relative: boolean }[] = [
    { label: 'Created', iso: folder.createdAt, relative: false },
    { label: 'Last full pull', iso: folder.lastFullPullAt, relative: true },
  ];
  if (supportsIncrementalPull) {
    rows.push({ label: 'Last incremental pull', iso: folder.lastIncrementalPullAt, relative: true });
  }

  const showAssetBadge = folder.isAssetTable;
  const showLockBadge = Boolean(folder.lock);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap={8} wrap="nowrap" align="center">
          {folder.connectorService && <ConnectorIcon connector={folder.connectorService} size={20} p={0} />}
          <Text13Medium c="var(--fg-primary)">{folder.name}</Text13Medium>
        </Group>
      }
      size="md"
      centered
    >
      <Stack gap="xs">
        {rows.map(({ label, iso, relative }) => (
          <Stack key={label} gap={2}>
            <Text13Medium c="var(--fg-secondary)">{label}</Text13Medium>
            {iso ? (
              <Group gap={6} align="baseline">
                <TextMono9Regular c="var(--fg-primary)">
                  {relative ? relativeTime(iso) : new Date(iso).toLocaleString()}
                </TextMono9Regular>
                {relative && (
                  <TextMono9Regular c="var(--fg-muted)">({new Date(iso).toLocaleString()})</TextMono9Regular>
                )}
              </Group>
            ) : (
              <TextMono9Regular c="var(--fg-muted)">Never</TextMono9Regular>
            )}
          </Stack>
        ))}

        {syncCount > 0 && (
          <Stack gap={2}>
            <Text13Medium c="var(--fg-secondary)">Syncs</Text13Medium>
            <TextMono9Regular c="var(--fg-primary)">
              Involved in {syncCount} sync{syncCount === 1 ? '' : 's'}
            </TextMono9Regular>
          </Stack>
        )}

        {(showAssetBadge || showLockBadge) && (
          <Group gap="xs" mt="xs">
            {showAssetBadge && (
              <Badge variant="light" color="blue">
                Asset table
              </Badge>
            )}
            {showLockBadge && (
              <Badge variant="light" color="orange">
                Locked: {folder.lock}
              </Badge>
            )}
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
