/**
 * End-to-end publish tests driven by the driver script (scripts/driver-run.js).
 *
 * The driver script is an opinionated scenario runner that works with two related
 * Postgres tables — authors and posts (posts.authorId FK → authors.id) — and
 * exercises the full publish-from-git cycle: seed DB, create workbook, pull records
 * locally, make changes, accept + upload, trigger publish, wait, download, verify.
 *
 * All assertions are internal to the driver: if it exits 0 the scenario passed.
 * Run it directly with --no-cleanup --pause=everywhere for interactive step review.
 */

import { runDriver } from "../src/driver";

const postgresUrl = process.env.DATABASE_URL;
const describeIfPostgres = postgresUrl ? describe : describe.skip;

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
