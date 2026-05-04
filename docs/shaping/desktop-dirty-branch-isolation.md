# Shaping Doc / Build plan: Desktop Dirty Branch Isolation + New Publish Reconciliation

**Date:** 2026-05-04
**Status:** DRAFT

---

## Problem Statement

The desktop app and the web app share `origin/dirty` — a single remote branch used as a
combined queue for all approved-but-unpublished changes. This causes two major problems:

1. **Contaminated publishes.** When the desktop user hits Publish, the server reads from
   `origin/dirty`, which may contain changes from the web app (or another machine) that the
   desktop user did not intend to publish. The desktop user publishes things they didn't
   approve locally.
2. **Lossy post-publish reconciliation.** After publish, the server calls `rebaseDirty()`,
   which does a whole-branch 3-way merge. This is the wrong abstraction for partial publish:
   publish success is per-record, not per-branch. Canonical field values (server-assigned
   IDs, timestamps, normalized formats) can be lost, and unpublished intent can be clobbered.

A third structural problem: publish plan files are "smuggled" through the dirty branch,
mixing ephemeral metadata with approved content. The dirty branch is doing too many jobs.

---

## Design Goals

1. Desktop gets its own isolated dirty lane — completely independent from `origin/dirty`.
2. Publish runs from an immutable snapshot, not a live branch.
3. Post-publish reconciliation is record-by-record, not whole-branch rebase.
4. Deletes preserve user intent even when publish is partial.
5. An explicit branch merge command replaces the implicit merge that happened during upload.
6. Web app is unaffected by all of the above.

---

## Key Design Decisions

### D1: Desktop isolation is desktop-only for now

The web app continues using `origin/dirty` as its shared dirty queue. This is a desktop-only
change. No cross-cutting platform change until the model is validated.

### D2: Normal download never resets dirty

`workspace init` (first-time setup) creates the machine-named local dirty branch from `main`.
Subsequent `files download` operations fetch `main` and rebase local dirty on top of it.
Local dirty is only reset via an explicit re-init. Users do not lose approved work on normal download.

### D3: Named branch = working lane; immutable snapshot = publish artifact

The machine-named branch (`desktop/<machine-name>`) is the user's working dirty lane. It is
not the publish input. When the user triggers Publish:

1. The CLI resolves the current dirty branch tip to a commit SHA.
2. A snapshot tag `refs/publish/attempts/<publish-id>` is pushed, keyed by a new publish ID.
3. The publish plan files are pushed alongside the snapshot, stored at a fixed path keyed by
   publish ID (not smuggled into the dirty branch tree).
4. The server publishes from that immutable SHA. It never reads the live mutable branch.

This prevents branch-moves-during-publish, retry-resolves-to-different-commit, and
support-can-reproduce-exactly-what-shipped-Tuesday.

### D4: FS-based publish execution — no mid-publish git ops

Inspired by the polling-v2 pattern in `experimental/scratch-v4-backend`.

During publish execution, the server does zero git operations. Instead:

- Plan entries are materialized to a temp directory keyed by publish ID.
- For each record: push to remote connector → refetch result (connectors often return the
  updated state directly) → write result as a file to the temp dir.
- If publish stops (success or failure): a single reconciliation git operation runs at the end.

This gives us a durable publish journal (the temp dir) and a simple failure model: "did a
result file get written for this record?"

### D5: Record-by-record post-publish reconciliation

Replaces `rebaseDirty()`. New algorithm after publish completes (fully or partially):

```
For each record path in the publish plan:

  IF result file exists (record was pushed):
    dirty[path] = main[path]          // canonical server state wins

  IF no result file (record was not pushed):
    dirty[path] = main[path] + reapply(pending_plan_entry)
    // start from master's value, apply the pending change on top

For records NOT in the publish plan (untouched):
    dirty[path] = dirty[path]         // unchanged
    main[path]  = main[path]          // unchanged
```

**Delete handling:**

| State                          | main          | dirty                           |
| ------------------------------ | ------------- | ------------------------------- |
| Delete was pushed successfully | record absent | record absent                   |
| Delete is pending (unpushed)   | record exists | record absent (preserve intent) |
| Record not in publish plan     | record exists | record exists (unchanged)       |

For a pending delete, dirty must not have the record even though main does. This preserves
the user's approved intent and means the next publish attempt can retry the delete correctly.

### D5b: Working copy is never touched by reconciliation

The reconciliation step (server-side) only writes to the `dirty` branch. It does not touch
the working copy (the materialized files the user sees on disk).

Unapproved edits — changes the user has made locally but not yet accepted into dirty — are
preserved as a delta on top of dirty, exactly as they are today. When the desktop runs
`files download` after publish, the re-materialization step uses the existing `KeepLocal`
mechanism: for each file, if the working copy differs from old dirty in a way that isn't
explained by the new dirty, keep the working copy version. The unapproved edits survive
regardless of what the reconciliation did to the dirty branch underneath them.

```
working copy = new_dirty + unapproved_edits   ← same invariant as today
```

### D6: Branch merge command

A new explicit CLI command replaces the implicit merge that happened as a side effect of
`files upload`. This is the building block for cross-user collaboration.

```
scratchmd branches merge-from <source-branch> [target-branch]
```

Uses the existing 3-way merge logic in `shared/merge.rs` — the same code that handles
download/upload merges. The merge base is computed as `merge_base(source, target)`.

Target defaults to local dirty if omitted.

Use cases:

- Merge another user's desktop branch into your local dirty
- Explicitly pull `origin/dirty` web app changes into your local branch
- Building block for a future "sync with teammate" button in the desktop UI

---

## Deployable Steps (8 independently shippable slices)

Each slice must be deployable to production on its own, without requiring any other slice
to have already shipped. The mechanism: every slice that has a logical prerequisite gets a
**backward-compatible guard** — it detects whether the prerequisite is in place at runtime
and falls back to the old behavior if not.

The invariant: shipping Slice N to prod must leave the system in a correct state even if
Slices 1 through N-1 have not yet been deployed. Verified in the "guard" notes below.

---

### Slice 1 — Desktop Workspace Init Isolation

**What ships:** `workspace init` creates a machine-named local dirty branch
(`desktop/<machine-name>`) seeded from `main`. Does not fetch or touch `origin/dirty`.
Includes a one-time migration: on first `files download` after update, detect if the
workspace is on the old model (local `dirty` tracking `origin/dirty`), and if so rename
the branch to `desktop/<machine-name>` and cut the remote tracking link.

**Files:** `scratch-git-2/src/cli/commands/workspaces.rs` (init + migration on download)

**Backward-compatible guard:** none needed — this is purely additive for new workspaces,
and the migration is safe for existing ones (rename only, no data loss).

**How to validate:** Fresh init → branch is `desktop/<hostname>`. Existing workspace opened
after update → branch is renamed, `origin/dirty` tracking link is gone. Running migration
twice is a no-op.

**Can ship independently:** Yes.

---

### Slice 2 — Desktop Download Isolation

**What ships:** `files download` does two things for the new model:

1. Fetch `main` → rebase local dirty onto new `main`. _(replaces the old origin/dirty merge)_
2. Fetch `origin/desktop/<machine-name>` if it exists → 3-way merge with local dirty,
   using the most recent publish snapshot SHA as the merge base.

Step 2 is how the post-publish reconciled dirty state gets back to the desktop. Without it,
Slice 5 produces the right dirty on the server but the desktop never sees it. The merge uses
local-wins on conflict, same as today's download behavior.

Note: step 2 uses the same 3-way merge logic as the `branches merge-from` command (Slice 6).
They share the same underlying function — Slice 2 just calls it automatically on every
download; Slice 6 exposes it as an explicit user command.

**Files:** `scratch-git-2/src/cli/commands/files.rs` (`download_single_repo`)

**Backward-compatible guard:** Detect the current dirty branch name. If `desktop/*` → new
behavior (fetch `origin/desktop/<machine-name>`, skip `origin/dirty`). If old `dirty` →
old behavior. Slice 2 can ship before Slice 1 — it silently does nothing new until Slice 1's
migration has renamed the branch.

**How to validate:** Run a full publish (Slices 3-5 active), then run download. Confirm
the post-publish reconciled dirty from the server has been merged into local dirty. Confirm
mid-publish edits made locally survived the merge (local-wins). Confirm unapproved working
copy edits are untouched.

**Can ship independently:** Yes.

---

### Slice 3 — Publish Snapshot + Server Accepts Ref Param

**What ships:**
- CLI: when publish starts, resolve the current dirty branch tip (old `dirty` or new
  `desktop/<machine>`) to a commit SHA, push snapshot tag
  `refs/publish/attempts/<publish-id>`. The snapshot always works regardless of branch name.
- Server: `POST /publish/from-git` accepts an optional `ref` param. With `ref`: reads from
  that SHA. Without `ref` (old clients): falls back to `origin/dirty` as before.

**Files:**
- `scratch-git-2/src/cli/commands/plan_publish.rs`
- `server/src/publish-plan/publish-from-git.service.ts`
- `server/src/cli/cli-workbook.controller.ts`

**Backward-compatible guard:**
- Server: `ref` is optional with fallback — zero breaking change for old clients.
- CLI: snapshot logic resolves `HEAD` of whichever dirty branch exists — works with both
  old `dirty` and new `desktop/<machine>`. No dependency on Slice 1.

**Deploy order:** Server first (safe to receive old requests). Then CLI binary update.
Rollback: remove `ref` param handling from server; old CLI still works.

**How to validate:** Old client (no `ref`) → server reads `origin/dirty`, publish works as
before. New client (sends `ref`) → server reads that SHA, publish is locked to snapshot.
Push new dirty commit mid-flight → server still reads original SHA.

**Can ship independently:** Yes.

---

### Slice 4 — FS-Based Publish Execution (No Mid-Publish Git Ops)

**What ships:** The publish executor materializes plan entries to a temp directory keyed by
publish ID. After each record: push to connector → write result file to temp dir. No git
commits during execution. The old `rebaseDirty()` still fires at the end — Slice 5 has
not shipped yet, so reconciliation behavior is unchanged from the user's perspective.

**Files:** `server/src/publish-plan/publish-from-git.service.ts` (refactor `runFromGit`
phases loop; the `rebaseDirty()` call at lines 313-335 is unchanged)

**Backward-compatible guard:** The FS temp dir is created and populated regardless of
whether Slice 3's snapshot ref was provided. If `ref` is absent (old client), the executor
reads from `origin/dirty` as before but still writes result files. The temp dir is internal
to the server — no client change needed.

**Temp dir structure:**
```
/tmp/publish-<publish-id>/
  plan/
    <folder>/edit/<record>.json      ← plan entry (input)
    <folder>/create/<record>.json    ← plan entry (input)
    <folder>/delete/<record>.json    ← plan entry (input)
  results/
    <folder>/edit/<record>.json      ← result after push (output)
    <folder>/create/<record>.json    ← result after push (output)
    <folder>/delete/<record>.json    ← tombstone after push (output)
```

If a record exists in `plan/` but not `results/`: not published (pending or failed).
If a record exists in `results/`: successfully published.

**How to validate:** Inject failure after 3rd record. Confirm temp dir has exactly 3 result
files. Old `rebaseDirty()` still fires at the end and produces the same dirty branch it
always did (new executor, same reconciliation).

**Can ship independently:** Yes. Slice 3 not required.

---

### Slice 5 — Post-Publish Reconciliation

**What ships:** Replace `rebaseDirty()` with a record-by-record reconciliation function
that handles all three cases in a single pass:

- **Record was pushed** (result file exists): `dirty[path] = main[path]`.
- **Record was not pushed** (plan entry exists, no result file): `dirty[path] = main[path] +
  reapply(pending_plan_entry)`.
- **Delete was pushed** (tombstone in results): record absent from dirty.
- **Delete is pending** (plan entry, no tombstone): record absent from dirty (intent preserved).
- **Record not in plan**: dirty unchanged.

After reconciliation, server pushes the new dirty state to `origin/desktop/<machine-name>`.
Desktop pulls it on next download and 3-way merges using the snapshot SHA as merge base.

**Files:** `server/src/publish-plan/publish-from-git.service.ts` — replace `rebaseDirty()`
at lines 313-335.

**Backward-compatible guard:** At reconciliation time, check whether the temp dir exists
with a `plan/` subdirectory. If yes: use new record-by-record reconciliation. If no (Slice 4
not yet deployed for this publish run): fall back to the old `rebaseDirty()`.

This means Slice 5 can ship to prod before Slice 4. For any publish job that ran through the
old executor (no temp dir), it silently falls back. For any job that ran through the new
executor (temp dir exists), it uses new reconciliation. The two upgrade together naturally.

**How to validate:** Publish with no temp dir present → `rebaseDirty()` fires (old behavior,
verified in test). Publish with temp dir (Slice 4 active) → new reconciliation fires. Run
all 12 edge-case scenarios from the test harness.

**Can ship independently:** Yes. Slice 4 not required (guard handles it).

---

### Slice 6 — Branch Merge Command

**What ships:** New CLI command `scratchmd branches merge-from <source-branch> [target-branch]`.

Uses `shared/merge.rs` 3-way merge logic directly. Merge base is computed as
`merge_base(source, target)`. Target defaults to local dirty if omitted.

Server endpoint: `POST /workbooks/:id/connections/:connId/branches/merge` that triggers the
CLI command (or runs the merge logic directly).

Desktop IPC: `scratch:merge-branch` handler, exposed as a "Merge from..." option in the
branch/collaboration UI.

**Files:**

- `scratch-git-2/src/cli/commands/branches.rs` (new file)
- `scratch-git-2/src/cli/commands/mod.rs` (register new command)
- `server/src/cli/cli-workbook.controller.ts` (new endpoint)
- `scratch-desktop/src/main/index.ts` (new IPC handler)

**How to validate:** Desktop user A and user B both have local dirty branches with non-
overlapping changes. A runs `merge-from desktop/<user-b>`. A's dirty now contains both
sets of changes. Re-run → idempotent result (merge base catches up, no duplicate changes).

**Depends on:** nothing (fully independent — can ship any time)

---

### Slice 7 — Cleanup: Remove Desktop's origin/dirty Dependency

---

### Slice 7 — Cleanup: Remove Desktop's origin/dirty Dependency

**What ships:** Remove all `origin/dirty` reads and writes from desktop code paths.
Deprecate `files upload` for the desktop app (it pushed to origin/dirty). The desktop's
IPC handler for `scratch:push-workspace-changes` either errors or is hidden from the UI.

**Files:**

- `scratch-git-2/src/cli/commands/files.rs` (remove upload path for desktop mode)
- `scratch-desktop/src/main/index.ts` (remove or gate `push-workspace-changes` handler)
- `scratch-git-2/src/cli/git_ops/remote.rs` (remove `push_origin_dirty` if unused)

**How to validate:** Run `scratchmd files upload` from a desktop workspace → returns an
error or no-op. `git ls-remote origin dirty` shows that `origin/dirty` has NOT been touched
since the workspace was initialized.

**Depends on:** All of Slices 1-7 validated and stable. This is the final cleanup.

---

---

### Slice 8 — Resume Publish After Failure _(rough / unplanned)_

> **Status: placeholder — not ready to implement. Shape this before picking it up.**

**The idea:** After a publish job stops at the first failure, the user should be able to
resume it — continuing from where it left off without re-running records that already
succeeded.

Today's flow: publish stops at first failure → user sees error → user hits Publish again →
the entire plan is rebuilt from dirty vs main → all records are re-planned, including ones
that already published successfully in the previous run. The first run's work is thrown away.

Goal: after a failure, a "Resume" or "Retry failed" action picks up the existing publish job
by its ID, reads the temp dir that Slice 4 left behind (result files for succeeded records
are still there), and continues executing only the records that have no result file yet.
No re-planning. No re-pushing records that already landed.

Today: stop at first failure → user must re-publish the entire plan.
Goal: continue from the failure point → one resume gets as far as possible.

**Rough shape of what changes:**

- The FS-based executor (Slice 4) already has a result file per record. It just needs to
  keep going when one record fails instead of aborting.
- The reconciliation step (Slices 5-7) doesn't change — it already handles arbitrary
  partial publish. A "kept going" run is just a different mix of result/no-result files.
- The publish plan needs a way to carry per-record failure state back to the client
  ("post-2 failed: connector returned 429 rate limit").
- The desktop UI needs a "partial success" state: N records published, M failed (with
  reasons), with a "Retry failed" button that plans only the failed records.

**What is NOT figured out:**

- Phase ordering constraints. Today: edit → create → delete → backfill → rename. If a
  create fails, should dependent backfills be skipped? Probably yes, but the logic to
  express and enforce those dependencies needs design.
- Rate limit handling. Should the executor wait-and-retry within the same run, or abort
  the record and let the user retry? There is a difference between a transient 429 and a
  permanent 400.
- Retry idempotency. If an edit was pushed but the refetch failed (so no result file was
  written), does a retry re-push the edit? Need a way to detect "already applied on remote."
- User mental model. If 90 records succeed and 10 fail, does the UI show a partial success
  clearly enough that users know they need to action the failures?

**Do not start implementing this until the above is answered.**

---

## Prod-Deployability and Deployment Strategy

There are three separate publish jobs in the server. This matters for understanding blast radius:

- `publish.job.ts` — web app publish (uses `PublishPlanBuildService` + `PublishPlanRunService`)
- `publish-data-folder.job.ts` — legacy per-folder publish
- `publish-from-git.job.ts` — desktop/CLI publish only (calls `PublishFromGitService`)

Slices 4 and 5 only touch `PublishFromGitService`, which is called exclusively by
`publish-from-git.job.ts`. Web app publishes are entirely unaffected.

### Summary Table

| Slice | Independently deployable? | Guard mechanism |
|-------|--------------------------|-----------------|
| 1 | Yes | Migration runs on first download; idempotent |
| 2 | Yes | Detects branch model at runtime; old model → old behavior |
| 3 | Yes | `ref` param is optional; server falls back to `origin/dirty` |
| 4 | Yes | Server-only; old `rebaseDirty()` still fires; no client change |
| 5 | Yes | Checks for temp dir; absent → falls back to `rebaseDirty()` |
| 6 | Yes | Fully additive; nothing calls it until the UI exposes it |
| 7 | Last | No guard possible — irreversible removal. Gate on version check. |
| 8 | Unplanned | — |

### Per-Slice Tests

**Slice 1:**
Unit test: init creates `desktop/<hostname>`. Integration test: old-model workspace
migrated on next download (branch renamed, tracking link cut). Idempotency: migration
runs twice → no-op. Machine name determinism: same machine always produces same branch name.

**Slice 2:**
Guard test: old-model workspace (pre-Slice 1) → download still reads `origin/dirty`.
New-model workspace → download skips `origin/dirty`. Contrast test: document the old
behavior explicitly so the break is visible in the test history.
Post-publish merge test: server has pushed reconciled dirty to `origin/desktop/<machine>`;
download fetches it and 3-way merges; local mid-publish edits survive (local-wins);
unapproved working copy edits are untouched. Idempotency: no `origin/desktop/<machine>`
ref → download completes normally with no merge step.

**Slice 3:**
Server unit: `POST /publish/from-git` with no `ref` → reads `origin/dirty`. With
`ref=<sha>` → reads that SHA. CLI test: snapshot tag exists before request fires; tag
points at correct commit; push to dirty after snapshot → server ignores it.

**Slice 4:**
Executor unit: N plan entries → N result files on success. Inject failure after M → M result
files. Result files contain connector-returned state (not input state). Old `rebaseDirty()`
fires after executor completes (regression: new executor must not remove the rebase call).
Feature flag test: `PUBLISH_FS_EXECUTOR=false` → old executor runs, no temp dir written.

**Slice 5:**
Guard test: no temp dir present → `rebaseDirty()` fires, old behavior. Temp dir present →
new reconciliation fires. Run all 12 edge-case scenarios from the test harness as a required
gate. Regression: `rebaseDirty()` is NOT called when temp dir is present.

**Slice 6:**
3-way merge unit: reuse `shared/merge.rs` fixtures for source/target/base combinations.
Idempotency: `merge-from` twice → second run is no-op. Conflict: same field modified on
both sides → `ours wins` (document which side is "ours" in this command's context).

**Slice 7:**
`scratchmd files upload` from desktop workspace → explicit error message. After any desktop
CLI command, `git ls-remote origin dirty` shows no new writes. End-to-end smoke: full
download → edit → publish → download cycle with zero `origin/dirty` involvement.

### Deployment Order for Slice 7 (Cleanup)

Slice 7 is the only one that cannot be independently deployed in the usual sense — it
removes the old code path entirely. Safe to ship only when:
1. Slices 1-5 have been stable for at least one full release cycle.
2. Server logs show no `origin/dirty` push events from desktop clients for 2+ weeks.
3. Auto-updater confirms all active desktop sessions are on a version that uses the new path.
4. Tag as a breaking change in the release notes.

---

## What We Are NOT Changing

- Web app's use of `origin/dirty` — unchanged.
- The 3-way merge algorithm in `shared/merge.rs` — reused, not replaced.
- The publish plan format on disk — extended (result files added), not restructured.
- CLI command names visible to the web app flow — unchanged.

---

## Open Questions

1. **Machine name collision:** Two machines with the same hostname would share a branch. For
   v1, is hostname + username suffix enough? (`desktop/<hostname>-<username>`)
2. **Temp dir cleanup:** Who cleans up `/tmp/publish-<publish-id>/` and when? On success
   immediately? On next init? Keep for N days for debugging?
3. **Plan entry retry:** After a partial publish, the remaining plan entries need to be
   preserved in dirty so the next publish can retry them. Is the `.scratch/.publish-plans/`
   path in the dirty tree the right place, or should they live separately?
4. **Publish result ref lifetime:** How long do `refs/publish/attempts/<publish-id>` tags
   live on the server? Auto-pruned after reconciliation? Or kept for audit?
5. **Branch merge conflict UI:** If `branches merge-from` hits a JSON conflict, how does the
   desktop surface it? The current `ours wins` strategy silently resolves. Do we want
   explicit conflict markers in the UI for the explicit merge command?

---

## How the New Dirty Branch Gets Back to the Desktop

After publish (full or partial), the server pushes the reconciled dirty state to
`origin/desktop/<machine-name>`. The desktop picks this up on the next download.

The 3-way merge that runs on the desktop uses the **publish snapshot SHA** as the merge base.
This is what makes mid-publish edits safe: the snapshot is the known common ancestor between
what the server computed and what the user has locally.

```
                   snapshot (S1)
                   /           \
                  /             \
   server reconciled dirty     local dirty (with mid-publish edits)
                  \             /
                   \           /
                    merged dirty
```

### Setup for all examples

Two records, three fields each:

```
Before publish:
  main[post-1]   = { title: "Hello", status: "draft",    id: "ext-111" }
  dirty[post-1]  = { title: "Hello 2", status: "draft",  id: "ext-111" }  ← pending edit

  main[post-2]   = { title: "Foo",   status: "draft",    id: "ext-222" }
  dirty[post-2]  = { title: "Foo Bar", status: "review", id: "ext-222" }  ← pending edit

  main[post-3]   = { title: "Baz",   status: "live",     id: "ext-333" }
  dirty[post-3]  = { title: "Baz",   status: "live",     id: "ext-333" }  ← no change

Publish plan:  post-1 (edit), post-2 (edit)
Snapshot SHA:  S1  (tip of dirty at publish time)
```

Publish takes 10 minutes. "User edits" happen AFTER S1 is taken — on the local dirty
branch while publish is running on the server.

---

### Case 1 — Full success, user does nothing

Server pushes post-1 and post-2. Remote service returns canonical values with
server-assigned `updated_at` timestamps.

```
After publish:
  main[post-1]   = { title: "Hello 2", status: "draft",  id: "ext-111", updated_at: "2026-05-04T20:00Z" }
  main[post-2]   = { title: "Foo Bar", status: "review", id: "ext-222", updated_at: "2026-05-04T20:01Z" }

Server reconciled dirty:
  dirty[post-1]  = main[post-1]   ← published, dirty = master
  dirty[post-2]  = main[post-2]   ← published, dirty = master
  dirty[post-3]  = (unchanged)

Desktop download (merge base = S1, local = S1, server = reconciled):
  No local changes → fast-forward

Final dirty:
  post-1: { title: "Hello 2", updated_at: "2026-05-04T20:00Z", ... }  ✓ canonical
  post-2: { title: "Foo Bar", updated_at: "2026-05-04T20:01Z", ... }  ✓ canonical
  post-3: unchanged
```

---

### Case 2 — Full success, user edits a record NOT in the plan

During publish, user edits post-3 (not in the publish plan) locally.

```
User's local dirty after S1:
  dirty[post-3]  = { title: "Baz Updated", status: "live", id: "ext-333" }

Server reconciled dirty:
  dirty[post-1]  = main[post-1]   ← published
  dirty[post-2]  = main[post-2]   ← published
  dirty[post-3]  = { title: "Baz", status: "live", id: "ext-333" }   ← server doesn't know about user edit

Desktop merge (base=S1):
  post-3: base="Baz", local="Baz Updated", server="Baz"
  → server = base (no change from server side) → local wins

Final dirty:
  post-3: { title: "Baz Updated", ... }   ✓ user's mid-publish edit preserved
```

---

### Case 3 — Full success, user re-edits a record that WAS in the plan

User edits post-1 again mid-publish (title → "Hello 3") after snapshot was taken.

```
User's local dirty after S1:
  dirty[post-1]  = { title: "Hello 3", status: "draft", id: "ext-111" }

Server pushes "Hello 2" (the snapshot value). Canonical result:
  main[post-1]   = { title: "Hello 2", updated_at: "...", id: "ext-111" }

Server reconciled dirty:
  dirty[post-1]  = main[post-1]   = { title: "Hello 2", updated_at: "..." }

Desktop merge (base=S1):
  post-1.title: base="Hello 2", local="Hello 3", server="Hello 2"
  → server = base → local wins

Final dirty:
  post-1: { title: "Hello 3", updated_at: "..." }
  ✓ User's newer edit is now a pending change on top of the canonical state
  ✓ Next publish will push "Hello 3"
```

---

### Case 4 — Partial failure: post-1 succeeds, post-2 fails, user does nothing

Server pushes post-1 OK, post-2 connector returns 500. Stops.

```
Server reconciled dirty:
  dirty[post-1]  = main[post-1]        ← published, dirty = master
  dirty[post-2]  = main[post-2] + reapply(snapshot[post-2])
                 = { title: "Foo Bar", status: "review", id: "ext-222" }
                 ← pending, reapplied on top of main

Desktop download: no mid-publish edits → fast-forward

Final dirty:
  post-1: canonical { title: "Hello 2", updated_at: "..." }  ✓
  post-2: { title: "Foo Bar", status: "review", ... }         ✓ still pending
```

Next publish plan: only post-2 (post-1 is now dirty=master, no diff).

---

### Case 5 — Partial failure + user edits the FAILED record mid-publish

post-2 fails. User also edits post-2 locally to "Foo Bar Plus" while publish was running.

```
User's local dirty after S1:
  dirty[post-2]  = { title: "Foo Bar Plus", status: "review", id: "ext-222" }

Server reconciled dirty:
  dirty[post-2]  = { title: "Foo Bar", status: "review", ... }   ← reapplied from snapshot

Desktop merge (base=S1):
  post-2.title: base="Foo Bar" (S1), local="Foo Bar Plus", server="Foo Bar"
  → server = base → local wins

Final dirty:
  post-2: { title: "Foo Bar Plus", status: "review", ... }
  ✓ User's newer edit replaces the retry value
  ✓ Next publish will push "Foo Bar Plus", not the original "Foo Bar"
```

---

### Case 6 — Partial failure + user reverts the failed record to main value

post-2 fails. User decides to discard their edit and reverts post-2 to match main.

```
User's local dirty after S1:
  dirty[post-2]  = { title: "Foo", status: "draft", id: "ext-222" }   ← reverted to main value

Server reconciled dirty:
  dirty[post-2]  = { title: "Foo Bar", status: "review", ... }   ← reapplied from snapshot

Desktop merge (base=S1):
  post-2.title: base="Foo Bar" (S1), local="Foo", server="Foo Bar"
  → local ≠ base, server = base → local wins (user's revert)

Final dirty:
  post-2: { title: "Foo", status: "draft", ... }   ← same as main
  ✓ post-2 no longer appears in next publish plan (dirty = main)
  ✓ User's discard intent wins
```

---

### Case 7 — Partial failure + user locally DELETES the failed record

post-2 fails. User marks post-2 for deletion in their local dirty (approves it as deleted).

```
User's local dirty after S1:
  dirty[post-2]  = ABSENT   ← deleted from dirty (pending delete)

Server reconciled dirty:
  dirty[post-2]  = { title: "Foo Bar", ... }   ← reapplied from snapshot (still pending edit)

Desktop merge (base=S1):
  post-2: base=EXISTS ("Foo Bar"), local=ABSENT, server=EXISTS ("Foo Bar")
  → server = base, local deleted → local delete wins

Final dirty:
  post-2: ABSENT
  ✓ Next publish plan will be a DELETE for post-2 (not an edit)
  ✓ The original pending edit is superseded by the delete intent
```

---

### Case 8 — Server publish result push fails (network error after reconciliation)

Both records publish OK. Server computes new dirty. But the push of reconciled dirty to
`origin/desktop/<machine-name>` fails (network drop).

```
Server: reconciled dirty computed but not pushed.

Desktop: user does download → fetches origin/desktop/macbook → nothing new (same as S1).
Local dirty = snapshot state (pre-publish pending changes still there).

main has been updated (post-1 and post-2 are published).

Desktop merge (base=S1):
  post-1: base=S1 ("Hello 2"), local=S1 ("Hello 2"), server=S1 ("Hello 2")
  → all same → post-1 still looks like a pending edit in dirty even though it's published

Result: dirty still shows post-1 and post-2 as pending.
  ⚠ Next publish re-plans them. Server sees them as edits (dirty != main).
  Server pushes them again — idempotent since values haven't changed.
  ⚠ Wasted publish work, but NO data loss and NO corrupt state.
```

Mitigation: The publish endpoint response tells the desktop which records were published.
Desktop can apply a partial local reconciliation from that response even if the server
couldn't push the result branch.

---

### Case 9 — User creates a NEW record mid-publish (not in plan)

User creates post-4 locally after S1. It has no remote ID yet.

```
User's local dirty after S1:
  dirty[post-4]  = { title: "New Post", status: "draft", id: null }   ← no remote ID

Server reconciled dirty: no post-4 (wasn't in the plan, server doesn't know about it)

Desktop merge (base=S1):
  post-4: base=ABSENT (S1), local=EXISTS, server=ABSENT
  → local added it, server and base both absent → local wins

Final dirty:
  post-4: { title: "New Post", status: "draft", id: null }
  ✓ User's new record survives publish untouched
  ✓ Appears in next publish plan as a CREATE
```

---

### Case 10 — User deletes a record that WAS being published (delete intent after snapshot)

User approves deletion of post-1 locally after snapshot is taken. Server has already
published the edit for post-1 ("Hello 2").

```
User's local dirty after S1:
  dirty[post-1]  = ABSENT   ← user deleted it during publish

Server publishes post-1 as an edit ("Hello 2"). Canonical:
  main[post-1]   = { title: "Hello 2", updated_at: "...", id: "ext-111" }

Server reconciled dirty:
  dirty[post-1]  = main[post-1]   ← published, dirty = master

Desktop merge (base=S1):
  post-1: base=EXISTS ("Hello 2"), local=ABSENT, server=EXISTS ("Hello 2")
  → server = base, local deleted → local delete wins

Final dirty:
  post-1: ABSENT
  ✓ The published edit lands in main ("Hello 2" is now the canonical version in Airtable)
  ✓ Next publish plan: DELETE post-1 from the remote service
  ✓ Correct: edit shipped, then delete will ship
```

---

### Case 11 — Both records fail immediately (connector is down)

Nothing is pushed. Server temp dir has no result files at all.

```
Server reconciled dirty:
  dirty[post-1]  = main[post-1] + reapply(snapshot[post-1]) = { title: "Hello 2", ... }
  dirty[post-2]  = main[post-2] + reapply(snapshot[post-2]) = { title: "Foo Bar", ... }

(Same as snapshot since main hasn't changed and reapplied values = snapshot values)

Server pushes to origin/desktop/macbook → same tree as snapshot.

Desktop download: server's dirty = snapshot = local dirty → fast-forward, nothing changes.

Final dirty: unchanged from before publish attempt.
  ✓ Idempotent. Next publish retries both records.
```

---

### Case 12 — post-1 succeeds, user had edited BOTH title AND status mid-publish, only title was in the plan entry

Server published post-1 but the plan entry only carried `title` (a field-scoped plan).
User added a `status` change locally after snapshot.

```
Plan entry for post-1: { title: "Hello 2" }  ← only this field is in scope
Canonical main[post-1] after publish: { title: "Hello 2", status: "draft", id: "ext-111", updated_at: "..." }

User's local dirty after S1:
  dirty[post-1]  = { title: "Hello 2", status: "review", id: "ext-111" }  ← status changed locally

Server reconciled dirty:
  dirty[post-1]  = main[post-1]   = { title: "Hello 2", status: "draft", updated_at: "..." }

Desktop merge (base=S1):
  post-1.title:  base="Hello 2", local="Hello 2", server="Hello 2"  → same, no conflict
  post-1.status: base="draft" (S1), local="review", server="draft" (main, unchanged by publish)
  → server = base → local wins

Final dirty:
  post-1: { title: "Hello 2", status: "review", updated_at: "..." }
  ✓ Canonical title + updated_at from server
  ✓ User's local status change preserved as pending
  ✓ Next publish plan: post-1 edit for status field only
```

---

## The Assignment

Before implementation begins: write a test harness that can simulate partial publish
(inject failure after N records) and assert the exact dirty branch state after reconciliation.
This harness is the validation oracle for Slices 5-7. Without it, the reconciliation logic
cannot be safely shipped.
