/**
 * End-to-end publish tests driven by the driver script (scripts/driver-run.js).
 *
 * The driver script is an opinionated scenario runner that works with two related
 * Postgres tables — authors and posts (posts.authorId FK → authors.id) — and
 * exercises the full publish cycle: seed DB, create workbook, pull records
 * locally, make changes, accept, upload via /upload-patch, drive
 * /publish-v2/plan-job + /run-job to completion, download, verify.
 *
 * All assertions are internal to the driver: if it exits 0 the scenario passed.
 * Run it directly with --no-cleanup --pause=everywhere for interactive step review.
 */

import { runDriver } from "../src/driver";

const postgresUrl = process.env.DATABASE_URL;
const describeIfPostgres = postgresUrl ? describe : describe.skip;

// All tests in this suite are skipped pending a driver-script rewrite for the
// post-slice-F single-worktree layout. The driver verifies record state at
// three on-disk locations — `.scratch/connections/master/<conn>/`,
// `.scratch/connections/dirty/<conn>/`, and the working tree — but the first
// two no longer exist after the simplification described in
// docs/plans/2026-05-17-simplify-local-workspace-architecture.md. Review state
// is now held in `.scratch/connections/<conn>/accepted-patches.json` and the
// "published" view comes from `refs/heads/main` in the bare repo, neither of
// which the driver currently knows how to inspect.
//
// Restoring these tests requires reworking `scripts/driver-run.js` (the
// master/dirty location helpers near getMasterConnectionDir/getDirtyConnectionDir
// and the per-location verification loops) to read from the bare repo +
// accepted-patches.json instead.
describeIfPostgres("driver: publish", () => {
  it.skip("edit: updates a record end-to-end", () => {
    runDriver({ count: 1 });
  });

  it.skip("create: adds a new record end-to-end", () => {
    runDriver({ count: 1, editCount: 0, createCount: 1 });
  });

  it.skip("delete: removes a record end-to-end", () => {
    runDriver({ count: 1, editCount: 0, deleteCount: 1 });
  });

  it.skip("pseudo-ref FK to existing record: backfills authorId from @/ path", () => {
    // Post 1 gets authorId = "@/public/authors/author-1.json"; after publish the
    // backfill phase resolves it to the existing author's remote id (1).
    runDriver({ count: 1, addFk: "1-1" });
  });

  it.skip("pseudo-ref FK to new record: creates author then backfills authorId", () => {
    // A new author-create-1.json is created locally alongside an edited post.
    // The post gets authorId = "@/public/authors/author-create-1.json". The
    // publish plan creates the author first, then backfills the post's FK.
    runDriver({ count: 1, addFk: "1-0" });
  });
});
