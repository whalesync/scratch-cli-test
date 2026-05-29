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
  setupAuthorsTable,
  setupTestTable,
  teardownAuthorsTable,
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

    it("accept generates accepted-patches.json with the expected RFC 7396 entry", () => {
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
        // carrying the field-level RFC 7396 merge patch.
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
        expect(entry.patch).toMatchObject({ author: newAuthor });

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

        const canonical =
          JSON.stringify(JSON.parse(onDisk), null, 2) + "\n";
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

        const data = JSON.parse(fs.readFileSync(controlFile, "utf-8")) as Record<
          string,
          unknown
        >;
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

        const acceptResult = cli.json<{ status: string; filesAccepted: number }>(
          ["files", "accept", editedRecordWorkspacePath],
          { cwd: workspaceDir },
        );
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
        expect(onDisk).toBe(
          JSON.stringify(JSON.parse(onDisk), null, 2) + "\n",
        );

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
    // Quirk worth knowing: the Postgres connector currently SWALLOWS per-row
    // constraint violations rather than failing the run-job. So a publish
    // that hits a VARCHAR(20) overflow comes back as `status: "published"`,
    // exit code 0, with no warning — but `main` does not advance, the patch
    // does not drop from `accepted-patches.json`, and the Postgres row is
    // unchanged. The user's only signal is that `files unpublished` keeps
    // reporting the path as still-pending.
    //
    // This describe block locks in that behavior so a future change to the
    // connector (surfacing the per-row failure as a run-job error, or to a
    // `warnings[]` payload, or as a non-zero exit) will trip these tests
    // and force an intentional update — not a silent change in user-visible
    // behavior. The recovery test at the end proves the workspace is still
    // recoverable after the silent drop.
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
          data: JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>,
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
        const data = JSON.parse(fs.readFileSync(aliceAbsPath, "utf-8")) as Record<
          string,
          unknown
        >;
        data.name = longName;
        fs.writeFileSync(aliceAbsPath, JSON.stringify(data, null, 2) + "\n");

        const unreviewed = cli.json<{ count: number }>(
          ["files", "unreviewed"],
          { cwd: workspaceDir },
        );
        expect(unreviewed.count).toBe(1);

        const acceptResult = cli.json<{ status: string; filesAccepted: number }>(
          ["files", "accept", aliceWorkspacePath],
          { cwd: workspaceDir },
        );
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

    it("triggers a publish whose row will be silently dropped by the connector", async () => {
      // Drives the actual publish so the assertion-style tests below
      // (patch preserved, main unmoved, worktree retains edit, Postgres
      // unchanged) have post-publish state to observe. Intentionally NOT
      // asserting the publish exit code or status here — that's DEV-10243's
      // job. See the `.skip`'d test immediately below for the assertion
      // we'd like to make once the reporting gap is closed.
      try {
        cli.json(["files", "publish"], { cwd: workspaceDir });
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);

    // SKIPPED — pending DEV-10243.
    //
    // The intended assertion is that `files publish` exits non-zero with
    // `status: "failed"` and a `failedConnections` entry of `phase: "run-job"`
    // when the destination connector rejects every row in the batch (e.g.,
    // VARCHAR(20) overflow, type mismatch, FK violation). Today this is
    // unreachable: per-row connector throws are caught by `processBatch`,
    // the plan ends as `CompletedWithErrors`, but the BullMQ job wrapper
    // marks the job `status: "completed"` regardless — so the CLI's
    // `poll_job` sees success and prints `"published"`. See DEV-10243 for
    // the full root-cause trace and the proposed fix (Option 1: surface
    // `failedCount` in `JobProgress` and map to a `warnings[]` entry).
    //
    // Once DEV-10243 lands, delete the running test above, un-skip this
    // one, and flip the assertion to whichever shape the fix chose:
    //   - Option 1 (exit 0 + warning): publishResult.warnings.length > 0
    //     and a per-row failure detail.
    //   - Option 2 (exit non-zero):    expectError: true, status "failed",
    //     failedConnections has one entry with phase "run-job".
    //
    // The other tests in this block already lock in the recoverable
    // workspace state that the silent-drop leaves behind, so they don't
    // depend on this assertion landing.
    it.skip("publish reports the per-row failure to the CLI (DEV-10243)", async () => {
      try {
        const publishResult = cli.json<{
          status: string;
          publishedConnections: string[];
          failedConnections: Array<unknown>;
          warnings: Array<unknown>;
        }>(["files", "publish"], { cwd: workspaceDir });

        expect(publishResult.status).toBe("failed");
        expect(publishResult.publishedConnections).not.toContain(connDirName);
        expect(publishResult.failedConnections.length).toBeGreaterThan(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);

    it("silent drop preserves the patch in accepted-patches.json (DEV-10175 + re-anchor no-op detection)", () => {
      try {
        // The DEV-10175 fix says: a failed run-job must NOT clear pending
        // edits. The silent-drop variant also reaches the correct outcome,
        // via a different code path: `reconcile_accepted_after_publish`
        // DOES run (the run-job "succeeded"), but `re_anchor_patches` sees
        // that the patch's intended outcome still differs from `new_main`'s
        // blob (because the connector didn't actually write the new value)
        // and preserves the entry. `files unpublished` is the user-visible
        // signal that something didn't actually land.
        const afterFail = readAcceptedPatches(workspaceDir, connDirName);
        expect(afterFail.patches).toHaveLength(1);
        const entry = afterFail.patches[0];
        expect(entry.kind).toBe("update");
        expect(entry.patch).toMatchObject({ name: longName });

        const unpublished = cli.json<{ count: number }>(
          ["files", "unpublished"],
          { cwd: workspaceDir },
        );
        expect(unpublished.count).toBe(1);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });

    it("silent drop leaves refs/heads/main unmoved", () => {
      try {
        // No commit was created server-side, so origin/main didn't advance,
        // so reconcile (which doesn't run on this path anyway) had nothing
        // to fast-forward to. The local ref must still point at the
        // pre-publish snapshot.
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
        // Bug B's rematerialize runs `materialize_local_repo(approved_map_new, ...)`,
        // and `approved_map_new` is `apply(new_main, surviving_patch)`. Since
        // the patch survived re-anchor (the previous test proves this), the
        // rematerialize writes the user's intended bytes — same content the
        // user originally typed, normalized to canonical formatting.
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
        const data = JSON.parse(fs.readFileSync(aliceAbsPath, "utf-8")) as Record<
          string,
          unknown
        >;
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

        const acceptResult = cli.json<{ status: string; filesAccepted: number }>(
          ["files", "accept", aliceWorkspacePath],
          { cwd: workspaceDir },
        );
        expect(acceptResult.status).toBe("accepted");
        expect(acceptResult.filesAccepted).toBe(1);

        const acceptedAfterFix = readAcceptedPatches(workspaceDir, connDirName);
        expect(acceptedAfterFix.patches).toHaveLength(1);
        expect(acceptedAfterFix.patches[0].patch).toMatchObject({
          name: recoveredName,
        });

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
        expect(onDisk).toBe(
          JSON.stringify(JSON.parse(onDisk), null, 2) + "\n",
        );

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
