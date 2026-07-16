import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
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

/** Recursively find all .json record files under a directory (skipping dot-dirs). */
function findJsonFiles(dir: string): string[] {
  const results: string[] = [];
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

/** Extract the first complete JSON object from CLI stdout (mirrors ScratchCli.json). */
function firstJsonObject(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("{");
    if (start === -1)
      throw new Error(`No JSON found in CLI output:\n${stdout}`);
    let depth = 0;
    for (let i = start; i < stdout.length; i++) {
      if (stdout[i] === "{") depth++;
      else if (stdout[i] === "}") depth--;
      if (depth === 0) return JSON.parse(stdout.slice(start, i + 1));
    }
    throw new Error(`Incomplete JSON in CLI output:\n${stdout}`);
  }
}

interface BlockedConflictPayload {
  status: string;
  conflictCount: number;
  paths: string[];
  stashFiles: string[];
  elapsedMs: number;
}

/**
 * DEV-10641: a malformed LOCAL working-tree record file must not hard-fail the
 * whole workspace pull. Before the fix, `files download` aborted with
 * "failed to parse working tree blob at <path> as JSON" and left the corrupt
 * file untouched, so the desktop "Try again" button looped forever. After the
 * fix the corrupt record is treated as a hard conflict: the clean server value
 * is materialized over the corrupt file, the raw bytes are stashed to
 * `unreviewed-changes.json`, and a workspace-wide pull reports a structured
 * `blocked_conflict` (non-zero) that the desktop already understands — so the
 * next pull finds a clean file and succeeds.
 */
describeIfPostgres(
  "Pull with a malformed local record — recovers instead of aborting (DEV-10641)",
  () => {
    let workspaceId: string;
    let connectionId: string;
    let linkedFolderId: string;
    let workspaceDir: string;
    let hasFailed = false;

    beforeAll(async () => {
      await setupTestTable();

      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("corrupt-record"),
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
      connectionId = conn.id;

      const parentDir = path.join(cli.home, "test-corrupt-record");
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
          ...tableIdParts.flatMap((part: string) => ["--table-id", part]),
          "--name",
          blogPostsTable.displayName,
        ],
        { cwd: workspaceDir },
      );
      linkedFolderId = linked.id;

      // Initial pull + download so the 3 records materialize locally.
      cli.run(["linked", "--workspace", workspaceId, "pull", linkedFolderId], {
        cwd: workspaceDir,
      });
      cli.run(["files", "download"], { cwd: workspaceDir });
    });

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

    it("restores a malformed local record and keeps the pull alive, then the retry succeeds", async () => {
      try {
        // --- Locate the record we will corrupt; capture its clean identity ---
        const jsonFilesBefore = findJsonFiles(workspaceDir);
        expect(jsonFilesBefore).toHaveLength(3);
        const corruptTarget = jsonFilesBefore.find(
          (f) =>
            (JSON.parse(fs.readFileSync(f, "utf-8")) as { title?: string })
              .title === "Why Software Companies Are Rethinking Technical Debt",
        )!;
        expect(corruptTarget).toBeDefined();
        expect(JSON.parse(fs.readFileSync(corruptTarget, "utf-8")).author).toBe(
          "Marcus Rivera",
        );

        // --- Corrupt the LOCAL working-tree copy (unparseable JSON on disk) ---
        // Mirrors the customer report: an external tool/editor left the file
        // malformed. The server's copy stays valid.
        const corruptBytes = "{ this is not valid json";
        fs.writeFileSync(corruptTarget, corruptBytes);

        // --- Advance the server so the re-download runs the reconcile step ---
        // download_single_repo only re-applies unreviewed working-tree edits —
        // where the malformed-record parse lives — when the connection's `main`
        // has moved. Mutate a DIFFERENT record so the corrupt one's server value
        // stays unchanged and we can assert it is restored to its clean content.
        const client = new Client({ connectionString: postgresUrl });
        await client.connect();
        try {
          const res = await client.query(
            `UPDATE integration_blog_posts
               SET author = 'DEV-10641 Advance', updated_dt = NOW()
             WHERE title = 'The Rise of AI-Powered Development Tools'`,
          );
          expect(res.rowCount).toBe(1);
        } finally {
          await client.end();
        }
        expect(
          cli.run(
            ["linked", "--workspace", workspaceId, "pull", linkedFolderId],
            { cwd: workspaceDir },
          ).exitCode,
        ).toBe(0);

        // --- Re-download: BEFORE the fix this aborted the ENTIRE pull with
        //     "failed to parse working tree blob ... as JSON" and left the
        //     corrupt file in place. AFTER the fix it treats the malformed record
        //     as a hard conflict — restoring the clean server value, stashing the
        //     raw bytes, and (for a workspace-wide pull) reporting a structured
        //     blocked_conflict the desktop already handles. ---
        const relPath = path.relative(workspaceDir, corruptTarget);
        const firstDownload = cli.run(["files", "download"], {
          cwd: workspaceDir,
          expectError: true,
        });

        // Not the old hard crash.
        expect(firstDownload.stderr).not.toContain(
          "failed to parse working tree blob",
        );
        // A graceful, structured refusal instead of an aborted pull.
        const payload = firstJsonObject(
          firstDownload.stdout,
        ) as BlockedConflictPayload;
        expect(payload.status).toBe("blocked_conflict");
        expect(payload.paths.length).toBeGreaterThan(0);
        expect(
          payload.paths.some((p) => p.endsWith(path.basename(corruptTarget))),
        ).toBe(true);
        expect(payload.stashFiles.length).toBeGreaterThan(0);

        // The corrupt file was overwritten with the clean server value on disk —
        // THIS is what breaks the infinite "Try again" loop.
        const restored = JSON.parse(fs.readFileSync(corruptTarget, "utf-8"));
        expect(restored.title).toBe(
          "Why Software Companies Are Rethinking Technical Debt",
        );
        expect(restored.author).toBe("Marcus Rivera");

        // The raw corrupt bytes are preserved in the stash (nothing silently
        // lost — "default to non-destructive").
        const stashPath = path.join(workspaceDir, payload.stashFiles[0]);
        const stash = JSON.parse(fs.readFileSync(stashPath, "utf-8")) as {
          patches: Array<{ path: string; patch: unknown }>;
        };
        const stashedEntry = stash.patches.find((p) =>
          p.path.endsWith(path.basename(corruptTarget)),
        );
        expect(stashedEntry).toBeDefined();
        expect(stashedEntry!.patch).toBe(corruptBytes);

        // --- The retry now succeeds: the local file is clean, so a second
        //     workspace-wide pull is no longer blocked (the loop is broken). ---
        const secondDownload = cli.run(["files", "download"], {
          cwd: workspaceDir,
        });
        expect(secondDownload.exitCode).toBe(0);

        // A disjoint record still carries the server change we made above, proving
        // the pull as a whole completed rather than aborting on the bad record.
        const aiPost = findJsonFiles(workspaceDir)
          .map((f) => JSON.parse(fs.readFileSync(f, "utf-8")))
          .find(
            (r: { title?: string }) =>
              r.title === "The Rise of AI-Powered Development Tools",
          );
        expect(aiPost).toBeDefined();
        expect(aiPost.author).toBe("DEV-10641 Advance");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 120_000);
  },
);
