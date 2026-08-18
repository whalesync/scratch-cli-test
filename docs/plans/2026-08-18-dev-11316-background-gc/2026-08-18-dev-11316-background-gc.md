# Background GC for scratch-git — plan for DEV-11316 MR 2 → 4

- **Created:** 2026-08-18
- **Author:** Ivan Dimitrov
- **Status:** Planned
- **Linear:** [DEV-11316](https://linear.app/whalesync/issue/DEV-11316/phase-2-rc1-robust-gc-maintenance-dominant-safe-win) (parent [DEV-11253](https://linear.app/whalesync/issue/DEV-11253); incident [DEV-11266](https://linear.app/whalesync/issue/DEV-11266))
- **Shipped so far:** MR 1 — [!3253](https://gitlab.com/whalesync/spinner/-/merge_requests/3253) (`25c96230b`): write-lock guards and the `gcInProgress` marker live inside the blocking task, `git gc` exit status checked, `--prune=now` → `--prune=1.hour.ago`.

## Summary

Unlink repo operations from garbage collection. After every pull / sync / publish the job makes one cheap, **bounded, non-deleting** compaction call (`mode: compact` — pack loose objects, roll up small packs; skipped when there is nothing to do). A **full, pruning `git gc`** (`mode: full`) runs only from an hourly maintenance sweep, detached from any HTTP request, on idle repos, one at a time, under an exclusive per-repo lock — and because it runs on already-compact repos it is fast and rarely near the 300 s proxy cliff. Pack quality is not compromised: pack count stays logarithmic continuously, and every repo still gets a real `git gc` at least weekly.

The full plan with diagrams, request/response examples, the lock model, the sweep loop and a worked example on the Whalesync Internal repos is in the companion page:

**→ [2026-08-18-dev-11316-background-gc.html](./2026-08-18-dev-11316-background-gc.html)** (open in a browser)

## MR sequence

| # | Scope | Status |
|---|---|---|
| 1 | scratch-git: lock lifetime + RAII marker + exit check + prune grace | **Merged** (!3253) |
| 2 | scratch-git: detached `/gc` — `mode: compact\|full`, `waitSeconds`, `state`, `GET /gc`, per-repo RwLock (`GcGuard`), flock across blue/green, SIGTERM kills the child | Planned |
| 3 | server: `callGitApi` retries 409 `gc_in_progress` by role (worker sleeps, api fails fast), `AbortSignal` timeouts, `compact` after pull/sync/**publish** | Planned |
| 4 | server: `GitMaintenanceService` hourly sweep — bounded step per repo, requeue on `more_needed`, `full` only when idle and compact, metrics | Planned |

## Key decisions

- Hot path = incremental (`git maintenance run --task=loose-objects --task=incremental-repack`, or `git repack -d --geometric=2` — measure on the two big repos and pick). Both are bounded per run, delete nothing, converge over repeats, and are safe next to live writers → no exclusive lock.
- Full GC is all-or-nothing and O(history) → never on a request path; detached task owns lock + marker + child; only the sweep starts it; only when `count-objects` says the repo is compact and no job is running on the workbook.
- "Done vs more needed" is read from the repo (`count-objects -v`), never stored — crash-safe and idempotent by construction.
- Prune grace stays `1.hour.ago` (`SCRATCH_GIT_GC_PRUNE_EXPIRY`; `now`/`all` refused).
