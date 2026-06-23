/**
 * Types for the admin-only cron dev tool (web client). Cron jobs normally run on their own
 * schedule; these back listing them and triggering a manual run for testing.
 */

/** One triggerable cron job. */
export interface CronJobSummaryDto {
  /** Stable kebab-case identifier used to trigger the job. */
  slug: string;
  /** What the job does. */
  description: string;
  /** The job's normal schedule, as the NestJS CronExpression name (e.g. "EVERY_HOUR"). */
  schedule: string;
}

/** Response of `GET /cron/jobs`. */
export interface ListCronJobsResponseDto {
  jobs: CronJobSummaryDto[];
}

/** Response of `POST /cron/jobs/:slug/trigger` — the outcome of one manual run. */
export interface TriggerCronJobResponseDto {
  slug: string;
  /** True when the job ran to completion without throwing. */
  ran: boolean;
  /** Wall-clock duration of the run, in milliseconds. */
  durationMs: number;
  /** Present when `ran` is false: the error message from the failed run. */
  error?: string;
}
