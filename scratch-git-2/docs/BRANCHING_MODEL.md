# Branching Model

How record state moves between the local working tree, the server, and the live SaaS app.

## State and where it lives

| State         | Where it lives                                                                                | Owner          |
| ------------- | --------------------------------------------------------------------------------------------- | -------------- |
| **published** | `refs/heads/main` blob in the connection's bare repo (server + local mirror)                  | Server         |
| **approved**  | Entry in `<workspace>/.scratch/connections/<conn>/accepted-patches.json` (RFC 7396 patch)     | Local CLI/UI   |
| **local**     | The record file on disk in `<workspace>/<connection>/<folder>/<record>.json`                  | User           |

The accepted-patches file holds the user's edits that have been **approved for publish but not yet sent**. It IS the wire payload that ships to `/upload-patch` — no diff is recomputed at upload time.

A field is **unreviewed** when `local ≠ approved` (the file on disk differs from `published` overlaid with the patch).
A file is **unpublished** when it has an entry in `accepted-patches.json`.

## Workflow

| Action                      | What changes                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Edit a record file on disk  | `local` diverges from `approved`. The file is now **unreviewed**.                                                                   |
| `scratchmd files accept`    | `approved` ← `local`. Patch entry created/updated. Working file untouched.                                                          |
| `scratchmd files reject`    | `local` ← `approved`. Patch entry untouched. No-op if nothing was unreviewed.                                                       |
| `scratchmd files discard`   | `local` ← `published`. Patch entry removed. Field/file returns to whatever's live in the SaaS app.                                  |
| `scratchmd files upload`    | Ship `accepted-patches.json` verbatim to the server's `dirty` branch via `/upload-patch`. No publish.                               |
| `scratchmd files publish`   | Trigger the server-side publish plan + run jobs. On success, advance local `refs/heads/main`; re-anchor `accepted-patches.json` against the new main (`reconcile_accepted_after_publish`). |
| `scratchmd files download`  | Refuse if any field is unreviewed. Otherwise fetch origin, re-anchor accepted patches against the new main, and replay on top of new blobs. |

## Publish reconcile (DEV-10048)

After a publish, `accepted-patches.json` and the server `dirty` branch are
reconciled per the publish redesign
([`docs/plans/2026-06-24-publish-failed-patches-redesign/2026-06-24-publish-failed-patches-redesign.md`](../../docs/plans/2026-06-24-publish-failed-patches-redesign/2026-06-24-publish-failed-patches-redesign.md)):

- The run-job carries a **`publishOrigin`** (`'desktop'` / `'web'`) that routes a
  record's **failed** edit. The server reconciles `dirty` via `rebaseDirty` with an
  **exclude-set** — paths to converge to `main` (published + no-op edits, plus
  failed paths on a desktop publish) — so a no-op edit (e.g. a removed key `main`
  never advanced for) stops re-accumulating on `dirty` as a phantom.
- The client post-publish reconcile (`reconcile_accepted_after_publish`, and the
  new `files reconcile-after-publish` the desktop runs per connection) moves
  connector-rejected records into **`failed-patches.json`** (re-surfaced in the
  worktree as needs-approval, with the connector error), drops publish-no-op
  survivors, keeps genuine still-pending edits, and preserves unreviewed edits.

## Single-record publish (DEV-10413)

`files upload --file-path <workspace-relative-path>` and `files reconcile-published --file-path <…>` publish exactly **one** record without disturbing the rest of the workspace. The desktop's per-record **Publish** button drives them; they mirror Scratch Web's single-file publish.

| Action                                         | What changes                                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files upload --file-path <p>`                 | Ship **only** that record's patch from `accepted-patches.json` to `dirty` (accumulating onto whatever is there). **Skips the dirty-gate probe** and relaxes `refuse_if_dirty`; keeps `refuse_if_stale`. The other approved records are never uploaded. |
| `files publish` (plan scoped via `filePath`)   | The server's plan build filters the `dirty`↔`main` diff to that one path, so only it publishes. `rebase_dirty` fast-forwards `dirty` clean afterward.                                                          |
| `files reconcile-published --file-path <p>`    | The single-record analogue of the post-publish `files download`. Re-anchors **only** that record's patch against the new `main` (drops it if the publish landed, keeps it re-anchored if the connector batch failed), and **surgically rewrites only that record's working file** — never `materialize_local_repo`. Leaves every other pending patch and on-disk record (including unreviewed edits) untouched. |

**Why a separate reconcile.** `files download` refuses while *any* field anywhere in the workspace is unreviewed, so it can't run after a single-record publish when other records still have unreviewed edits. `reconcile-published` is scoped to the one record and runs regardless.

**Two distinct over-publish guards** (don't conflate them):

1. **Scoped upload** keeps the desktop's *other* approved records off `dirty` entirely — they can't appear in any plan.
2. **`filePath` plan scope** guards against changes already on `dirty` from another source (web sync, a prior interrupted "Publish all") — there `dirty` is genuinely busy and the filter is load-bearing.

**Load-bearing invariant.** A scoped publish advances `main` for exactly one path, so every sibling blob is byte-identical in old-vs-new `main`. That's what lets `reconcile-published` leave the other records' working files alone (re-materializing them would produce identical bytes). FK backfill can break this; the per-record Publish button is update-only to avoid it (untested v1 limitation).

## Pre-Phase-5 model (historical)

Before slice F (2026-05-20), the CLI carried a local `refs/heads/dirty` branch as the "approved" snapshot, with the user's working tree on a sparse worktree of `dirty`. Accept committed working-tree edits onto `dirty`. That branch was retired in favor of `accepted-patches.json` — see the [architecture-change plan](../../docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture/2026-05-17-simplify-local-workspace-architecture.md). The server-side `dirty` branch (the publish staging area) is unchanged.

## See also

- [REVIEW_MODEL.md](REVIEW_MODEL.md) — definitive accept/reject/discard semantics, the patch file format, the field-level state model.
- [REPO_STRUCTURES.md](REPO_STRUCTURES.md) — on-disk layout for the workspace and the bare repo.
