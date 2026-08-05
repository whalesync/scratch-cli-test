# Cron module

Scheduled background work for the server. Each cron job is a small `@Injectable()` service
with a method decorated `@Cron(CronExpression.…)` (NestJS `@nestjs/schedule`). The module
also exposes an **admin-only dev tool** for listing and manually triggering these jobs.

## Layout

The dev tool is split into a **read-only list** (served everywhere the browser can reach) and a
**debug trigger** (served only where the schedules run). This split is what lets the API service list
the jobs without loading the `@Cron` services — instantiating those on the API service would
double-fire every cron job.

- `*.service.ts` — one service per job (e.g. `record-count-refresh.service.ts`,
  `old-job-cleanup.service.ts`, `routine-run-reaper.service.ts`, `stale-job-reaper.service.ts`,
  `expired-api-token-cleanup.service.ts`). The `@Cron` method holds the job logic.
- `cron-job-definitions.ts` — the static `CRON_JOB_DEFINITIONS` list (`{ slug, description, schedule }`
  per job), the single source of truth the list is served from, plus `isManualCronTriggeringAllowed()`
  (the deployed-block policy), the shared 403 message, and `getCronServiceLogsUrl()` (the GCP Cloud
  Logging deep link for the cron service, deployed environments only).
- `cron.controller.ts` — `CronController`, the **read-only** `GET /cron/jobs` (list). Dependency-free
  (no `@Cron` services). **Admin only** (`ScratchAuthGuard` + `hasAdminToolsPermission`). Backs the
  "Cron Jobs" dev-tool panel in the web client (`/settings/dev/cron`).
- `cron-list.module.ts` — `CronListModule` hosting `CronController`. Mounted on the API service
  (`isAPIService()`), which is what the browser talks to.
- `cron-debug.controller.ts` — `CronDebugController`, the **write** side: `POST /cron/jobs/:slug/trigger`
  (run now). Injects the `@Cron` services and refuses the trigger with a 403 in deployed environments.
- `cron.module.ts` — registers `ScheduleModule.forRoot()`, every cron service, and `CronDebugController`.
  Mounted only on the cron service / local monolith (`isCronService()`), where the schedules run.

In the local monolith both modules mount: `CronController` owns `GET /cron/jobs` and `CronDebugController`
owns `POST /cron/jobs/:slug/trigger`, so the two `@Controller('cron')` classes never collide.

## Triggering is local-dev only

Manual triggering is blocked in every deployed (Cloud Run) environment and allowed only in local
development — `isManualCronTriggeringAllowed()` returns `!ScratchConfigService.isRunningInCloudRun()`.
`CronDebugController` enforces it (403), and `CronController` reports it to the client via
`ListCronJobsResponseDto.canTrigger`, which disables the panel's "Trigger" button. Listing works
everywhere; on the deployed API service the trigger route simply isn't present (`CronDebugController`
lives only where the schedules run).

## Cron service logs link

`CronController` also returns `ListCronJobsResponseDto.cronServiceLogsUrl` — a GCP Cloud Logging deep
link (`getCronServiceLogsUrl()`) pre-filtered to the `cron-service` Cloud Run logs for the current
environment's project (`spv1eu-test` / `spv1eu-production`). It's null in local development, so the
panel's "View cron service logs" button appears only in deployed environments. The Cloud Run service
name, region, and per-env project ids live in `cron-job-definitions.ts`; keep them in sync with
`terraform/modules/env/services.tf` and `terraform/envs/*` if the infra changes.

## Adding a new cron job

1. Create `<job-name>.service.ts` with an `@Injectable()` class and a single
   `@Cron(CronExpression.…)`-decorated method containing the logic. Make it idempotent and
   non-fatal (catch + `WSLogger.warn`), since it runs unattended and may overlap retries.
2. Register the service in **both** the `providers` and `exports` arrays of `cron.module.ts`.
3. **Add its metadata to `CRON_JOB_DEFINITIONS` in `cron-job-definitions.ts`** — a
   `{ slug, description, schedule }` entry (keep `schedule` in sync with the `@Cron` expression). This
   is what makes the job appear in the dev-tool list (`CronController`) everywhere.
4. **Add its runner to `runnerBySlug()` in `cron-debug.controller.ts`** — inject the service into the
   controller and map the slug to the same method the `@Cron` schedule calls. This is what makes the
   job manually triggerable (in local dev); a job in `CRON_JOB_DEFINITIONS` but missing from
   `runnerBySlug()` is listable but 404s on trigger.

## Conventions

- Long sweeps should page over their work set in batches (see `old-job-cleanup.service.ts` /
  `record-count-refresh.service.ts`) and skip records that shouldn't be touched (e.g.
  `isPendingDelete` workbooks).
- Log a one-line summary at start and finish with `WSLogger.info` (`source` = the service name).
- A manual trigger runs the job synchronously and the controller reports
  `{ ran, durationMs, error? }`, so a failing job surfaces in the dev tool rather than silently
  succeeding.
