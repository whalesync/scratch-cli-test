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

## MRs

Eight merge requests in deployment order. MR1 and MR2 are the critical unlock — everything
else flows independently after MR2 is live.

**Note on publish jobs:** There are three separate publish jobs in the server.
MR4 and MR5 only touch `PublishFromGitService`, called exclusively by
`publish-from-git.job.ts` (desktop/CLI). Web app publish (`publish.job.ts`) is unaffected.

---

### MR1 — Server: Publish Accepts Snapshot Ref
_Server only. Ships first, alone. No client change required._

**What ships:** `POST /publish/from-git` accepts an optional `ref` param. With `ref`:
reads from that exact SHA (the publish snapshot). Without `ref` (old clients): falls back
to `origin/dirty` as before. Zero behavior change for existing clients.

**Files:**
- `server/src/publish-plan/publish-from-git.service.ts`
- `server/src/cli/cli-workbook.controller.ts`

**Guard:** `ref` is optional with fallback. Rollback: remove the param; old clients still work.

**Tests:** `POST` with no `ref` → reads `origin/dirty`. With `ref=<sha>` → reads that SHA
and ignores any subsequent pushes to the branch.

---

### MR2 — Client: Branch Isolation + Snapshot Publish
_Requires MR1 live first. Ships Slice 1 + Slice 3 client in one binary release._

Renaming `dirty` to `desktop/<machine-name>` breaks `files upload`, which is hardcoded to
merge against `origin/dirty` — after the rename they share no history and
`merge_base(desktop/<machine>, origin/dirty)` returns nothing. MR1 must be live so the
new snapshot push has a valid server endpoint before the old upload path is replaced.

**What ships:**
- `workspace init` creates `desktop/<machine-name>` seeded from `main`. Does not touch
  `origin/dirty`.
- One-time migration on first `files download` after update: detect old model (local `dirty`
  tracking `origin/dirty`), rename branch to `desktop/<machine-name>`, cut tracking link.
  Idempotent.
- Snapshot publish replaces `files upload` in the publish flow: resolve current dirty branch
  tip to a commit SHA, push `refs/publish/attempts/<publish-id>`, send `ref` param to server.

**Files:**
- `scratch-git-2/src/cli/commands/workspaces.rs` (init + migration)
- `scratch-git-2/src/cli/commands/plan_publish.rs` (snapshot push)

**Tests:** Fresh init → branch is `desktop/<hostname>`. Existing workspace → migrated on
next download (branch renamed, tracking link cut, migration idempotent). Full publish
end-to-end: snapshot tag exists before server request fires; mid-flight push to branch →
server ignores it; publish completes from original SHA.

---

### MR3 — Client: Download Isolation
_Independent. Guard makes it safe before or after MR2._

**What ships:** `files download` does two things for new-model workspaces:
1. Fetch `main` → rebase local dirty onto new `main`.
2. Fetch `origin/desktop/<machine-name>` if it exists → 3-way merge with local dirty using
   the publish snapshot SHA as merge base. This is how post-publish reconciled dirty gets
   back to the desktop.

Uses the same 3-way merge logic as MR6 (`branches merge-from`) — shared function, different
trigger. MR3 calls it automatically on every download; MR6 exposes it as an explicit command.

**Files:** `scratch-git-2/src/cli/commands/files.rs` (`download_single_repo`)

**Guard:** Detect dirty branch name. `desktop/*` → new behavior. Old `dirty` → old behavior.
Does nothing new until MR2's migration has run.

**Tests:** Old-model workspace → download still reads `origin/dirty` (guard fires). New-model
workspace → skips `origin/dirty`, merges `origin/desktop/<machine>`. Post-publish merge:
reconciled dirty from server lands; mid-publish local edits survive (local-wins); unapproved
working copy untouched. No `origin/desktop/<machine>` ref → normal download, no merge step.

---

### MR4 — Server: FS-Based Publish Execution
_Server only. Independent. No behavior change visible to users yet._

**What ships:** Publish executor materializes plan entries to a temp dir keyed by publish ID.
After each record: push to connector → write result file. No git commits during execution.
`rebaseDirty()` still fires at the end — behavior is unchanged until MR5 ships.

**Temp dir structure:**
```
/tmp/publish-<publish-id>/
  plan/
    <folder>/edit/<record>.json       ← plan entry (input)
    <folder>/create/<record>.json
    <folder>/delete/<record>.json
  results/
    <folder>/edit/<record>.json       ← connector result after push (output)
    <folder>/create/<record>.json
    <folder>/delete/<record>.json     ← tombstone
```
Record in `plan/` but not `results/` = not published. Record in `results/` = published.

**Files:** `server/src/publish-plan/publish-from-git.service.ts` (refactor `runFromGit` loop;
`rebaseDirty()` call unchanged)

**Guard:** Temp dir is written regardless of whether MR1's `ref` param was used. Works with
both old and new clients. Feature flag `PUBLISH_FS_EXECUTOR=false` to toggle off if needed.

**Tests:** N plan entries → N result files on success. Inject failure after M → M result
files. Result files contain connector-returned state, not input state. `rebaseDirty()` still
fires after executor (regression guard).

---

### MR5 — Server: Post-Publish Reconciliation
_Server only. Guard makes it safe before or after MR4._

**What ships:** Replace `rebaseDirty()` with record-by-record reconciliation in one pass:

- **Record pushed** (result file exists): `dirty[path] = main[path]`
- **Record not pushed** (plan entry, no result): `dirty[path] = main[path] + reapply(pending)`
- **Delete pushed** (tombstone in results): record absent from dirty
- **Delete pending** (plan entry, no tombstone): record absent from dirty (intent preserved)
- **Not in plan**: dirty unchanged

After reconciliation, server pushes new dirty to `origin/desktop/<machine-name>`. Desktop
picks it up on next download via MR3's merge step.

**Files:** `server/src/publish-plan/publish-from-git.service.ts` (replace `rebaseDirty()`)

**Guard:** Check for temp dir with `plan/` subdirectory. Present → new reconciliation.
Absent (MR4 not yet deployed) → fall back to `rebaseDirty()`. The two activate together
naturally as MR4 starts writing temp dirs.

**Tests:** No temp dir → `rebaseDirty()` fires. Temp dir present → new reconciliation fires,
`rebaseDirty()` does NOT fire. Run all 12 edge-case scenarios as a required pre-merge gate.

---

### MR6 — CLI + Server + Desktop: Branch Merge Command
_Fully independent. Can ship at any point._

**What ships:** `scratchmd branches merge-from <source-branch> [target-branch]`

Uses `shared/merge.rs` 3-way merge. Merge base is `merge_base(source, target)`. Target
defaults to local dirty. Shared implementation with MR3's download merge step.

**Files:**
- `scratch-git-2/src/cli/commands/branches.rs` (new)
- `scratch-git-2/src/cli/commands/mod.rs`
- `server/src/cli/cli-workbook.controller.ts` (new endpoint)
- `scratch-desktop/src/main/index.ts` (new IPC handler)

**Tests:** Non-overlapping changes on two branches → merged correctly. Run twice →
idempotent. Same field modified on both sides → `ours wins` (document which side is ours).

---

### MR7 — Cleanup: Remove Desktop's origin/dirty Dependency
_Last. Irreversible. Gate on version adoption before shipping._

**What ships:** Remove all `origin/dirty` reads and writes from desktop code paths.
`files upload` from a desktop workspace returns an explicit error. `push-workspace-changes`
IPC handler removed or gated.

**Files:**
- `scratch-git-2/src/cli/commands/files.rs`
- `scratch-desktop/src/main/index.ts`
- `scratch-git-2/src/cli/git_ops/remote.rs` (remove `push_origin_dirty` if unused)

**Gate:** Only ship when: (1) MR1-MR5 stable for one full release cycle, (2) server logs
show no `origin/dirty` desktop writes for 2+ weeks, (3) auto-updater confirms all active
sessions are on a post-MR2 binary. Tag as breaking change.

**Tests:** `scratchmd files upload` from desktop → explicit error. No desktop CLI command
touches `origin/dirty`. End-to-end smoke: download → edit → publish → download with zero
`origin/dirty` involvement.

---

### MR8 — Resume Publish After Failure _(rough / unplanned)_

> **Status: placeholder. Do not implement until the open questions below are answered.**

After a publish stops at first failure, a Resume action picks up the existing job by ID,
reads the MR4 temp dir (result files for succeeded records still present), and continues
only records with no result file. No re-planning. No re-pushing records that already landed.

**Open questions before shaping:**
- Phase ordering: if a `create` fails, should dependent `backfill` entries be skipped?
- Rate limits: retry within the run (429) vs abort and surface (400)?
- Idempotency: edit was pushed but refetch failed → no result file → retry re-pushes. How to detect "already applied"?
- UI: how does "90 succeeded, 10 failed" surface clearly enough that users know to action it?

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
