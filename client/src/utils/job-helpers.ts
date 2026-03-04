import { JobEntity } from '@/types/server-entities/job';
import { PublishPlanStatus } from '@spinner/shared-types';
import pluralize from 'pluralize';

export type JobType = 'sync' | 'publish' | 'pull' | 'unknown';

export const getJobType = (type: string): JobType => {
  if (type.includes('sync')) return 'sync';
  if (type.includes('publish')) return 'publish';
  if (type.includes('pull') || type === 'refresh-records') return 'pull';
  return 'unknown';
};

export const getTypeLabel = (jobType: JobType): string => {
  switch (jobType) {
    case 'sync':
      return 'Sync';
    case 'publish':
      return 'Publish';
    case 'pull':
      return 'Pull';
    default:
      return 'JOB';
  }
};

export const publishPlanStatusBadgeColor = (status: PublishPlanStatus): string => {
  switch (status) {
    case PublishPlanStatus.Completed:
      return 'green';
    case PublishPlanStatus.CompletedWithErrors:
      return 'orange';
    case PublishPlanStatus.Failed:
      return 'red';
    case PublishPlanStatus.Canceled:
      return 'grape';
    case PublishPlanStatus.Planned:
      return 'yellow';
    case PublishPlanStatus.EditsRunning:
    case PublishPlanStatus.CreatesRunning:
    case PublishPlanStatus.DeletesRunning:
    case PublishPlanStatus.BackfillRunning:
    case PublishPlanStatus.RenameFilesRunning:
      return 'blue';
    case PublishPlanStatus.EditsCompleted:
    case PublishPlanStatus.CreatesCompleted:
    case PublishPlanStatus.DeletesCompleted:
    case PublishPlanStatus.BackfillCompleted:
      return 'teal';
    default:
      return 'gray';
  }
};

export const getJobDescription = (job: JobEntity): string => {
  const jobType = getJobType(job.type);
  const progress =
    job.publicProgress && typeof job.publicProgress === 'object'
      ? (job.publicProgress as Record<string, unknown>)
      : null;

  switch (jobType) {
    case 'sync': {
      if (progress?.tables && Array.isArray(progress.tables)) {
        const tables = progress.tables as Array<{ status?: string }>;
        const failedCount = tables.filter((t) => t.status === 'failed').length;
        const count = tables.length;
        if (failedCount > 0) {
          return `Sync failed for ${failedCount} of ${count} table${count !== 1 ? 's' : ''}`;
        }
        return `Synced ${count} table${count !== 1 ? 's' : ''}`;
      }
      if (progress?.syncName) {
        return `Sync ${progress.syncName}`;
      }
      return 'Sync';
    }
    case 'publish': {
      if (progress?.totalFiles !== undefined) {
        const count = Number(progress.totalFiles) || 0;
        return `Publish ${count} ${pluralize('change', count)}`;
      }
      return 'Publish changes';
    }
    case 'pull': {
      const fileCount = progress?.totalFiles ?? progress?.totalRequested;
      if (fileCount !== undefined) {
        const count = Number(fileCount) || 0;
        const folderCount = progress?.folderCount as number | undefined;
        const connectionName = progress?.connectionName as string | undefined;
        const connectionSuffix = connectionName ? ` in ${connectionName}` : '';
        if (folderCount && folderCount > 1) {
          return `Pull ${count} record${count !== 1 ? 's' : ''} from ${folderCount} folders${connectionSuffix}`;
        }
        const folderSuffix = progress?.folderName ? ` for ${progress.folderName}` : '';
        return `Pull ${count} record${count !== 1 ? 's' : ''}${folderSuffix}${connectionSuffix}`;
      }
      return 'Pull data';
    }
    default:
      return job.type;
  }
};
