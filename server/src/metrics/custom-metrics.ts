import { assertUnreachable } from 'src/utils/asserts';
import { CustomMetricDimension, CustomMetricUnit } from './types';

/**
 * The list of metrics we collect manually.
 */
export enum CustomMetric {
  API_REQUEST = 'api_request',
  API_RATE_LIMIT_EXCEEDED = 'api_rate_limit_exceeded',

  // BullMQ job metrics — completed
  JOB_PULL_LINKED_FOLDER_FILES_COMPLETED = 'job_pull_linked_folder_files_completed',
  JOB_REFRESH_RECORDS_COMPLETED = 'job_refresh_records_completed',
  JOB_SYNC_DATA_FOLDERS_COMPLETED = 'job_sync_data_folders_completed',
  JOB_REHOST_ASSETS_COMPLETED = 'job_rehost_assets_completed',
  JOB_APPLY_PATCHES_COMPLETED = 'job_apply_patches_completed',
  JOB_PUBLISH_COMPLETED = 'job_publish_completed',
  JOB_DELETE_WORKBOOK_COMPLETED = 'job_delete_workbook_completed',
  JOB_DISCARD_PENDING_CHANGES_COMPLETED = 'job_discard_pending_changes_completed',

  // BullMQ job metrics — failed
  JOB_PULL_LINKED_FOLDER_FILES_FAILED = 'job_pull_linked_folder_files_failed',
  JOB_REFRESH_RECORDS_FAILED = 'job_refresh_records_failed',
  JOB_SYNC_DATA_FOLDERS_FAILED = 'job_sync_data_folders_failed',
  JOB_REHOST_ASSETS_FAILED = 'job_rehost_assets_failed',
  JOB_APPLY_PATCHES_FAILED = 'job_apply_patches_failed',
  JOB_PUBLISH_FAILED = 'job_publish_failed',
  JOB_DELETE_WORKBOOK_FAILED = 'job_delete_workbook_failed',
  JOB_DISCARD_PENDING_CHANGES_FAILED = 'job_discard_pending_changes_failed',

  // BullMQ job metrics — error (worker-level errors)
  JOB_WORKER_ERROR = 'job_worker_error',

  // BullMQ job metrics — canceled
  JOB_PULL_LINKED_FOLDER_FILES_CANCELED = 'job_pull_linked_folder_files_canceled',
  JOB_REFRESH_RECORDS_CANCELED = 'job_refresh_records_canceled',
  JOB_SYNC_DATA_FOLDERS_CANCELED = 'job_sync_data_folders_canceled',
  JOB_REHOST_ASSETS_CANCELED = 'job_rehost_assets_canceled',
  JOB_APPLY_PATCHES_CANCELED = 'job_apply_patches_canceled',
  JOB_PUBLISH_CANCELED = 'job_publish_canceled',
  JOB_DELETE_WORKBOOK_CANCELED = 'job_delete_workbook_canceled',
  JOB_DISCARD_PENDING_CHANGES_CANCELED = 'job_discard_pending_changes_canceled',

  // BullMQ job metrics — stalled
  JOB_PULL_LINKED_FOLDER_FILES_STALLED = 'job_pull_linked_folder_files_stalled',
  JOB_REFRESH_RECORDS_STALLED = 'job_refresh_records_stalled',
  JOB_SYNC_DATA_FOLDERS_STALLED = 'job_sync_data_folders_stalled',
  JOB_REHOST_ASSETS_STALLED = 'job_rehost_assets_stalled',
  JOB_APPLY_PATCHES_STALLED = 'job_apply_patches_stalled',
  JOB_PUBLISH_STALLED = 'job_publish_stalled',
  JOB_DELETE_WORKBOOK_STALLED = 'job_delete_workbook_stalled',
  JOB_DISCARD_PENDING_CHANGES_STALLED = 'job_discard_pending_changes_stalled',

  // Sync — unmatched-destination (Pass 3) accounting. Summed across all table
  // mappings within one sync run.
  SYNC_UNMATCHED_WITH_KEY_COUNT = 'sync_unmatched_with_key_count',
  SYNC_UNMATCHED_WITHOUT_KEY_COUNT = 'sync_unmatched_without_key_count',
  SYNC_ARCHIVE_WRITES_TOTAL = 'sync_archive_writes_total',

  // Sync-mapping v2 backfill (DEV-10008). `v1_remaining` is a gauge of syncs
  // still on the frozen v1 column (mappingsV2 IS NULL) — the explicit signal
  // for the Phase 4 drop of the v1 column once it holds at 0. `v2_transformed`
  // counts rows migrated per backfill batch.
  BACKFILL_SYNC_MAPPING_V1_REMAINING = 'backfill_sync_mapping_v1_remaining',
  BACKFILL_SYNC_MAPPING_V2_TRANSFORMED_TOTAL = 'backfill_sync_mapping_v2_transformed_total',
}

export function expectedDimensionForMetric(metric: CustomMetric): CustomMetricDimension {
  switch (metric) {
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_COMPLETED:
    case CustomMetric.JOB_REFRESH_RECORDS_COMPLETED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_COMPLETED:
    case CustomMetric.JOB_REHOST_ASSETS_COMPLETED:
    case CustomMetric.JOB_APPLY_PATCHES_COMPLETED:
    case CustomMetric.JOB_PUBLISH_COMPLETED:
    case CustomMetric.JOB_DELETE_WORKBOOK_COMPLETED:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_FAILED:
    case CustomMetric.JOB_REFRESH_RECORDS_FAILED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_FAILED:
    case CustomMetric.JOB_REHOST_ASSETS_FAILED:
    case CustomMetric.JOB_APPLY_PATCHES_FAILED:
    case CustomMetric.JOB_PUBLISH_FAILED:
    case CustomMetric.JOB_DELETE_WORKBOOK_FAILED:
    case CustomMetric.JOB_WORKER_ERROR:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_CANCELED:
    case CustomMetric.JOB_REFRESH_RECORDS_CANCELED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_CANCELED:
    case CustomMetric.JOB_REHOST_ASSETS_CANCELED:
    case CustomMetric.JOB_APPLY_PATCHES_CANCELED:
    case CustomMetric.JOB_PUBLISH_CANCELED:
    case CustomMetric.JOB_DELETE_WORKBOOK_CANCELED:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_STALLED:
    case CustomMetric.JOB_REFRESH_RECORDS_STALLED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_STALLED:
    case CustomMetric.JOB_REHOST_ASSETS_STALLED:
    case CustomMetric.JOB_APPLY_PATCHES_STALLED:
    case CustomMetric.JOB_PUBLISH_STALLED:
    case CustomMetric.JOB_DELETE_WORKBOOK_STALLED:
    case CustomMetric.JOB_DISCARD_PENDING_CHANGES_COMPLETED:
    case CustomMetric.JOB_DISCARD_PENDING_CHANGES_FAILED:
    case CustomMetric.JOB_DISCARD_PENDING_CHANGES_CANCELED:
    case CustomMetric.JOB_DISCARD_PENDING_CHANGES_STALLED:
    case CustomMetric.SYNC_UNMATCHED_WITH_KEY_COUNT:
    case CustomMetric.SYNC_UNMATCHED_WITHOUT_KEY_COUNT:
    case CustomMetric.SYNC_ARCHIVE_WRITES_TOTAL:
    case CustomMetric.BACKFILL_SYNC_MAPPING_V1_REMAINING:
    case CustomMetric.BACKFILL_SYNC_MAPPING_V2_TRANSFORMED_TOTAL:
      return CustomMetricDimension.NO_DIMENSION;
    case CustomMetric.API_REQUEST:
    case CustomMetric.API_RATE_LIMIT_EXCEEDED:
      return CustomMetricDimension.AUTH_SOURCE;
    default:
      return assertUnreachable(metric);
  }
}

export function unitForMetric(metric: CustomMetric): CustomMetricUnit {
  switch (metric) {
    case CustomMetric.API_REQUEST:
    case CustomMetric.API_RATE_LIMIT_EXCEEDED:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_COMPLETED:
    case CustomMetric.JOB_REFRESH_RECORDS_COMPLETED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_COMPLETED:
    case CustomMetric.JOB_REHOST_ASSETS_COMPLETED:
    case CustomMetric.JOB_APPLY_PATCHES_COMPLETED:
    case CustomMetric.JOB_PUBLISH_COMPLETED:
    case CustomMetric.JOB_DELETE_WORKBOOK_COMPLETED:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_FAILED:
    case CustomMetric.JOB_REFRESH_RECORDS_FAILED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_FAILED:
    case CustomMetric.JOB_REHOST_ASSETS_FAILED:
    case CustomMetric.JOB_APPLY_PATCHES_FAILED:
    case CustomMetric.JOB_PUBLISH_FAILED:
    case CustomMetric.JOB_DELETE_WORKBOOK_FAILED:
    case CustomMetric.JOB_WORKER_ERROR:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_CANCELED:
    case CustomMetric.JOB_REFRESH_RECORDS_CANCELED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_CANCELED:
    case CustomMetric.JOB_REHOST_ASSETS_CANCELED:
    case CustomMetric.JOB_APPLY_PATCHES_CANCELED:
    case CustomMetric.JOB_PUBLISH_CANCELED:
    case CustomMetric.JOB_DELETE_WORKBOOK_CANCELED:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_STALLED:
    case CustomMetric.JOB_REFRESH_RECORDS_STALLED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_STALLED:
    case CustomMetric.JOB_REHOST_ASSETS_STALLED:
    case CustomMetric.JOB_APPLY_PATCHES_STALLED:
    case CustomMetric.JOB_PUBLISH_STALLED:
    case CustomMetric.JOB_DELETE_WORKBOOK_STALLED:
    case CustomMetric.JOB_DISCARD_PENDING_CHANGES_COMPLETED:
    case CustomMetric.JOB_DISCARD_PENDING_CHANGES_FAILED:
    case CustomMetric.JOB_DISCARD_PENDING_CHANGES_CANCELED:
    case CustomMetric.JOB_DISCARD_PENDING_CHANGES_STALLED:
    case CustomMetric.SYNC_UNMATCHED_WITH_KEY_COUNT:
    case CustomMetric.SYNC_UNMATCHED_WITHOUT_KEY_COUNT:
    case CustomMetric.SYNC_ARCHIVE_WRITES_TOTAL:
    case CustomMetric.BACKFILL_SYNC_MAPPING_V2_TRANSFORMED_TOTAL:
      return CustomMetricUnit.EVENT_COUNT;
    case CustomMetric.BACKFILL_SYNC_MAPPING_V1_REMAINING:
      // A gauge: how many syncs remain on the frozen v1 column right now, not a
      // per-event tally.
      return CustomMetricUnit.INSTANTANEOUS_COUNT;
    default:
      return assertUnreachable(metric);
  }
}

/** Maps job type → metric for each job state. */
import { JobType } from '@spinner/shared-types';
import type { JobTypes } from 'src/worker/jobs/union-types';

export const JOB_COMPLETED_METRIC: Record<JobTypes, CustomMetric> = {
  [JobType.PullLinkedFolderFiles]: CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_COMPLETED,
  [JobType.RefreshRecords]: CustomMetric.JOB_REFRESH_RECORDS_COMPLETED,
  [JobType.SyncDataFolders]: CustomMetric.JOB_SYNC_DATA_FOLDERS_COMPLETED,
  [JobType.RehostAssets]: CustomMetric.JOB_REHOST_ASSETS_COMPLETED,
  [JobType.ApplyPatches]: CustomMetric.JOB_APPLY_PATCHES_COMPLETED,
  [JobType.Publish]: CustomMetric.JOB_PUBLISH_COMPLETED,
  [JobType.DeleteWorkbook]: CustomMetric.JOB_DELETE_WORKBOOK_COMPLETED,
  [JobType.DiscardPendingChanges]: CustomMetric.JOB_DISCARD_PENDING_CHANGES_COMPLETED,
  // THROWAWAY: reuse the sync metric for the temporary pull-then-sync job.
  [JobType.TemporarySyncWithPull]: CustomMetric.JOB_SYNC_DATA_FOLDERS_COMPLETED,
};

export const JOB_FAILED_METRIC: Record<JobTypes, CustomMetric> = {
  [JobType.PullLinkedFolderFiles]: CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_FAILED,
  [JobType.RefreshRecords]: CustomMetric.JOB_REFRESH_RECORDS_FAILED,
  [JobType.SyncDataFolders]: CustomMetric.JOB_SYNC_DATA_FOLDERS_FAILED,
  [JobType.RehostAssets]: CustomMetric.JOB_REHOST_ASSETS_FAILED,
  [JobType.ApplyPatches]: CustomMetric.JOB_APPLY_PATCHES_FAILED,
  [JobType.Publish]: CustomMetric.JOB_PUBLISH_FAILED,
  [JobType.DeleteWorkbook]: CustomMetric.JOB_DELETE_WORKBOOK_FAILED,
  [JobType.DiscardPendingChanges]: CustomMetric.JOB_DISCARD_PENDING_CHANGES_FAILED,
  // THROWAWAY: reuse the sync metric for the temporary pull-then-sync job.
  [JobType.TemporarySyncWithPull]: CustomMetric.JOB_SYNC_DATA_FOLDERS_FAILED,
};

export const JOB_CANCELED_METRIC: Record<JobTypes, CustomMetric> = {
  [JobType.PullLinkedFolderFiles]: CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_CANCELED,
  [JobType.RefreshRecords]: CustomMetric.JOB_REFRESH_RECORDS_CANCELED,
  [JobType.SyncDataFolders]: CustomMetric.JOB_SYNC_DATA_FOLDERS_CANCELED,
  [JobType.RehostAssets]: CustomMetric.JOB_REHOST_ASSETS_CANCELED,
  [JobType.ApplyPatches]: CustomMetric.JOB_APPLY_PATCHES_CANCELED,
  [JobType.Publish]: CustomMetric.JOB_PUBLISH_CANCELED,
  [JobType.DeleteWorkbook]: CustomMetric.JOB_DELETE_WORKBOOK_CANCELED,
  [JobType.DiscardPendingChanges]: CustomMetric.JOB_DISCARD_PENDING_CHANGES_CANCELED,
  // THROWAWAY: reuse the sync metric for the temporary pull-then-sync job.
  [JobType.TemporarySyncWithPull]: CustomMetric.JOB_SYNC_DATA_FOLDERS_CANCELED,
};

export const JOB_STALLED_METRIC: Record<JobTypes, CustomMetric> = {
  [JobType.PullLinkedFolderFiles]: CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_STALLED,
  [JobType.RefreshRecords]: CustomMetric.JOB_REFRESH_RECORDS_STALLED,
  [JobType.SyncDataFolders]: CustomMetric.JOB_SYNC_DATA_FOLDERS_STALLED,
  [JobType.RehostAssets]: CustomMetric.JOB_REHOST_ASSETS_STALLED,
  [JobType.ApplyPatches]: CustomMetric.JOB_APPLY_PATCHES_STALLED,
  [JobType.Publish]: CustomMetric.JOB_PUBLISH_STALLED,
  [JobType.DeleteWorkbook]: CustomMetric.JOB_DELETE_WORKBOOK_STALLED,
  [JobType.DiscardPendingChanges]: CustomMetric.JOB_DISCARD_PENDING_CHANGES_STALLED,
  // THROWAWAY: reuse the sync metric for the temporary pull-then-sync job.
  [JobType.TemporarySyncWithPull]: CustomMetric.JOB_SYNC_DATA_FOLDERS_STALLED,
};
