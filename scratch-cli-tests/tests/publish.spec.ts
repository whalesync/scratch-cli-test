import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import YAML from "yaml";
import { ScratchCli } from "../src/cli";
import {
  deleteWorkspace,
  TEST_CONNECTOR_SERVICE,
  uniqueName,
} from "../src/helpers";
import {
  AUTHOR_IDS,
  REVIEW_IDS,
  setupAuthorsTable,
  setupProductsTable,
  setupReviewsTable,
  setupTestTable,
  teardownAuthorsTable,
  teardownProductsTable,
  teardownReviewsTable,
  teardownTestTable,
} from "../src/postgres";

const cli = new ScratchCli();
const postgresUrl = process.env.DATABASE_URL;
const preserveOnFailure = process.env.PRESERVE_WORKBOOK_ON_FAILURE === "true";

const describeIfPostgres = postgresUrl ? describe : describe.skip;

/**
 * Note on job monitoring: `files publish` and `files upload` both poll their
 * server-side jobs to completion before returning (see
 * `scratch-git-2/src/cli/commands/files.rs::run_publish` and
 * `upload_single_repo_via_patches`). A zero exit + a `published` /
 * `uploaded` status is therefore a positive signal that the apply-patches
 * job, the plan-job, AND the run-job all reached `completed`. The Postgres
 * row-level assertion in the publish step is the second, independent check
 * that the run-job actually carried the change through to the external
 * service — not just to the server's dirty branch.
 */

/** Recursively find all .json record files under a directory (skipping dot-dirs). */
function findJsonFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      results.push(...findJsonFiles(fullPath));
    } else if (entry.name.endsWith(".json") && !entry.name.startsWith(".")) {
      results.push(fullPath);
    }
  }
  return results;
}

interface WorkspaceMarker {
  workbook: { id: string; name: string };
  connections: Array<{ id: string; dirName: string; service: string }>;
}

interface AcceptedPatch {
  path: string;
  kind: "create" | "update" | "delete";
  patch: Record<string, unknown> | null;
}

interface AcceptedPatchesFile {
  patches: AcceptedPatch[];
}

/**
 * `failed-patches.json` entry (the publish redesign, DEV-10048). Same envelope
 * as an accepted patch plus entry-level connector rejection detail: a
 * record-level `error` message and optional per-field `fieldErrors` keyed by
 * RFC 6902 JSON Pointer. See `scratch-git-2/src/shared/failed_patches.rs`.
 */
interface FailedPatch extends AcceptedPatch {
  error?: string;
  fieldErrors?: Record<string, string>;
}

interface FailedPatchesFile {
  patches: FailedPatch[];
}

/** Read .scratch/.scratchmd workspace marker. */
function readMarker(workspaceDir: string): WorkspaceMarker {
  const markerPath = path.join(workspaceDir, ".scratch", ".scratchmd");
  return YAML.parse(fs.readFileSync(markerPath, "utf-8")) as WorkspaceMarker;
}

/** Read accepted-patches.json for a given connection dir name. */
function readAcceptedPatches(
  workspaceDir: string,
  connDirName: string,
): AcceptedPatchesFile {
  const patchPath = path.join(
    workspaceDir,
    ".scratch",
    "connections",
    connDirName,
    "accepted-patches.json",
  );
  if (!fs.existsSync(patchPath)) return { patches: [] };
  const raw = fs.readFileSync(patchPath, "utf-8");
  if (!raw.trim()) return { patches: [] };
  return JSON.parse(raw) as AcceptedPatchesFile;
}

/** Read failed-patches.json for a given connection dir name (DEV-10048). */
function readFailedPatches(
  workspaceDir: string,
  connDirName: string,
): FailedPatchesFile {
  const patchPath = path.join(
    workspaceDir,
    ".scratch",
    "connections",
    connDirName,
    "failed-patches.json",
  );
  if (!fs.existsSync(patchPath)) return { patches: [] };
  const raw = fs.readFileSync(patchPath, "utf-8");
  if (!raw.trim()) return { patches: [] };
  return JSON.parse(raw) as FailedPatchesFile;
}

/** Absolute path to accepted-patches.json for a connection. */
function acceptedPatchesPath(
  workspaceDir: string,
  connDirName: string,
): string {
  return path.join(
    workspaceDir,
    ".scratch",
    "connections",
    connDirName,
    "accepted-patches.json",
  );
}

describeIfPostgres(
  "Publish via accepted-patches.json — accept → upload → publish → download",
  () => {
    let workspaceId: string;
    let workspaceDir: string;
    let connDirName: string;
    let editedRecordId: string;
    let editedRecordWorkspacePath: string;
    let editedRecordAbsPath: string;
    let originalAuthor: string;
    const newAuthor = "Sarah Chen-Published-Via-Patch";
    let hasFailed = false;

    beforeAll(async () => {
      await setupTestTable();

      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("publish-patch"),
      ]);
      workspaceId = ws.id;

      const conn = cli.json<{ id: string }>([
        "connections",
        "--workspace",
        workspaceId,
        "add",
        "--service",
        TEST_CONNECTOR_SERVICE,
        "--param",
        `connectionString=${postgresUrl}`,
      ]);
      const connectionId = conn.id;

      const parentDir = path.join(cli.home, "test-publish-patch");
      fs.mkdirSync(parentDir, { recursive: true });
      const initResult = cli.json<{ directory: string }>(
        ["workspaces", "init", workspaceId],
        { cwd: parentDir },
      );
      workspaceDir = path.join(parentDir, initResult.directory);

      const tables = cli.json<Array<{ id: string; displayName: string }>>([
        "linked",
        "--workspace",
        workspaceId,
        "available",
        connectionId,
      ]);
      const blogPostsTable = tables.find(
        (t) => t.displayName === "integration_blog_posts",
      )!;
      const tableIdParts = blogPostsTable.id.split(",");
      const linked = cli.json<{ id: string }>(
        [
          "linked",
          "--workspace",
          workspaceId,
          "add",
          "--connection-id",
          connectionId,
          ...tableIdParts.flatMap((p: string) => ["--table-id", p]),
          "--name",
          blogPostsTable.displayName,
        ],
        { cwd: workspaceDir },
      );
      cli.run(["linked", "--workspace", workspaceId, "pull", linked.id], {
        cwd: workspaceDir,
      });
      cli.run(["files", "download"], { cwd: workspaceDir });

      // Discover the connection directory name from the marker. Post-slice-F,
      // record files live at `<workspace>/<connDirName>/<schema>/<table>/*.json`
      // (single non-sparse worktree on `main`).
      const marker = readMarker(workspaceDir);
      connDirName = marker.connections[0]!.dirName;

      // Pick the AI-tools post — its author "Sarah Chen" is the row we mutate
      // through the patch workflow. The other two records stay as a control.
      const allFiles = findJsonFiles(workspaceDir);
      const targetFile = allFiles
        .map((p) => ({
          p,
          data: JSON.parse(fs.readFileSync(p, "utf-8")) as Record<
            string,
            unknown
          >,
        }))
        .find(
          (r) => r.data.title === "The Rise of AI-Powered Development Tools",
        );
      if (!targetFile) {
        throw new Error("Expected AI-tools blog post not found after pull");
      }
      editedRecordAbsPath = targetFile.p;
      editedRecordWorkspacePath = path.relative(workspaceDir, targetFile.p);
      editedRecordId = String(targetFile.data.post_id);
      originalAuthor = String(targetFile.data.author);
    }, 120_000);

    afterAll(async () => {
      const shouldPreserve = preserveOnFailure && hasFailed;
      if (shouldPreserve) {
        console.log(
          `[preserve] Keeping workbook ${workspaceId} and local dir ${workspaceDir} for inspection`,
        );
      }
      if (workspaceId && !shouldPreserve) deleteWorkspace(cli, workspaceId);
      if (workspaceDir && !shouldPreserve) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownTestTable();
    });

    it("starts with no accepted-patches.json", () => {
      try {
        const before = readAcceptedPatches(workspaceDir, connDirName);
        expect(before.patches).toHaveLength(0);
        expect(originalAuthor).toBe("Sarah Chen");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("local edit shows up as an unreviewed change", () => {
      try {
        // Mutate the working file. The change is now "unreviewed" — present
        // on disk but not yet in accepted-patches.json. We deliberately omit
        // the trailing newline that the server canonical format includes:
        // the detector should compare semantically, not byte-for-byte, so
        // the missing newline alone must not turn the change into a false
        // positive at the next assertion (the author edit is the real diff).
        const data = JSON.parse(
          fs.readFileSync(editedRecordAbsPath, "utf-8"),
        ) as Record<string, unknown>;
        data.author = newAuthor;
        fs.writeFileSync(editedRecordAbsPath, JSON.stringify(data, null, 2));

        const unreviewed = cli.json<{
          count: number;
          entries: Array<{ path: string; connectionName?: string }>;
        }>(["files", "unreviewed"], { cwd: workspaceDir });
        expect(unreviewed.count).toBe(1);
        const entry = unreviewed.entries[0];
        // `unreviewed` reports the path relative to the connection root.
        expect(entry.path).toBe(
          path.relative(
            path.join(workspaceDir, connDirName),
            editedRecordAbsPath,
          ),
        );
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("accept generates accepted-patches.json with the expected RFC 6902 entry", () => {
      try {
        const acceptResult = cli.json<{
          status: string;
          filesAccepted: number;
          paths: string[];
        }>(["files", "accept", editedRecordWorkspacePath], {
          cwd: workspaceDir,
        });

        expect(acceptResult.status).toBe("accepted");
        expect(acceptResult.filesAccepted).toBe(1);
        expect(acceptResult.paths).toEqual([editedRecordWorkspacePath]);

        // accepted-patches.json must now exist with a single update entry
        // carrying the field-level RFC 6902 JSON Patch (DEV-10237).
        const patchFile = readAcceptedPatches(workspaceDir, connDirName);
        expect(patchFile.patches).toHaveLength(1);
        const entry = patchFile.patches[0];

        // `path` in the patch file is connection-relative.
        const expectedRelPath = path.relative(
          path.join(workspaceDir, connDirName),
          editedRecordAbsPath,
        );
        expect(entry.path).toBe(expectedRelPath);
        expect(entry.kind).toBe("update");
        expect(entry.patch).toEqual([
          { op: "add", path: "/author", value: newAuthor },
        ]);

        // After accept, the change is approved, so `files unreviewed` is empty
        // and `files unpublished` reports the change.
        const unreviewedAfter = cli.json<{ count: number }>(
          ["files", "unreviewed"],
          { cwd: workspaceDir },
        );
        expect(unreviewedAfter.count).toBe(0);

        const unpublished = cli.json<{
          count: number;
          entries: Array<{ path: string }>;
        }>(["files", "unpublished"], { cwd: workspaceDir });
        expect(unpublished.count).toBe(1);
        expect(unpublished.entries[0].path).toBe(expectedRelPath);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("upload posts accepted-patches.json to the server's dirty branch", async () => {
      try {
        const uploadResult = cli.json<{
          status: string;
          filesUpdated: number;
          updatedPaths: string[];
          connections: Array<{
            connectionName: string;
            status: string;
            filesUpdated: number;
          }>;
        }>(["files", "upload"], { cwd: workspaceDir });

        // Workspace-level aggregate.
        expect(uploadResult.filesUpdated).toBe(1);
        expect(uploadResult.updatedPaths).toEqual([
          `${connDirName}/${path.relative(
            path.join(workspaceDir, connDirName),
            editedRecordAbsPath,
          )}`,
        ]);

        // Per-connection result.
        const perConn = uploadResult.connections.find(
          (c) => c.connectionName === connDirName,
        );
        expect(perConn).toBeDefined();
        expect(perConn!.status).toBe("uploaded");
        expect(perConn!.filesUpdated).toBe(1);

        // Server-side: the upload-patches job ran inside `files upload` (it
        // polls to completion), but we double-check by asking the server for
        // its current dirty branch — the editing change should now be there.
        // `unpublished` still reflects the local accepted-patches.json file,
        // which `files publish` will reconcile against `main` only AFTER the
        // run-job finishes. So unpublished is still 1 here.
        const unpublishedAfterUpload = cli.json<{ count: number }>(
          ["files", "unpublished"],
          { cwd: workspaceDir },
        );
        expect(unpublishedAfterUpload.count).toBe(1);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("publish triggers plan-job + run-job and applies the change to Postgres", async () => {
      try {
        // `files publish` drives /publish-v2/plan-job then /publish-v2/run-job
        // for each connection and polls both jobs to completion before
        // returning. A non-zero exit (or any terminal state other than
        // "completed") makes the CLI bail, so a zero exit + a `published`
        // status payload is a positive signal that both jobs succeeded.
        const publishResult = cli.json<{
          status: string;
          publishedConnections: string[];
          skippedNoDiff: string[];
          elapsedMs: number;
        }>(["files", "publish"], { cwd: workspaceDir });

        expect(publishResult.status).toBe("published");
        expect(publishResult.publishedConnections).toContain(connDirName);
        expect(publishResult.skippedNoDiff).not.toContain(connDirName);

        // The Postgres connector's run-job writes the new value through to
        // the actual database. Verify directly — this is the "changes are
        // properly published" assertion the spec requires.
        const client = new Client({ connectionString: postgresUrl });
        await client.connect();
        try {
          const res = await client.query<{ author: string }>(
            `SELECT author FROM integration_blog_posts WHERE post_id = $1`,
            [editedRecordId],
          );
          expect(res.rowCount).toBe(1);
          expect(res.rows[0].author).toBe(newAuthor);
        } finally {
          await client.end();
        }
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);

    it("publish reconciles accepted-patches.json against the new main", () => {
      try {
        // After a successful publish, `reconcile_accepted_after_publish`
        // drops patches that already landed in `main`. The single update we
        // accepted DID land, so the file should now be empty (or the patches
        // array should be empty if the file still exists).
        const afterPublish = readAcceptedPatches(workspaceDir, connDirName);
        expect(afterPublish.patches).toHaveLength(0);

        const unpublishedAfterPublish = cli.json<{ count: number }>(
          ["files", "unpublished"],
          { cwd: workspaceDir },
        );
        expect(unpublishedAfterPublish.count).toBe(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("worktree file is byte-equal to canonical post-publish content (hard-reset semantics)", () => {
      try {
        // Bug B: `reconcile_accepted_after_publish` rematerializes the
        // worktree to the post-publish canonical state. The "local edit"
        // step above deliberately wrote the file WITHOUT a trailing newline
        // (`JSON.stringify(data, null, 2)`) — the server canonical format
        // includes one. Before the fix the reconcile left those bytes
        // untouched, so the file would still be missing its trailing newline
        // here. With the fix the worktree snaps to main's canonical bytes.
        const onDisk = fs.readFileSync(editedRecordAbsPath, "utf-8");
        expect(onDisk.endsWith("\n")).toBe(true);

        const canonical = JSON.stringify(JSON.parse(onDisk), null, 2) + "\n";
        expect(onDisk).toBe(canonical);

        // Independent confirmation: git sees nothing modified in the
        // connection's worktree (the per-connection dir is what holds the
        // .git pointer, not the workspace root). Any byte drift the
        // rematerialize missed would appear here.
        const connWorktree = path.join(workspaceDir, connDirName);
        const status = execFileSync(
          "git",
          ["-C", connWorktree, "status", "--porcelain"],
          { encoding: "utf-8" },
        );
        expect(status.trim()).toBe("");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("download succeeds (no unreviewed gate) and the local file still shows the published value", () => {
      try {
        // download's pre-flight refuses if any unreviewed working-tree edits
        // exist. After accept+publish the change is published, so the file's
        // local content matches its `apply(main, {})` value (= main itself,
        // post-publish) and download should run cleanly.
        const downloadResult = cli.json<{
          status?: string;
        }>(["files", "download"], { cwd: workspaceDir });
        // status is either "up_to_date" (no server-side delta beyond what we
        // already have) or a successful download payload — both are fine.
        // The important assertion is that the command didn't return
        // `blocked_unreviewed` (which would have thrown above on non-zero
        // exit, since cli.json doesn't pass expectError).
        expect(downloadResult).toBeDefined();

        // The working file content should still be the published value.
        const afterDownload = JSON.parse(
          fs.readFileSync(editedRecordAbsPath, "utf-8"),
        ) as Record<string, unknown>;
        expect(afterDownload.author).toBe(newAuthor);

        // And — critically — no more lingering pending state.
        expect(
          readAcceptedPatches(workspaceDir, connDirName).patches,
        ).toHaveLength(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("whitespace-only diff on a never-touched record is not flagged as unreviewed", () => {
      try {
        // Bug A: `detect_unreviewed_fast` does a semantic JSON compare for
        // EVERY byte-flagged data path (not just the ones in
        // accepted-patches.json). A whitespace-only diff on a record the
        // user has never touched must round-trip through the second pass and
        // emerge as "not unreviewed".
        //
        // Before the fix, this control file fell into the "unpatched path"
        // branch and got flagged immediately on any gix::status byte diff,
        // so `files unreviewed` would have returned count >= 1 and `files
        // download` would have bailed with `blocked_unreviewed`.
        const allFiles = findJsonFiles(workspaceDir);
        const controlFile = allFiles.find((p) => p !== editedRecordAbsPath);
        if (!controlFile) {
          throw new Error(
            "Expected a control record file to exist alongside the edited one",
          );
        }

        const data = JSON.parse(
          fs.readFileSync(controlFile, "utf-8"),
        ) as Record<string, unknown>;
        // Re-serialize WITHOUT a trailing newline. The semantic JSON value
        // is unchanged from main; only the bytes differ.
        fs.writeFileSync(controlFile, JSON.stringify(data, null, 2));

        const unreviewed = cli.json<{ count: number }>(
          ["files", "unreviewed"],
          { cwd: workspaceDir },
        );
        expect(unreviewed.count).toBe(0);

        // And download must proceed (cli.json throws on non-zero exit, so a
        // bailout via `blocked_unreviewed` would fail this assertion).
        const downloadResult = cli.json<{ status?: string }>(
          ["files", "download"],
          { cwd: workspaceDir },
        );
        expect(downloadResult).toBeDefined();
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("second accept→upload→publish cycle on the same record snaps the worktree to canonical bytes again", async () => {
      try {
        // Prove the publish/reconcile loop is stable across multiple cycles:
        // a second edit, accepted and published, must follow the same
        // hard-reset trajectory as the first. This also implicitly confirms
        // that the rematerialize step's `worktree_reset_mixed` left the gix
        // index aligned with the new main (otherwise the next publish's
        // pre-flight `detect_unreviewed_fast` would re-trip on the
        // just-published record).
        const secondAuthor = "Sarah Chen-Re-Published";

        const data = JSON.parse(
          fs.readFileSync(editedRecordAbsPath, "utf-8"),
        ) as Record<string, unknown>;
        data.author = secondAuthor;
        // Again deliberately omit the trailing newline so the rematerialize
        // step has to do the work this time too.
        fs.writeFileSync(editedRecordAbsPath, JSON.stringify(data, null, 2));

        const acceptResult = cli.json<{
          status: string;
          filesAccepted: number;
        }>(["files", "accept", editedRecordWorkspacePath], {
          cwd: workspaceDir,
        });
        expect(acceptResult.status).toBe("accepted");
        expect(acceptResult.filesAccepted).toBe(1);

        const uploadResult = cli.json<{ filesUpdated: number }>(
          ["files", "upload"],
          { cwd: workspaceDir },
        );
        expect(uploadResult.filesUpdated).toBe(1);

        const publishResult = cli.json<{
          status: string;
          publishedConnections: string[];
        }>(["files", "publish"], { cwd: workspaceDir });
        expect(publishResult.status).toBe("published");
        expect(publishResult.publishedConnections).toContain(connDirName);

        // Postgres reflects the second edit.
        const client = new Client({ connectionString: postgresUrl });
        await client.connect();
        try {
          const res = await client.query<{ author: string }>(
            `SELECT author FROM integration_blog_posts WHERE post_id = $1`,
            [editedRecordId],
          );
          expect(res.rowCount).toBe(1);
          expect(res.rows[0].author).toBe(secondAuthor);
        } finally {
          await client.end();
        }

        // Worktree snapped to canonical bytes for a second time.
        const onDisk = fs.readFileSync(editedRecordAbsPath, "utf-8");
        expect(onDisk.endsWith("\n")).toBe(true);
        expect(onDisk).toBe(JSON.stringify(JSON.parse(onDisk), null, 2) + "\n");

        // accepted-patches.json drained again.
        expect(
          readAcceptedPatches(workspaceDir, connDirName).patches,
        ).toHaveLength(0);

        // git status clean (no leftover modifications from either cycle).
        const connWorktree = path.join(workspaceDir, connDirName);
        const status = execFileSync(
          "git",
          ["-C", connWorktree, "status", "--porcelain"],
          { encoding: "utf-8" },
        );
        expect(status.trim()).toBe("");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 240_000);

    it("publish on a clean workspace is a no-op", async () => {
      try {
        // Running publish again now that everything is in sync must report
        // either `no_changes` or `no_diff` (server-side plan was empty for
        // every connection). Both mean "nothing to do" — the important
        // assertion is that the CLI doesn't fail and doesn't re-publish.
        const idempotent = cli.json<{
          status: string;
          publishedConnections: string[];
        }>(["files", "publish"], { cwd: workspaceDir });
        expect(["no_changes", "no_diff"]).toContain(idempotent.status);
        expect(idempotent.publishedConnections).toHaveLength(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);
  },
);

describeIfPostgres(
  "Silent connector rejection — VARCHAR(20) violation reports success but no row is applied",
  () => {
    // Drives the failure path documented in DEV-10175 and the matching Rust
    // unit test (`reconcile_keeps_patch_when_server_main_did_not_advance`).
    //
    // Quirk worth knowing: the Postgres connector SWALLOWS per-row constraint
    // violations rather than failing the run-job. So a publish that hits a
    // VARCHAR(20) overflow comes back with exit code 0 — `main` does not
    // advance and the Postgres row is unchanged. As of DEV-10243 the publish no
    // longer reports a clean `"published"`: the run-job's `failedCount` is
    // surfaced to the CLI as a `phase: "run-job"` entry in `warnings[]` (exit
    // stays 0), and `files unpublished` still reports the path as still-pending.
    //
    // As of the publish redesign (DEV-10048) the rejected edit no longer stays
    // in `accepted-patches.json`. The post-publish reconcile demotes a
    // connector-rejected record approved → local (needs approval): its entry
    // MOVES from `accepted-patches.json` to `failed-patches.json` (carrying the
    // run-job's record-level `error`), and the worktree file is re-materialized
    // as `apply(new_main, failed_patch)` so the user's value re-surfaces as a
    // needs-approval edit. `accepted-patches.json` ends empty for the path.
    //
    // This describe block locks in that behavior so a future change to the
    // connector (e.g. flipping the per-row failure to a non-zero exit) will
    // trip these tests and force an intentional update — not a silent change
    // in user-visible behavior. The recovery test at the end proves the
    // workspace is still recoverable after the dropped row.
    let workspaceId: string;
    let workspaceDir: string;
    let connDirName: string;
    let aliceWorkspacePath: string;
    let aliceAbsPath: string;
    let prePublishMainHash: string;
    const longName = "A".repeat(30); // 30 chars > VARCHAR(20)
    let hasFailed = false;

    beforeAll(async () => {
      await setupAuthorsTable();

      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("publish-fail"),
      ]);
      workspaceId = ws.id;

      const conn = cli.json<{ id: string }>([
        "connections",
        "--workspace",
        workspaceId,
        "add",
        "--service",
        TEST_CONNECTOR_SERVICE,
        "--param",
        `connectionString=${postgresUrl}`,
      ]);
      const connectionId = conn.id;

      const parentDir = path.join(cli.home, "test-publish-fail");
      fs.mkdirSync(parentDir, { recursive: true });
      const initResult = cli.json<{ directory: string }>(
        ["workspaces", "init", workspaceId],
        { cwd: parentDir },
      );
      workspaceDir = path.join(parentDir, initResult.directory);

      const tables = cli.json<Array<{ id: string; displayName: string }>>([
        "linked",
        "--workspace",
        workspaceId,
        "available",
        connectionId,
      ]);
      const authorsTable = tables.find(
        (t) => t.displayName === "integration_authors",
      );
      if (!authorsTable) {
        throw new Error(
          `integration_authors not found in available tables: ${tables.map((t) => t.displayName).join(", ")}`,
        );
      }
      const tableIdParts = authorsTable.id.split(",");
      const linked = cli.json<{ id: string }>(
        [
          "linked",
          "--workspace",
          workspaceId,
          "add",
          "--connection-id",
          connectionId,
          ...tableIdParts.flatMap((p: string) => ["--table-id", p]),
          "--name",
          authorsTable.displayName,
        ],
        { cwd: workspaceDir },
      );
      cli.run(["linked", "--workspace", workspaceId, "pull", linked.id], {
        cwd: workspaceDir,
      });
      cli.run(["files", "download"], { cwd: workspaceDir });

      const marker = readMarker(workspaceDir);
      connDirName = marker.connections[0]!.dirName;

      // Find Alice's record file. Records are written under
      // `<workspaceDir>/<connDirName>/<schema>/<table>/<author_id>.json`.
      const allFiles = findJsonFiles(workspaceDir);
      const aliceFile = allFiles
        .map((p) => ({
          p,
          data: JSON.parse(fs.readFileSync(p, "utf-8")) as Record<
            string,
            unknown
          >,
        }))
        .find((r) => r.data.author_id === AUTHOR_IDS.alice);
      if (!aliceFile) {
        throw new Error(
          `Expected Alice's record (${AUTHOR_IDS.alice}) not found after pull`,
        );
      }
      aliceAbsPath = aliceFile.p;
      aliceWorkspacePath = path.relative(workspaceDir, aliceFile.p);
      expect(aliceFile.data.name).toBe("Alice");
    }, 120_000);

    afterAll(async () => {
      if (workspaceId && !hasFailed) deleteWorkspace(cli, workspaceId);
      if (workspaceDir && !hasFailed) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownAuthorsTable();
    });

    it("accept + upload succeed even though the value will fail at run-job time", () => {
      try {
        // Snapshot main BEFORE publish so we can prove later that it didn't
        // advance on failure.
        const connWorktree = path.join(workspaceDir, connDirName);
        prePublishMainHash = execFileSync(
          "git",
          ["-C", connWorktree, "rev-parse", "refs/heads/main"],
          { encoding: "utf-8" },
        ).trim();

        // Push the name past the VARCHAR(20) limit. Upload-patch writes this
        // into the server's dirty branch in git — no DB validation happens
        // there, so upload succeeds. The constraint check happens later when
        // the run-job executes the UPDATE against Postgres.
        const data = JSON.parse(
          fs.readFileSync(aliceAbsPath, "utf-8"),
        ) as Record<string, unknown>;
        data.name = longName;
        fs.writeFileSync(aliceAbsPath, JSON.stringify(data, null, 2) + "\n");

        const unreviewed = cli.json<{ count: number }>(
          ["files", "unreviewed"],
          { cwd: workspaceDir },
        );
        expect(unreviewed.count).toBe(1);

        const acceptResult = cli.json<{
          status: string;
          filesAccepted: number;
        }>(["files", "accept", aliceWorkspacePath], { cwd: workspaceDir });
        expect(acceptResult.status).toBe("accepted");
        expect(acceptResult.filesAccepted).toBe(1);

        const uploadResult = cli.json<{ filesUpdated: number }>(
          ["files", "upload"],
          { cwd: workspaceDir },
        );
        expect(uploadResult.filesUpdated).toBe(1);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    // DEV-10243: the run-job that rejects every row now surfaces the failure to
    // the CLI as a non-fatal `warnings[]` entry (Option 1) instead of a silent
    // `"published"`. Before the fix the per-row throw was caught by the server's
    // `processBatch`, the plan ended `CompletedWithErrors`, but the BullMQ job
    // still reported `completed` — so `poll_job` saw success and the CLI printed
    // a clean `"published"`. The fix copies the plan's `failedCount` onto the
    // run-job's `publicProgress`; the CLI reads it and emits a `phase: "run-job"`
    // warning. Publish still exits 0 (the edits are recoverable), so `cli.json`
    // returning at all proves exit 0.
    //
    // This is also the single publish that the state-assertion tests below
    // (patch preserved, main unmoved, worktree retains edit, Postgres unchanged)
    // observe — running it here once leaves exactly the recoverable state they
    // check.
    it("publish reports the per-row failure to the CLI (DEV-10243)", async () => {
      try {
        const publishResult = cli.json<{
          status: string;
          publishedConnections: string[];
          failedConnections: Array<unknown>;
          warnings: Array<{
            name: string;
            status: string;
            warning: { phase: string; message: string; failedCount: number };
          }>;
        }>(["files", "publish"], { cwd: workspaceDir });

        // Never a clean silent success: exit 0 + a run-job warning.
        expect(publishResult.status).toBe("published");
        expect(publishResult.failedConnections).toHaveLength(0);
        expect(publishResult.warnings.length).toBeGreaterThan(0);

        const warning = publishResult.warnings.find(
          (w) => w.name === connDirName,
        );
        expect(warning).toBeDefined();
        expect(warning?.warning.phase).toBe("run-job");
        expect(warning?.warning.failedCount).toBeGreaterThan(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);

    it("silent drop moves the rejected patch to failed-patches.json (DEV-10048)", () => {
      try {
        // The publish redesign (DEV-10048) demotes a connector-rejected record
        // approved → local (needs approval) rather than leaving it accepted:
        // `reconcile_accepted_after_publish` DOES run (the run-job reported
        // `completed`, so `poll_job` returned Ok — the DEV-10243 warning is
        // raised only after reconcile), and `partition_reanchored_after_publish`
        // sees the path in the run-job's `failedOperations` and routes its
        // re-anchored patch to `failed-patches.json` (with the record-level
        // connector `error`), clearing it from `accepted-patches.json`. The
        // worktree file is re-materialized as `apply(new_main, failed_patch)`,
        // so the user's value re-surfaces as a needs-approval edit (the
        // user-visible "this didn't land" signal is now `files unreviewed`).
        const accepted = readAcceptedPatches(workspaceDir, connDirName);
        expect(accepted.patches).toHaveLength(0);

        const afterFail = readFailedPatches(workspaceDir, connDirName);
        expect(afterFail.patches).toHaveLength(1);
        const entry = afterFail.patches[0];
        // `path` in the patch file is connection-relative (same envelope as
        // accepted-patches.json — see the accept test above), not the
        // workspace-relative `aliceWorkspacePath`.
        const expectedConnectionRelativePath = path.relative(
          path.join(workspaceDir, connDirName),
          aliceAbsPath,
        );
        expect(entry.path).toBe(expectedConnectionRelativePath);
        expect(entry.kind).toBe("update");
        expect(entry.patch).toEqual([
          { op: "add", path: "/name", value: longName },
        ]);
        // The connector's rejection message rides at the entry level (never on
        // the RFC 6902 ops). Postgres reports a VARCHAR(20) overflow.
        expect(entry.error).toBeDefined();
        expect(entry.error).toContain("value too long");

        // The failed edit re-surfaces as a needs-approval (unreviewed) change,
        // not as a still-accepted one — `files unpublished` reads only
        // `accepted-patches.json`, so it now reports 0.
        const unpublished = cli.json<{ count: number }>(
          ["files", "unpublished"],
          { cwd: workspaceDir },
        );
        expect(unpublished.count).toBe(0);

        const unreviewed = cli.json<{ count: number }>(
          ["files", "unreviewed"],
          { cwd: workspaceDir },
        );
        expect(unreviewed.count).toBe(1);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("silent drop leaves refs/heads/main unmoved", () => {
      try {
        // No commit was created server-side (every row was rejected), so
        // origin/main didn't advance and reconcile had nothing to
        // fast-forward to. The local ref must still point at the pre-publish
        // snapshot.
        const connWorktree = path.join(workspaceDir, connDirName);
        const postPublishMainHash = execFileSync(
          "git",
          ["-C", connWorktree, "rev-parse", "refs/heads/main"],
          { encoding: "utf-8" },
        ).trim();
        expect(postPublishMainHash).toBe(prePublishMainHash);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("silent drop leaves the worktree file with the user's pending edit", () => {
      try {
        // The reconcile rematerializes the worktree from `new_main` + the
        // surviving accepted patches + the just-failed patches (DEV-10048): the
        // failed entry is applied as `apply(new_main, failed_patch)` so the
        // record re-surfaces on disk as a needs-approval edit. The bytes are the
        // user's intended value (the prior test proves the failed patch carries
        // `add /name longName`), normalized to canonical formatting.
        const onDisk = JSON.parse(
          fs.readFileSync(aliceAbsPath, "utf-8"),
        ) as Record<string, unknown>;
        expect(onDisk.name).toBe(longName);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("Postgres row was NOT updated", async () => {
      try {
        const client = new Client({ connectionString: postgresUrl });
        await client.connect();
        try {
          const res = await client.query<{ name: string }>(
            `SELECT name FROM integration_authors WHERE author_id = $1`,
            [AUTHOR_IDS.alice],
          );
          expect(res.rowCount).toBe(1);
          // Original seeded value, not the rejected long one.
          expect(res.rows[0].name).toBe("Alice");
        } finally {
          await client.end();
        }
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("recovery: fixing the name, re-accepting, and republishing succeeds end-to-end", async () => {
      try {
        // Closes the failure loop: prove that the workspace isn't wedged.
        // Editing the worktree to a valid value rewrites the existing patch
        // entry (the accept-time `compute_entry` path always emits a fresh
        // entry from the current snapshot+working pair), upload + publish
        // succeed, and the rematerialize step that Bug B added snaps the
        // worktree to canonical bytes — same hard-reset semantics as the
        // happy path, just one failure-recover cycle later.
        const recoveredName = "AliceFixed"; // 10 chars, well under 20

        // Rewrite the worktree file. Deliberately omit the trailing newline
        // so the subsequent rematerialize has work to do — this also
        // re-exercises Bug B's fix on the recovery branch.
        const data = JSON.parse(
          fs.readFileSync(aliceAbsPath, "utf-8"),
        ) as Record<string, unknown>;
        data.name = recoveredName;
        fs.writeFileSync(aliceAbsPath, JSON.stringify(data, null, 2));

        // The new working value differs from the existing patch's applied
        // value (longName), so it shows up as unreviewed and needs a fresh
        // accept. The previous accept's patch entry gets replaced, not
        // stacked on top.
        const unreviewed = cli.json<{ count: number }>(
          ["files", "unreviewed"],
          { cwd: workspaceDir },
        );
        expect(unreviewed.count).toBe(1);

        const acceptResult = cli.json<{
          status: string;
          filesAccepted: number;
        }>(["files", "accept", aliceWorkspacePath], { cwd: workspaceDir });
        expect(acceptResult.status).toBe("accepted");
        expect(acceptResult.filesAccepted).toBe(1);

        const acceptedAfterFix = readAcceptedPatches(workspaceDir, connDirName);
        expect(acceptedAfterFix.patches).toHaveLength(1);
        expect(acceptedAfterFix.patches[0].patch).toEqual([
          { op: "add", path: "/name", value: recoveredName },
        ]);

        // Upload + publish. This is now a happy-path cycle.
        const uploadResult = cli.json<{ filesUpdated: number }>(
          ["files", "upload"],
          { cwd: workspaceDir },
        );
        expect(uploadResult.filesUpdated).toBe(1);

        const publishResult = cli.json<{
          status: string;
          publishedConnections: string[];
        }>(["files", "publish"], { cwd: workspaceDir });
        expect(publishResult.status).toBe("published");
        expect(publishResult.publishedConnections).toContain(connDirName);

        // Postgres now has the recovered value (the previously-failed long
        // string was never written).
        const client = new Client({ connectionString: postgresUrl });
        await client.connect();
        try {
          const res = await client.query<{ name: string }>(
            `SELECT name FROM integration_authors WHERE author_id = $1`,
            [AUTHOR_IDS.alice],
          );
          expect(res.rowCount).toBe(1);
          expect(res.rows[0].name).toBe(recoveredName);
        } finally {
          await client.end();
        }

        // reconcile_accepted_after_publish ran: patch dropped, main advanced
        // past the snapshot taken before the (failed) first publish attempt,
        // worktree snapped to canonical bytes, git clean.
        expect(
          readAcceptedPatches(workspaceDir, connDirName).patches,
        ).toHaveLength(0);

        const connWorktree = path.join(workspaceDir, connDirName);
        const postRecoveryMainHash = execFileSync(
          "git",
          ["-C", connWorktree, "rev-parse", "refs/heads/main"],
          { encoding: "utf-8" },
        ).trim();
        expect(postRecoveryMainHash).not.toBe(prePublishMainHash);

        const onDisk = fs.readFileSync(aliceAbsPath, "utf-8");
        expect(onDisk.endsWith("\n")).toBe(true);
        expect(onDisk).toBe(JSON.stringify(JSON.parse(onDisk), null, 2) + "\n");

        const status = execFileSync(
          "git",
          ["-C", connWorktree, "status", "--porcelain"],
          { encoding: "utf-8" },
        );
        expect(status.trim()).toBe("");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 240_000);
  },
);

// ---------------------------------------------------------------------------
// DEV-10756 — a publish that rejects MORE than the 20-record failed-operations
// display cap must still route EVERY failure into failed-patches.json. Before
// the fix, the desktop/CLI reconcile trusted the capped `publicProgress`
// `failedOperations` list as the complete rejection set, so failures beyond 20
// were stranded (error-free) in accepted-patches.json and silently re-published.
// The fix has the reconcile fetch the COMPLETE set from the server by pipeline
// id. This drives the CLI-native `files publish` path (the same reconcile the
// desktop uses), seeds 25 VARCHAR(20)-violating rows, and asserts all 25 land
// in failed-patches.json with none left accepted.
// ---------------------------------------------------------------------------
describeIfPostgres(
  "Overflow failures past the 20-record cap all reach failed-patches.json (DEV-10756)",
  () => {
    let workspaceId: string;
    let workspaceDir: string;
    let connDirName: string;
    let failingRecordCount: number;
    const longName = "A".repeat(30); // 30 chars > VARCHAR(20) → every row is rejected
    const ADDITIONAL_AUTHOR_ROWS = 22; // + the 3 seeded by setupAuthorsTable = 25 (> the cap of 20)
    let hasFailed = false;

    beforeAll(async () => {
      await setupAuthorsTable();

      // Seed enough extra VARCHAR(20) rows that a single publish fails on MORE
      // than 20 records — the condition the summary cap used to truncate.
      const client = new Client({ connectionString: postgresUrl });
      await client.connect();
      try {
        for (let i = 0; i < ADDITIONAL_AUTHOR_ROWS; i++) {
          const author_id = `40000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
          await client.query(
            `INSERT INTO integration_authors (author_id, name, bio) VALUES ($1, $2, $3)`,
            [author_id, `Author ${i}`, "seed"],
          );
        }
      } finally {
        await client.end();
      }

      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("publish-overflow"),
      ]);
      workspaceId = ws.id;

      const conn = cli.json<{ id: string }>([
        "connections",
        "--workspace",
        workspaceId,
        "add",
        "--service",
        TEST_CONNECTOR_SERVICE,
        "--param",
        `connectionString=${postgresUrl}`,
      ]);
      const connectionId = conn.id;

      const parentDir = path.join(cli.home, "test-publish-overflow");
      fs.mkdirSync(parentDir, { recursive: true });
      const initResult = cli.json<{ directory: string }>(
        ["workspaces", "init", workspaceId],
        { cwd: parentDir },
      );
      workspaceDir = path.join(parentDir, initResult.directory);

      const tables = cli.json<Array<{ id: string; displayName: string }>>([
        "linked",
        "--workspace",
        workspaceId,
        "available",
        connectionId,
      ]);
      const authorsTable = tables.find(
        (t) => t.displayName === "integration_authors",
      );
      if (!authorsTable) {
        throw new Error(
          `integration_authors not found in available tables: ${tables.map((t) => t.displayName).join(", ")}`,
        );
      }
      const tableIdParts = authorsTable.id.split(",");
      const linked = cli.json<{ id: string }>(
        [
          "linked",
          "--workspace",
          workspaceId,
          "add",
          "--connection-id",
          connectionId,
          ...tableIdParts.flatMap((p: string) => ["--table-id", p]),
          "--name",
          authorsTable.displayName,
        ],
        { cwd: workspaceDir },
      );
      cli.run(["linked", "--workspace", workspaceId, "pull", linked.id], {
        cwd: workspaceDir,
      });
      cli.run(["files", "download"], { cwd: workspaceDir });

      const marker = readMarker(workspaceDir);
      connDirName = marker.connections[0]!.dirName;
    }, 180_000);

    afterAll(async () => {
      if (workspaceId && (!hasFailed || !preserveOnFailure)) {
        deleteWorkspace(cli, workspaceId);
      }
      if (workspaceDir && (!hasFailed || !preserveOnFailure)) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownAuthorsTable();
    });

    it("routes ALL >20 rejected records to failed-patches.json — none stranded as accepted", () => {
      try {
        // Push every author's name past the VARCHAR(20) limit so the run-job
        // rejects each row (one `failed-batch` op per record).
        const records = findJsonFiles(workspaceDir)
          .map((p) => ({
            p,
            data: JSON.parse(fs.readFileSync(p, "utf-8")) as Record<
              string,
              unknown
            >,
          }))
          .filter((r) => typeof r.data.author_id === "string");

        // The whole point of the test: the failure count must EXCEED the
        // 20-record display cap, or it wouldn't exercise the overflow bug.
        expect(records.length).toBeGreaterThan(20);
        failingRecordCount = records.length;

        for (const rec of records) {
          rec.data.name = longName;
          fs.writeFileSync(rec.p, JSON.stringify(rec.data, null, 2) + "\n");
        }

        cli.run(["files", "accept-all"], { cwd: workspaceDir });
        const uploadResult = cli.json<{ filesUpdated: number }>(
          ["files", "upload"],
          { cwd: workspaceDir },
        );
        expect(uploadResult.filesUpdated).toBe(failingRecordCount);

        const publishResult = cli.json<{
          status: string;
          warnings: Array<{
            name: string;
            warning: { phase: string; failedCount: number };
          }>;
        }>(["files", "publish"], { cwd: workspaceDir });
        expect(publishResult.status).toBe("published");

        // The authoritative failed count (uncapped) is the whole set.
        const warning = publishResult.warnings.find(
          (w) => w.name === connDirName,
        );
        expect(warning?.warning.phase).toBe("run-job");
        expect(warning?.warning.failedCount).toBe(failingRecordCount);

        // The fix: EVERY rejected record is in failed-patches.json (not capped at
        // 20), and NONE is left silently accepted. Pre-fix this would be 20 in
        // failed-patches and (failingRecordCount - 20) stranded in accepted.
        const failed = readFailedPatches(workspaceDir, connDirName);
        expect(failed.patches).toHaveLength(failingRecordCount);
        expect(
          failed.patches.every((entry) => typeof entry.error === "string"),
        ).toBe(true);

        const accepted = readAcceptedPatches(workspaceDir, connDirName);
        expect(accepted.patches).toHaveLength(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 300_000);
  },
);

// ---------------------------------------------------------------------------
// DEV-10596 — connector-scoped publish. `files upload --connection <id|dir>`
// narrows the two-pass upload to ONE connection so the chosen connector
// publishes regardless of any OTHER connection's state. Two connections (both
// linking `integration_blog_posts` to the same Postgres) prove the scoping:
// each has its own connector-account id + dir name, so an upload scoped to one
// must never touch the other.
// ---------------------------------------------------------------------------
describeIfPostgres(
  "Connector-scoped upload — files upload --connection (DEV-10596)",
  () => {
    let workspaceId: string;
    let workspaceDir: string;
    let connA: { id: string; dirName: string };
    let connB: { id: string; dirName: string };
    let hasFailed = false;

    /** Edit the AI-tools post's author under one connection dir, then accept it. */
    function editAndAcceptAiToolsAuthor(
      connDirName: string,
      newAuthor: string,
    ): void {
      const connRoot = path.join(workspaceDir, connDirName);
      const target = findJsonFiles(connRoot)
        .map((p) => ({
          p,
          data: JSON.parse(fs.readFileSync(p, "utf-8")) as Record<
            string,
            unknown
          >,
        }))
        .find(
          (r) => r.data.title === "The Rise of AI-Powered Development Tools",
        );
      if (!target) {
        throw new Error(`AI-tools post not found under ${connDirName}`);
      }
      target.data.author = newAuthor;
      fs.writeFileSync(target.p, JSON.stringify(target.data, null, 2));
      const wsRelPath = path.relative(workspaceDir, target.p);
      const acceptResult = cli.json<{ status: string }>(
        ["files", "accept", wsRelPath],
        { cwd: workspaceDir },
      );
      expect(acceptResult.status).toBe("accepted");
    }

    beforeAll(async () => {
      await setupTestTable();

      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("publish-conn-scope"),
      ]);
      workspaceId = ws.id;

      const addConnection = (): string =>
        cli.json<{ id: string }>([
          "connections",
          "--workspace",
          workspaceId,
          "add",
          "--service",
          TEST_CONNECTOR_SERVICE,
          "--param",
          `connectionString=${postgresUrl}`,
        ]).id;
      const connAId = addConnection();
      const connBId = addConnection();

      const parentDir = path.join(cli.home, "test-publish-conn-scope");
      fs.mkdirSync(parentDir, { recursive: true });
      const initResult = cli.json<{ directory: string }>(
        ["workspaces", "init", workspaceId],
        { cwd: parentDir },
      );
      workspaceDir = path.join(parentDir, initResult.directory);

      const linkBlogPosts = (connectionId: string): void => {
        const tables = cli.json<Array<{ id: string; displayName: string }>>([
          "linked",
          "--workspace",
          workspaceId,
          "available",
          connectionId,
        ]);
        const blogPosts = tables.find(
          (t) => t.displayName === "integration_blog_posts",
        )!;
        const tableIdParts = blogPosts.id.split(",");
        const linked = cli.json<{ id: string }>(
          [
            "linked",
            "--workspace",
            workspaceId,
            "add",
            "--connection-id",
            connectionId,
            ...tableIdParts.flatMap((p: string) => ["--table-id", p]),
            "--name",
            blogPosts.displayName,
          ],
          { cwd: workspaceDir },
        );
        cli.run(["linked", "--workspace", workspaceId, "pull", linked.id], {
          cwd: workspaceDir,
        });
      };
      linkBlogPosts(connAId);
      linkBlogPosts(connBId);
      cli.run(["files", "download"], { cwd: workspaceDir });

      const marker = readMarker(workspaceDir);
      const dirNameById = new Map(
        marker.connections.map((c) => [c.id, c.dirName]),
      );
      connA = { id: connAId, dirName: dirNameById.get(connAId)! };
      connB = { id: connBId, dirName: dirNameById.get(connBId)! };
    }, 180_000);

    afterAll(async () => {
      const shouldPreserve = preserveOnFailure && hasFailed;
      if (workspaceId && !shouldPreserve) deleteWorkspace(cli, workspaceId);
      if (workspaceDir && !shouldPreserve) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownTestTable();
    });

    it("rejects `--connection` combined with `--file-path` (upload)", () => {
      const result = cli.run(
        [
          "files",
          "upload",
          "--connection",
          connA.id,
          "--file-path",
          `${connA.dirName}/x.json`,
        ],
        { cwd: workspaceDir, expectError: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "mutually exclusive",
      );
    });

    it("rejects `--connection` combined with `--file-path` (download)", () => {
      const result = cli.run(
        [
          "files",
          "download",
          "--connection",
          connA.id,
          "--file-path",
          `${connA.dirName}/x.json`,
        ],
        { cwd: workspaceDir, expectError: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "mutually exclusive",
      );
    });

    it("rejects an unknown `--connection`", () => {
      const result = cli.run(
        ["files", "upload", "--connection", "ca_does_not_exist"],
        { cwd: workspaceDir, expectError: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "No connection matching",
      );
    });

    it("uploads ONLY the connection named by its account id", () => {
      try {
        editAndAcceptAiToolsAuthor(connA.dirName, "Author-A-Scoped");
        editAndAcceptAiToolsAuthor(connB.dirName, "Author-B-Scoped");

        const result = cli.json<{
          status: string;
          connections: Array<{
            connectionName: string;
            status: string;
            filesUpdated: number;
          }>;
        }>(["files", "upload", "--connection", connA.id], {
          cwd: workspaceDir,
        });

        // Connection B was never in scope, so the result carries A alone.
        expect(result.connections).toHaveLength(1);
        expect(result.connections[0].connectionName).toBe(connA.dirName);
        expect(result.connections[0].status).toBe("uploaded");
        expect(result.connections[0].filesUpdated).toBe(1);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("uploads the other connection when scoped by its dir name", () => {
      try {
        // `--connection` also accepts the connection dir name (the same convention
        // `files reconcile-after-publish --connection` uses). Connection B's edit
        // is still staged-but-unuploaded after the id-scoped call above.
        const result = cli.json<{
          connections: Array<{ connectionName: string; status: string }>;
        }>(["files", "upload", "--connection", connB.dirName], {
          cwd: workspaceDir,
        });
        expect(result.connections).toHaveLength(1);
        expect(result.connections[0].connectionName).toBe(connB.dirName);
        expect(result.connections[0].status).toBe("uploaded");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// DEV-10596 — connector-scoped publish LIFECYCLE, MULTI-FOLDER. Each connection
// maps TWO data folders, and the two connections map DISJOINT tables:
//   - Connection A (always-valid)  → integration_blog_posts + integration_products
//   - Connection B (failure-prone) → integration_authors    + integration_reviews
// This proves the connector-scoped guarantees hold across a connection's WHOLE
// folder set, not just a single table:
//   1. Publishing one connection publishes ALL of its folders end-to-end.
//   2. The OTHER connection's folders are never impacted (data + staged edits
//      survive unchanged), and it publishes independently afterward.
//   3. Partial publishing — a `files publish` where connection A succeeds and
//      connection B is rejected by the connector — leaves the workspace valid
//      and recoverable: A's folders all land, B's rejected row is quarantined in
//      failed-patches.json (never lost), A is untouched by B's failure, and a
//      follow-up publish recovers B cleanly.
//
// The failure is induced with `integration_authors.name VARCHAR(20)`: a >20-char
// value passes accept + upload (git-only) but is rejected by Postgres at run-job
// time. Because A and B are separate connections (separate repos + pipelines), A
// lands while B fails IN THE SAME `files publish` — a genuine partial success.
// ---------------------------------------------------------------------------
describeIfPostgres(
  "Connector-scoped publish lifecycle (multi-folder) — isolation + partial-failure recovery (DEV-10596)",
  () => {
    let workspaceId: string;
    let workspaceDir: string;
    // Connection A = always-valid (blog_posts + products); B = failure-prone (authors + reviews).
    let connA: { id: string; dirName: string };
    let connB: { id: string; dirName: string };

    // One record per folder (4 total), each located by a distinctive field.
    let blogPost: { abs: string; ws: string }; // A / integration_blog_posts
    let blogPostId: string;
    let product: { abs: string; ws: string }; // A / integration_products
    let productId: string;
    let alice: { abs: string; ws: string }; // B / integration_authors (VARCHAR(20) failure vector)
    let review: { abs: string; ws: string }; // B / integration_reviews

    const longName = "A".repeat(30); // 30 chars > VARCHAR(20) → connector rejects
    let hasFailed = false;

    function editField(absPath: string, field: string, value: unknown): void {
      const data = JSON.parse(fs.readFileSync(absPath, "utf-8")) as Record<
        string,
        unknown
      >;
      data[field] = value;
      fs.writeFileSync(absPath, JSON.stringify(data, null, 2) + "\n");
    }

    function acceptOne(wsPath: string): void {
      const res = cli.json<{ status: string; filesAccepted: number }>(
        ["files", "accept", wsPath],
        { cwd: workspaceDir },
      );
      expect(res.status).toBe("accepted");
      expect(res.filesAccepted).toBe(1);
    }

    async function selectScalar(
      sql: string,
      params: unknown[],
    ): Promise<string> {
      const client = new Client({ connectionString: postgresUrl });
      await client.connect();
      try {
        const res = await client.query<{ v: string }>(sql, params);
        expect(res.rowCount).toBe(1);
        return res.rows[0].v;
      } finally {
        await client.end();
      }
    }

    // Per-folder Postgres readbacks (one per mapped table).
    const blogAuthorInPg = (): Promise<string> =>
      selectScalar(
        `SELECT author AS v FROM integration_blog_posts WHERE post_id = $1`,
        [blogPostId],
      );
    const productCategoryInPg = (): Promise<string> =>
      selectScalar(
        `SELECT category AS v FROM integration_products WHERE product_id = $1`,
        [productId],
      );
    const aliceNameInPg = (): Promise<string> =>
      selectScalar(
        `SELECT name AS v FROM integration_authors WHERE author_id = $1`,
        [AUTHOR_IDS.alice],
      );
    const reviewBodyInPg = (): Promise<string> =>
      selectScalar(
        `SELECT body AS v FROM integration_reviews WHERE review_id = $1`,
        [REVIEW_IDS.first],
      );

    beforeAll(async () => {
      await setupTestTable();
      await setupProductsTable();
      await setupAuthorsTable();
      await setupReviewsTable();

      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("publish-multifolder"),
      ]);
      workspaceId = ws.id;

      const addConnection = (): string =>
        cli.json<{ id: string }>([
          "connections",
          "--workspace",
          workspaceId,
          "add",
          "--service",
          TEST_CONNECTOR_SERVICE,
          "--param",
          `connectionString=${postgresUrl}`,
        ]).id;
      const connAId = addConnection();
      const connBId = addConnection();

      const parentDir = path.join(cli.home, "test-publish-multifolder");
      fs.mkdirSync(parentDir, { recursive: true });
      const initResult = cli.json<{ directory: string }>(
        ["workspaces", "init", workspaceId],
        { cwd: parentDir },
      );
      workspaceDir = path.join(parentDir, initResult.directory);

      const linkTable = (connectionId: string, displayName: string): void => {
        const tables = cli.json<Array<{ id: string; displayName: string }>>([
          "linked",
          "--workspace",
          workspaceId,
          "available",
          connectionId,
        ]);
        const table = tables.find((t) => t.displayName === displayName);
        if (!table) {
          throw new Error(
            `${displayName} not found in available tables: ${tables.map((t) => t.displayName).join(", ")}`,
          );
        }
        const tableIdParts = table.id.split(",");
        const linked = cli.json<{ id: string }>(
          [
            "linked",
            "--workspace",
            workspaceId,
            "add",
            "--connection-id",
            connectionId,
            ...tableIdParts.flatMap((p: string) => ["--table-id", p]),
            "--name",
            table.displayName,
          ],
          { cwd: workspaceDir },
        );
        cli.run(["linked", "--workspace", workspaceId, "pull", linked.id], {
          cwd: workspaceDir,
        });
      };
      // A maps two folders; B maps two DISJOINT folders (no shared table).
      linkTable(connAId, "integration_blog_posts");
      linkTable(connAId, "integration_products");
      linkTable(connBId, "integration_authors");
      linkTable(connBId, "integration_reviews");
      cli.run(["files", "download"], { cwd: workspaceDir });

      const marker = readMarker(workspaceDir);
      const dirNameById = new Map(
        marker.connections.map((c) => [c.id, c.dirName]),
      );
      connA = { id: connAId, dirName: dirNameById.get(connAId)! };
      connB = { id: connBId, dirName: dirNameById.get(connBId)! };

      const recordsUnder = (
        dirName: string,
      ): Array<{ p: string; data: Record<string, unknown> }> =>
        findJsonFiles(path.join(workspaceDir, dirName)).map((p) => ({
          p,
          data: JSON.parse(fs.readFileSync(p, "utf-8")) as Record<
            string,
            unknown
          >,
        }));

      const aRecords = recordsUnder(connA.dirName);
      const blogHit = aRecords.find(
        (r) => r.data.title === "The Rise of AI-Powered Development Tools",
      );
      const productHit = aRecords.find((r) => r.data.name === "Widget A");
      if (!blogHit || !productHit) {
        throw new Error("blog/product records not found under connection A");
      }
      blogPost = { abs: blogHit.p, ws: path.relative(workspaceDir, blogHit.p) };
      blogPostId = String(blogHit.data.post_id);
      product = {
        abs: productHit.p,
        ws: path.relative(workspaceDir, productHit.p),
      };
      productId = String(productHit.data.product_id);

      const bRecords = recordsUnder(connB.dirName);
      const aliceHit = bRecords.find(
        (r) => r.data.author_id === AUTHOR_IDS.alice,
      );
      const reviewHit = bRecords.find(
        (r) => r.data.review_id === REVIEW_IDS.first,
      );
      if (!aliceHit || !reviewHit) {
        throw new Error("alice/review records not found under connection B");
      }
      alice = { abs: aliceHit.p, ws: path.relative(workspaceDir, aliceHit.p) };
      review = {
        abs: reviewHit.p,
        ws: path.relative(workspaceDir, reviewHit.p),
      };
      expect(aliceHit.data.name).toBe("Alice");
    }, 240_000);

    afterAll(async () => {
      const shouldPreserve = preserveOnFailure && hasFailed;
      if (workspaceId && !shouldPreserve) deleteWorkspace(cli, workspaceId);
      if (workspaceDir && !shouldPreserve) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownReviewsTable();
      await teardownAuthorsTable();
      await teardownProductsTable();
      await teardownTestTable();
    });

    // --- Requirement 1 & 2: publish one connection (all its folders); the other untouched. ---

    it("stages a valid accepted change in BOTH folders of BOTH connections", () => {
      try {
        editField(blogPost.abs, "author", "Author-One");
        acceptOne(blogPost.ws);
        editField(product.abs, "category", "cat-one");
        acceptOne(product.ws);
        editField(alice.abs, "name", "AliceOne");
        acceptOne(alice.ws);
        editField(review.abs, "body", "body-one");
        acceptOne(review.ws);

        // accepted-patches.json is per CONNECTION and aggregates its folders → 2 each.
        expect(
          readAcceptedPatches(workspaceDir, connA.dirName).patches,
        ).toHaveLength(2);
        expect(
          readAcceptedPatches(workspaceDir, connB.dirName).patches,
        ).toHaveLength(2);
        expect(
          cli.json<{ count: number }>(["files", "unreviewed"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("`upload --connection A` stages both of A's folders and nothing from B", () => {
      try {
        const result = cli.json<{
          connections: Array<{
            connectionName: string;
            status: string;
            filesUpdated: number;
          }>;
        }>(["files", "upload", "--connection", connA.id], {
          cwd: workspaceDir,
        });
        expect(result.connections).toHaveLength(1);
        expect(result.connections[0].connectionName).toBe(connA.dirName);
        expect(result.connections[0].status).toBe("uploaded");
        // Both of A's folders had a changed record.
        expect(result.connections[0].filesUpdated).toBe(2);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("`files publish` lands BOTH of A's folders and touches NEITHER of B's (Req 1 & 2)", async () => {
      try {
        const publishResult = cli.json<{
          status: string;
          publishedConnections: string[];
          skippedNoDiff: string[];
          failedConnections: unknown[];
        }>(["files", "publish"], { cwd: workspaceDir });

        expect(publishResult.status).toBe("published");
        expect(publishResult.publishedConnections).toContain(connA.dirName);
        expect(publishResult.publishedConnections).not.toContain(connB.dirName);
        expect(publishResult.skippedNoDiff).toContain(connB.dirName);
        expect(publishResult.failedConnections).toHaveLength(0);

        // Req 1: both of A's folders reached Postgres.
        expect(await blogAuthorInPg()).toBe("Author-One");
        expect(await productCategoryInPg()).toBe("cat-one");
        // Req 2: both of B's folders are untouched.
        expect(await aliceNameInPg()).toBe("Alice");
        expect(await reviewBodyInPg()).toBe("Loved every bit of it");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);

    it("connection B keeps BOTH staged folder edits (recoverable)", () => {
      try {
        expect(
          readAcceptedPatches(workspaceDir, connA.dirName).patches,
        ).toHaveLength(0);
        expect(
          readAcceptedPatches(workspaceDir, connB.dirName).patches,
        ).toHaveLength(2);
        // Only B's two changes remain unpublished.
        expect(
          cli.json<{ count: number }>(["files", "unpublished"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(2);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("publishing connection B later lands BOTH of its folders (Req 2)", async () => {
      try {
        const uploadResult = cli.json<{
          connections: Array<{ connectionName: string; filesUpdated: number }>;
        }>(["files", "upload", "--connection", connB.id], {
          cwd: workspaceDir,
        });
        expect(uploadResult.connections).toHaveLength(1);
        expect(uploadResult.connections[0].connectionName).toBe(connB.dirName);
        expect(uploadResult.connections[0].filesUpdated).toBe(2);

        const publishResult = cli.json<{
          status: string;
          publishedConnections: string[];
        }>(["files", "publish"], { cwd: workspaceDir });
        expect(publishResult.status).toBe("published");
        expect(publishResult.publishedConnections).toContain(connB.dirName);

        // Both of B's folders landed; A stayed put.
        expect(await aliceNameInPg()).toBe("AliceOne");
        expect(await reviewBodyInPg()).toBe("body-one");
        expect(await blogAuthorInPg()).toBe("Author-One");
        expect(await productCategoryInPg()).toBe("cat-one");
        expect(
          readAcceptedPatches(workspaceDir, connA.dirName).patches,
        ).toHaveLength(0);
        expect(
          readAcceptedPatches(workspaceDir, connB.dirName).patches,
        ).toHaveLength(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);

    // --- Requirement 3: partial publish (connection B rejected) is recoverable. ---

    it("a publish where A succeeds and B is rejected is a valid partial success (Req 3)", async () => {
      try {
        // A: valid edits in both folders. B: a constraint-violating edit in authors.
        editField(blogPost.abs, "author", "Author-Three");
        acceptOne(blogPost.ws);
        editField(product.abs, "category", "cat-three");
        acceptOne(product.ws);
        editField(alice.abs, "name", longName);
        acceptOne(alice.ws);
        expect(
          cli.json<{ count: number }>(["files", "unreviewed"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(0);

        cli.json(["files", "upload", "--connection", connA.id], {
          cwd: workspaceDir,
        });
        cli.json(["files", "upload", "--connection", connB.id], {
          cwd: workspaceDir,
        });

        const publishResult = cli.json<{
          status: string;
          publishedConnections: string[];
          failedConnections: unknown[];
          warnings: Array<{
            name: string;
            warning: { phase: string; failedCount: number };
          }>;
        }>(["files", "publish"], { cwd: workspaceDir });

        expect(publishResult.status).toBe("published");
        expect(publishResult.publishedConnections).toContain(connA.dirName);
        expect(publishResult.failedConnections).toHaveLength(0);
        const bWarning = publishResult.warnings.find(
          (w) => w.name === connB.dirName,
        );
        expect(bWarning).toBeDefined();
        expect(bWarning?.warning.phase).toBe("run-job");
        expect(bWarning?.warning.failedCount).toBeGreaterThan(0);
        // A published cleanly — no warning.
        expect(
          publishResult.warnings.find((w) => w.name === connA.dirName),
        ).toBeUndefined();

        // A's BOTH folders landed; B's rejected row did NOT.
        expect(await blogAuthorInPg()).toBe("Author-Three");
        expect(await productCategoryInPg()).toBe("cat-three");
        expect(await aliceNameInPg()).toBe("AliceOne");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);

    it("B's rejected row is quarantined in failed-patches.json; A is fully clean (Req 3)", () => {
      try {
        expect(
          readAcceptedPatches(workspaceDir, connB.dirName).patches,
        ).toHaveLength(0);
        const failed = readFailedPatches(workspaceDir, connB.dirName);
        expect(failed.patches).toHaveLength(1);
        const entry = failed.patches[0];
        expect(entry.path).toBe(
          path.relative(path.join(workspaceDir, connB.dirName), alice.abs),
        );
        expect(entry.kind).toBe("update");
        expect(entry.patch).toEqual([
          { op: "add", path: "/name", value: longName },
        ]);
        expect(entry.error).toBeDefined();
        expect(entry.error).toContain("value too long");

        expect(
          cli.json<{ count: number }>(["files", "unreviewed"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(1);

        // A is fully published and clean — untouched by B's failure.
        expect(
          readAcceptedPatches(workspaceDir, connA.dirName).patches,
        ).toHaveLength(0);
        const aWorktree = path.join(workspaceDir, connA.dirName);
        expect(
          execFileSync("git", ["-C", aWorktree, "status", "--porcelain"], {
            encoding: "utf-8",
          }).trim(),
        ).toBe("");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("recovery: fixing B's rejected value and republishing lands it (Req 3)", async () => {
      try {
        editField(alice.abs, "name", "AliceFixed"); // 10 chars, valid
        acceptOne(alice.ws);
        expect(
          readAcceptedPatches(workspaceDir, connB.dirName).patches,
        ).toHaveLength(1);

        cli.json(["files", "upload", "--connection", connB.id], {
          cwd: workspaceDir,
        });
        const publishResult = cli.json<{
          status: string;
          publishedConnections: string[];
        }>(["files", "publish"], { cwd: workspaceDir });
        expect(publishResult.status).toBe("published");
        expect(publishResult.publishedConnections).toContain(connB.dirName);

        expect(await aliceNameInPg()).toBe("AliceFixed");
        // A remains at its last published values throughout B's recovery.
        expect(await blogAuthorInPg()).toBe("Author-Three");
        expect(await productCategoryInPg()).toBe("cat-three");

        expect(
          readAcceptedPatches(workspaceDir, connB.dirName).patches,
        ).toHaveLength(0);
        expect(
          readFailedPatches(workspaceDir, connB.dirName).patches,
        ).toHaveLength(0);
        const bWorktree = path.join(workspaceDir, connB.dirName);
        expect(
          execFileSync("git", ["-C", bWorktree, "status", "--porcelain"], {
            encoding: "utf-8",
          }).trim(),
        ).toBe("");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);
  },
);

// ---------------------------------------------------------------------------
// DEV-10596 — connector-scoped BULK REVIEW. `files accept-all --connection` and
// `files reject-all --connection` accept/reject every unreviewed change across
// ONLY the named connection's data folders, leaving other connections untouched.
// This is what the desktop's connector-scoped "Accept and publish" / "Discard
// and publish" buttons call. Two connections (both linking blog_posts to the
// same Postgres) prove the scoping.
// ---------------------------------------------------------------------------
describeIfPostgres(
  "Connector-scoped bulk review — files accept-all/reject-all --connection (DEV-10596)",
  () => {
    let workspaceId: string;
    let workspaceDir: string;
    let connA: { id: string; dirName: string };
    let connB: { id: string; dirName: string };
    let hasFailed = false;

    /** Edit the AI-tools post's author under one connection dir (leaves it UNREVIEWED). */
    function editAiToolsAuthor(connDirName: string, newAuthor: string): void {
      const target = findJsonFiles(path.join(workspaceDir, connDirName))
        .map((p) => ({
          p,
          data: JSON.parse(fs.readFileSync(p, "utf-8")) as Record<
            string,
            unknown
          >,
        }))
        .find(
          (r) => r.data.title === "The Rise of AI-Powered Development Tools",
        );
      if (!target) {
        throw new Error(`AI-tools post not found under ${connDirName}`);
      }
      target.data.author = newAuthor;
      fs.writeFileSync(target.p, JSON.stringify(target.data, null, 2) + "\n");
    }

    beforeAll(async () => {
      await setupTestTable();

      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("bulk-review-scope"),
      ]);
      workspaceId = ws.id;

      const addConnection = (): string =>
        cli.json<{ id: string }>([
          "connections",
          "--workspace",
          workspaceId,
          "add",
          "--service",
          TEST_CONNECTOR_SERVICE,
          "--param",
          `connectionString=${postgresUrl}`,
        ]).id;
      const connAId = addConnection();
      const connBId = addConnection();

      const parentDir = path.join(cli.home, "test-bulk-review-scope");
      fs.mkdirSync(parentDir, { recursive: true });
      const initResult = cli.json<{ directory: string }>(
        ["workspaces", "init", workspaceId],
        { cwd: parentDir },
      );
      workspaceDir = path.join(parentDir, initResult.directory);

      const linkBlogPosts = (connectionId: string): void => {
        const tables = cli.json<Array<{ id: string; displayName: string }>>([
          "linked",
          "--workspace",
          workspaceId,
          "available",
          connectionId,
        ]);
        const blogPosts = tables.find(
          (t) => t.displayName === "integration_blog_posts",
        )!;
        const tableIdParts = blogPosts.id.split(",");
        const linked = cli.json<{ id: string }>(
          [
            "linked",
            "--workspace",
            workspaceId,
            "add",
            "--connection-id",
            connectionId,
            ...tableIdParts.flatMap((p: string) => ["--table-id", p]),
            "--name",
            blogPosts.displayName,
          ],
          { cwd: workspaceDir },
        );
        cli.run(["linked", "--workspace", workspaceId, "pull", linked.id], {
          cwd: workspaceDir,
        });
      };
      linkBlogPosts(connAId);
      linkBlogPosts(connBId);
      cli.run(["files", "download"], { cwd: workspaceDir });

      const marker = readMarker(workspaceDir);
      const dirNameById = new Map(
        marker.connections.map((c) => [c.id, c.dirName]),
      );
      connA = { id: connAId, dirName: dirNameById.get(connAId)! };
      connB = { id: connBId, dirName: dirNameById.get(connBId)! };
    }, 180_000);

    afterAll(async () => {
      const shouldPreserve = preserveOnFailure && hasFailed;
      if (workspaceId && !shouldPreserve) deleteWorkspace(cli, workspaceId);
      if (workspaceDir && !shouldPreserve) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownTestTable();
    });

    it("`accept-all --connection` accepts ONLY the named connection's edits", () => {
      try {
        editAiToolsAuthor(connA.dirName, "Accepted-A");
        editAiToolsAuthor(connB.dirName, "Pending-B");
        // Both connections now have one unreviewed edit.
        expect(
          cli.json<{ count: number }>(["files", "unreviewed"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(2);

        cli.run(["files", "accept-all", "--connection", connA.id], {
          cwd: workspaceDir,
        });

        // Only B's edit is still unreviewed; A's was accepted.
        expect(
          cli.json<{ count: number }>(["files", "unreviewed"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(1);
        expect(
          readAcceptedPatches(workspaceDir, connA.dirName).patches,
        ).toHaveLength(1);
        expect(
          readAcceptedPatches(workspaceDir, connB.dirName).patches,
        ).toHaveLength(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("`reject-all --connection` reverts ONLY the named connection's edits", () => {
      try {
        // B still has its unreviewed edit from the previous test.
        cli.run(["files", "reject-all", "--connection", connB.id], {
          cwd: workspaceDir,
        });

        // B's edit reverted → nothing unreviewed anywhere.
        expect(
          cli.json<{ count: number }>(["files", "unreviewed"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(0);
        // A's accepted patch is untouched by rejecting B; B accepted nothing.
        expect(
          readAcceptedPatches(workspaceDir, connA.dirName).patches,
        ).toHaveLength(1);
        expect(
          readAcceptedPatches(workspaceDir, connB.dirName).patches,
        ).toHaveLength(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("rejects `--connection` combined with `--folder` (accept-all + reject-all)", () => {
      const accept = cli.run(
        [
          "files",
          "accept-all",
          "--connection",
          connA.id,
          "--folder",
          `${connA.dirName}/x`,
        ],
        { cwd: workspaceDir, expectError: true },
      );
      expect(accept.exitCode).not.toBe(0);
      expect(`${accept.stdout}\n${accept.stderr}`).toContain(
        "mutually exclusive",
      );

      const reject = cli.run(
        [
          "files",
          "reject-all",
          "--connection",
          connA.id,
          "--folder",
          `${connA.dirName}/x`,
        ],
        { cwd: workspaceDir, expectError: true },
      );
      expect(reject.exitCode).not.toBe(0);
      expect(`${reject.stdout}\n${reject.stderr}`).toContain(
        "mutually exclusive",
      );
    });
  },
);

/**
 * Stand up a workspace with `integration_authors` linked, pulled, and
 * downloaded, and locate Alice's record file on disk. Shared by the two
 * delete-focused suites below (the review-ladder walk-back and the
 * connector-rejected delete) so their setup stays identical. Assumes the
 * caller has already seeded `integration_authors` (via `setupAuthorsTable`).
 */
async function linkAuthorsWorkspaceAndFindAlice(prefix: string): Promise<{
  workspaceId: string;
  workspaceDir: string;
  connDirName: string;
  aliceAbsPath: string;
  aliceWorkspacePath: string;
}> {
  const ws = cli.json<{ id: string }>([
    "workspaces",
    "create",
    uniqueName(prefix),
  ]);
  const workspaceId = ws.id;

  const conn = cli.json<{ id: string }>([
    "connections",
    "--workspace",
    workspaceId,
    "add",
    "--service",
    TEST_CONNECTOR_SERVICE,
    "--param",
    `connectionString=${postgresUrl}`,
  ]);
  const connectionId = conn.id;

  const parentDir = path.join(cli.home, `test-${prefix}`);
  fs.mkdirSync(parentDir, { recursive: true });
  const initResult = cli.json<{ directory: string }>(
    ["workspaces", "init", workspaceId],
    { cwd: parentDir },
  );
  const workspaceDir = path.join(parentDir, initResult.directory);

  const tables = cli.json<Array<{ id: string; displayName: string }>>([
    "linked",
    "--workspace",
    workspaceId,
    "available",
    connectionId,
  ]);
  const authorsTable = tables.find(
    (t) => t.displayName === "integration_authors",
  );
  if (!authorsTable) {
    throw new Error(
      `integration_authors not found in available tables: ${tables.map((t) => t.displayName).join(", ")}`,
    );
  }
  const tableIdParts = authorsTable.id.split(",");
  const linked = cli.json<{ id: string }>(
    [
      "linked",
      "--workspace",
      workspaceId,
      "add",
      "--connection-id",
      connectionId,
      ...tableIdParts.flatMap((p: string) => ["--table-id", p]),
      "--name",
      authorsTable.displayName,
    ],
    { cwd: workspaceDir },
  );
  cli.run(["linked", "--workspace", workspaceId, "pull", linked.id], {
    cwd: workspaceDir,
  });
  cli.run(["files", "download"], { cwd: workspaceDir });

  const marker = readMarker(workspaceDir);
  const connDirName = marker.connections[0]!.dirName;

  const aliceFile = findJsonFiles(workspaceDir)
    .map((p) => ({
      p,
      data: JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>,
    }))
    .find((r) => r.data.author_id === AUTHOR_IDS.alice);
  if (!aliceFile) {
    throw new Error(
      `Expected Alice's record (${AUTHOR_IDS.alice}) not found after pull`,
    );
  }

  return {
    workspaceId,
    workspaceDir,
    connDirName,
    aliceAbsPath: aliceFile.p,
    aliceWorkspacePath: path.relative(workspaceDir, aliceFile.p),
  };
}

// The publish-delete happy path is covered end-to-end by the driver suite
// (scratch-cli-tests/tests/driver-publish.spec.ts). These two suites cover the
// two paths the driver does NOT: walking a staged delete back down the review
// ladder, and a delete the external connector rejects at run-job time.
describeIfPostgres(
  "Delete review ladder — reject and restore-deleted-record walk a staged delete back",
  () => {
    let workspaceId: string;
    let workspaceDir: string;
    let connDirName: string;
    let aliceAbsPath: string;
    let aliceWorkspacePath: string;
    let hasFailed = false;

    beforeAll(async () => {
      await setupAuthorsTable();
      ({
        workspaceId,
        workspaceDir,
        connDirName,
        aliceAbsPath,
        aliceWorkspacePath,
      } = await linkAuthorsWorkspaceAndFindAlice("delete-ladder"));
    }, 120_000);

    afterAll(async () => {
      const shouldPreserve = preserveOnFailure && hasFailed;
      if (workspaceId && !shouldPreserve) deleteWorkspace(cli, workspaceId);
      if (workspaceDir && !shouldPreserve) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownAuthorsTable();
    });

    it("reject restores a working-tree deletion that was never accepted", () => {
      try {
        // Delete the file on disk only (no accept) — a pending unreviewed delete.
        fs.rmSync(aliceAbsPath);
        expect(fs.existsSync(aliceAbsPath)).toBe(false);
        const unreviewed = cli.json<{ count: number }>(
          ["files", "unreviewed"],
          {
            cwd: workspaceDir,
          },
        );
        expect(unreviewed.count).toBe(1);

        // reject restores the working file to its approved (== published) state.
        cli.run(["files", "reject", aliceWorkspacePath], { cwd: workspaceDir });
        expect(fs.existsSync(aliceAbsPath)).toBe(true);
        const restored = JSON.parse(fs.readFileSync(aliceAbsPath, "utf-8")) as {
          name: string;
        };
        expect(restored.name).toBe("Alice");
        const after = cli.json<{ count: number }>(["files", "unreviewed"], {
          cwd: workspaceDir,
        });
        expect(after.count).toBe(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("accepting a deletion stages a kind:delete patch (patch is null)", () => {
      try {
        fs.rmSync(aliceAbsPath);
        const accept = cli.json<{ status: string; filesAccepted: number }>(
          ["files", "accept", aliceWorkspacePath],
          { cwd: workspaceDir },
        );
        expect(accept.status).toBe("accepted");
        expect(accept.filesAccepted).toBe(1);

        const accepted = readAcceptedPatches(workspaceDir, connDirName);
        expect(accepted.patches).toHaveLength(1);
        expect(accepted.patches[0].kind).toBe("delete");
        expect(accepted.patches[0].patch).toBeNull();

        // Staged for publish (approved-but-unpublished), and the file stays gone.
        const unpublished = cli.json<{ count: number }>(
          ["files", "unpublished"],
          {
            cwd: workspaceDir,
          },
        );
        expect(unpublished.count).toBe(1);
        expect(fs.existsSync(aliceAbsPath)).toBe(false);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("restore-deleted-record brings the file back and drops the delete entry", () => {
      try {
        const restore = cli.json<{ status: string; filesRestored: number }>(
          ["files", "restore-deleted-record", aliceWorkspacePath],
          { cwd: workspaceDir },
        );
        expect(restore.status).toBe("restored");
        expect(restore.filesRestored).toBe(1);

        // File is back with the published value, and the delete patch is gone —
        // nothing left to publish, nothing left unreviewed.
        expect(fs.existsSync(aliceAbsPath)).toBe(true);
        const restored = JSON.parse(fs.readFileSync(aliceAbsPath, "utf-8")) as {
          name: string;
        };
        expect(restored.name).toBe("Alice");
        expect(
          readAcceptedPatches(workspaceDir, connDirName).patches,
        ).toHaveLength(0);
        expect(
          cli.json<{ count: number }>(["files", "unpublished"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(0);
        expect(
          cli.json<{ count: number }>(["files", "unreviewed"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);
  },
);

// A delete the connector rejects at run-job time (Postgres foreign-key
// violation) must be quarantined, NOT silently succeed — the delete mirror of
// the DEV-10048 edit-rejection suite above. A child table (never linked into
// Scratch) holds a row referencing Alice, so `DELETE FROM integration_authors
// WHERE author_id = <alice>` fails with a foreign-key constraint error.
describeIfPostgres(
  "Publish a connector-rejected delete — quarantine to failed-patches.json (FK violation)",
  () => {
    const CHILD_TABLE = "integration_author_refs";
    let workspaceId: string;
    let workspaceDir: string;
    let connDirName: string;
    let aliceAbsPath: string;
    let aliceWorkspacePath: string;
    let prePublishMainHash: string;
    let hasFailed = false;

    beforeAll(async () => {
      await setupAuthorsTable();

      // A child row referencing Alice so the remote DELETE is rejected. The
      // child table is intentionally NOT linked into Scratch — it exists only to
      // enforce the foreign key at publish time.
      const client = new Client({ connectionString: postgresUrl });
      await client.connect();
      try {
        await client.query(`DROP TABLE IF EXISTS ${CHILD_TABLE} CASCADE`);
        await client.query(
          `CREATE TABLE ${CHILD_TABLE} (
             ref_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
             author_id UUID NOT NULL REFERENCES integration_authors(author_id)
           )`,
        );
        await client.query(
          `INSERT INTO ${CHILD_TABLE} (author_id) VALUES ($1)`,
          [AUTHOR_IDS.alice],
        );
      } finally {
        await client.end();
      }

      ({
        workspaceId,
        workspaceDir,
        connDirName,
        aliceAbsPath,
        aliceWorkspacePath,
      } = await linkAuthorsWorkspaceAndFindAlice("delete-fail"));
    }, 120_000);

    afterAll(async () => {
      const shouldPreserve = preserveOnFailure && hasFailed;
      if (shouldPreserve) {
        console.log(
          `[preserve] Keeping workbook ${workspaceId} and local dir ${workspaceDir} for inspection`,
        );
      }
      if (workspaceId && !shouldPreserve) deleteWorkspace(cli, workspaceId);
      if (workspaceDir && !shouldPreserve) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      const client = new Client({ connectionString: postgresUrl });
      await client.connect();
      try {
        await client.query(`DROP TABLE IF EXISTS ${CHILD_TABLE} CASCADE`);
      } finally {
        await client.end();
      }
      await teardownAuthorsTable();
    });

    it("accept + upload a delete of a referenced row succeed (rejection is deferred to run-job)", () => {
      try {
        const connWorktree = path.join(workspaceDir, connDirName);
        prePublishMainHash = execFileSync(
          "git",
          ["-C", connWorktree, "rev-parse", "refs/heads/main"],
          { encoding: "utf-8" },
        ).trim();

        // Delete the file, accept it (kind:delete), and upload to the dirty
        // branch. Upload writes git, not the DB, so no FK check fires yet.
        fs.rmSync(aliceAbsPath);
        const accept = cli.json<{ status: string; filesAccepted: number }>(
          ["files", "accept", aliceWorkspacePath],
          { cwd: workspaceDir },
        );
        expect(accept.status).toBe("accepted");
        expect(accept.filesAccepted).toBe(1);
        expect(
          readAcceptedPatches(workspaceDir, connDirName).patches[0].kind,
        ).toBe("delete");

        // Upload succeeds even though the delete will be rejected downstream.
        const upload = cli.run(["files", "upload"], { cwd: workspaceDir });
        expect(upload.exitCode).toBe(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("publish surfaces the connector's FK rejection instead of silently succeeding", async () => {
      try {
        // Mirror DEV-10243/DEV-10048: a per-row rejection is recoverable, so
        // publish exits 0 (cli.json returning at all proves exit 0) and reports
        // a run-job warning rather than a clean, silent "published".
        const publishResult = cli.json<{
          status: string;
          failedConnections: Array<unknown>;
          warnings: Array<{
            name: string;
            warning: { phase: string; message: string; failedCount: number };
          }>;
        }>(["files", "publish"], { cwd: workspaceDir });

        expect(publishResult.failedConnections).toHaveLength(0);
        expect(publishResult.warnings.length).toBeGreaterThan(0);
        const warning = publishResult.warnings.find(
          (w) => w.name === connDirName,
        );
        expect(warning).toBeDefined();
        expect(warning?.warning.phase).toBe("run-job");
        expect(warning?.warning.failedCount).toBeGreaterThan(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);

    it("the rejected delete is quarantined in failed-patches.json (DEV-10048)", () => {
      try {
        // accepted-patches.json is cleared for the path; the delete moves to
        // failed-patches.json carrying the connector's record-level error.
        expect(
          readAcceptedPatches(workspaceDir, connDirName).patches,
        ).toHaveLength(0);

        const afterFail = readFailedPatches(workspaceDir, connDirName);
        expect(afterFail.patches).toHaveLength(1);
        const entry = afterFail.patches[0];
        const expectedConnectionRelativePath = path.relative(
          path.join(workspaceDir, connDirName),
          aliceAbsPath,
        );
        expect(entry.path).toBe(expectedConnectionRelativePath);
        expect(entry.kind).toBe("delete");
        expect(entry.patch).toBeNull();
        expect(entry.error).toBeDefined();
        expect(entry.error?.toLowerCase()).toContain("foreign key");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("publish left refs/heads/main unmoved (the delete never committed)", () => {
      try {
        const connWorktree = path.join(workspaceDir, connDirName);
        const postPublishMainHash = execFileSync(
          "git",
          ["-C", connWorktree, "rev-parse", "refs/heads/main"],
          { encoding: "utf-8" },
        ).trim();
        expect(postPublishMainHash).toBe(prePublishMainHash);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("Alice's row still exists in Postgres (the delete did not land)", async () => {
      try {
        const client = new Client({ connectionString: postgresUrl });
        await client.connect();
        try {
          const res = await client.query<{ name: string }>(
            `SELECT name FROM integration_authors WHERE author_id = $1`,
            [AUTHOR_IDS.alice],
          );
          expect(res.rowCount).toBe(1);
          expect(res.rows[0].name).toBe("Alice");
        } finally {
          await client.end();
        }
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);
  },
);

// Publishing a delete must be idempotent: once the row is gone, re-running
// publish and download converges to the same state instead of erroring or
// re-issuing the delete. Guards the "make operations idempotent and resumable"
// invariant for the delete path specifically.
describeIfPostgres(
  "Publishing a delete is idempotent — re-publish and re-download are clean no-ops",
  () => {
    let workspaceId: string;
    let workspaceDir: string;
    let connDirName: string;
    let aliceAbsPath: string;
    let aliceWorkspacePath: string;
    let hasFailed = false;

    beforeAll(async () => {
      await setupAuthorsTable();
      ({
        workspaceId,
        workspaceDir,
        connDirName,
        aliceAbsPath,
        aliceWorkspacePath,
      } = await linkAuthorsWorkspaceAndFindAlice("delete-idempotent"));
    }, 120_000);

    afterAll(async () => {
      const shouldPreserve = preserveOnFailure && hasFailed;
      if (workspaceId && !shouldPreserve) deleteWorkspace(cli, workspaceId);
      if (workspaceDir && !shouldPreserve) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownAuthorsTable();
    });

    it("delete publishes successfully and removes the row from Postgres", async () => {
      try {
        fs.rmSync(aliceAbsPath);
        cli.run(["files", "accept", aliceWorkspacePath], { cwd: workspaceDir });
        cli.run(["files", "upload"], { cwd: workspaceDir });

        const publishResult = cli.json<{
          status: string;
          publishedConnections: string[];
        }>(["files", "publish"], { cwd: workspaceDir });
        expect(publishResult.status).toBe("published");
        expect(publishResult.publishedConnections).toContain(connDirName);

        // The delete landed: the row is gone and reconcile cleared the patch.
        const client = new Client({ connectionString: postgresUrl });
        await client.connect();
        try {
          const res = await client.query(
            `SELECT 1 FROM integration_authors WHERE author_id = $1`,
            [AUTHOR_IDS.alice],
          );
          expect(res.rowCount).toBe(0);
        } finally {
          await client.end();
        }
        expect(
          readAcceptedPatches(workspaceDir, connDirName).patches,
        ).toHaveLength(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);

    it("re-publishing with nothing staged is a no-op (no re-issued delete)", () => {
      try {
        // The server-side plan is empty now that the delete already landed, so
        // publish reports "nothing to do" rather than failing on the
        // already-deleted row.
        const idempotent = cli.json<{
          status: string;
          publishedConnections: string[];
        }>(["files", "publish"], { cwd: workspaceDir });
        expect(["no_changes", "no_diff"]).toContain(idempotent.status);
        expect(idempotent.publishedConnections).toHaveLength(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);

    it("re-downloading keeps the record gone and the working tree clean", () => {
      try {
        cli.run(["files", "download"], { cwd: workspaceDir });
        expect(fs.existsSync(aliceAbsPath)).toBe(false);
        expect(
          cli.json<{ count: number }>(["files", "unreviewed"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(0);
        expect(
          cli.json<{ count: number }>(["files", "unpublished"], {
            cwd: workspaceDir,
          }).count,
        ).toBe(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 60_000);
  },
);
