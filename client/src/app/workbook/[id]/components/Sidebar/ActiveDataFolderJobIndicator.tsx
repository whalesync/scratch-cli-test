'use client';

import { SpinningIcon } from '@/app/components/Icons/SpinningIcon';
import { Text12Regular } from '@/app/components/base/text';
import { SyncDataFoldersPublicProgress } from '@/app/components/jobs/SyncStatus/SyncJobProgress';
import { PublishRecordsPublicProgress } from '@/app/components/jobs/publish/PublishJobProgress';
import { PullLinkedFolderFilesProgress } from '@/app/components/jobs/pull/PullJobProgress';
import { useWorkbookActiveJobs } from '@/hooks/use-workbook-active-jobs';
import { Box, Group, HoverCard, Stack } from '@mantine/core';
import { DataFolder } from '@spinner/shared-types';
import { RefreshCwIcon } from 'lucide-react';

interface ActiveDataFolderJobIndicatorProps {
  folder: DataFolder;
}

export function ActiveDataFolderJobIndicator({ folder }: ActiveDataFolderJobIndicatorProps) {
  const { getJobsForDataFolder, isLoading } = useWorkbookActiveJobs(folder.workbookId);
  const folderJobs = getJobsForDataFolder(folder.id);

  if (folderJobs.length === 0 || isLoading) return null;

  const job = folderJobs[0];

  if (!job.publicProgress) return null;

  let cardContent: React.ReactNode = (
    <Group gap={8} wrap="nowrap">
      <Text12Regular c="var(--fg-secondary)">{job.type}</Text12Regular>
    </Group>
  );

  // TODO: make these constants in shared types
  if (job.type === 'pull-linked-folder-files') {
    const progress = job.publicProgress as PullLinkedFolderFilesProgress;
    // extract out the
    cardContent = (
      <Stack gap={8}>
        <Text12Regular>Pulling files from {folder.connectorDisplayName}</Text12Regular>
        <Text12Regular c="var(--fg-secondary)">{progress.totalFiles} files</Text12Regular>
      </Stack>
    );
  } else if (job.type === 'sync-data-folders') {
    const progress = job.publicProgress as SyncDataFoldersPublicProgress;
    const tableProgress = progress.tables.find((t) => t.id === folder.id);
    cardContent = (
      <Stack gap={8}>
        <Text12Regular>Syncing</Text12Regular>
        <Text12Regular c="var(--fg-secondary)">{progress.totalFilesSynced} files</Text12Regular>
        {tableProgress && (
          <>
            <Text12Regular c="var(--fg-secondary)">{tableProgress.status}</Text12Regular>
            <Text12Regular c="var(--fg-secondary)">{tableProgress.creates} creates</Text12Regular>
            <Text12Regular c="var(--fg-secondary)">{tableProgress.updates} updates</Text12Regular>
            <Text12Regular c="var(--fg-secondary)">{tableProgress.deletes} deletes</Text12Regular>
          </>
        )}
      </Stack>
    );
  } else if (job.type === 'refresh-records') {
    const progress = job.publicProgress as { totalRequested?: number; updatedPaths?: string[] };
    const updated = progress.updatedPaths?.length ?? 0;
    cardContent = (
      <Stack gap={8}>
        <Text12Regular>Pulling files from {folder.connectorDisplayName}</Text12Regular>
        <Text12Regular c="var(--fg-secondary)">
          {updated} / {progress.totalRequested ?? 0} files
        </Text12Regular>
      </Stack>
    );
  } else if (job.type === 'publish-data-folder') {
    const progress = job.publicProgress as PublishRecordsPublicProgress;
    const tableProgress = progress.tables.find((t) => t.id === folder.id);
    cardContent = (
      <Stack gap={8}>
        <Text12Regular>Pushing changes to {folder.connectorDisplayName}</Text12Regular>
        <Text12Regular c="var(--fg-secondary)">{progress.totalRecordsPublished} files</Text12Regular>
        {tableProgress && (
          <>
            <Text12Regular c="var(--fg-secondary)">{tableProgress.status}</Text12Regular>
            <Text12Regular c="var(--fg-secondary)">{tableProgress.creates} creates</Text12Regular>
            <Text12Regular c="var(--fg-secondary)">{tableProgress.updates} updates</Text12Regular>
            <Text12Regular c="var(--fg-secondary)">{tableProgress.deletes} deletes</Text12Regular>
          </>
        )}
      </Stack>
    );
  }

  return (
    <HoverCard position="right" withArrow shadow="md" withinPortal openDelay={200} closeDelay={100}>
      <HoverCard.Target>
        <Box onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
          <SpinningIcon Icon={RefreshCwIcon} size={12} c="var(--mantine-color-blue-6)" />
        </Box>
      </HoverCard.Target>
      <HoverCard.Dropdown p="xs">{cardContent}</HoverCard.Dropdown>
    </HoverCard>
  );
}
