# Don't block pulling newer server changes when local unreviewed edits exist (DEV-10523)

**Linear:** [DEV-10523 — Don't block pulling newer server changes when local unreviewed edits exist — stash & re-apply](https://linear.app/whalesync/issue/DEV-10523/dont-block-pulling-newer-server-changes-when-local-unreviewed-edits)
**Author:** Curtis Fonger
**Status:** Planned
**Surface:** `scratchmd` CLI / scratch-git (`/scratch-git-2`) is the root-cause fix. Scratch Desktop (`/scratch-desktop`): mostly passthrough (the new message flows through the existing error display), plus a small single-record "Download and publish" change (folded in — see "Single-record publish" below). **No server changes.**
**Related:** root-cause fix behind [DEV-10413](https://linear.app/whalesync/issue/DEV-10413/publish-one-record-is-blocked) (Done); relaxes the pull-side behavior of the [DEV-10316](https://linear.app/whalesync/issue/DEV-10316/publish-from-desktop-app-also-pushed-dirty-changes-from-web-app) dirty-gate work.

---

## Problem

When a user has local **unreviewed** edits and then pulls newer changes from the server — via **Pull all**, **Re-download files**, or single-record publish's **"Server has newer changes → Download and publish"** — the pull is **blocked**:

> Error invoking remote method 'scratch:pull-workspace-changes': Error: 249 unreviewed record(s) — run `scratchmd files accept-all` or `discard-all`, then retry.

The only escape offered (`accept-all` / `discard-all`) touches edits the user hasn't reviewed, which is unacceptable. So a user trying to publish **one** record (or just refresh) is dead-ended by **all** of their other unreviewed edits. Reported by Joel ([Slack](https://whalesync.slack.com/archives/C027U8U66BA/p1781813233907719)).

### Root cause

All three desktop pull flows route through one path:

`window.scratchDesktop.pullWorkspaceChanges(...)` → IPC `scratch:pull-workspace-changes` (`scratch-desktop/src/main/index.ts:834`) → `scratchmd files download` → `run_download` (`scratch-git-2/src/cli/commands/files.rs:582`).

`run_download` has an **all-or-nothing pre-flight** at **`files.rs:655–678`**: it walks every connection, and if `local ≠ approved` for *any* record (the gix-status fast path `list_unreviewed_records_using_gix_status`, `review_ops.rs:1289`) it prints `blocked_unreviewed` and bails **before fetching anything**:

```rust
if !blocked.is_empty() {
    print_blocked_unreviewed_result(&blocked, started.elapsed().as_millis(), json)?;
    anyhow::bail!(
        "{} unreviewed record(s) — run `scratchmd files accept-all` or `discard-all`, then retry.",
        blocked.len()
    );
}
```

The desktop's `runScratchmd` (`scratch-desktop/src/main/scratchmd.ts:375`) throws on the non-zero exit, and each flow surfaces it as a toast/modal.

---

## How the architecture already works (context for the fix)

| State         | Where it lives                                                                         |
| ------------- | -------------------------------------------------------------------------------------- |
| **published** | `refs/heads/main` blob in the connection's bare repo                                   |
| **approved**  | `published` overlaid with the entry in `.scratch/connections/<conn>/accepted-patches.json` |
| **local**     | The record file on disk (the worktree)                                                 |

A record is **unreviewed** when `local ≠ approved` (REVIEW_MODEL.md).

The key insight: **the download already rebases the _approved_ patches across a server advance, and the _unreviewed_ delta is the exact same patch shape, rebased by the exact same machinery.**

`download_single_repo` (`files.rs:4826`), per connection whose `main` actually moved:

1. `fetch_origin`; short-circuit to `up_to_date` if `refs/heads/main == refs/remotes/origin/main` (connections that didn't move pay only the fetch and are never touched).
2. Load `accepted-patches.json`; read **old main** (`refs/heads/main`), the **worktree**, and **new main** (`refs/remotes/origin/main`).
3. **Re-anchor** the approved patches old-main → new-main via `re_anchor::re_anchor_patches` (`re_anchor.rs:314`). This is a **value-based** rebase (`re_anchor_one`, `re_anchor.rs:125`): reconstruct the user's intended value, layer it onto the server's new state **user-wins per touched key**, re-emit a clean entry. Field-level collisions are detected (`detect_conflict`) and **logged to `.scratch/conflicts.log`** — the patch value is preserved (user always wins), the log is audit-only.
4. `compute_accepted_state(new_main, re_anchored)` → the new **approved** state; `materialize_local_repo` writes it to the worktree.
5. Save the re-anchored `accepted-patches.json` **before** advancing `refs/heads/main` (crash-recovery: a crash between the two re-converges on the next pull).

So the approved patches already survive a server advance with user-wins semantics. The unreviewed edits do not — they're blocked instead. This plan extends the same treatment to them.

### Three distinct gates — keep them separate (do NOT reopen the DEV-10316 publish hole)

DEV-10316 was specifically about **publish accidentally pushing the web app's dirty changes** onto a connection. That gate exists for a reason and must stay. There are three independent guards in play, and DEV-10523 touches **only the first**:

| # | Gate | Where | Protects against | DEV-10523 |
| - | ---- | ----- | ---------------- | --------- |
| **A** | **Pull-side local-unreviewed block** | `run_download` (`files.rs:655–678`) | (nothing real — it's an over-broad refusal) | **Relax** → stash & re-apply |
| **B** | **Publish-side local-unreviewed block** | `run_publish` (`files.rs:1301–1318`) | publishing edits the user never reviewed | **Untouched** |
| **C** | **Server dirty-gate** (DEV-10316) | upload commit `refuse_if_dirty` (`upload_single_repo_via_patches`, `files.rs:5118–5129`) + `expectedBaseDirtyHead` TOCTOU + server `/upload-patch/commit` | over-publishing the server's `dirty` (web-sync) changes the desktop never had locally | **Untouched** |

A, B, and C are independent. A and B *happen to share* the same error string + `print_blocked_unreviewed_result`, but they live on different commands (download vs. publish) and answer different questions. C lives entirely on the upload/publish path and is server-enforced.

**Why relaxing A does not reopen C's hole:** after a relaxed download, the user's re-applied edits are still *unreviewed* in the worktree. To publish them they must still go through B (accept first → publish refuses on unreviewed) and C (`refuse_if_dirty` server-side). Nothing about stash-and-re-apply on the *pull* path lets an unreviewed or web-dirty change reach the SaaS app. DEV-10523 makes **no server changes** and **no changes to `run_upload` / `run_publish` / the upload-commit DTO**, so the publish hole stays plugged.

---

## Design

**Replace the workspace-wide block with: stash → pull → re-apply, per connection, reusing the existing user-wins re-anchor.** The unreviewed delta (`approved → local`) is computed as an `AnchoredPatch` with `re_anchor::compute_entry` — the identical shape as an accepted patch — and rebased onto the new approved state with `re_anchor_one`.

### Conflict policy (decided with Curtis)

> **User-wins-and-log as much as possible. Fail only when the edit literally can't be re-applied** — the record was deleted server-side, or the value reconstruction genuinely errors.

This deliberately mirrors how *approved* patches are already handled (user-wins + `conflicts.log`), and is **looser** than the ticket's first-draft "fail on any conflict." A same-field collision is **not** a failure: the user's unreviewed edit wins, the worktree keeps it (still flagged unreviewed so the user can review it later), and the collision is logged.

The narrow **hard-conflict** set that does fail-and-stash:

1. **Server deleted the record the user was editing.** Precisely: `approved_old[path]` is `Some`, `approved_new[path]` is `None`, and the unreviewed delta is not itself a `Delete` (an `Update`/edit to a now-nonexistent record). You can't re-apply an edit to a record that no longer exists. *(Note: a brand-new local record that the server simply doesn't have — `approved_old` is `None`, `approved_new` is `None` — is **not** a conflict; it's a local `Create` and re-applies fine.)*
2. **Reconstruction error.** `re_anchor_one` returns `Err` (a value/patch genuinely can't be applied — the "JSON format changed so much the patch doesn't work" case). In the value-based model this is rare because the delta is computed fresh from `(approved_old, local)`, but we treat any `Err` defensively as a hard conflict rather than crashing the whole pull.

### Per-connection algorithm (in `download_single_repo`)

After step 2 above (old main, worktree, new main, accepted file all in hand), and computing the re-anchored approved state `approved_new`:

1. **Compute `approved_old`** = `compute_accepted_state(old_main, accepted_file)` (the state the worktree edits sit on top of).
2. **Compute unreviewed deltas**: for every data path, `compute_entry(approved_old[p], worktree[p])`. The non-`None` results are the unreviewed edits (semantic JSON diff — a whitespace/key-order-only change yields `None`, matching `list_unreviewed`). Skip if empty (fast common path — no extra work, no stash file).
3. **Stash all unreviewed deltas** to `.scratch/connections/<conn>/unreviewed-changes.json` **before** materialize (crash-safety / non-destructive: if we crash after overwriting the worktree but before re-applying, the edits are recoverable on disk).
4. **Build the final worktree map in memory** (avoids a lossy materialize-then-rewrite window): start from `approved_new`, then for each unreviewed delta:
   - **Hard conflict** (record deleted server-side, or `re_anchor_one` errors): collect it; leave the path at its `approved_new` value (absent for a server delete). Do **not** re-apply.
   - **Otherwise** (user-wins): `re_anchor_one(p, delta.kind, delta.patch, approved_old[p], approved_new[p])`; apply the re-anchored delta onto `approved_new[p]` and set the path to the result (or remove it for a `Delete`). If `re_anchor_one` reported a field collision, append it to `conflicts.log` (same as the approved path).
5. **Materialize the final map** (`materialize_local_repo(final_map, current=worktree)`) — one write; mtimes preserved for unchanged files; `changed_paths`/counts computed from `worktree → final_map` (the real on-disk delta).
6. **Save** re-anchored `accepted-patches.json` + **advance** `refs/heads/main` (unchanged ordering).
7. **Finalize the stash**: if there were hard conflicts, rewrite `unreviewed-changes.json` to hold **only** the hard-conflict entries (carrying the user's full intended content so an agent can re-create/resolve without the now-gone `approved_old`); surface them in the `DownloadResult`. Otherwise **delete** `unreviewed-changes.json` (clean success).

### Why this converges and is crash-safe

- Connections that didn't move short-circuit; their unreviewed edits are untouched (free).
- After save+advance, the connection is consistent: worktree = `approved_new` + user-wins edits; `accepted-patches.json` = re-anchored approved; `main` = new. `list_unreviewed` then correctly flags exactly the re-applied edits.
- The crash window between materialize and ref-advance re-converges: on the next pull, a moved-but-unedited record's recomputed "delta" is `approved_old → approved_new`, which `re_anchor_one` collapses to a no-op against `approved_new` (verified against `compute_entry`/`rebase_onto` semantics) — so no phantom unreviewed edits accumulate. Genuine edits re-derive identically.
- `unreviewed-changes.json` is a **recovery artifact**, not resumable state — nothing auto-replays it on a later pull. On clean success it's deleted.

### Failure surface (CLI)

Remove `blocked_unreviewed`. Add `blocked_conflict` for the hard-conflict case (`run_download` aggregates across connections; clean connections still complete; non-zero exit only if any connection had a hard conflict):

- **`--json`** (what the desktop reads): `{ "status": "blocked_conflict", "conflictCount": N, "paths": [...], "stashFiles": [".scratch/connections/<conn>/unreviewed-changes.json", ...], "elapsedMs": ... }`.
- **Human**: per the ticket —
  > Some local edits conflict with newer changes from the server. Local edits have been saved to `<conn>/unreviewed-changes.json` if you wish to reapply them. Please point your AI agent at the file to resolve conflicts and re-apply changes.

  followed by the conflicting paths (like `print_blocked_unreviewed_result`).

### Single-record publish: tolerate *other* records' conflicts (folded in)

DEV-10523 is the root cause behind DEV-10413's "server ahead" dead-end: single-record publish, when the server has advanced, prompts **"Server has newer changes → Download and publish"**, and that button calls the *full* `pullWorkspaceChanges` (`PublishChangesModal.tsx:901`) → `files download`. With the block relaxed (above), this succeeds in the common case. The remaining gap: a **hard conflict on some _other_ record** would fail the whole download and still block the one-record publish. We fold in the fix so single-record publish is bulletproof against other records' state.

**Why not a literal "re-anchor only the target record" scoped download** (the first idea): unsound here. The post-publish `reconcile_published_record` (DEV-10413, `files.rs:4647`) can touch exactly one record only because *our own publish* advanced `main` by exactly one path — every sibling blob is byte-identical old→new `main` (the load-bearing invariant), so leaving siblings' worktrees + patches alone is correct. In the **server-ahead** case the **server** advanced `main` by *arbitrary* paths. Advancing the connection's `refs/heads/main` without re-anchoring **all** accepted patches and reconciling **all** worktree files would leave the other patches anchored against stale `main` and their server updates **silently never materialized** (the next full pull short-circuits on "up to date"). So the connection-wide re-anchor/materialize (the DEV-10523 core) is required; you cannot scope it.

**The sound scope is conflict _reporting_, not re-anchoring.** Add `files download --file-path <workspace-relative-path>`:

- Runs the **identical** full re-anchor + materialize + stash-and-re-apply over the whole connection (other records *are* brought up to date, with their unreviewed edits preserved user-wins — consistent with the "Download and publish" prompt, which is explicit about downloading).
- **Scopes only the failure decision to the target:** exit non-zero `blocked_conflict` **iff the target record itself** is a hard conflict (you can't publish a record the server deleted). If only *other* records hard-conflict, exit **zero** with a status like `downloaded_with_stashed_conflicts` that lists the stashed paths, so the target — re-anchored against the new `main` — is ready to publish and the desktop can optionally notify about the other stashed edits.

This mirrors the existing `--file-path` precedent on `files upload` / `files reconcile-published`, keeps the policy in the CLI (frontends stay connector-agnostic), and means the single-record "Download and publish" path proceeds exactly when it safely can.

---

## File-by-file changes

### `scratch-git-2` (the fix)

- **`src/cli/commands/files.rs`**
  - `run_download` (582): delete the pre-flight block (655–678) and the `blocked` accumulation loop. After the per-connection loop, aggregate hard-conflict results; if any, print a `blocked_conflict` payload (human + JSON) and exit non-zero. **Scope: this is the only gate DEV-10523 touches** (see "Three distinct gates" above).
  - `download_single_repo` (4826): implement the algorithm above. New `DownloadResult` fields for hard conflicts (e.g. `hard_conflict_paths: Vec<String>`, and a `unreviewed_conflicts_auto_resolved` counter for the soft/logged ones, parallel to `conflicts_auto_resolved`).
  - **Add `--file-path <path>` to `files download`** (`FilesCommands::Download`, defs at ~30; dispatch at 508; `run_download` signature at 582). When set: run the identical connection-wide re-anchor/materialize/stash, but resolve the owning connection via the existing `resolve_connection_and_relpath` (`files.rs`, used by `reconcile-published`) and **scope the failure decision to the target** — non-zero `blocked_conflict` only if the target path is a hard conflict; otherwise exit 0 with `downloaded_with_stashed_conflicts` listing other stashed paths. Other connections still pull normally.
  - **Add** `print_blocked_conflict_result` (3956) for `run_download`'s new hard-conflict case. **Do not remove `print_blocked_unreviewed_result`** — `run_publish` (1312–1318) still calls it for the publish-side unreviewed block, which stays. `run_download` simply stops calling it.
  - `refresh_workbook_for_contexts` (~3330): this *also* short-circuits with the "skipping local refresh — N unreviewed record(s)" warning (a different, non-fatal path used by focus-sync auto-pulls). **Decided: keep its warn-and-skip unchanged** — auto-pulls shouldn't silently rewrite the worktree; it's out of the three user-facing flows and lower risk. Leave a code comment pointing at this plan so the divergence from `run_download` is intentional and documented.
- **`src/shared/`**: add an `unreviewed_changes` module (or a thin generalization of `accepted_patches`) that reads/writes the same `{ version, patches }` envelope with `FILENAME = "unreviewed-changes.json"`, reusing `save_atomic`/`load` discipline.
- **`src/shared/re_anchor.rs`**: no logic change — reuse `compute_entry`, `re_anchor_one`. (`#![allow(dead_code)]` already present; these become live callers.)

### `scratch-desktop`

- **All three flows** stop blocking on unreviewed edits for the common (user-wins) case automatically once the CLI is fixed. The IPC `pull-workspace-changes` (`index.ts:834`) gains `--json` so the desktop parses the structured download status (it currently runs human-mode and ignores stdout on success; on failure `runScratchmd` throws the stderr). This mirrors the DEV-10316 pattern where the desktop already parses `blocked_stale`/`blocked_dirty` JSON from the upload/publish CLI.
- **Single-record "Download and publish"** (folded in): wire the scoped download.
  - `pullWorkspaceChanges` (preload `index.ts:172`, IPC `index.ts:834`) gains an optional `{ filePath?: string }` (the IPC handler appends `--file-path <p>` to the `files download` args), parallel to how single-record `uploadWorkspaceChanges`/`reconcilePublishedRecord` already pass `--file-path` (DEV-10413).
  - `handleDownloadAndPublish` (`PublishChangesModal.tsx:901`) in `singleRecord` mode passes the target's CLI path. Because the CLI scopes the failure to the target, the existing "throws on non-zero → error mode; else continue to `startUpload`" control flow is already correct: it proceeds whenever the target is publishable, and only stops if the target itself conflicts. (No special-casing in the renderer.)
- **Conflict modal** (in this PR): switch the IPC `pull-workspace-changes` to `files download --json` and pattern-match the `blocked_conflict` / `downloaded_with_stashed_conflicts` status (parallel to how `PublishChangesModal` already parses `blocked_stale` / `blocked_dirty`). Render a dialog that names the stash file(s) and gives the "point your AI agent at `unreviewed-changes.json` to resolve conflicts and re-apply" guidance, across all three flows. `downloaded_with_stashed_conflicts` (single-record, non-target conflicts) is a non-blocking notice; `blocked_conflict` is the recoverable error state.

### Docs

- Update `scratch-git-2/docs/REVIEW_MODEL.md` (pull no longer blocks on unreviewed; describe stash & re-apply + `unreviewed-changes.json`).
- Cross-check `PULL_AFTER_PUBLISH.md` for any "pull refuses on unreviewed" wording.

---

## Stash file format (`unreviewed-changes.json`)

Per-connection, sibling to `accepted-patches.json`, same `{ version, patches: [AnchoredPatch] }` envelope so it's familiar and an agent can fold entries into `accepted-patches.json` if desired.

- On the **crash-safety pre-stash** (step 3): all unreviewed deltas as computed (`compute_entry` output).
- On **finalize with hard conflicts** (step 7): only the hard-conflict paths, each carrying the user's **full intended content** (a `Create`-shaped entry with the complete local value) so it's self-contained — the original `approved_old` base it was diffed against no longer exists on disk.

---

## Edge cases

- **No unreviewed edits** → identical to today (no stash file created, fast path).
- **Connection didn't move** → short-circuits `up_to_date`; edits untouched.
- **Soft field collision** (user & server both changed field X) → user-wins in the worktree, logged to `conflicts.log`, still flagged unreviewed. No failure.
- **Server deleted an edited record** → hard conflict; worktree shows it deleted; the user's content is preserved in `unreviewed-changes.json`; non-zero exit + recoverable message.
- **Local-only create the server lacks** → re-applies as a `Create` (not a conflict).
- **Local delete + server also deleted** → no-op (both agree).
- **Local delete + server modified** → user-wins delete, logged (not a hard conflict).
- **Mixed clean + conflicting connections** → clean ones pull fully; only the conflicting one stashes; one aggregated non-zero exit.
- **Single-record "Download and publish"** → uses the scoped `--file-path` download: proceeds to publish whenever the **target** record is publishable, even if *other* records soft- or hard-conflict (other conflicts are stashed, not blocking). Blocked only if the **target itself** hard-conflicts (e.g. the server deleted the very record being published — correct).

---

## Tests

New `download_single_repo` cases in the Slice-D section (`src/cli/commands/tests/files.rs:2188`, using `seed_main_with_record` / `advance_remote_main`):

1. Unreviewed edit on a **disjoint field** is preserved across a pull (re-applied on top of the server's change to another field); no `unreviewed-changes.json` left; not in `conflicts.log`.
2. Unreviewed edit the server **independently matched** → no-op; clean; record no longer unreviewed.
3. Unreviewed edit colliding with a server change on the **same field** → **user-wins**, worktree keeps the user's value, `conflicts.log` records the field; clean exit; no stash left.
4. **Unreviewed create** (brand-new local file) survives a pull.
5. **Server deleted an edited record** → hard conflict: worktree shows it deleted, `unreviewed-changes.json` written with the user's full content, `DownloadResult` reports the hard conflict.
6. **Mixed**: one connection clean, one with a hard conflict → clean one fully pulled, stash only on the conflicting one.
7. **No unreviewed edits** → unchanged behavior; no stash file.
8. Unreviewed **delete** that the server also deleted → no-op.

Scoped-download (`--file-path`) cases, exercising `run_download` end-to-end (or a `download_single_repo`-level harness with the scope plumbed):

9. Target clean, **another** record hard-conflicts → exit 0, `downloaded_with_stashed_conflicts`, other record stashed, target re-anchored against new `main` and ready to publish.
10. **Target itself** hard-conflicts (server deleted it) → non-zero `blocked_conflict`.
11. Target clean, another record **soft**-conflicts → exit 0; other record user-wins + logged; target publishable.

Plus `unreviewed_changes` module unit tests (round-trip, version stamping) and, if added, `re_anchor` reuse coverage.

Run `cargo test`, `cargo fmt`, root `yarn build` + `yarn lint`, and (per memory) `yarn lint-strict` in `server/` if any TS changes; desktop `yarn typecheck` if desktop is touched.

---

## Out of scope (v1)

- Auto-replaying `unreviewed-changes.json` on a subsequent pull (it's a manual/AI recovery artifact).
- A dedicated `scratchmd files resolve-conflicts` command (the agent edits the worktree + file directly for now).
- Rich desktop conflict-resolution UI beyond the message passthrough (optional polish above).
- Changing `refresh_workbook_for_contexts`'s focus-sync warn-and-skip (recommend leaving as-is for v1).

*(Previously deferred and now **folded in**: the scoped single-record download so a hard conflict on another record can't block a one-record publish — see "Single-record publish" above.)*

---

## Decisions (resolved with Curtis)

1. **`refresh_workbook_for_contexts` focus-sync path → keep warn-and-skip unchanged.** Auto-pulls shouldn't silently rewrite the worktree; out of the three user-facing flows.
2. **Desktop conflict modal → in this PR** (not a follow-up). Switch the pull IPC to `--json`; render the `blocked_conflict` / `downloaded_with_stashed_conflicts` dialog across all three flows.
3. **`conflicts.log` → log unreviewed-edit collisions identically to approved-patch collisions** (no distinct tag). It's an audit log; the existing `ConflictEntry { ts, connector_account_id, path, conflicting_keys }` shape is reused as-is.
