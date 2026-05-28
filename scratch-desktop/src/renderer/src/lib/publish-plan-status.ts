import { PublishPlanStatus } from '@spinner/shared-types';

/**
 * Maps a publish plan status to a Mantine color token used in the Status
 * badge. Mirrors the web client's `publishPlanStatusBadgeColor` (kept local
 * to avoid pulling the web utils package into desktop).
 */
export function publishPlanStatusBadgeColor(status: PublishPlanStatus): string {
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
    default:
      return 'gray';
  }
}

/** Maps the active BullMQ job status to a badge color. */
export function jobStatusBadgeColor(status: string): string {
  if (status === 'active') return 'blue';
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'canceled') return 'grape';
  return 'gray';
}

export function formatPhaseCount(count: number): string {
  if (count >= 10000) {
    return (count / 1000).toFixed(1) + 'K';
  }
  return count.toString();
}
