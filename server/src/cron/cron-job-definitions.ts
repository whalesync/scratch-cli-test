import type { CronJobSummaryDto } from '@spinner/shared-types';
import { ScratchConfigService, type ScratchEnvironment } from '../config/scratch-config.service';

/**
 * The static metadata for every cron job — the single source of truth for the dev-tool list. Served
 * by the dependency-free {@link CronController} (`GET /cron/jobs`), which is mounted on the API service
 * the browser talks to and so must not pull in the `@Cron` services.
 *
 * Keep this list in sync with the `@Cron` expressions on the individual services and with the
 * `runnerBySlug()` map in `cron-debug.controller.ts` (which binds each slug to the method its schedule
 * calls). A slug listed here but missing from `runnerBySlug()` is listable but not triggerable.
 */
export const CRON_JOB_DEFINITIONS: CronJobSummaryDto[] = [
  {
    slug: 'record-count-refresh',
    description: "Reconcile every workbook's per-folder record counts with git.",
    schedule: 'EVERY_HOUR',
  },
  {
    slug: 'old-job-cleanup',
    description: 'Delete completed/failed/canceled jobs past the retention period.',
    schedule: 'EVERY_DAY_AT_3AM',
  },
  {
    slug: 'stale-job-reaper',
    description: 'Fail jobs stuck in the created state past the stale threshold.',
    schedule: 'EVERY_5_MINUTES',
  },
  {
    slug: 'stale-active-job-reaper',
    description: "Reconcile DbJobs stuck 'active' whose BullMQ job is gone/terminal, clearing folder locks.",
    schedule: 'EVERY_5_MINUTES',
  },
  {
    slug: 'routine-run-reaper',
    description: 'Resume routine runs stuck in the running state.',
    schedule: 'EVERY_5_MINUTES',
  },
  {
    slug: 'expired-api-token-cleanup',
    description: 'Delete expired Whalesync session tokens.',
    schedule: 'EVERY_HOUR',
  },
];

/**
 * Whether this server permits a manual cron-job trigger. Manual triggering is a local-development
 * convenience only: it is blocked in every deployed (Cloud Run) environment, where cron jobs run on
 * their own schedule on the dedicated cron service and manual runs from the API service can't reach
 * that context anyway. The web client mirrors this in `ListCronJobsResponseDto.canTrigger`, and both
 * cron controllers enforce it on the trigger endpoint.
 */
export function isManualCronTriggeringAllowed(): boolean {
  return !ScratchConfigService.isRunningInCloudRun();
}

/** The 403 message returned when a manual trigger is refused because this server is deployed. */
export const CRON_TRIGGERING_DISABLED_MESSAGE =
  'Triggering cron jobs is disabled in deployed environments. Cron jobs run on their schedule on the dedicated cron service.';

/** The Cloud Run service name and region that run the cron schedules (see terraform/modules/env/services.tf). */
const CRON_CLOUD_RUN_SERVICE_NAME = 'cron-service';
const CRON_CLOUD_RUN_REGION = 'europe-west1';

/** The Scratch GCP project per deployed environment (see terraform/envs/*). */
const GCP_PROJECT_ID_BY_ENVIRONMENT: Partial<Record<ScratchEnvironment, string>> = {
  test: 'spv1eu-test',
  production: 'spv1eu-production',
};

/**
 * A deep link to the GCP Cloud Logging Explorer, pre-filtered to the cron service's Cloud Run logs
 * (`severity>=DEFAULT`), scoped to the current environment's GCP project. Returns null in local
 * development (no Cloud Run logs exist there) so the web client only surfaces the "View logs" action
 * in deployed environments (test, production).
 */
export function getCronServiceLogsUrl(): string | null {
  if (!ScratchConfigService.isRunningInCloudRun()) {
    return null;
  }
  const gcpProjectId = GCP_PROJECT_ID_BY_ENVIRONMENT[ScratchConfigService.getScratchEnvironment()];
  if (!gcpProjectId) {
    return null;
  }
  const logsQuery = [
    'resource.type = "cloud_run_revision"',
    `resource.labels.service_name = "${CRON_CLOUD_RUN_SERVICE_NAME}"`,
    `resource.labels.location = "${CRON_CLOUD_RUN_REGION}"`,
    'severity>=DEFAULT',
  ].join('\n');
  return `https://console.cloud.google.com/logs/query;query=${encodeURIComponent(logsQuery)}?project=${gcpProjectId}`;
}
