# Pull Schedule: weekly & monthly frequencies + when-to-run selector

- **Date:** 2026-06-25
- **Status:** Planned
- **Author:** Chris Hoefgen
- **Linear:** [DEV-10569](https://linear.app/whalesync/issue/DEV-10569) (weekly/monthly + when-to-run), [DEV-10471](https://linear.app/whalesync/issue/DEV-10471) (daily time-of-day — subsumed by DEV-10569)

---

## Context / problem statement

Two Scratch design partners asked for richer pull scheduling:

- **DEV-10471** (William, ordotype.fr): the "daily" pull schedule has no way to choose *what time* it runs — he wants it early in the morning so data is fresh when he arrives.
- **DEV-10569** (Sarah, FinTech Collective): wants **weekly** and **monthly** cadences (she does a monthly Affinity backup) plus a **when-to-run** selector — time-of-day for daily, day-of-week + time for weekly, day-of-month + time for monthly.

DEV-10569's "when-to-run" part subsumes DEV-10471, so this single piece of work closes both issues.

**Current state of the code** (verified during planning):

- A `Schedule` row (`server/prisma/schema.prisma`) stores a single 5-field `cronExpression String` as the source of truth for frequency. `action` is a plain String (no DB enum). There is **no timezone stored anywhere** (not on `User`, `Workbook`, or `Schedule`).
- Frequency UI is 5 hardcoded cron presets (`PULL_SCHEDULE_OPTIONS` in `pull-schedule-helpers.ts`): Manual / 5 min / 30 min / Hourly / Daily — **no time-of-day control at all**.
- Cron is parsed with `cron-parser` v5.5.0. The single computation point is `ScheduleService.computeNextRunAt(cron) = CronExpressionParser.parse(cron).next().toDate()`. A `@Cron(EVERY_10_SECONDS)` evaluator (`scheduler.service.ts`) finds rows where `nextRunAt <= NOW()`, recomputes the next `nextRunAt`, and atomically claims them. Everything runs in **server/UTC time**.
- Three modals manage schedules: **Pull** (`ConnectionPullScheduleModal`, direct Schedule API via `applyScheduleRow`), **Routine** (`RoutineScheduleModal`, direct Schedule API), and **Sync** (`SyncScheduleModal`, whose cron rides the **sync config** and is persisted by the parent sync save, not a direct Schedule API call).

**Intended outcome:** users pick Daily/Weekly/Monthly with an explicit local time (and weekday / day-of-month), it runs unattended at that wall-clock time in their timezone, and the same upgraded picker is used by all three modals.

---

## Key decisions

1. **Scope — all three modals.** Build one reusable `ScheduleFrequencyPicker` and adopt it in the Pull, Sync, and Routine modals, unifying the currently-duplicated option lists.
2. **Timezone — tz-aware, stored per schedule.** Add a nullable `timezone` column; auto-capture the browser IANA timezone when the user sets a time-based schedule; show it as a label (no manual tz override in v1). See the dedicated reasoning section below.
3. **Monthly day-of-month — allow 1–31 with a warning** that days 29–31 skip shorter months (standard 5-field cron has no "last day of month" primitive, so it is not offered).
4. **Cron stays the source of truth.** The cron expression already encodes frequency + time + weekday/day-of-month. The only genuinely new state is the timezone. A pure, unit-tested helper module composes/decomposes/describes the cron for the UI.
5. **Timezone is captured only for time-based frequencies** (daily/weekly/monthly). Interval frequencies (5 min / 30 min / hourly) and "manual" are timezone-invariant and keep `timezone = null` — this avoids silently shifting existing UTC `0 0 * * *` ("Daily") rows when a user edits an unrelated field.

---

## Timezone approach: UTC-only vs tz-aware (decision + reasoning)

Two options were weighed.

### Option A — UTC-only cron, convert in the UI (rejected)
Store the cron as a fixed UTC expression and do all timezone handling in the frontend: render the UTC time in the user's local zone, and convert local → UTC when building the cron. **Appeal:** no schema migration and zero server changes.

**Why it fails: a static UTC cron cannot follow DST.** A timezone offset is not constant; a stored cron is. Example — New York user, "daily at 8:00 AM local":
- Winter (EST, UTC−5): 8 AM = `0 13 * * *`
- Summer (EDT, UTC−4): 8 AM = `0 12 * * *`

Only one can be stored, so the schedule silently drifts ±1 hour at each DST boundary (the 8 AM backup fires at 9 AM for half the year). For "early morning so the data's fresh when I arrive," that's a quiet wrong-result — the kind that generates "my schedule moved" support tickets, and it conflicts with the product principle *"surface failures; never silently succeed."*

**Weekly/monthly are worse than drift** — the offset can push the local time across a day or month boundary, so the local → UTC conversion is not a clean fixed transform:
- "Monday 11:00 PM Los Angeles" → **Tuesday** 07:00 UTC (the cron's day-of-week must shift).
- "31st at 11 PM local" can convert to the **1st** of the next month in UTC.
- Because the offset itself changes with DST, the "correct" converted day/hour differs between summer and winter — so a single stored UTC cron literally cannot represent some weekly/monthly local schedules correctly year-round.

### Option B — tz-aware cron with a stored timezone (chosen)
Store the cron with the wall-clock fields exactly as the user entered them, plus the IANA timezone, and let `cron-parser` interpret it: `CronExpressionParser.parse(cron, { tz }).next().toDate()`. The `{ tz }` option is confirmed present in cron-parser v5.5.0 (`CronExpressionOptions.tz?: string`). It computes the next wall-clock match in the named zone and converts to an absolute UTC instant **each run**, so it tracks DST automatically — daily/weekly/monthly stay pinned to the user's local time all year.

`.next().toDate()` still returns an absolute UTC `Date`, so the existing `nextRunAt <= NOW()` evaluator and the `atomicClaim` raw SQL (`WHERE "nextRunAt" <= NOW()`) remain valid unchanged.

**Cost:** one nullable `timezone` column (+ migration) and threading one optional parameter through ~5 server call sites — mechanical and well-scoped. This cost was judged worth it because correctness for weekly/monthly across the whole year (the headline of DEV-10569) is otherwise unachievable.

---

## Implementation plan

### Server

**1. `Schedule` model — add `timezone String?`** (nullable; `null` = UTC, backward compatible).
- `server/prisma/schema.prisma` — add `timezone String?` to the `Schedule` model.
- Add a migration `server/prisma/migrations/<timestamp>_schedule_timezone/migration.sql` (`ALTER TABLE "Schedule" ADD COLUMN "timezone" TEXT;`). **Do not run `prisma migrate`** — migrations are applied by the maintainer; run only `prisma generate`.

**2. `server/src/schedule/schedule.service.ts` — thread timezone through every cron computation.**
- `computeNextRunAt(cronExpression, timezone?)` → `parse(cronExpression, { tz: timezone ?? undefined }).next().toDate()`.
- `validateCronExpression(cronExpression, action, timezone?)` — parse with the same `{ tz }` so validation and execution agree; min-interval logic unchanged.
- `create` — persist `dto.timezone ?? null`; compute `nextRunAt` with it.
- `update` — **currently recomputes `nextRunAt` only when `cronExpression` changes and never persists tz.** Recompute when cron **or** timezone changed; persist `dto.timezone` when provided; the re-enable branch must call `computeNextRunAt(cron, dto.timezone ?? existing.timezone)`.
- `restoreSchedulesForConnectionMigration` — `computeNextRunAt(schedule.cronExpression, schedule.timezone)`.

**3. `server/src/schedule/scheduler.service.ts` — the evaluator recompute (critical).**
- Both recompute sites — `evaluateSchedules` (~line 87) and `evaluateRoutineSchedule` (~line 329) — must pass `schedule.timezone`. **If missed, every time-based schedule drifts back to UTC after its first fire.**

**4. `server/src/schedule/entities/schedule.entity.ts`** — map `timezone` from the Prisma row.

**5. Sync persistence path** (sync schedules ride the sync config, not a direct Schedule API call).
- `packages/shared-types/src/dto/sync/sync-api.ts` — add `scheduleTimezone?: string` to the `SaveSyncBody` interface and the `ExportSyncConfig` read type.
- `server/src/sync/sync-mapping.schema.ts` — add `scheduleTimezone: z.string().optional()` to `saveSyncBodySchema`. **This schema is `.strict()` — if the field is omitted there, any request carrying it is rejected with an unrecognized-key error.**
- `server/src/sync/sync.service.ts` — pass `timezone: body.scheduleTimezone` into the two `scheduleService.create(...)` calls (~376, ~541) and the `scheduleService.update(...)` call (~538); read it back at ~654 alongside `schedule`.

### shared-types

- `packages/shared-types/src/db/schedule.ts` — add `timezone: string | null` to the `Schedule` interface (file is tagged "keep in sync with schema.prisma").
- `packages/shared-types/src/dto/schedule/create-schedule.dto.ts` & `update-schedule.dto.ts` — add `timezone: z.string().optional()` to both zod schemas.
- **New pure helper module** `packages/shared-types/src/schedule/schedule-frequency.ts`, re-exported from the root barrel `src/index.ts` (the package already ships runtime JS + zod, so this is fine; the root barrel is lower-friction than a new subpath export). This is generic schedule logic, not connector knowledge, so it does not violate "keep connector knowledge out of frontends."
  - `buildScheduleCron(parts)` → cron string. Frequencies: `manual` (`''`), `every5m` (`*/5 * * * *`), `every30m` (`*/30 * * * *`), `hourly` (`0 * * * *`), `daily` (`M H * * *`), `weekly` (`M H * * D`), `monthly` (`M H DOM * *`), dev-only `everyMinute` (`* * * * *`).
  - `parseScheduleCron(cron)` → tagged union. Recognized presets/time-based crons return their structured parts (existing `0 0 * * *` must still map to **Daily @ 00:00** so legacy rows render unchanged); anything unrecognized returns `{ kind: 'custom', raw }`. **Never reconstruct a custom cron from parts — pass `raw` through untouched on save** (corruption guard).
  - `describeScheduleCron(cron, timezone)` → human label ("Daily at 8:00 AM", "Weekly on Mondays at 8:00 AM", "Monthly on the 5th at 8:00 AM · America/New_York"); falls back to the raw cron for `custom`. Dependency-free string formatting.

### Client

- **New `client/src/app/workbook/[id]/components/shared/ScheduleFrequencyPicker.tsx`**: a frequency `Select` (Manual / 5 min / 30 min / Hourly / Daily / Weekly / Monthly, + dev-only "Every minute" gated on `useDevTools`) with conditional controls — `TimeInput` from `@mantine/dates` (already installed) for daily/weekly/monthly, weekday `Select` for weekly, day-of-month `Select` 1–31 with the 29–31 warning for monthly — plus a timezone label. Props take/return a cron **string** (`value`/`onChange`) so existing per-row state shapes don't change; it seeds sub-controls via `parseScheduleCron` and emits via `buildScheduleCron`. Defaults: 08:00, Monday, day 1. An unrecognized (`custom`) cron renders read-only and is passed through unchanged.
- `pull-schedule-helpers.ts`:
  - Add `getScheduleTimezone(cron)`: returns `Intl.DateTimeFormat().resolvedOptions().timeZone` for time-based crons, `null` for interval/manual.
  - `applyScheduleRow` — **currently compares and sends only `cronExpression`.** Compare `(cron, timezone)` as a pair so a tz-only change isn't dropped; include `timezone` on both create and update.
- `ConnectionPullScheduleModal.tsx` — replace `FrequencySelect` with `ScheduleFrequencyPicker`; pass the derived `timezone` to every `applyScheduleRow`; seed existing rows from their stored `cronExpression`/`timezone`.
- `RoutineScheduleModal.tsx` — replace the `Select` with `ScheduleFrequencyPicker`; include `timezone` in create/update payloads; switch `getRoutineScheduleLabel` to `describeScheduleCron`.
- `SyncScheduleModal.tsx` — replace the `Select` with `ScheduleFrequencyPicker`; change `onSave` to `(cron, timezone)`; switch `getScheduleLabel` to `describeScheduleCron`.
- `MainPane/SyncToolbar.tsx` + the parent sync editor (`SyncEditor`) — carry a `scheduleTimezone` field alongside `schedule`, thread it through `onScheduleChange`/save into the sync API `scheduleTimezone`.
- `ScheduledRunsView.tsx` (~line 239) — third label site; switch its static cron lookup to `describeScheduleCron`.

---

## Edge cases & risks

- **Evaluator UTC drift (highest risk):** the two `computeNextRunAt` recompute sites in `scheduler.service.ts` must take `schedule.timezone`, or a time-based schedule reverts to UTC after its first fire.
- **`.strict()` sync schema:** `scheduleTimezone` must be added to `saveSyncBodySchema` in `server/src/sync/sync-mapping.schema.ts`, or requests carrying it are rejected. Keep it `.optional()`.
- **Timezone-only edits currently dropped** in three places — `ScheduleService.update` (recompute gate), `applyScheduleRow` (change detection), and `sync.service.ts` (the update call passes only `cronExpression`). All must compare/forward the timezone.
- **Legacy rows / no silent shift:** existing rows have `timezone = null` (UTC). Capturing tz only for time-based frequencies means interval rows stay UTC and don't move; `0 0 * * *` keeps mapping to Daily @ 00:00.
- **DST pathologies — add explicit unit tests:** spring-forward "gap" times (e.g. 02:30 on a day that jumps 02:00→03:00) and fall-back "duplicate" times (01:30 occurs twice). `cron-parser` handles both, but pin the behavior with tests so a future upgrade can't silently change it.
- **Custom/legacy crons:** `parseScheduleCron` returns `{ kind: 'custom', raw }` and the picker passes it through untouched; never rebuild from parts.
- **Debounce & unique key unaffected:** the 30s `SCHEDULE_DEBOUNCE_WINDOW_MS` keys on recent `dbJob` rows (weekly/monthly intervals dwarf it), and `@@unique([workbookId, action, entityId])` doesn't involve the cron or timezone.
- **No existing audit/PostHog tracking** in the schedule module; none is added by this change (sync's `trackCreateSync`/`trackUpdateSync` don't capture the cron today).

---

## Out of scope / known limitations

- **CLI sync round-trip:** reading the new `scheduleTimezone` is safe (the Rust `ExportSyncConfig` in `scratch-git-2/src/cli/api/mod.rs` ignores unknown fields), but a `scratchmd` sync **export → import** will silently reset the tz to null unless `pub schedule_timezone: Option<String>` is added to that struct. Keep the zod field `.optional()` so old CLI binaries keep working. Add the Rust field only if CLI tz preservation is required (follow-up).
- **No manual timezone-override dropdown** in v1 (auto-captures browser tz).
- **No "last day of month"** — standard 5-field cron has no such primitive.

---

## Verification

**Unit tests**
- shared-types: `buildScheduleCron`/`parseScheduleCron` round-trip for every frequency incl. the legacy presets (`0 0 * * *` → Daily @ 00:00) and the `custom` pass-through; `describeScheduleCron` labels (daily/weekly/monthly incl. DOM 29–31).
- server `schedule.service.spec`: `computeNextRunAt('0 8 * * *', 'America/New_York')` yields the correct UTC instant; **DST cases** (spring-forward gap, fall-back duplicate); `update` recomputes `nextRunAt` on a **timezone-only** change.
- server `scheduler.service.spec`: assert the evaluator passes `schedule.timezone` to the recompute (no UTC drift after first fire).
- server sync spec: `scheduleTimezone` survives create → read and update; confirm the `.strict()` schema accepts it.

**Build / lint:** from repo root — `yarn build`, `yarn lint`, `yarn typecheck` (run `prisma generate` after the schema edit; do **not** run `prisma migrate`).

**Manual (web app)**
1. Connection pull-schedule modal → **Weekly → Monday → 08:00** → Save. Confirm (read-only DB query via `terraform/tools/connect_to_gcp_db_readonly.sh test`, or local psql) the row has `cronExpression = '0 8 * * 1'`, `timezone = '<browser tz>'`, and `nextRunAt` = next Monday 08:00 in that zone (as UTC).
2. **Monthly → day 31** → confirm the 29–31 warning shows.
3. Reopen the modal → confirm it re-seeds the picker (frequency/time/day) and shows the timezone label.
4. Repeat for a **Routine** schedule and a **Sync** schedule to confirm the unified picker + tz round-trip through both persistence paths.
5. Edit an existing **hourly** schedule and confirm `timezone` stays `null` (no silent shift).

**CLI suite:** since the sync request shape changed, run the `workspace-sync` suite in `/scratch-cli-tests` to confirm the additive optional `scheduleTimezone` doesn't regress the sync round-trip.
