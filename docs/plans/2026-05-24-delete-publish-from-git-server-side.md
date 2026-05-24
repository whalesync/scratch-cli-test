# Delete `publish-v2/run-from-git` (server-side counterpart of Phase 7a)

**Date**: 2026-05-24
**Status**: Blocked on ≥7-day zero-caller window + perf gate. Expected ship-window ~2026-06-02 to 2026-06-09.
**Linear**: TBD (DEV team)
**Author**: Curtis Fonger
**Related**: [`resolved/2026-05-17-simplify-local-workspace-architecture.md`](resolved/2026-05-17-simplify-local-workspace-architecture.md) — Phase 7a (caller-side removal) shipped on `mr39` 2026-05-23; this plan is the server-side counterpart. Originally tracked inline as "Phase 7" in the main plan; extracted into its own doc 2026-05-24 to keep the parent plan compact now that everything else there has shipped or been cancelled.

**Scope**: Once the in-house and external `publish-v2/run-from-git` callers have rolled forward off older desktop installs, delete the server endpoint, the worker, the service, the DTO, the parity test, and the smoke test. Pure deletion phase — Phase 7a already removed every in-tree caller.

## Context (carried over from Phase 7a)

Phase 7a (shipped `mr39` 2026-05-23) deleted the caller-side surface: `scratchmd plan-publish` + `scratchmd publish-from-git`, the CLI api client method, the scratch-git-2 service's `POST /api/repo/publish-plan/:id/build` route + `TempWorktree` helpers, and `shared/plan_publish.rs` (~855 LOC). Net diff +26 / −2271 across 21 files. The server endpoint + worker + DTO stayed alive to keep older desktop installs working until they auto-update past the cutover.

**Caller observation snapshot (queried `Job` table on 2026-05-23):** `publish-from-git` job has 46 total entries, 5 in the last 7 days, 41 in the last 30 days; last seen 2026-05-22T18:08 UTC. Five distinct users in the last 14 days:

| User                   | Calls | Last seen  | Notes                                                         |
| ---------------------- | ----- | ---------- | ------------------------------------------------------------- |
| `jacobg@mogxp.com`     | 10    | 2026-05-15 | External; dormant (8 days). Likely older desktop install.     |
| `ryder@whalesync.com`  | 4     | 2026-05-19 | Internal. Ask team to update desktop.                         |
| `rob@whalesync.com`    | 4     | 2026-05-13 | Internal. Ask team to update desktop.                         |
| `curtis@whalesync.com` | 4     | 2026-05-22 | Internal (author). Older local install / dogfood.             |
| `mj@causeit.org`       | 1     | 2026-05-22 | External; co-published on a 2026-05-22 call. Asked to update. |

`runContext` is `""` on every row (the legacy enqueue path was never wired to populate it), so we can't distinguish desktop/CLI/web from the row itself. Web client doesn't call `run-from-git` (`client/src/lib/api/workbook.ts:489,507` uses `publish-v2/plan-job` + `run-job`); current desktop code doesn't call it either. The remaining 5 callers are almost certainly older auto-updated desktop installs.

## What stays alive today (the deletion target)

- Server endpoints `POST /workbooks/:id/publish-v2/run-from-git` (web variant, `publish-plan.controller.ts:115`) and `POST /cli/v1/workbooks/:id/publish-v2/run-from-git` (CLI variant, `cli-workbook.controller.ts:418`).
- `PublishFromGitService`, `PublishFromGitJobHandler`, `enqueuePublishFromGitJob`, `PublishFromGitDto`, `JobType.PublishFromGit` (= `'publish-from-git'`), and the 4 metric enum entries (`JOB_PUBLISH_FROM_GIT_{COMPLETED,FAILED,CANCELED,STALLED}`).
- Parity test `apply-patches-vs-legacy-invariants.spec.ts` — server-side only, doesn't depend on the CLI binary, still valid coverage until the endpoint dies.
- Smoke test `smoke-tests/publish/publish-from-git-happy-path.spec.ts` — uses raw HTTP via `TestApiClient`, not the CLI binary. Replaced by the new `publish-upload-patch-happy-path.spec.ts` from F13 (shipped 2026-05-24, `mr45`); both run side-by-side until Phase 7 drops the legacy one.

## What to delete

- The `run-from-git` endpoint in both `cli-workbook.controller.ts` and `publish-plan.controller.ts`.
- `enqueuePublishFromGitJob` and `publish-from-git.service.ts` (+ the `BullEnqueuerService` method + module wiring).
- `JobType.PublishFromGit` enum value + the 4 `JOB_PUBLISH_FROM_GIT_*` metric entries in `server/src/metrics/custom-metrics.ts`.
- `PublishFromGitJobHandler` + `PublishFromGitJobDefinition` + the `publish-from-git.job.ts` file.
- `PublishFromGitDto` (`packages/shared-types/src/dto/publish-v2.dto.ts` or wherever it lives).
- The parity test `apply-patches-vs-legacy-invariants.spec.ts` introduced in Phase 1.
- The smoke test `smoke-tests/publish/publish-from-git-happy-path.spec.ts` + its `runPublishFromGit` helper in `smoke-tests/helpers/cli-publish-fixtures.ts`.

**Note on completed scope vs. original plan:** the original Phase 7 list also included `cli/commands/plan_publish.rs` and `shared/plan_publish.rs` (~855 LOC) — both shipped in Phase 7a.

## Pre-flight checks

Run these before opening the deletion MR:

1. **Caller window.** Query the `Job` table for `publish-from-git` rows in the last 7 days. Must be zero for ≥7 consecutive days. Cross-reference Cloud Monitoring's `job_publish_from_git_completed` metric for the same window — should also be flat at zero.
2. **In-house team check.** Ping `ryder@`, `rob@`, `curtis@` (internal) to confirm their desktop installs have rolled forward. Easiest signal: ask them to launch the app and check Settings → About for a version >= the mr39 release tag.
3. **External callers.** `jacobg@mogxp.com` was dormant on 2026-05-23 (last seen 2026-05-15); if still silent at deletion time, no action needed. `mj@causeit.org` was asked to update post-call; confirm before deletion or accept the risk that one external user gets a hard 404 on next publish (their data is safe — server rejects the request; they retry via the new path automatically once they update).

## Perf gate

Before deletion, measure p50/p95 latency of the new path's `/upload-patch` → first published operation on the Monorepo workspace (135k files). Must be within 2× today's `run-from-git` baseline. If it regresses beyond that, fix before deletion — don't ship the regression and clean up later.

Today's baseline (mr31 dogfood, 2026-05-21): publish-v2 `/upload-patch` round-trip on the Monorepo measured 2.9s for `files upload` and 1.7s for the publish pre-flight. The legacy `run-from-git` baseline isn't directly comparable (it bundles plan + run + upload into one call), but rough numbers: ~30s for the full Monorepo flow on a warm cache. New path is faster wall-clock; the perf gate is about confirming nothing regressed under the hood, not about justifying the cutover.

## Done when

- `run-from-git` has been removed from the server (controllers, service, worker, DTO, metric enum).
- Parity + smoke tests are gone (`apply-patches-vs-legacy-invariants.spec.ts`, `publish-from-git-happy-path.spec.ts`, the `runPublishFromGit` helper).
- Perf gate cleared and documented.
- `Job` table has had zero `publish-from-git` rows for ≥7 consecutive days at deletion time.

## Risks

- **One last external user hits a 404.** If `mj@causeit.org` or another straggler hasn't updated, their next publish attempt fails hard. Mitigation: error response is a clean 404 (or 405 if we keep the route but throw) — no data loss, just a UX failure. They retry after updating. Accept the risk; the ≥7-day window makes it small.
- **Phase 7a's caller snapshot is incomplete.** `runContext` was always `""` so we couldn't distinguish call sources. Possible (unlikely) that a script or integration we don't know about still posts to the endpoint. Mitigation: the zero-caller window catches this — if anything is calling it, we'll see rows.
- **Perf gate fails.** If the new path is more than 2× slower than the old, we have to either accept the regression (no), fix the underlying issue (best), or postpone the deletion (acceptable). Most likely cause would be the `ApplyPatchesJob` worker doing per-patch work that the old `run-from-git` batched — measurable, fixable.
