# Background repo maintenance (GC)

How scratch-git keeps its bare repositories compact — the switch-gated maintenance loop that
replaced the after-job `git gc` (DEV-11316, merged 2026-08-31). This is the canonical reference;
the historical design plan with the measurements and traces lives in
[`/docs/plans/resolved/2026-08-18-dev-11316-background-gc/`](../../docs/plans/resolved/2026-08-18-dev-11316-background-gc/2026-08-18-dev-11316-background-gc.md).

## The model in three lines

| Layer | When | Condition | What it does |
| --- | --- | --- | --- |
| **Writes** (pull/sync/publish/rebase, CLI patches) | continuously | — | gix writes **loose objects**; nothing packs on the hot path |
| **quick** step | ≤ 1/h per repo | `loose ≥ 500` or `packs > 10` | pack all loose (`pack-objects` + `prune-packed`), then one geometric roll-up (`repack -d --geometric=2 --write-midx`). **Deletes nothing** — safe next to live writers, no lock |
| **full** step | ≤ 1/day per repo | activity since last full **and** (small-pack share ≥ 15 % or `packs > 10` or last full > 7 d) | `git -c repack.writeBitmaps=false -c gc.writeCommitGraph=true gc --cruft --prune=1.hour.ago`, then `git fsck --connectivity-only` as canary |

Steady state per repo: one big pack, a few geometric packs, at most one small cruft pack, ~zero
loose objects.

Key git facts the design leans on (verified on git 2.39, the prod image):

- **Deletion needs a reachability walk** (O(history)); packing does not. So only `full` walks and
  only `full` deletes.
- **The prune grace is liveness, not age**: `--prune=1.hour.ago` deletes an unreachable object
  only if the file holding it (loose file or pack) is ≥ 1 h untouched. This is git's own
  writer-vs-GC concurrency model, which is why `full` takes **no lock against writers**.
- **`--cruft`**: young unreachable objects land in a *cruft pack* with a `.mtimes` sidecar
  (per-object ages carried across repacks) instead of exploding back to loose — no loose leftovers
  after a full, no quick↔full ping-pong. Geometric roll-ups leave cruft packs alone.
- **`objects/info/commit-graph` is written only by `git gc`** — which makes its mtime the honest
  "last full GC" marker (forced via `gc.writeCommitGraph=true`).
- Never use `git maintenance run` or `git gc --auto` in the service: both can silently no-op
  (stale `objects/maintenance.lock`; `gc.log` wedge), and 2.39 ignores the loose-objects batch
  size.

## The loop

`src/service/maintenance.rs`. A single tokio task, tick every 60 s (a long tick delays the next;
no overlap):

1. Re-read the switch from the DB (both blue/green containers run permanently and share the
   disk; a flip through either must reach the other within a tick — and deleting the DB reads as
   *off*).
2. If off: do nothing.
3. **Scan** every repo under `GIT_REPOS_DIR` from files alone — no git processes: newest ref-dir
   mtime (any branch/tag update renames a lock file into its ref directory), loose count + bytes,
   pack count/sizes, `commit-graph` mtime (= last full), newest `.pack` mtime (= last quick). A
   repo that cannot be fully read counts as *unreadable* and is skipped — a partial view is never
   treated as truth.
4. **Decide** per repo (pure function `decide()`, table-tested), then run due steps serially —
   quick steps first, then fulls, oldest-written first. **Failure backoff:** a repo whose newest
   journaled run `failed`/`timed_out` is skipped for 24 h (`failed_step_backoff_ms`) so a broken
   repo (e.g. pre-existing corruption) can't burn every tick, and once eligible again it sorts
   behind healthy repos. One batched journal query per tick; a missing/deleted DB just means the
   repo is retried — the journal only ever *slows* retries, never gates work. Manual runs bypass
   the backoff. The dev-tools Repos tab shows a red ⏸ line with the retry time.
5. Journal every outcome and the tick itself; prune the journal (30-day retention; vanished-repo
   rows only after a complete scan).

Every step is **crash-safe and killable**: git children run in their own process group (SIGTERM
first — git cleans its own lock/temp files — SIGKILL after 5 s), each command writes to a temp
name and renames at the end, budgets are wall-clock (quick 30 min, full 60 min), and the loop is
joined on shutdown before the runtime is torn down. A killed step leaves the repo unchanged and
simply runs again on a later tick.

Per-repo exclusion: the in-process `gcInProgress` marker (shared with manual `/gc`) plus an
advisory `flock` on `<repo>/scratch-git-maintenance.lock` across the blue/green containers, with
a re-scan + re-decide under the lock.

## Nothing is stored that matters — the DB is throw-away

All timestamps `decide()` uses are **derived from files git maintains** (`commit-graph` mtime,
newest pack mtime, ref-dir mtimes). The SQLite file is only a cache + journal:

```
<root>  =  parent of GIT_REPOS_DIR        (/data on the VM, local/ in a dev checkout)
├── repos/…/coa_….git                     bare repos
├── staging/<jobId>/                      per-job staging
└── maintenance/maintenance.sqlite        switch row + 30-day runs/ticks journal
```

Writes create the DB; reads assume defaults when it (or a row) is missing. Deleting it costs the
journal history and turns the switch off — never extra GC work. A repo restored from a snapshot
reads as the snapshot's state, not as anything a cache remembered.

## The switch — default OFF

- In memory; persisted as the `settings.enabled` row; re-read every tick.
- **Missing DB / missing row ⇒ off.** A deploy therefore changes nothing until the switch is
  flipped in the admin dev tool (`/settings/dev/gc`), and the rollback is the same switch.
- While **off**: pull/sync jobs run their after-job `POST /gc` (full `git gc`) exactly as before
  this feature. While **on**: that call returns `{skipped: true, reason: "maintenance_enabled"}`
  in ~1 ms and the loop owns all packing and pruning. (Follow-up once permanently on: delete the
  two `runGitGc` calls in `pull-linked-folder-files.job.ts` / `sync-data-folders.job.ts`.)

## Endpoints

| scratch-git `:3100` | server proxy (admin) | Purpose |
| --- | --- | --- |
| `GET/PUT /api/maintenance/config` | `GET/PUT /dev-tools/git-maintenance/config` | the switch (`{enabled}`) |
| `GET /api/maintenance/status` | `GET …/status` | switch, thresholds, tick in progress, current step, last tick |
| `GET /api/maintenance/repos` | `GET …/repos` (enriched with the owning workbook user) | every repo: counts/bytes, derived timestamps, FS creation time, and the decision the next tick would take |
| `GET /api/maintenance/runs?repo=&limit=` | `GET …/runs` | the journal, newest first |
| `GET /api/maintenance/settings`, `GET /api/maintenance/ticks` | `GET …/settings`, `GET …/ticks` | raw DB tables |
| `POST /api/maintenance/run {repoId, mode}` | `POST …/run` | run one quick/full **now**, forced past the due-rules; works with the switch off; repo id validated |

Web UI: **`/settings/dev/gc`** (switch, status badges, Repos/Runs/Ticks/Settings tables with
per-column help tooltips, per-repo view/quick/full buttons); a one-line cron-style entry remains
on `/settings/dev/cron`.

## Observability

- One log line per step and per tick, greppable by repo:
  `[GC] repo=org_…/wkb_…/coa_… mode=full reason=lastFullAgeH=192 state=completed loose 18240→0 packs 7→2 packBytes …→… ms=9800 fsck=clean`
  `[GC] tick repos=253 unreadableDirs=0 scanMs=840 dueQuick=4 dueFull=1`
- Outcome states: `completed` · `failed` / `timed_out` / `aborted` (nothing advanced; repo stays
  due) · `fsck_failed` / `fsck_inconclusive` (the gc ran; the canary did not pass / finish — red
  in the UI, error-level log).
- The journal (`maintenance_runs`) keeps 30 days of every step; `sqlite3
  /data/maintenance/maintenance.sqlite` works read-only on the VM.

## Rollout runbook

1. Deploy (switch off — no behaviour change).
2. Trial: `/settings/dev/gc` → run a manual **quick**, then **full**, on one or two large repos;
   check the journal row, `fsck ok`, and `count-objects` via the repo row.
3. Flip the switch. First pass gives most repos one full each, serialized; expect the Runs tab to
   fill over the following hours.
4. Watch for the first days: `scanMs` in the tick lines/journal (the scan stats every loose file
   for byte counts), `unreadableDirs` (must stay 0), any non-green run states, and disk usage.
5. Before making the switch the *default*: implement **freshen-on-write** (gix
   `Repository::write_object` skips existing objects without touching their mtime — the one gap
   vs git's grace model; 5 call sites in `git/repo.rs` / `git/rebase.rs`).

Known accepted trade-offs: a part-failed quick may defer its retry by ≤ 1 h (its partial pack
advances the derived `last_quick`); a received `git push` also creates a pack and can delay a
quick by ≤ 1 h; repos inside unreadable directories appear only in the tick's unreadable count,
not in the repo table.
