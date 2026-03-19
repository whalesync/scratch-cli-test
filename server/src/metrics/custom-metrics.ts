import { assertUnreachable } from 'src/utils/asserts';
import { CustomMetricDimension, CustomMetricUnit } from './types';

/**
 * The list of metrics we collect manually.
 * TODO: Add actual metric values here as needed.
 */
export enum CustomMetric {
  SYNC_DATA_FOLDERS_JOB_SUCCESS = 'sync_data_folders_job_success',
}

export function expectedDimensionForMetric(metric: CustomMetric): CustomMetricDimension {
  switch (metric) {
    case CustomMetric.SYNC_DATA_FOLDERS_JOB_SUCCESS:
      return CustomMetricDimension.NO_DIMENSION;
    default:
      return assertUnreachable(metric);
  }
}

export function unitForMetric(metric: CustomMetric): CustomMetricUnit {
  switch (metric) {
    case CustomMetric.SYNC_DATA_FOLDERS_JOB_SUCCESS:
      return CustomMetricUnit.EVENT_COUNT;
    default:
      return assertUnreachable(metric);
  }
}
