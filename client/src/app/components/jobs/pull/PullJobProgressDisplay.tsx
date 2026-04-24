import { getTerminalTableStatus } from '@/app/components/jobs/job-utils';
import { TableStatus } from '@/app/components/jobs/publish/PublishJobProgress';
import {
  FolderError,
  PullProgress,
  isPullFilesProgress,
  isPullLinkedFolderFilesProgress,
} from '@/app/components/jobs/pull/PullJobProgress';
import { SyncStatus } from '@/app/components/jobs/SyncStatus/sync-status';
import { Text13Regular } from '@/app/components/base/text';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { JobEntity } from '@/types/server-entities/job';
import { Alert, Stack } from '@mantine/core';
import { Service } from '@spinner/shared-types';
import { AlertCircle } from 'lucide-react';
import { FC } from 'react';

type Props = {
  job?: JobEntity<PullProgress>;
};

export const PullJobProgressDisplay: FC<Props> = (props) => {
  const { job } = props;
  const { metadata } = useConnectorsMetadata();

  if (!job || !job.publicProgress) {
    return null;
  }

  const { publicProgress, state, failedReason } = job;

  // Handle pull linked folder files progress (single folder)
  if (isPullLinkedFolderFilesProgress(publicProgress)) {
    const folderErrors = publicProgress.folderErrors ? Object.entries(publicProgress.folderErrors) : [];

    return (
      <Stack gap="xl">
        <Stack gap="md">
          <SyncStatus
            tableName={publicProgress.folderName}
            connector={publicProgress.connector}
            doneCount={publicProgress.totalFiles}
            status={getTerminalTableStatus(publicProgress.status as TableStatus, state)}
            direction="left"
          />

          {publicProgress.hasDirtyDiscoveredDeletes && (
            <Alert icon={<AlertCircle size={16} />} color="yellow" p="xs">
              Files with unpublished scratch changes were deleted from{' '}
              {getServiceName(metadata, publicProgress.connector as Service)}
            </Alert>
          )}
        </Stack>

        {folderErrors.map(([folderId, folderError]: [string, FolderError]) => (
          <Stack key={folderId} gap="xs">
            <SyncStatus
              tableName={folderError.folderName}
              connector={publicProgress.connector}
              doneCount={0}
              status="failed"
              direction="left"
            />
            <Alert icon={<AlertCircle size={16} />} color="red" p="xs">
              <Text13Regular>{folderError.message}</Text13Regular>
              {folderError.details && (
                <Text13Regular c="dimmed" mt={4}>
                  {folderError.details}
                </Text13Regular>
              )}
            </Alert>
          </Stack>
        ))}

        {failedReason && folderErrors.length === 0 && (
          <Alert icon={<AlertCircle size={16} />} title="Pull Failed" color="red" mt="md">
            {failedReason}
          </Alert>
        )}
      </Stack>
    );
  }

  // Handle pull files progress (folders)
  if (isPullFilesProgress(publicProgress)) {
    return (
      <Stack gap="xl">
        {publicProgress.folders.map((folder) => (
          <Stack key={folder.id} gap="md">
            <SyncStatus
              tableName={folder.name}
              connector={folder.connector}
              doneCount={folder.files}
              status={getTerminalTableStatus(folder.status as TableStatus, state)}
              direction="left"
            />

            {folder.hasDirtyDiscoveredDeletes && (
              <Alert icon={<AlertCircle size={16} />} color="yellow" p="xs">
                Files with unpublished scratch changes were deleted from{' '}
                {getServiceName(metadata, folder.connector as Service)}
              </Alert>
            )}
          </Stack>
        ))}
        {failedReason && (
          <Alert icon={<AlertCircle size={16} />} title="Pull Failed" color="red" mt="md">
            {failedReason}
          </Alert>
        )}
      </Stack>
    );
  }

  // Handle pull records progress (tables) - original behavior
  return (
    <Stack gap="xl">
      {publicProgress.tables.map((table) => (
        <Stack key={table.id} gap="md">
          <SyncStatus
            tableName={table.name}
            connector={table.connector}
            doneCount={table.records}
            status={getTerminalTableStatus(table.status as TableStatus, state)}
            direction="left"
          />

          {table.hasDirtyDiscoveredDeletes && (
            <Alert icon={<AlertCircle size={16} />} color="yellow" p="xs">
              Records with unpublished scratch changes were deleted from{' '}
              {getServiceName(metadata, table.connector as Service)}
            </Alert>
          )}
        </Stack>
      ))}
      {failedReason && (
        <Alert icon={<AlertCircle size={16} />} title="Pull Failed" color="red" mt="md">
          {failedReason}
        </Alert>
      )}
    </Stack>
  );
};
