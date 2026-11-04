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
  JOB_CLEANUP_CONNECTION_INDEX_ROWS_COMPLETED = 'job_cleanup_connection_index_rows_completed',
  JOB_APPLY_SYNC_DRAFT_COMPLETED = 'job_apply_sync_draft_completed',

  // BullMQ job metrics — failed
  JOB_PULL_LINKED_FOLDER_FILES_FAILED = 'job_pull_linked_folder_files_failed',
  JOB_REFRESH_RECORDS_FAILED = 'job_refresh_records_failed',
  JOB_SYNC_DATA_FOLDERS_FAILED = 'job_sync_data_folders_failed',
  JOB_REHOST_ASSETS_FAILED = 'job_rehost_assets_failed',
  JOB_APPLY_PATCHES_FAILED = 'job_apply_patches_failed',
  JOB_PUBLISH_FAILED = 'job_publish_failed',
  JOB_DELETE_WORKBOOK_FAILED = 'job_delete_workbook_failed',
  JOB_DISCARD_PENDING_CHANGES_FAILED = 'job_discard_pending_changes_failed',
  JOB_CLEANUP_CONNECTION_INDEX_ROWS_FAILED = 'job_cleanup_connection_index_rows_failed',
  JOB_APPLY_SYNC_DRAFT_FAILED = 'job_apply_sync_draft_failed',

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
  JOB_CLEANUP_CONNECTION_INDEX_ROWS_CANCELED = 'job_cleanup_connection_index_rows_canceled',
  JOB_APPLY_SYNC_DRAFT_CANCELED = 'job_apply_sync_draft_canceled',

  // BullMQ job metrics — stalled
  JOB_PULL_LINKED_FOLDER_FILES_STALLED = 'job_pull_linked_folder_files_stalled',
  JOB_REFRESH_RECORDS_STALLED = 'job_refresh_records_stalled',
  JOB_SYNC_DATA_FOLDERS_STALLED = 'job_sync_data_folders_stalled',
  JOB_REHOST_ASSETS_STALLED = 'job_rehost_assets_stalled',
  JOB_APPLY_PATCHES_STALLED = 'job_apply_patches_stalled',
  JOB_PUBLISH_STALLED = 'job_publish_stalled',
  JOB_DELETE_WORKBOOK_STALLED = 'job_delete_workbook_stalled',
  JOB_DISCARD_PENDING_CHANGES_STALLED = 'job_discard_pending_changes_stalled',
  JOB_CLEANUP_CONNECTION_INDEX_ROWS_STALLED = 'job_cleanup_connection_index_rows_stalled',
  JOB_APPLY_SYNC_DRAFT_STALLED = 'job_apply_sync_draft_stalled',

  // Orphaned-job / stuck-run recovery (DEV-11146). Each counter fires when a crash-recovery path
  // actually reclaims something a dead worker left behind — rare "something crashed upstream"
  // signals, charted to watch frequency and confirm fixes reduce them.
  JOB_REAPED_STALE_ACTIVE = 'job_reaped_stale_active',
  JOB_REAPED_STALE_CREATED = 'job_reaped_stale_created',
  JOB_RECONCILED_ON_FAILED_EVENT = 'job_reconciled_on_failed_event',
  ROUTINE_RUN_REAPED = 'routine_run_reaped',
  // A subset of ROUTINE_RUN_REAPED (DEV-11274): the run's current step job was still running past the step's timeout
  // with no driver left to enforce it, so the reaper resumed the run to cancel the job and fail the run.
  ROUTINE_RUN_REAPED_PAST_STEP_DEADLINE = 'routine_run_reaped_past_step_deadline',

  // Routine step timeouts (DEV-12713). `TIMED_OUT` fires when a step's job outlives the step's timeout, so the
  // executor cancels the job and fails the run. `JOB_WAIT_ENDED_BEFORE_TIMEOUT` fires when the executor's wait on
  // a step's job ends early with the job unfinished (a Redis error, or BullMQ failing a stalled job the worker never
  // recorded); the executor then leaves the run to RoutineRunReaperService rather than cancel a job that may be fine.
  ROUTINE_STEP_TIMED_OUT = 'routine_step_timed_out',
  ROUTINE_STEP_JOB_WAIT_ENDED_BEFORE_TIMEOUT = 'routine_step_job_wait_ended_before_timeout',

  // Graceful-shutdown drain accounting (DEV-11184). Exactly one of these fires per worker instance on
  // SIGTERM (Cloud Run deploy / scale-down). The DRAINED:TIMED_OUT ratio over deploys is the chartable
  // signal that graceful shutdown is working and that deploy-induced job orphaning trends to zero.
  WORKER_SHUTDOWN_DRAINED = 'worker_shutdown_drained',
  WORKER_SHUTDOWN_TIMED_OUT = 'worker_shutdown_timed_out',
  // DEV-12428: an in-flight job threw after its worker began shutting down, so the error was treated as
  // the shutdown's (closed clients), not a real failure — the job was left active for stall recovery to
  // redeliver instead of being recorded failed. Pairs with WORKER_SHUTDOWN_TIMED_OUT.
  JOB_LEFT_FOR_STALL_RECOVERY_ON_SHUTDOWN = 'job_left_for_stall_recovery_on_shutdown',

  // Deploy-rollover DB resilience (DEV-11312). On a cold Cloud Run worker revision the private-IP
  // egress to Cloud SQL is briefly unavailable, so the worker's startup DbJob lookup can throw a
  // transient Prisma connection error (P1001/P2024). JOB_STARTUP_DB_RETRY fires once per retry;
  // JOB_STARTUP_DB_RETRY_EXHAUSTED fires when retries run out and the job still fails. The
  // retried:exhausted ratio is the chartable signal that deploy churn no longer kills real jobs.
  JOB_STARTUP_DB_RETRY = 'job_startup_db_retry',
  JOB_STARTUP_DB_RETRY_EXHAUSTED = 'job_startup_db_retry_exhausted',

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

  // scratch-git disk observability (DEV-11315 / parent DEV-11253 RC5). The three gauges are set by the
  // read-only `ScratchGitDiskObservabilityService` sweep; only `SCRATCH_GIT_REPO_LOOSE_OBJECTS` is emitted
  // from Phase 1 (the others are reserved — see below). The three GC/reaper counters are registered here
  // now but EMITTED by the Phase 2–4 remediations at call sites that already exist; keeping them in the
  // enum from Phase 1 keeps both exhaustive switches below complete so those phases don't touch the
  // metric plumbing. Do NOT add a `_TOTAL` suffix to the counters — the Managed-Prometheus exporter
  // appends `_total` to counters at query time.
  SCRATCH_GIT_REPO_LOOSE_OBJECTS = 'scratch_git_repo_loose_objects', // gauge: max loose objects across all repos
  SCRATCH_GIT_STAGING_ORPHAN_BYTES = 'scratch_git_staging_orphan_bytes', // gauge: reserved, emitted in Phase 3 (DEV-11317)
  SCRATCH_GIT_DISK_PERCENT = 'scratch_git_disk_percent', // gauge: reserved — the Ops-Agent disk metric already covers alerting
  SCRATCH_GIT_RUN_STORE_BYTES = 'scratch_git_run_store_bytes', // gauge: total bytes of Live Export run store dirs (`le-*`) after the hourly staging reap
  GC_MAINTENANCE_RUN = 'gc_maintenance_run', // counter: emitted in Phase 2 (DEV-11316)
  STAGING_DIR_REAPED = 'staging_dir_reaped', // counter: emitted in Phase 3 (DEV-11317)
  PLAN_TAGS_REAPED = 'plan_tags_reaped', // counter: emitted in Phase 4 (DEV-11318)

  // Publish delete-op anomaly (DEV-10595). Fires when a publish delete operation has no resolvable
  // remote record id (its FileIndex row is missing / its id was never extractable at pull time), so
  // the record cannot be deleted from the external service. These deletes are now marked failed-batch
  // instead of a silent success; the counter charts how often the anomaly happens in prod.
  PUBLISH_DELETE_MISSING_REMOTE_ID = 'publish_delete_missing_remote_id',

  // Subscription enforcement (DEV-11400). Counts schedules the SubscriptionEnforcementService disabled
  // because their organization's subscription lapsed (Stripe status expired/past_due/canceled) — charts how
  // much scheduled work is being quiesced by paywall enforcement.
  SUBSCRIPTION_LAPSE_SCHEDULES_DISABLED = 'subscription_lapse_schedules_disabled',

  // Live Export record-limit enforcement (DEV-11157). Fires once each time a sync/publish job is failed
  // because its Live Export workbook's organization is over the plan's `liveExportRecordCountLimit` — charts
  // how often the record cap is actually blocking exports.
  LIVE_EXPORT_RECORD_LIMIT_ENFORCED = 'live_export_record_limit_enforced',

  // Rehosted-asset reaper (DEV-12324). The nightly `RehostedAssetReaperService` deletes objects in the GCS
  // assets bucket that no `Asset` row references. `REAPED` counts objects deleted, `REAP_FAILED` deletes that
  // errored, and `SWEEP_ABORTED` sweeps stopped early (a DB or listing error, the URL-drift tripwire, or too many
  // consecutive failed deletes). An aborted sweep deletes nothing further, so it needs its own signal.
  REHOSTED_ASSET_OBJECT_REAPED = 'rehosted_asset_object_reaped',
  REHOSTED_ASSET_OBJECT_REAP_FAILED = 'rehosted_asset_object_reap_failed',
  REHOSTED_ASSET_REAPER_SWEEP_ABORTED = 'rehosted_asset_reaper_sweep_aborted',

  // Whalesync run notifications (DEV-12330). Failed Live Export runs are queued as `WhalesyncRunNotification`
  // rows and pushed to Whalesync, which emails the export's owner. `SENT` counts rows Whalesync accepted,
  // `FAILED` failed delivery attempts (each retry counts), and `GAVE_UP` rows that will never be delivered (out of
  // attempts, a terminal 4xx, or an invalid payload), i.e. an owner who won't get the email. `BACKFILLED` counts
  // failed runs the sweep had to queue because the executor's hook never did (e.g. the process died first).
  WHALESYNC_RUN_NOTIFY_SENT = 'whalesync_run_notify_sent',
  WHALESYNC_RUN_NOTIFY_FAILED = 'whalesync_run_notify_failed',
  WHALESYNC_RUN_NOTIFY_GAVE_UP = 'whalesync_run_notify_gave_up',
  WHALESYNC_RUN_NOTIFY_BACKFILLED = 'whalesync_run_notify_backfilled',
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
    case CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_COMPLETED:
    case CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_FAILED:
    case CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_CANCELED:
    case CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_STALLED:
    case CustomMetric.JOB_APPLY_SYNC_DRAFT_COMPLETED:
    case CustomMetric.JOB_APPLY_SYNC_DRAFT_FAILED:
    case CustomMetric.JOB_APPLY_SYNC_DRAFT_CANCELED:
    case CustomMetric.JOB_APPLY_SYNC_DRAFT_STALLED:
    case CustomMetric.JOB_REAPED_STALE_ACTIVE:
    case CustomMetric.JOB_REAPED_STALE_CREATED:
    case CustomMetric.JOB_RECONCILED_ON_FAILED_EVENT:
    case CustomMetric.ROUTINE_RUN_REAPED:
    case CustomMetric.ROUTINE_RUN_REAPED_PAST_STEP_DEADLINE:
    case CustomMetric.ROUTINE_STEP_TIMED_OUT:
    case CustomMetric.ROUTINE_STEP_JOB_WAIT_ENDED_BEFORE_TIMEOUT:
    case CustomMetric.SYNC_UNMATCHED_WITH_KEY_COUNT:
    case CustomMetric.SYNC_UNMATCHED_WITHOUT_KEY_COUNT:
    case CustomMetric.SYNC_ARCHIVE_WRITES_TOTAL:
    case CustomMetric.BACKFILL_SYNC_MAPPING_V1_REMAINING:
    case CustomMetric.BACKFILL_SYNC_MAPPING_V2_TRANSFORMED_TOTAL:
    case CustomMetric.WORKER_SHUTDOWN_DRAINED:
    case CustomMetric.WORKER_SHUTDOWN_TIMED_OUT:
    case CustomMetric.JOB_LEFT_FOR_STALL_RECOVERY_ON_SHUTDOWN:
    case CustomMetric.JOB_STARTUP_DB_RETRY:
    case CustomMetric.JOB_STARTUP_DB_RETRY_EXHAUSTED:
    case CustomMetric.SCRATCH_GIT_REPO_LOOSE_OBJECTS:
    case CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES:
    case CustomMetric.SCRATCH_GIT_DISK_PERCENT:
    case CustomMetric.SCRATCH_GIT_RUN_STORE_BYTES:
    case CustomMetric.GC_MAINTENANCE_RUN:
    case CustomMetric.STAGING_DIR_REAPED:
    case CustomMetric.PLAN_TAGS_REAPED:
    case CustomMetric.PUBLISH_DELETE_MISSING_REMOTE_ID:
    case CustomMetric.SUBSCRIPTION_LAPSE_SCHEDULES_DISABLED:
    case CustomMetric.LIVE_EXPORT_RECORD_LIMIT_ENFORCED:
    case CustomMetric.REHOSTED_ASSET_OBJECT_REAPED:
    case CustomMetric.REHOSTED_ASSET_OBJECT_REAP_FAILED:
    case CustomMetric.REHOSTED_ASSET_REAPER_SWEEP_ABORTED:
    case CustomMetric.WHALESYNC_RUN_NOTIFY_SENT:
    case CustomMetric.WHALESYNC_RUN_NOTIFY_FAILED:
    case CustomMetric.WHALESYNC_RUN_NOTIFY_GAVE_UP:
    case CustomMetric.WHALESYNC_RUN_NOTIFY_BACKFILLED:
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
    case CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_COMPLETED:
    case CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_FAILED:
    case CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_CANCELED:
    case CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_STALLED:
    case CustomMetric.JOB_APPLY_SYNC_DRAFT_COMPLETED:
    case CustomMetric.JOB_APPLY_SYNC_DRAFT_FAILED:
    case CustomMetric.JOB_APPLY_SYNC_DRAFT_CANCELED:
    case CustomMetric.JOB_APPLY_SYNC_DRAFT_STALLED:
    case CustomMetric.JOB_REAPED_STALE_ACTIVE:
    case CustomMetric.JOB_REAPED_STALE_CREATED:
    case CustomMetric.JOB_RECONCILED_ON_FAILED_EVENT:
    case CustomMetric.ROUTINE_RUN_REAPED:
    case CustomMetric.ROUTINE_RUN_REAPED_PAST_STEP_DEADLINE:
    case CustomMetric.ROUTINE_STEP_TIMED_OUT:
    case CustomMetric.ROUTINE_STEP_JOB_WAIT_ENDED_BEFORE_TIMEOUT:
    case CustomMetric.SYNC_UNMATCHED_WITH_KEY_COUNT:
    case CustomMetric.SYNC_UNMATCHED_WITHOUT_KEY_COUNT:
    case CustomMetric.SYNC_ARCHIVE_WRITES_TOTAL:
    case CustomMetric.BACKFILL_SYNC_MAPPING_V2_TRANSFORMED_TOTAL:
    case CustomMetric.WORKER_SHUTDOWN_DRAINED:
    case CustomMetric.WORKER_SHUTDOWN_TIMED_OUT:
    case CustomMetric.JOB_LEFT_FOR_STALL_RECOVERY_ON_SHUTDOWN:
    case CustomMetric.JOB_STARTUP_DB_RETRY:
    case CustomMetric.JOB_STARTUP_DB_RETRY_EXHAUSTED:
    case CustomMetric.GC_MAINTENANCE_RUN:
    case CustomMetric.STAGING_DIR_REAPED:
    case CustomMetric.PLAN_TAGS_REAPED:
    case CustomMetric.PUBLISH_DELETE_MISSING_REMOTE_ID:
    case CustomMetric.SUBSCRIPTION_LAPSE_SCHEDULES_DISABLED:
    case CustomMetric.LIVE_EXPORT_RECORD_LIMIT_ENFORCED:
    case CustomMetric.REHOSTED_ASSET_OBJECT_REAPED:
    case CustomMetric.REHOSTED_ASSET_OBJECT_REAP_FAILED:
    case CustomMetric.REHOSTED_ASSET_REAPER_SWEEP_ABORTED:
    case CustomMetric.WHALESYNC_RUN_NOTIFY_SENT:
    case CustomMetric.WHALESYNC_RUN_NOTIFY_FAILED:
    case CustomMetric.WHALESYNC_RUN_NOTIFY_GAVE_UP:
    case CustomMetric.WHALESYNC_RUN_NOTIFY_BACKFILLED:
      return CustomMetricUnit.EVENT_COUNT;
    case CustomMetric.BACKFILL_SYNC_MAPPING_V1_REMAINING:
      // A gauge: how many syncs remain on the frozen v1 column right now, not a
      // per-event tally.
      return CustomMetricUnit.INSTANTANEOUS_COUNT;
    case CustomMetric.SCRATCH_GIT_REPO_LOOSE_OBJECTS:
    case CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES:
    case CustomMetric.SCRATCH_GIT_DISK_PERCENT:
    case CustomMetric.SCRATCH_GIT_RUN_STORE_BYTES:
      // Gauges: the current disk-observability reading (worst-repo loose objects, orphaned staging
      // bytes, disk percent, run store bytes) at scan time — not a per-event tally. `..._BYTES` holds raw bytes.
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
  [JobType.CleanupConnectionIndexRows]: CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_COMPLETED,
  [JobType.ApplySyncDraft]: CustomMetric.JOB_APPLY_SYNC_DRAFT_COMPLETED,
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
  [JobType.CleanupConnectionIndexRows]: CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_FAILED,
  [JobType.ApplySyncDraft]: CustomMetric.JOB_APPLY_SYNC_DRAFT_FAILED,
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
  [JobType.CleanupConnectionIndexRows]: CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_CANCELED,
  [JobType.ApplySyncDraft]: CustomMetric.JOB_APPLY_SYNC_DRAFT_CANCELED,
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
  [JobType.CleanupConnectionIndexRows]: CustomMetric.JOB_CLEANUP_CONNECTION_INDEX_ROWS_STALLED,
  [JobType.ApplySyncDraft]: CustomMetric.JOB_APPLY_SYNC_DRAFT_STALLED,
};
