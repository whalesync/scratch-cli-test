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

## Pre-Phase-5 model (historical)

Before slice F (2026-05-20), the CLI carried a local `refs/heads/dirty` branch as the "approved" snapshot, with the user's working tree on a sparse worktree of `dirty`. Accept committed working-tree edits onto `dirty`. That branch was retired in favor of `accepted-patches.json` — see the [architecture-change plan](../../docs/plans/2026-05-17-simplify-local-workspace-architecture.md). The server-side `dirty` branch (the publish staging area) is unchanged.

## See also

- [REVIEW_MODEL.md](REVIEW_MODEL.md) — definitive accept/reject/discard semantics, the patch file format, the field-level state model.
- [REPO_STRUCTURES.md](REPO_STRUCTURES.md) — on-disk layout for the workspace and the bare repo.
