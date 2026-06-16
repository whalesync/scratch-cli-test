# Routines: Step Execution & BullMQ Job Orchestration

> **Companion to [Routines: File-Defined Workflow Pipelines](./routines-design.md).** This document evaluates _how_ a routine waits for each step's job to finish and advances to the next, and whether the design's proposed "poll `DbJob` status" loop is robust against hung runs. It is a working/iteration doc — the design doc is the source of truth for everything else (run/step modeling, the `schedule:` trigger, the review ladder).

## Overview

This document evaluates the step-execution mechanism proposed in the [routines design](./routines-design.md) — `RoutineExecutorService.execute(runId)` running steps sequentially and **polling `DbJob.status` every 5 seconds** until terminal, with a 30-minute per-step timeout — and lays out better-grounded alternatives built on BullMQ features the codebase does not yet use.

The short version: the polling loop is the one part of the design with no durable owner. Every other long-running coordinator in this codebase is either a BullMQ job on the worker role (crash-recovered by the stalled mechanism) or a short, atomically-claimed `@Cron` evaluator. The executor loop is neither — it is in-memory state on whichever instance happened to handle the trigger, and nothing reaps it if that instance goes away. That is the source of the hung-run risk.

## Design requirements

Routines are a YAML-defined pipeline system in the spirit of GitLab CI / GitHub Actions: a routine is a graph of discrete actions, and each action is a first-class unit of work. Two requirements follow from that framing and constrain every option below:

1. **Each action is its own `DbJob`.** A `pull`, `sync`, `publish-plan`, or `publish` step must be enqueued and tracked as an independent `DbJob` — its own status, progress, logs, retry, and cancellation — exactly as that action runs when triggered standalone today. A user looking at a routine run should see the same per-action job they would see if they ran the action by hand. (The proposed design already does this: it enqueues one job per step and records it on `RoutineRunStep.jobId`.)
2. **Step-to-step advancement must survive a process restart.** The mechanism that moves a run from step N to step N+1 must not live only in one instance's memory, or a redeploy mid-run hangs the `RoutineRun` (see below).

These two requirements pull in tension under a naive design — per-step jobs are easy, but the _thing that chains them_ is where the durability is usually lost. The job of this document is to find the mechanism that satisfies both.

> **Revision note.** An earlier draft of this doc recommended **Option B (Process Step Jobs)** — collapsing the whole routine into one BullMQ job. That satisfies requirement 2 (durable advancement) but **violates requirement 1**: the routine becomes a single `DbJob` and the individual actions are no longer independently tracked. Option B is therefore rejected (kept below for the record), and the recommendation now centers on the two designs that keep one `DbJob` per action: a durable orchestrator (Option A) and a BullMQ flow of per-step jobs (Option C). The publish action — historically the awkward one — is made to fit cleanly by a new self-planning publish job (see [The self-planning publish job](#the-self-planning-publish-job)).

## Why the polling design is fragile

The mechanics of `DbJob` are actually fine for a poller to read: the worker writes the terminal status (`completed`/`failed`/`canceled`) **synchronously inside `processJob`, before the BullMQ job is acked** (`server/src/worker/bull-worker.service.ts:248-266`), and `JobService.updateJobStatus` guards the write with `WHERE status != 'canceled'` (`server/src/job/job.service.ts:92`) so a late worker write can never clobber a user cancel. The `DbJob` row is durable in Postgres for 60 days (`RETENTION_DAYS` in `server/src/cron/old-job-cleanup.service.ts`), well past the BullMQ object's eviction at `removeOnComplete`/`removeOnFail: 100`. So as a _signal_, `DbJob.status` is reliable. The fragility is not in what the poller reads; it is in **where the poller runs and what happens when that process dies.**

Concretely:

1. **The executor is in-memory state on one instance, with no persisted owner.** `RoutineService.triggerRun` starts `execute(runId)` as a fire-and-forget async method that lives in memory for up to `(#steps × 30 min)`. Nothing records _which_ instance is driving the loop. `RoutineRun.currentStepIndex`/`status` record progress, but they are advisory: they say "we were on step 2," not "instance X is still polling step 2." There is no lease, no claim, no `routineRunDriverInstanceId` column. Contrast `SchedulerService.atomicClaim` (`server/src/schedule/scheduler.service.ts:73`), which is exactly the atomic-claim primitive this loop lacks.

2. **Process restart mid-run hangs the run with nothing to reap it.** This is the failure the design is right to worry about. Cloud Run instances are explicitly treated as ephemeral (see the `maxStalledCount` comment at `bull-worker.service.ts:64-65`). On redeploy / scale-down / crash, the in-memory loop vanishes. The step's underlying job keeps running on a worker and writes `DbJob=completed` normally — but **no executor is left to observe it and advance the run.** `RoutineRun` stays `running` and `RoutineRunStep` stays `running` forever. The step's work succeeded; the run never moves. Critically, **nothing reaps this**: `StaleJobReaperService` (`server/src/cron/stale-job-reaper.service.ts`) only touches `DbJob` rows stuck in `created`, and it has no notion of `RoutineRun` at all. `DbJob`s have a backstop; routine runs have none.

3. **No multi-instance ownership.** Triggers come from two roles: the REST controller (API role) and `SchedulerService` (CRON role; registered only when `ScratchConfigService.isCronService()`, `server/src/schedule/schedule.module.ts:28`). "One run at a time" is presumably a status check at trigger time, but a status check is check-then-act with no atomic guard. Two instances, or one retried trigger, can both enter `execute(runId)` for the same run and double-enqueue every step.

4. **The 30-minute per-step timeout fights the worker, it doesn't stop it.** The timeout is a wall-clock on the _poll loop_, unrelated to the worker's BullMQ lock (`WORKER_LOCK_TIMEOUT_MS`, default 120 s, auto-renewed, so a 30-minute publish keeps its lock fine). When the timeout fires, the publish job is **still running on the worker.** Unless the executor also calls `JobService.cancelJob`, the run is marked failed while the publish keeps shipping approved changes to the external service — a direct violation of "keep the user in control" and "default to non-destructive." If it _does_ cancel, cancellation is only honored at the next `checkpoint()`, and a publish mid-`runPipeline` may have already pushed a subset of records (a partial publish surfaced only in progress, not status). The design doc's Open Question #1 already flags that large-folder publishes legitimately exceed 30 minutes, so the timeout will also abandon perfectly healthy jobs.

5. **Per-step latency.** A 5 s poll adds up to ~5 s of dead time per step. Across a four-step routine that is up to ~20 s of pure waiting per run on top of the real work.

6. **Status-only success detection misreads publishes.** A `JobType.Publish` job ends `DbJob=completed` even when every record was rejected by the connector; per-record failures live only in `progress.publicProgress.failedCount`/`failedOperations` (`server/src/worker/jobs/job-definitions/publish.job.ts:39-47, 313-318`), never in `DbJob.status`. A poller keyed on `status == 'completed'` marks the step succeeded and advances, masking a total publish failure. This concern is independent of which mechanism replaces polling — any of them must inspect `publicProgress.failedCount`, not just terminal status.

The common thread: items 1-4 all reduce to _the coordinator has no durable existence outside one process's memory._ That is the property BullMQ's own job machinery already provides for every other long-running operation in this system.

## BullMQ mechanisms that help

These are the relevant primitives, with the one gotcha each that matters for this design.

**(a) Flows / `FlowProducer` — modeling a strictly sequential chain.** `new FlowProducer({ connection })` then `.add({ name, queueName, children: [...] })` enqueues a whole parent/child tree **atomically**. Execution is leaf-first, root-last: a parent sits in the `waiting-children` state and is not pickable by a worker until its children complete. So a strict `pull → sync → publish-plan → publish` chain is expressed _inverted_ — `publish` is the root, its single child is `publish-plan`, whose single child is `sync`, whose single child (the deepest leaf, runs first) is `pull`. Each later step reads the previous step's output via `await job.getChildrenValues()`. All four nodes can target the **same** `worker-queue`; the existing worker dispatches on `job.name`. Source: https://docs.bullmq.io/guide/flows

**(b) Flow failure control — and the opt-in `failParentOnFailure`.** This is the load-bearing gotcha. **By default a child's failure does not propagate to its parent** — the docs state that a child without `failParentOnFailure` "will not affect the parent's state if they fail," so the failed dependency is never satisfied and the parent never advances out of `waiting-children`. That is the same orphaned-coordinator hang the design is trying to avoid, reintroduced in a new place. To get fail-fast you must opt in per child:

- `failParentOnFailure: true` on **every** non-root step — a failed step (after its own `attempts` are exhausted) cascades failure up to the root, so the whole routine fails cleanly with no orphaned waiting parent. Propagation is _lazy_ (a worker must pick up the parent to transition it), so the exact semantics should be verified against our pinned BullMQ version.
- `ignoreDependencyOnFailure` / `removeDependencyOnFailure` — the opposite intent (parent **succeeds** despite the failed child). Wrong for a hard-stop routine; listed only so they are not chosen by mistake.

Sources: https://docs.bullmq.io/guide/flows/fail-parent , https://docs.bullmq.io/guide/flows/ignore-dependency , https://docs.bullmq.io/guide/flows/remove-dependency

**(c) Stalled-job auto-recovery — the real anti-hung-job primitive.** This is what the polling loop fundamentally lacks. A worker holds a Redis lock (`lockDuration`) on an active job and renews it on an interval; when the process dies, renewal stops, the lock lapses, and on the next `stalledInterval` sweep any live worker re-queues the job — up to `maxStalledCount` times, after which it is failed (so a poison job fails fast rather than cycling). The repo already runs this with `maxStalledCount: 20` (`bull-worker.service.ts:71`). The key insight: this is _Redis-persisted state outside any process._ A crashed coordinator that is itself a BullMQ job leaves a recoverable footprint; an in-memory loop leaves nothing. For a flow, the gaps _between_ steps are also covered — a parent in `waiting-children` holds no lock and needs no live process; it is promoted by the last child's completion. Source: https://docs.bullmq.io/guide/workers/stalled-jobs

**(d) Event-driven waiting — `QueueEvents` + `job.waitUntilFinished`.** `new QueueEvents('worker-queue', { connection })` emits **global** `completed`/`failed`/`progress` for jobs run by _any_ worker on _any_ instance (the Worker's own `worker.on('completed')` is local to the process that ran the job — which is why the API/cron instance running `execute()` never sees it today). `await job.waitUntilFinished(queueEvents, ttlMs)` resolves with the return value or rejects on failure/timeout — a near-instant drop-in for the 5 s poll. Two costs: it needs a **dedicated Redis connection**, and — the critical caveat — **it is not durable across a restart of the waiting process.** If the orchestrator restarts, the pending promise is gone; the Redis stream's delivery guarantee only covers a dropped connection that reconnects, not a fresh process. So events are a fast-path trigger, never the source of truth. Sources: https://docs.bullmq.io/guide/events , https://api.docs.bullmq.io/classes/v5.Job.html

**(e) "Process Step Jobs" — the single-job state machine.** The simplest alternative to a separate orchestrator: model the _entire routine_ as **one** BullMQ job carrying `{ currentRoutineStep }` in `job.data`. A `while (step !== Finish)` loop runs each stage; between stages the handler calls `await job.updateData({ currentRoutineStep: next })` to checkpoint, then either falls through or yields via `await job.moveToDelayed(Date.now(), token); throw new DelayedError()`. Because the step is persisted to Redis before yielding, a crash/restart resumes at the stored step. One gotcha: manual `moveToDelayed`/`DelayedError` moves do **not** increment `attemptsMade`, so bound restarts with the `maxStartedAttempts` worker option, not `attempts`. Source: https://docs.bullmq.io/patterns/process-step-jobs

**(f) Idempotency/retry options, and NO built-in timeout.** A deterministic `jobId` (e.g. `jobId: pull-${workbookId}-${runId}`) makes re-enqueue a no-op while the job still exists; `deduplication: { id, ttl }` gives time-windowed throttling; `attempts` + `backoff: { type: 'exponential', delay }` cover transient failures. The single most important fact for the 30-minute-timeout question: **BullMQ has no built-in per-job timeout.** The docs say so plainly — "BullMQ does not provide a specific mechanism to timeout jobs, however this can be accomplished... with a custom timeout code in the worker's process function" — and recommend `AbortController` + `setTimeout`. This codebase **already has** that wiring: `processJob` builds an `AbortController`, threads `abortSignal` into every handler, and aborts on the cancel flag at each `checkpoint` (`bull-worker.service.ts:182, 215-236, 245`). So a per-action timeout becomes "read `timeoutMs` from job data, `controller.abort()` on expiry," reusing the abort path that already exists, and — unlike the executor's wall-clock — it actually stops the work instead of abandoning it. Sources: https://docs.bullmq.io/patterns/timeout-jobs , https://docs.bullmq.io/guide/jobs/job-ids , https://docs.bullmq.io/guide/jobs/deduplication

## The self-planning publish job

Every per-step-job design has historically tripped on the same thing: **a publish is not enqueued like the other actions.** It is a three-call shape the caller performs _around_ the job (as `SchedulerService` does for scheduled publishes, `scheduler.service.ts:264-286`):

1. `PublishPlanBuildService.createPipeline(...)` — synchronously create the `PublishPlan` row (status `Planning`) and get a `pipelineId`.
2. `BullEnqueuerService.enqueuePlanPipelineJob(..., pipelineId, runAfterPlan, ...)` — enqueue the `JobType.Publish` job for that pipeline.
3. `PublishPlanBuildService.setActiveJob(pipelineId, jobId)` — link the job back to the pipeline.

The only reason `createPipeline` runs synchronously up front is that the _caller_ (a controller, the desktop modal) needs the `pipelineId` immediately to navigate to and track the plan. **A routine step does not** — it can discover the `pipelineId` from the finished job and record it on `RoutineRunStep.pipelineId` (a field the design already carries). And the publish job already does the planning itself: `PublishJobHandler.run` calls `buildPipeline(...)`, which **already creates the pipeline inline when no `existingPipelineId` is passed** ("Direct flow: create pipeline inline", `publish-plan-build.service.ts:250-255`), then branches on `runAfterPlan`.

So the new job is small and reuses everything: a **self-planning publish job** that takes a `folder`/`connection` (not a pre-created `pipelineId`), creates its own pipeline as phase one, builds the plan, and — for `publish` — runs it; for `publish-plan`, stops after planning with the plan left staged for manual review. It writes the resulting `pipelineId` onto its progress/result so the routine can store it on the step.

Net effect: **the publish action becomes a single, self-contained `DbJob`, enqueued exactly like `pull` and `sync`** — no synchronous pre-work in the routine coordinator, no special node in a flow. This is the change that lets a publish step participate uniformly in the per-step-job designs below.

- It can be a new `JobType` (e.g. `RoutinePublish`) or the existing `JobType.Publish` taught to self-create its pipeline when `pipelineId` is omitted. Either way the planning/running logic in `PublishJobHandler` and `buildPipeline` is reused unchanged, and the existing UI/desktop publish path (which still wants the synchronous `pipelineId`) is left untouched.
- The `publish-plan` vs `publish` distinction stays the `runAfterPlan` flag, exactly as today.

## Candidate designs

With the self-planning publish job in hand, every action — `pull`, `sync`, `publish-plan`, `publish` — is a uniform single `DbJob` enqueued the same way, so **requirement 1 is satisfied by all of the per-step-job designs.** What is left to choose is the mechanism that _chains_ those jobs (requirement 2). All designs reuse the single `worker-queue`, the separate enqueuer/worker split, the `DbJob` mirror, and the `job-cancel:*` cancellation path unchanged.

### Option A — Durable, event-driven orchestrator (per-step jobs)

Keep `RoutineExecutorService` as a coordinator that enqueues one job per step, but make it durable instead of an in-memory polling loop.

```
triggerRun -> atomicClaim(runId)             (mirror SchedulerService.atomicClaim)
           -> for step at currentStepIndex:
                enqueue the step's action as its own DbJob
                  (existing enqueuers: pull / sync / self-planning publish)
                await job.waitUntilFinished(queueEvents, perActionTimeoutMs)   // fast path
                mirror DbJob status -> RoutineRunStep; inspect publicProgress.failedCount
                advance currentStepIndex (persisted to RoutineRun)
+ RoutineRunReaperService (@Cron): a RoutineRun stuck `running` whose current
  step's DbJob is already terminal is resumed from currentStepIndex (or failed).
  This is the backstop that makes a process restart recoverable.
```

- **Pros:** Each action is its own `DbJob` via the **existing enqueuers, unchanged** (requirement 1 for free). Coordination is plain procedural code, so conditional/dynamic step logic, per-step timeouts, and `failedCount` handling are trivial to express. Smallest delta from the proposed design; with the self-planning publish job, even a publish step is just another enqueue.
- **Cons:** The orchestrator is still a live process that can die mid-`await`. It is crash-safe **only** because of the bolted-on `RoutineRunReaperService` + the persisted `currentStepIndex` cursor + the `atomicClaim`. `waitUntilFinished` needs a dedicated `QueueEvents` connection and a startup reconcile (the pending promise is lost on restart; the reaper is what actually recovers the run). You are hand-building the durable advancement that Option C gets natively from BullMQ.
- **Reuses existing infra:** Very high (existing enqueuers verbatim), plus one new cron reaper.

### Option B — Process Step Jobs (one job per routine run) — REJECTED

The whole routine as **one** BullMQ job advancing through `RoutineStep.{Pull, Sync, PublishPlan, Publish, Finish}` via `updateData` + `moveToDelayed` (the [single-job state machine](#bullmq-mechanisms-that-help), mechanism (e)).

This is durable and cheap — it inherits stalled-recovery and `maxStartedAttempts` for free and needs no coordinator, reaper, or flow path — **but it collapses the routine into a single `DbJob`.** The individual `pull`/`sync`/`publish` actions are no longer independently tracked, observable, retryable, or cancelable. That directly **violates requirement 1**, which is the property the routine system is meant to expose (GitLab/Actions-style, one job per action). Rejected on that basis. Recorded here only so the trade-off is explicit: B is what you would pick if per-action visibility did _not_ matter.

### Option C — BullMQ flow of per-step jobs (recommended)

Model the routine as a flow whose nodes are the per-step jobs, nested so they run in order (leaf-first), with `failParentOnFailure: true` on every non-root node and a thin `routine` finalizer root.

```
FlowProducer.add({
  name: 'routine', queueName: 'worker-queue', data: { routineRunId },   // finalizer, runs last
  children: [{ name: 'publish', queueName, opts: { jobId, failParentOnFailure: true },        // self-planning publish job
    children: [{ name: 'publish-plan', queueName, opts: { jobId, failParentOnFailure: true },
      children: [{ name: 'sync', queueName, opts: { jobId, failParentOnFailure: true },
        children: [{ name: 'pull', queueName, opts: { jobId, failParentOnFailure: true } }] }] }] }],
})
// leaf-first execution order: pull -> sync -> publish-plan -> publish -> routine(finalize)
```

How it meets the two requirements, and what it costs:

- **Requirement 1 (per-step `DbJob`).** Each node is a normal job processed by the existing `processJob`, which creates/looks up a `DbJob` per job — so every step is its own `DbJob` automatically. To have the rows exist _before_ the step runs (so the UI can show "step 3 pending" and `RoutineRunStep.jobId` is known up front), the enqueue path pre-generates each node's `jobId`, creates a `DbJob` (status `created`) per node via the existing `jobService.createJob`, and passes those same ids into each flow node's `opts.jobId`. This is a new enqueuer method (`enqueueRoutineFlow`), not new job machinery.
- **Requirement 2 (durable advancement).** There is **no in-memory coordinator.** The gaps between steps live in Redis as `waiting-children`; a worker death mid-step is covered by stalled-recovery; a redeploy between steps loses nothing. This is the property the polling loop fundamentally lacks, and it is structural here rather than bolted on.
- **Failure.** `failParentOnFailure: true` on every non-root node makes the first failed step (after its own `attempts`) fail the whole flow; later steps never start. A small listener marks the unstarted `RoutineRunStep`s `skipped` and the run `failed`. The default "parent waits forever" behavior (mechanism (b)) must therefore be opted out of on every node, and propagation verified on our pinned BullMQ version.
- **Status sync.** Each step job carries `routineRunId` + `stepIndex`; a routine-scoped hook — a `QueueEvents` listener, or mirroring the existing `DbJob` status write through the `RoutineRunStep.jobId` link — updates `RoutineRunStep` as steps transition, and the `routine` finalizer root sets `RoutineRun.status` on completion (it can aggregate via `getChildrenValues()`). A `RoutineRunReaperService` is still worth keeping as a cheap backstop for missed events, but unlike in Option A it is **not load-bearing** — Redis is the source of truth.
- **Publish wart: resolved.** With the self-planning publish job, `publish`/`publish-plan` are ordinary single nodes. The reason this option looked heavy in the earlier draft is gone.
- **Forward fit.** The GitLab/Actions framing points at stages and parallel jobs; a flow models a parent-with-many-children "stage" natively, so this generalizes to fan-out later in a way a linear orchestrator loop does not. Caveat: a fully _dynamic_ pipeline (deciding step N+1 from step N's output) is awkward in a flow, since the tree is enqueued atomically up front. For static YAML pipelines this is a non-issue.
- **Reuses existing infra:** Medium-high — the `DbJob` mirror, cancellation, the worker, and the self-planning publish job all carry over; the genuinely new parts are the flow enqueue path (with pre-created `DbJob` rows) and the step-status listener.

## Recommendation

**Build the self-planning publish job regardless, model routines as a BullMQ flow of per-step jobs (Option C), and use Option A as the v1 stepping-stone toward it.**

Reasoning, decisively:

- Requirement 1 (each action is its own `DbJob`) rules out Option B. The choice is A or C — both keep per-step jobs.
- Between A and C, **C is the only design where step-to-step advancement is itself durable.** Option A's advancement is an in-memory `await` made safe only by a hand-built reaper + cursor + claim; the entire reason this document exists is that in-memory advancement hangs runs. C removes the in-memory advancement, so the hung-run failure is structurally impossible, not merely patched.
- C matches the GitLab/Actions mental model (a dependency graph of independent jobs) and is forward-compatible with parallel stages.
- The one thing that made C unattractive before — the publish three-call shape — is dissolved by the self-planning publish job, which the codebase is already 90% set up for (`buildPipeline` creates the pipeline inline today).

**Phased migration:**

- **v1 — Option A.** Lowest risk, smallest delta from the proposed design, and it reuses the existing per-action enqueuers verbatim. Concretely: add the **self-planning publish job**; replace the 5 s poll with `QueueEvents` + `job.waitUntilFinished(queueEvents, perActionTimeoutMs)`; on timeout, **always** `JobService.cancelJob` the step before failing the run (so no publish keeps shipping after the run is marked failed); inspect `publicProgress.failedCount` for publish steps, not just `DbJob.status`; and add `RoutineRunReaperService` (a `@Cron`, in the spirit of `StaleJobReaperService`) as the crash backstop. This ships the per-step-`DbJob` model with durable-enough recovery.
- **v2 — Option C.** Move the chaining into a flow so advancement is durable in Redis and the reaper stops being load-bearing. The self-planning publish job and the per-step `DbJob` rows carry over unchanged; what changes is the enqueue path (flow with pre-created `DbJob`s) and dropping the orchestrator loop in favor of the step-status listener + finalizer root.

Pick A and stop there only if near-term routines need dynamic/conditional step logic (`rules:`-style) that a statically-enqueued flow cannot express. Otherwise converge on C.

## Comparison

| Mechanism                                  | Each action its own `DbJob`?              | Durable step-to-step advancement?               | Auto-recovers a hung step?                                 | Publish as a single job?                  | Complexity                                     |
| ------------------------------------------ | ----------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| **Proposed: in-memory poll loop**          | Yes (one job per step)                    | No — advancement is in-memory; run hangs `running` | No — nothing reaps a hung `RoutineRun`                  | No — uses the 3-call shape                | Low to write, high hidden risk                 |
| **A: durable orchestrator + reaper**       | Yes (existing enqueuers)                  | Only via hand-built reaper + cursor + `atomicClaim` | Yes, but the reaper is hand-built                      | Yes (self-planning job)                   | Medium (reaper, `QueueEvents` conn, reconcile) |
| **B: Process Step Jobs**                   | **No — one `DbJob` per run (rejected)**   | Yes (inherited)                                 | Yes (inherited)                                            | n/a (in-handler)                          | Low-medium                                     |
| **C: flow of per-step jobs (recommended)** | Yes (one job per node)                    | Yes — `waiting-children` lives in Redis         | Yes (inherited), once `failParentOnFailure` is set everywhere | Yes (self-planning job)               | Medium-high (flow enqueue + status listener)   |

## Sources

- BullMQ Flows / `FlowProducer`, `getChildrenValues`, `waiting-children`: https://docs.bullmq.io/guide/flows
- Flow failure control (`failParentOnFailure` is opt-in per child): https://docs.bullmq.io/guide/flows/fail-parent
- Ignore / remove dependency on failure: https://docs.bullmq.io/guide/flows/ignore-dependency , https://docs.bullmq.io/guide/flows/remove-dependency
- Stalled-job detection and auto-recovery (lock, `stalledInterval`, `maxStalledCount`): https://docs.bullmq.io/guide/workers/stalled-jobs
- Global vs local events (`QueueEvents`): https://docs.bullmq.io/guide/events
- `Job.waitUntilFinished`: https://api.docs.bullmq.io/classes/v5.Job.html
- Process Step Jobs (single-job state machine, `updateData`, `moveToDelayed`, `maxStartedAttempts`): https://docs.bullmq.io/patterns/process-step-jobs
- No built-in per-job timeout; in-handler `AbortController` pattern: https://docs.bullmq.io/patterns/timeout-jobs
- Idempotent `jobId`: https://docs.bullmq.io/guide/jobs/job-ids
- Deduplication: https://docs.bullmq.io/guide/jobs/deduplication
- Retries and backoff: https://docs.bullmq.io/guide/retrying-failing-jobs
