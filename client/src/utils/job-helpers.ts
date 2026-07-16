import { Job, JobType as JobTypeConstant, PublishPlanStatus } from '@spinner/shared-types';
import pluralize from 'pluralize';
import { formatNumber } from './helpers';

export type JobType = 'sync' | 'publish' | 'pull' | 'rehost' | 'unknown';

export const getJobType = (type: string): JobType => {
  if (type.includes('sync')) return 'sync';
  if (type.includes('publish') || type.includes('pipeline')) return 'publish';
  if (type.includes('pull') || type === JobTypeConstant.RefreshRecords) return 'pull';
  if (type === JobTypeConstant.RehostAssets) return 'rehost';
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
    case 'rehost':
      return 'Pull Assets';
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
    case PublishPlanStatus.AssetUploadRunning:
    case PublishPlanStatus.EditsRunning:
    case PublishPlanStatus.CreatesRunning:
    case PublishPlanStatus.DeletesRunning:
    case PublishPlanStatus.BackfillRunning:
    case PublishPlanStatus.RenameFilesRunning:
      return 'blue';
    case PublishPlanStatus.AssetUploadCompleted:
    case PublishPlanStatus.EditsCompleted:
    case PublishPlanStatus.CreatesCompleted:
    case PublishPlanStatus.DeletesCompleted:
    case PublishPlanStatus.BackfillCompleted:
      return 'teal';
    default:
      return 'gray';
  }
};

export const getJobDescription = (job: Job): string => {
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
          return `Sync failed for ${formatNumber(failedCount)} of ${formatNumber(count)} table${count !== 1 ? 's' : ''}`;
        }
        return `Synced ${formatNumber(count)} table${count !== 1 ? 's' : ''}`;
      }
      if (progress?.syncName) {
        return `Sync ${progress.syncName}`;
      }
      return 'Sync';
    }
    case 'publish': {
      if (progress?.processedCount !== undefined && progress?.totalCount !== undefined) {
        const processed = Number(progress.processedCount) || 0;
        const total = Number(progress.totalCount) || 0;
        const tableCount = Number(progress.tableCount) || 0;
        const connectionName = progress.connectionName as string | undefined;
        const tableName = progress.tableName as string | undefined;
        const connectionSuffix = connectionName ? ` in ${connectionName}` : '';
        if (tableName) {
          return `Publish ${formatNumber(processed)} / ${formatNumber(total)} ${pluralize('change', total)} for ${tableName}${connectionSuffix}`;
        }
        if (tableCount > 1) {
          return `Publish ${formatNumber(processed)} / ${formatNumber(total)} ${pluralize('change', total)} across ${formatNumber(tableCount)} tables${connectionSuffix}`;
        }
        return `Publish ${formatNumber(processed)} / ${formatNumber(total)} ${pluralize('change', total)}${connectionSuffix}`;
      }
      if (progress?.totalFiles !== undefined) {
        const count = Number(progress.totalFiles) || 0;
        return `Publish ${formatNumber(count)} ${pluralize('change', count)}`;
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
          return `Pull ${formatNumber(count)} record${count !== 1 ? 's' : ''} from ${formatNumber(folderCount)} folders${connectionSuffix}`;
        }
        const folderSuffix = progress?.folderName ? ` for ${progress.folderName}` : '';
        return `Pull ${formatNumber(count)} record${count !== 1 ? 's' : ''}${folderSuffix}${connectionSuffix}`;
      }
      return 'Pull data';
    }
    case 'rehost': {
      const totalAssets = progress?.totalAssets as number | undefined;
      const failedAssets = progress?.failed as number | undefined;
      const folderName = progress?.dataFolderName as string | undefined;
      const folderSuffix = folderName ? ` for ${folderName}` : '';
      const failedSuffix = failedAssets ? ` (${formatNumber(failedAssets)} failed)` : '';
      if (totalAssets !== undefined) {
        return `Pull ${formatNumber(totalAssets)} asset${totalAssets !== 1 ? 's' : ''}${folderSuffix}${failedSuffix}`;
      }
      return `Pull assets${folderSuffix}${failedSuffix}`;
    }
    default:
      return job.type;
  }
};
