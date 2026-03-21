import { assertUnreachable } from 'src/utils/asserts';
import { CustomMetricDimension, CustomMetricUnit } from './types';

/**
 * The list of metrics we collect manually.
 */
export enum CustomMetric {
  SYNC_DATA_FOLDERS_JOB_SUCCESS = 'sync_data_folders_job_success',
  API_REQUEST = 'api_request',

  // BullMQ job metrics — completed
  JOB_PULL_LINKED_FOLDER_FILES_COMPLETED = 'job_pull_linked_folder_files_completed',
  JOB_REFRESH_RECORDS_COMPLETED = 'job_refresh_records_completed',
  JOB_PUBLISH_DATA_FOLDER_COMPLETED = 'job_publish_data_folder_completed',
  JOB_SYNC_DATA_FOLDERS_COMPLETED = 'job_sync_data_folders_completed',
  JOB_REHOST_ASSETS_COMPLETED = 'job_rehost_assets_completed',
  JOB_PUBLISH_FROM_GIT_COMPLETED = 'job_publish_from_git_completed',
  JOB_PUBLISH_COMPLETED = 'job_publish_completed',

  // BullMQ job metrics — failed
  JOB_PULL_LINKED_FOLDER_FILES_FAILED = 'job_pull_linked_folder_files_failed',
  JOB_REFRESH_RECORDS_FAILED = 'job_refresh_records_failed',
  JOB_PUBLISH_DATA_FOLDER_FAILED = 'job_publish_data_folder_failed',
  JOB_SYNC_DATA_FOLDERS_FAILED = 'job_sync_data_folders_failed',
  JOB_REHOST_ASSETS_FAILED = 'job_rehost_assets_failed',
  JOB_PUBLISH_FROM_GIT_FAILED = 'job_publish_from_git_failed',
  JOB_PUBLISH_FAILED = 'job_publish_failed',

  // BullMQ job metrics — error (worker-level errors)
  JOB_WORKER_ERROR = 'job_worker_error',

  // BullMQ job metrics — canceled
  JOB_PULL_LINKED_FOLDER_FILES_CANCELED = 'job_pull_linked_folder_files_canceled',
  JOB_REFRESH_RECORDS_CANCELED = 'job_refresh_records_canceled',
  JOB_PUBLISH_DATA_FOLDER_CANCELED = 'job_publish_data_folder_canceled',
  JOB_SYNC_DATA_FOLDERS_CANCELED = 'job_sync_data_folders_canceled',
  JOB_REHOST_ASSETS_CANCELED = 'job_rehost_assets_canceled',
  JOB_PUBLISH_FROM_GIT_CANCELED = 'job_publish_from_git_canceled',
  JOB_PUBLISH_CANCELED = 'job_publish_canceled',

  // BullMQ job metrics — stalled
  JOB_PULL_LINKED_FOLDER_FILES_STALLED = 'job_pull_linked_folder_files_stalled',
  JOB_REFRESH_RECORDS_STALLED = 'job_refresh_records_stalled',
  JOB_PUBLISH_DATA_FOLDER_STALLED = 'job_publish_data_folder_stalled',
  JOB_SYNC_DATA_FOLDERS_STALLED = 'job_sync_data_folders_stalled',
  JOB_REHOST_ASSETS_STALLED = 'job_rehost_assets_stalled',
  JOB_PUBLISH_FROM_GIT_STALLED = 'job_publish_from_git_stalled',
  JOB_PUBLISH_STALLED = 'job_publish_stalled',
}

export function expectedDimensionForMetric(metric: CustomMetric): CustomMetricDimension {
  switch (metric) {
    case CustomMetric.SYNC_DATA_FOLDERS_JOB_SUCCESS:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_COMPLETED:
    case CustomMetric.JOB_REFRESH_RECORDS_COMPLETED:
    case CustomMetric.JOB_PUBLISH_DATA_FOLDER_COMPLETED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_COMPLETED:
    case CustomMetric.JOB_REHOST_ASSETS_COMPLETED:
    case CustomMetric.JOB_PUBLISH_FROM_GIT_COMPLETED:
    case CustomMetric.JOB_PUBLISH_COMPLETED:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_FAILED:
    case CustomMetric.JOB_REFRESH_RECORDS_FAILED:
    case CustomMetric.JOB_PUBLISH_DATA_FOLDER_FAILED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_FAILED:
    case CustomMetric.JOB_REHOST_ASSETS_FAILED:
    case CustomMetric.JOB_PUBLISH_FROM_GIT_FAILED:
    case CustomMetric.JOB_PUBLISH_FAILED:
    case CustomMetric.JOB_WORKER_ERROR:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_CANCELED:
    case CustomMetric.JOB_REFRESH_RECORDS_CANCELED:
    case CustomMetric.JOB_PUBLISH_DATA_FOLDER_CANCELED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_CANCELED:
    case CustomMetric.JOB_REHOST_ASSETS_CANCELED:
    case CustomMetric.JOB_PUBLISH_FROM_GIT_CANCELED:
    case CustomMetric.JOB_PUBLISH_CANCELED:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_STALLED:
    case CustomMetric.JOB_REFRESH_RECORDS_STALLED:
    case CustomMetric.JOB_PUBLISH_DATA_FOLDER_STALLED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_STALLED:
    case CustomMetric.JOB_REHOST_ASSETS_STALLED:
    case CustomMetric.JOB_PUBLISH_FROM_GIT_STALLED:
    case CustomMetric.JOB_PUBLISH_STALLED:
      return CustomMetricDimension.NO_DIMENSION;
    case CustomMetric.API_REQUEST:
      return CustomMetricDimension.AUTH_SOURCE;
    default:
      return assertUnreachable(metric);
  }
}

export function unitForMetric(metric: CustomMetric): CustomMetricUnit {
  switch (metric) {
    case CustomMetric.SYNC_DATA_FOLDERS_JOB_SUCCESS:
    case CustomMetric.API_REQUEST:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_COMPLETED:
    case CustomMetric.JOB_REFRESH_RECORDS_COMPLETED:
    case CustomMetric.JOB_PUBLISH_DATA_FOLDER_COMPLETED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_COMPLETED:
    case CustomMetric.JOB_REHOST_ASSETS_COMPLETED:
    case CustomMetric.JOB_PUBLISH_FROM_GIT_COMPLETED:
    case CustomMetric.JOB_PUBLISH_COMPLETED:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_FAILED:
    case CustomMetric.JOB_REFRESH_RECORDS_FAILED:
    case CustomMetric.JOB_PUBLISH_DATA_FOLDER_FAILED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_FAILED:
    case CustomMetric.JOB_REHOST_ASSETS_FAILED:
    case CustomMetric.JOB_PUBLISH_FROM_GIT_FAILED:
    case CustomMetric.JOB_PUBLISH_FAILED:
    case CustomMetric.JOB_WORKER_ERROR:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_CANCELED:
    case CustomMetric.JOB_REFRESH_RECORDS_CANCELED:
    case CustomMetric.JOB_PUBLISH_DATA_FOLDER_CANCELED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_CANCELED:
    case CustomMetric.JOB_REHOST_ASSETS_CANCELED:
    case CustomMetric.JOB_PUBLISH_FROM_GIT_CANCELED:
    case CustomMetric.JOB_PUBLISH_CANCELED:
    case CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_STALLED:
    case CustomMetric.JOB_REFRESH_RECORDS_STALLED:
    case CustomMetric.JOB_PUBLISH_DATA_FOLDER_STALLED:
    case CustomMetric.JOB_SYNC_DATA_FOLDERS_STALLED:
    case CustomMetric.JOB_REHOST_ASSETS_STALLED:
    case CustomMetric.JOB_PUBLISH_FROM_GIT_STALLED:
    case CustomMetric.JOB_PUBLISH_STALLED:
      return CustomMetricUnit.EVENT_COUNT;
    default:
      return assertUnreachable(metric);
  }
}

/** Maps job type → metric for each job state. */
import type { JobTypes } from 'src/worker/jobs/union-types';

export const JOB_COMPLETED_METRIC: Record<JobTypes, CustomMetric> = {
  'pull-linked-folder-files': CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_COMPLETED,
  'refresh-records': CustomMetric.JOB_REFRESH_RECORDS_COMPLETED,
  'publish-data-folder': CustomMetric.JOB_PUBLISH_DATA_FOLDER_COMPLETED,
  'sync-data-folders': CustomMetric.JOB_SYNC_DATA_FOLDERS_COMPLETED,
  'rehost-assets': CustomMetric.JOB_REHOST_ASSETS_COMPLETED,
  'publish-from-git': CustomMetric.JOB_PUBLISH_FROM_GIT_COMPLETED,
  publish: CustomMetric.JOB_PUBLISH_COMPLETED,
};

export const JOB_FAILED_METRIC: Record<JobTypes, CustomMetric> = {
  'pull-linked-folder-files': CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_FAILED,
  'refresh-records': CustomMetric.JOB_REFRESH_RECORDS_FAILED,
  'publish-data-folder': CustomMetric.JOB_PUBLISH_DATA_FOLDER_FAILED,
  'sync-data-folders': CustomMetric.JOB_SYNC_DATA_FOLDERS_FAILED,
  'rehost-assets': CustomMetric.JOB_REHOST_ASSETS_FAILED,
  'publish-from-git': CustomMetric.JOB_PUBLISH_FROM_GIT_FAILED,
  publish: CustomMetric.JOB_PUBLISH_FAILED,
};

export const JOB_CANCELED_METRIC: Record<JobTypes, CustomMetric> = {
  'pull-linked-folder-files': CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_CANCELED,
  'refresh-records': CustomMetric.JOB_REFRESH_RECORDS_CANCELED,
  'publish-data-folder': CustomMetric.JOB_PUBLISH_DATA_FOLDER_CANCELED,
  'sync-data-folders': CustomMetric.JOB_SYNC_DATA_FOLDERS_CANCELED,
  'rehost-assets': CustomMetric.JOB_REHOST_ASSETS_CANCELED,
  'publish-from-git': CustomMetric.JOB_PUBLISH_FROM_GIT_CANCELED,
  publish: CustomMetric.JOB_PUBLISH_CANCELED,
};

export const JOB_STALLED_METRIC: Record<JobTypes, CustomMetric> = {
  'pull-linked-folder-files': CustomMetric.JOB_PULL_LINKED_FOLDER_FILES_STALLED,
  'refresh-records': CustomMetric.JOB_REFRESH_RECORDS_STALLED,
  'publish-data-folder': CustomMetric.JOB_PUBLISH_DATA_FOLDER_STALLED,
  'sync-data-folders': CustomMetric.JOB_SYNC_DATA_FOLDERS_STALLED,
  'rehost-assets': CustomMetric.JOB_REHOST_ASSETS_STALLED,
  'publish-from-git': CustomMetric.JOB_PUBLISH_FROM_GIT_STALLED,
  publish: CustomMetric.JOB_PUBLISH_STALLED,
};
