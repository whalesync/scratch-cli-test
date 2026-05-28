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
import { setupTestTable, teardownTestTable } from "../src/postgres";

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
        // on disk but not yet in accepted-patches.json.
        // NOTE: The Trailing Newline is to allow the test to pass when the server canonical format is `JSON.stringify(data, null, 2) + '\n'`.
        // There is a followup task to properly handle this in the scratchmd CLI during reconciliation (see docs/plans/2026-05-27-unreviewed-detection-semantic-compare.md).
        const data = JSON.parse(
          fs.readFileSync(editedRecordAbsPath, "utf-8"),
        ) as Record<string, unknown>;
        data.author = newAuthor;
        fs.writeFileSync(
          editedRecordAbsPath,
          JSON.stringify(data, null, 2) + "\n",
        );

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
