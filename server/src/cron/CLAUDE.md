# Cron module

Scheduled background work for the server. Each cron job is a small `@Injectable()` service
with a method decorated `@Cron(CronExpression.…)` (NestJS `@nestjs/schedule`). The module
also exposes an **admin-only dev tool** for listing and manually triggering these jobs.

## Layout

- `cron.module.ts` — registers `ScheduleModule.forRoot()`, every cron service, and the
  `CronController`.
- `*.service.ts` — one service per job (e.g. `record-count-refresh.service.ts`,
  `old-job-cleanup.service.ts`, `routine-run-reaper.service.ts`, `stale-job-reaper.service.ts`,
  `expired-api-token-cleanup.service.ts`). The `@Cron` method holds the job logic.
- `cron.controller.ts` — `GET /cron/jobs` (list) and `POST /cron/jobs/:slug/trigger` (run
  now). **Admin only** (`ScratchAuthGuard` + `hasAdminToolsPermission`). Backs the "Cron Jobs"
  dev-tool panel in the web client (`/settings/dev/cron`).

## Adding a new cron job

1. Create `<job-name>.service.ts` with an `@Injectable()` class and a single
   `@Cron(CronExpression.…)`-decorated method containing the logic. Make it idempotent and
   non-fatal (catch + `WSLogger.warn`), since it runs unattended and may overlap retries.
2. Register the service in **both** the `providers` and `exports` arrays of `cron.module.ts`.
3. **Add it to the `cronJobs()` list in `cron.controller.ts`** — inject the service into the
   controller and add a `{ slug, description, schedule, run }` entry whose `run` calls the same
   method the `@Cron` schedule calls. This is what makes the job listable and manually
   triggerable from the dev tool; a job that's scheduled but missing from this list runs on its
   schedule but can't be triggered for testing. Keep the `schedule` string in sync with the
   `@Cron` expression on the service.

## Conventions

- Long sweeps should page over their work set in batches (see `old-job-cleanup.service.ts` /
  `record-count-refresh.service.ts`) and skip records that shouldn't be touched (e.g.
  `isPendingDelete` workbooks).
- Log a one-line summary at start and finish with `WSLogger.info` (`source` = the service name).
- A manual trigger runs the job synchronously and the controller reports
  `{ ran, durationMs, error? }`, so a failing job surfaces in the dev tool rather than silently
  succeeding.
