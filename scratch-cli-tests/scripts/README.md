# Driver Scripts

These scripts back the driver-based publish suite in `tests/driver-publish.spec.ts`. The Jest spec is intentionally thin; the driver owns setup, the publish flow, and the assertions.

## What the driver does

`driver-run.js` creates a fresh Postgres database and workbook, seeds `authors` + `posts`, links both tables, pulls/downloads records, edits local JSON, accepts reviewed changes, uploads them, runs `scratchmd files publish`, downloads again, and verifies both the remote database and the local `master`, `dirty`, and working tree state.

It can also create and delete posts in the same cycle, leave some edits unreviewed, inject a concurrent edit into the remote `dirty` branch, and test FK backfill by writing `posts.authorId` as an `@/...` pseudo-reference to an author file. The current spec actively covers edit/create/delete flows; FK pseudo-ref cases are present but currently skipped.

`driver-push.js` reruns the publish half inside an existing driver workspace. `driver-cleanup.js` removes leftover driver workbooks, databases, and local workspace folders.

## Schema

| Table | Fields |
| --- | --- |
| `authors` | `id` identity PK, `name` text, `lastUpdated` timestamptz |
| `posts` | `id` identity PK, `name` text, `ts` timestamptz, `authorId` nullable FK -> `authors.id`, `lastUpdated` timestamptz |

Seeded state: one author (`Author 1`) and `N` posts (`Post 1..N`).

## Server-managed changes

Both tables have a trigger that overwrites `lastUpdated = NOW()` on every update. `lastUpdated` exists specifically to simulate server-managed fields that change during publish even when the user did not edit that field locally.

The driver also simulates background remote activity by committing `Remote Edit <id> (external)` directly to the remote `dirty` branch before publish. After the final download, the refreshed server version is expected to be accepted everywhere: remote DB, local `master`, local `dirty`, and the working tree.

A later change may add another server-normalized field with the same expectation; for now `lastUpdated` is the coverage for that behavior.
