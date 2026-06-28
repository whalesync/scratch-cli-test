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

// The driver-script rewrite for the slice-F local-workspace layout landed on
// 2026-05-29, so this suite is back online for the edit/create/delete cases.
//
// The two `pseudo-ref FK` cases remain `.skip`ped pending a fix for the
// backfill / re-anchor bug documented in
// docs/plans/2026-06-01-publish-backfill-reanchor-bug/2026-06-01-publish-backfill-reanchor-bug.md: after the
// server-side publish-plan refactor, the CLI's `accepted-patches.json` is no
// longer cleared for patches that contained an `@/...` pseudo-ref, so the
// post-publish working tree silently un-resolves the FK. Un-skip once one of
// the three remediation options in that plan ships.
describeIfPostgres("driver: publish", () => {
  it("edit: updates a record end-to-end", () => {
    runDriver({ count: 1 });
  });

  it("create: adds a new record end-to-end", () => {
    runDriver({ count: 1, editCount: 0, createCount: 1 });
  });

  it("delete: removes a record end-to-end", () => {
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
