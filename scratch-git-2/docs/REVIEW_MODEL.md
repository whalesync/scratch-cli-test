# Review Model: accept, reject, discard

How the scratchmd CLI thinks about pending changes to records.

Every record field has three conceptual values: **published**, **approved**, and **local**. The CLI's `accept` / `reject` / `discard` commands move fields between those values. This document explains what each command does and when to use it.

> If you've ever wondered "what's the difference between `reject` and `discard`?" — that's the question this doc was written to answer.

## Strict invariant

> **Only `accept` writes entries to `accepted-patches.json`. Only `discard` removes them. `reject` MUST NEVER mutate the patch file.**

This invariant holds at every layer that exposes review actions — the CLI subcommands, the napi bindings (`acceptField` / `rejectField` / `discardField`), and any UI button or wrapper that calls them. If you're implementing a new "Reject"-style action, the only thing it is allowed to touch is the working tree. If you find yourself reaching for `acceptField` (or any code that writes patches) to implement a reject, stop — you want `rejectField`.

Why: once a field is in `accepted-patches.json`, it's a committed promise that the value will be published. Letting a Reject silently mutate that file (even with a "no-op" same-value snapshot) breaks the "Approved" tab classification, the publish plan, and the user's mental model that they only approved what they actually approved.

## The three states

| State         | Where it lives                                                          | Git analogy                             |
| ------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| **published** | `refs/heads/main` blob — what's live in the SaaS app                    | A line in `main`                        |
| **approved**  | `published` overlaid with the entry in `accepted-patches.json` (if any) | A line in your local branch HEAD        |
| **local**     | the working-tree file on disk                                           | A line in your uncommitted working copy |

A field is **unreviewed** when `local ≠ approved`.
A file is **unpublished** when it has an entry in `accepted-patches.json`.

## The three actions

| Action      | Effect on `local`   | Effect on the patch file                                         | Git equivalent (for one line)                                        |
| ----------- | ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| **accept**  | unchanged           | set patch's value for this field to `local`                      | `git add -p` that line, then commit                                  |
| **reject**  | `local ← approved`  | unchanged                                                        | `git checkout HEAD -- <file>` for that line — drop the unstaged edit |
| **discard** | `local ← published` | remove this field from the patch entry; drop entry if it empties | `git restore --source=main --staged --worktree` for that line        |

### The easy confusion: reject vs. discard

**Reject** rolls back one step (unreviewed → approved). It throws away the unreviewed working-tree edit and restores the approved value.

**Discard** rolls back both steps (anything → published). It throws away both the unreviewed edit AND the approved patch, leaving the field at whatever the SaaS app currently has.

Once a field is already approved (`local == approved`), `reject` is a no-op — there's nothing to roll back. Only `discard` can undo an approval.

## A concrete example

Say `alice.json` has field `Email`:

- **published:** `alice@example.com` (current value in the SaaS app)
- **approved:** `alice@vp.example.com` (pending publish — an entry in `accepted-patches.json`)
- **local:** `alice@ceo.example.com` (you just edited the file but haven't accepted yet)

| Command on `Email`            | published     | approved              | local                |
| ----------------------------- | ------------- | --------------------- | -------------------- |
| (before)                      | alice@example | alice@vp.example      | alice@ceo.example    |
| `files accept-field Email …`  | alice@example | **alice@ceo.example** | alice@ceo.example    |
| `files reject-field Email …`  | alice@example | alice@vp.example      | **alice@vp.example** |
| `files discard-field Email …` | alice@example | **(entry removed)**   | **alice@example**    |

Accept and reject both close the `local ↔ approved` gap — accept by promoting `local`, reject by reverting it. Discard closes the `approved ↔ published` gap (and any `local ↔ approved` gap along the way) by dropping the patch entirely.

## CLI command reference

State is per-field, but commands come in three scopes: **whole-path**, **field-in-folder**, and **all-in-folder**.

### Whole-path commands

For one or more specific record paths, applied across every field.

| Command                             | What it does                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `scratchmd files accept <path>...`  | Capture every unreviewed field of each path into the patch entry. Working file untouched. |
| `scratchmd files reject <path>...`  | Restore the working file's content to its approved state. Patch entry untouched.          |
| `scratchmd files discard <path>...` | Drop the patch entry; restore the working file to its published content.                  |

Two file-level lifecycle convenience commands handle the edges where field-level semantics don't apply:

| Command                                            | What it does                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `scratchmd files restore-deleted-record <path>...` | Undo an accepted `Delete`: drop the entry, write the main blob back to the working file. |
| `scratchmd files discard-created-record <path>...` | Undo an accepted `Create`: drop the entry, remove the working file.                      |

### Field-in-folder commands

Apply the action to one named field across every record in a folder.

| Command                                                       | What it does                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `scratchmd files accept-field --field <F> --folder <folder>`  | For each unreviewed file in the folder, fold `F`'s local value into the patch.                                          |
| `scratchmd files reject-field --field <F> --folder <folder>`  | For each unreviewed file, set `local[F] ← approved[F]`. Patch untouched.                                                |
| `scratchmd files discard-field --field <F> --folder <folder>` | For each in-scope file, set `local[F] ← published[F]` and drop `F` from the patch (drop the whole entry if it empties). |

The `--field` argument supports dot-separated paths for nested fields, e.g. `--field author.name`.

### All-in-folder commands

Apply the action to every unreviewed (or approved, for `discard-all`) file in scope. `--folder` is optional; without it the command runs across every connection in the workspace.

| Command                                           | What it does                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `scratchmd files accept-all [--folder <folder>]`  | Accept every file with unreviewed changes in scope.                       |
| `scratchmd files reject-all [--folder <folder>]`  | Restore the working tree for every file with unreviewed changes in scope. |
| `scratchmd files discard-all [--folder <folder>]` | Drop every patch entry in scope; restore working files to published.      |

### Listing commands

Inspect state without changing it.

| Command                       | What it returns                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `scratchmd files unreviewed`  | Records whose working file differs from the approved state.                       |
| `scratchmd files unpublished` | Records with an entry in `accepted-patches.json` (approved, not yet published).   |
| `scratchmd files unpushed`    | Alias of `unpublished`. Kept for back-compat; will collapse once callers migrate. |

### Lifecycle commands

| Command                                       | What it does                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `scratchmd files download`                    | Pull the server's `main`, re-anchor `accepted-patches.json`, and re-apply any **unreviewed** working-tree edits user-wins (DEV-10523). It no longer refuses when unreviewed edits exist; an edit that can't be re-applied is stashed (see below) and reported as a `blocked_conflict`. |
| `scratchmd files download --file-path <p>`    | Single-record pull (the "Download and publish" flow). The whole workspace still pulls; this only **scopes the failure decision** to that record — non-zero `blocked_conflict` iff the target itself hard-conflicts, else `downloaded_with_stashed_conflicts` so the target stays publishable. |
| `scratchmd files upload`                      | Ship `accepted-patches.json` to the server's `dirty` branch. Does not publish.                                        |
| `scratchmd files upload --file-path <p>`      | Single-record (DEV-10413): ship only that record's patch; skips the dirty-gate probe (`refuse_if_dirty` relaxed, `refuse_if_stale` kept). |
| `scratchmd files publish`                     | Run the publish plan + execute it on connectors. Advances local `main` and clears `accepted-patches.json` on success. |
| `scratchmd files reconcile-published --file-path <p>` | Single-record post-publish reconcile: re-anchor only that record's patch against the new `main` and surgically rewrite only its working file — it touches just the one record, where `files download` brings the whole connection up to date. See [BRANCHING_MODEL.md](BRANCHING_MODEL.md#single-record-publish-dev-10413). |

## Where the data lives

Per connection, at `<workspace>/.scratch/connections/<conn>/accepted-patches.json`.

```json
{
  "patches": [
    {
      "path": "Companies/rec_123.json",
      "kind": "update",
      "patch": { "industry": "SaaS" }
    },
    {
      "path": "Companies/rec_456.json",
      "kind": "create",
      "patch": { "name": "Acme" }
    },
    {
      "path": "Companies/rec_789.json",
      "kind": "delete",
      "patch": null
    }
  ]
}
```

- `kind: "update"`: `patch` is an RFC 7396 JSON Merge Patch — only the changed keys.
- `kind: "create"`: `patch` is the full content of a new record (no main blob exists).
- `kind: "delete"`: `patch` is `null`; the record will be deleted on publish.

The file IS the wire format. `files upload` ships it verbatim to `/upload-patch` — no diff computation at upload time. All the per-field diff logic happens at accept time, in `re_anchor::compute_entry`.

It's safe to `cat` and inspect; it's a normal JSON file. Mutating callers acquire the workspace lock at `<workspace>/.scratch/lock` first, and writes are atomic (`<file>.tmp.<pid>` → fsync → rename, then an fsync of the containing directory so the rename itself survives a crash).

> **Don't hand-edit `accepted-patches.json`** (or its siblings). An external write — a manual edit, a Python `json.dump`, an editor — bypasses the `.scratch/lock` and the atomic temp→rename path, and can leave the file in a partially-written state (the classic symptom is **trailing NUL bytes after the closing `}`**, from a non-truncating write, a cloud-sync placeholder, or a power-loss). To drop unwanted patches, use `scratchmd files reject` / `discard`, which mutate the file safely. Relatedly, keep the workspace **out of a cloud-synced folder** (iCloud Drive, Dropbox, OneDrive) — those clients can momentarily expose a zero-filled placeholder for a file mid-sync.
>
> **Read-side resilience:** `load` tolerates a complete document followed by trailing NUL/whitespace padding — it strips the padding, parses, and warns (the file self-cleans on the next mutating write). Genuinely truncated or structurally-broken JSON still fails loud rather than risk mis-reconstructing the user's edits.

### `failed-patches.json` (post-publish connector rejections, DEV-10048)

Sibling to `accepted-patches.json`, at `<workspace>/.scratch/connections/<conn>/failed-patches.json`. After a publish, a record the destination connector **rejected** moves OUT of `accepted-patches.json` and INTO this file, carrying the connector's error. It uses the same `{ version, patches }` envelope, with two extra per-entry fields:

- `error` — the record-level connector message (e.g. `"Organization cannot be null"`).
- `fieldErrors` — optional per-field messages keyed by RFC 6902 JSON Pointer (e.g. `{ "/Organization": "Organization cannot be null" }`), driving the per-field "failed to publish" warning in the grid.

The error lives at the **entry** level, never on the RFC 6902 ops, so `patch` stays a conformant op array / merge patch and re-applies through the same machinery as an accepted patch.

The failed edit is re-applied to the **working tree** during the post-publish reconcile (so it shows as **needs-approval**), but is NOT in `accepted-patches.json` — so it is not staged to publish again until the user deliberately re-accepts it (which removes the `failed-patches.json` entry and folds the edit back into `accepted-patches.json`). An empty set deletes the file; a clean publish leaves none behind. See the publish redesign doc, [`docs/plans/2026-06-24-publish-failed-patches-redesign/2026-06-24-publish-failed-patches-redesign.md`](../../docs/plans/2026-06-24-publish-failed-patches-redesign/2026-06-24-publish-failed-patches-redesign.md).

### `unreviewed-changes.json` (the pull conflict stash, DEV-10523)

Sibling to `accepted-patches.json`, at `<workspace>/.scratch/connections/<conn>/unreviewed-changes.json`, with the same `{ version, patches }` envelope. `files download` re-applies unreviewed working-tree edits user-wins across a server advance instead of refusing the pull. The narrow set it **can't** re-apply — the server deleted the very record the user was editing, or the patch genuinely fails to reconstruct — would be lost when the worktree is overwritten with the new approved state. Before that overwrite, each such record is written here as a self-contained `create`-shaped entry carrying the user's full intended content (the base it was diffed against no longer exists), so the work is recoverable.

It is a **recovery artifact**, not resumable state: nothing auto-replays it on a later pull. Point an AI agent (or a human) at it to fold the entries back into the worktree / `accepted-patches.json`. A clean pull writes no such file.

## See also

- [REPO_STRUCTURES.md](REPO_STRUCTURES.md) — on-disk layout for CLI workspaces and service-side bare repos.
- The architecture-change plan at [`docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture/2026-05-17-simplify-local-workspace-architecture.md`](../../docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture/2026-05-17-simplify-local-workspace-architecture.md) — context for _why_ this model exists (history of the move from a three-worktree model; not a learning resource).
