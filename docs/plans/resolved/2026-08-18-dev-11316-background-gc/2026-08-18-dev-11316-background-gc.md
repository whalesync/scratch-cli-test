# Background GC for scratch-git — plan for DEV-11316 MR 2 → 4

- **Created:** 2026-08-18 · **Revised:** 2026-08-26 (two hard guarantees, git 2.39 measurements, lock-free full GC)
- **Author:** Ivan Dimitrov
- **Status:** Resolved (merged to master 2026-08-31 as `82d2a8956`, MR [!3305](https://gitlab.com/whalesync/spinner/-/merge_requests/3305); switch default OFF). **Canonical feature doc: [`scratch-git-2/docs/MAINTENANCE.md`](/scratch-git-2/docs/MAINTENANCE.md)** — this plan is the historical record of how the design evolved.
- **Linear:** [DEV-11316](https://linear.app/whalesync/issue/DEV-11316/phase-2-rc1-robust-gc-maintenance-dominant-safe-win) (parent [DEV-11253](https://linear.app/whalesync/issue/DEV-11253); incident [DEV-11266](https://linear.app/whalesync/issue/DEV-11266))
- **Shipped so far:** MR 1 — [!3253](https://gitlab.com/whalesync/spinner/-/merge_requests/3253) (`25c96230b`): write-lock guards and the `gcInProgress` marker live inside the blocking task, `git gc` exit status checked, `--prune=now` → `--prune=1.hour.ago`. Plan doc — [!3254](https://gitlab.com/whalesync/spinner/-/merge_requests/3254) (`a6c9d11e1`).

> **Superseded sections below.** The design evolved during implementation; the sections that
> follow are kept as history. The final decisions that differ from them:
> **G1 was dropped entirely** — no GC step after a job at all (the after-job `/gc` becomes a no-op
> while the switch is on); the loop's *quick* step replaced "compact after every job". The
> "budgetSeconds/batchSize hot path" and the `SCRATCH_GIT_FULL_GC_EXCLUSIVE` writer-lock flag were
> never built — full GC is lock-free via git's grace model from day one, with freshen-on-write as
> the pre-default-on follow-up. The per-repo JSON state file and the switch JSON became a
> throw-away SQLite cache/journal with all decision inputs **derived from git's own files**, and
> the full step gained `--cruft` + forced `commit-graph`. See "What is built" below and
> MAINTENANCE.md for the final system.

## The two guarantees (superseded — G1 dropped; see note above)

Everything below exists to make these two statements true, and each is checkable on its own.

| | Guarantee | Mechanism |
|---|---|---|
| **G1** | **After a pull / sync / publish, the job runs one GC step that finishes in ≤ 30 s regardless of repo size** — and the job never waits longer than that. | `mode: compact`: pack ≤ `batchSize` loose objects (`pack-objects` + `prune-packed`), non-deleting, under a **hard wall-clock budget** (`budgetSeconds`, default 30) that kills the child. Every step is crash-safe, so a kill costs only that step's work. |
| **G2** | **Maintenance runs outside any request, incrementally, and the repo keeps serving reads *and writes* while it runs.** | A sweep (`GitMaintenanceService`) applies bounded steps — compact, geometric roll-up, and a rare full `git gc --prune=1.hour.ago` — with **no exclusive lock**. Full GC is lock-free because scratch-git will **freshen** objects it re-writes, which is the one piece of git's own writer/GC concurrency model that gix skips today. |

## Summary

Unlink repo operations from garbage collection. The hot path does one cheap, bounded, non-deleting compaction (G1). Everything expensive — rolling packs together, the full repack, pruning — moves to an hourly sweep that runs one bounded step per repo per visit, reads "done or not" from `count-objects` (never from stored state), and never blocks a writer (G2). Pack quality is not compromised: pack count stays logarithmic continuously, and every repo still gets a real `git gc` at least weekly — on an already-compact repo, so it is fast.

The full plan with diagrams, request/response examples, the measurements, the lock-free argument, the sweep loop and a worked example is in the companion page:

**→ [2026-08-18-dev-11316-background-gc.html](./2026-08-18-dev-11316-background-gc.html)** (open in a browser)

## What changed in this revision (2026-08-26) and why

Four findings, all verified locally on git 2.39.5 (the version in the prod image: `debian:bookworm-slim`), against a bare repo seeded with 30 000 ~1 KB JSON blobs:

| # | Finding | Consequence for the design |
|---|---|---|
| F1 | `git maintenance run --task=loose-objects` **ignores `maintenance.loose-objects.batchSize` on 2.39** (all 30 000 loose packed in one 53 s pass; the setting only exists in newer releases). Its batch is a fixed 50 000. | We cannot bound the hot-path step by count with `git maintenance`. `compact` drives the plumbing itself: enumerate ≤ `batchSize` loose ids → `git pack-objects objects/pack/loose-` on stdin → `git prune-packed`. |
| F2 | A stale `objects/maintenance.lock` makes `git maintenance run` **exit 0 with no output and do nothing**. | Never call `git maintenance run` from the service — it is a second silent-skip trap of exactly the kind DEV-11253 was about. Every step is verified by `count-objects` before/after plus exit status. |
| F3 | Elapsed time is not a function of object count: packing 10 000 loose took 63 s, the next 5 000 took 13 s, a geometric roll-up of 30 000 packed objects took 108 s, a full `gc` took 52 s (laptop, I/O-bound, noisy). | G1 cannot come from a count threshold alone. The 30 s bound is a **wall-clock kill** (`tokio::process` child, `kill_on_drop`), with `batchSize` (default 5 000) tuned so kills are rare. |
| F4 | `git gc --prune=<grace>` **unpacks** young unreachable objects back to loose files (30 000 unreachable in a fresh pack → 30 000 loose after gc), and deletes unreachable objects only when their loose file / containing pack is older than the grace (verified: aged pack → dropped; touched pack → kept; aged loose → pruned; touched loose → kept). | (a) "loose → 0 after full GC" is the wrong acceptance check — the right one is "loose ≤ young unreachable, packs = 1 + young". (b) The mtime grace *is* git's concurrency model for running GC next to live writers; writers keep it sound by **freshening** objects they re-use. gix does not freshen (`gix::Repository::write_object_inner` returns early on `objects.exists(&oid)`), so scratch-git must — then full GC needs no exclusive lock. |

Decisions taken on the back of these:

- **`compact` = own batching + hard budget**, not `git maintenance`. Hot path packs loose objects only; roll-ups are sweep work.
- **Freshen-on-write in scratch-git** (MR 2): the five `write_object` call sites (`git/repo.rs` ×3, `git/rebase.rs` ×2) go through a helper that, when the object already exists, still writes it through `objects.write_buf` (gix-odb's loose writer renames over the existing file → fresh mtime; for a pack-only object it creates a fresh loose copy). Invariant this upholds: *every object a write references is either reachable at that moment or was written/freshened by that write within the grace.* Staged uploads are plain files under `{staging_dir}/{jobId}`, not objects, so they are written at commit time and satisfy it.
- **Full GC's exclusive lock becomes a rollout flag**, `SCRATCH_GIT_FULL_GC_EXCLUSIVE` (default `true` for the first week; the sweep runs `fsck` after every full as the canary; flip to `false` once clean). With the flag off, no writer ever waits for GC and the 409 `gc_in_progress` path is dormant.
- **Prune grace** stays `1.hour.ago` (`SCRATCH_GIT_GC_PRUNE_EXPIRY`; `now`/`all` refused); raise to `1.day.ago` if any write path is found to hold an object unreferenced for longer — disk cost is negligible (DEV-11253: the bloat is loose objects and unswept staging, not garbage).
- **`repack.writeBitmaps=false`** for `full` on the service: bitmaps are a large share of full-repack cost and only clones benefit.

## What is built (2026-08-27, branch `DEV-11316-background-gc-cron`, uncommitted)

The design moved on from "compact after every job" to **"nothing after a job; a switch-gated loop in scratch-git does everything"** — the hot-path step was redundant once a loop runs every minute, and it kept the job on the GC's critical path.

- `scratch-git-2/src/service/maintenance.rs` — the loop. Every 60 s (single task, no overlap): re-read the persisted switch; if on, scan all repos (a few `stat`s + `readdir`s each, no git process), `decide()` per repo, run due steps serially (quick first, then full; oldest-written first).
  - **quick** (≤ 1/h, when `loose ≥ 500` or `packs > 10`): `pack-objects` fed every loose id → `prune-packed` → `repack -d --geometric=2 --write-midx`. Deletes nothing. Budget 30 min.
  - **full** (≤ 1/day, when active since the last full **and** `smallPackShare ≥ 0.15` or `packs > 10` or last full > 7 d): `git -c repack.writeBitmaps=false gc --cruft --prune=1.hour.ago`, then `fsck --connectivity-only` as canary. Budget 60 min. `--cruft` (2026-08-30): young garbage goes into a cruft pack with per-object `.mtimes` instead of exploding to loose — no loose leftovers after a full, garbage ages truthfully across repacks (no quick↔full ping-pong), and the geometric roll-up leaves cruft packs alone (verified on 2.39). No exclusive lock — safety is git's mtime grace (freshen-on-write is the remaining follow-up before the default flips on).
  - Every git child runs in its **own process group** and is group-killed on budget/shutdown (`git gc` spawns `repack` → `pack-objects`); every step renames at the end, so a kill leaves the repo unchanged.
  - Per repo: in-process marker (shared with manual `/gc`), `flock` on `scratch-git-maintenance.lock` (cross blue/green), **re-scan + re-decide under the lock** (the tick's scan may be stale), outcome journaled to the maintenance DB, one `[GC] repo=… mode=… reason=… state=… loose a→b packs a→b …` log line per step.
- **No JSON files. One root.** Everything hangs off the parent of `GIT_REPOS_DIR` (`/data` on the VM): `repos/`, `staging/`, and now `maintenance/maintenance.sqlite` — a **throw-away cache + 30-day journal** (`settings`, `maintenance_runs`, `ticks`). Writes create it; reads assume defaults if it or a row is missing. Nothing `decide()` uses lives in it: last full = mtime of `objects/info/commit-graph` (only `git gc` writes it — verified on 2.39), last quick = newest `objects/pack/*.pack` mtime, activity = ref-dir mtimes. Deleting the DB costs history and turns the switch off; never extra GC work (test: delete between ticks ⇒ next tick runs nothing).
- **Switch**: in memory; `GET/PUT /api/maintenance/config` (`{enabled}`) writes the `settings` row first, then memory; read once at boot. Missing ⇒ **off**. (Blue/green: the draining container keeps its boot value for its last ~60 s.) `GET /api/maintenance/status` → switch, settings, current step, last tick; `GET /api/maintenance/runs?repo=&limit=` → the journal.
- **`POST /gc` while the switch is on** → `{ success: true, skipped: true, reason: "maintenance_enabled", … }` (no git run); jobs keep calling it unchanged. Manual `/gc` now also takes the cross-instance lock.
- **Server**: `ScratchGitClient.getMaintenanceConfig/setMaintenanceEnabled/getMaintenanceStatus`; admin endpoints `GET/PUT /dev-tools/git-maintenance/config`, `GET /dev-tools/git-maintenance/status`. **Client**: `GitMaintenancePanel` on `/settings/dev/cron` (switch + last-tick table). Shared types in `file-types.ts`.
- Tests: 575 service tests green (+22 new: switch persistence/reload, list/scan, decide table, quick/full steps, group kill, shutdown abort, stale-plan rescan, tick). Codex adversarial review round applied (process-group kill, blue/green reload, rescan-under-lock, nested ref mtimes + activity-since-full, unique temp files, fsck under budget, unreadable-dir count).
- Codex round 2 (2026-08-27) applied: shutdown now joins the loop (so the git process group is killed before the runtime goes away); stdin is fed to `pack-objects` concurrently under the same budget/shutdown; `tmp_*` cleanup only touches files older than 24 h (a `git push`'s `index-pack` is the only other writer); a config file that goes missing after startup switches the loop OFF on the next tick; scans are fallible and an unreadable repo is counted (`reposUnreadable`) and skipped instead of looking compact; a full whose fsck canary fails / cannot finish is recorded as `fsck_failed` / `fsck_inconclusive` (never green), timestamps still advance.
- Codex round 4 (2026-08-30, prod-safety charter) verdict: **SAFE TO DEPLOY WITH SWITCH OFF** — off-state is behaviourally equivalent to master except two intentional `/gc` improvements (cross-instance flock; 404 for missing repo). Fixes applied from it: per-tick switch re-read from the DB (both blue/green containers run permanently — a disable must reach the other one; also makes deleting the DB stop running loops), `-c gc.writeCommitGraph=true` + graph-less repos rate-limited by newest-pack age (no full-per-tick spam), vanished-repo journal pruning only after complete scans, repo-id validation on the manual endpoint. Accepted as-is: a part-failed quick can defer its retry by ≤ 1 h (partial pack advances `last_quick`); scan cost with loose-byte stats — watch `scanMs` at rollout; `/repos` doesn't enumerate unreadable subtrees (the tick badge counts them).
- Not in this MR: freshen-on-write (§4 in the html), PostHog-driven flag, changing the default to on.

## MR sequence

| # | Scope | Status |
|---|---|---|
| 1 | scratch-git: lock lifetime + RAII marker + exit check + prune grace | **Merged** (!3253) |
| 2 | scratch-git: detached `/gc` — `mode: compact\|rollup\|full`, `budgetSeconds` (hard kill), `batchSize`, `waitSeconds`, `state`, `GET /gc`, freshen-on-write, `SCRATCH_GIT_FULL_GC_EXCLUSIVE` (`GcGuard` RwLock + flock across blue/green), SIGTERM kills the child, `tmp_pack_*` cleanup, start/end logs | Planned |
| 3 | server: `compact` (budget 30 s) after pull/sync/**publish**; `AbortSignal` timeouts; `callGitApi` retries 409 `gc_in_progress` by role (worker sleeps, api fails fast) — only reachable while the exclusive flag is on | Planned |
| 4 | server: `GitMaintenanceService` hourly sweep — compact loop → roll-up → `full` when compact ∧ (packs ≥ P ∨ last full > 7 d); serialized; `fsck` canary after `full`; metrics | Planned |
| 5 | flip `SCRATCH_GIT_FULL_GC_EXCLUSIVE=false` after a clean week; optional DB repo lock (`REPO_LEVEL_LOCKING.md`) as a separate issue | Planned |

## Key decisions (carried from 2026-08-18, still standing)

- Full GC is all-or-nothing and O(history) → never on a request path; a detached task owns marker, guards and child; only the sweep starts it; only when `count-objects` says the repo is compact.
- "Done vs more needed" is read from the repo (`count-objects -v`), never stored — crash-safe and idempotent by construction.
- Exclusion, where it still exists (the flag), lives in scratch-git, not in NestJS job scheduling: `REPO_LEVEL_LOCKING.md` is unimplemented and excludes sync jobs.
- `waitSeconds` (0..240, < nginx 300) bounds how long the HTTP call observes a run; the run itself belongs to the task.
