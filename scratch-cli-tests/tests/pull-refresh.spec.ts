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

/** Recursively find all .json record files under a directory (skipping dot-dirs and .schema.json). */
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

describeIfPostgres("Pull refresh — remote changes appear after re-pull", () => {
  let workspaceId: string;
  let connectionId: string;
  let linkedFolderId: string;
  let workspaceDir: string;
  let hasFailed = false;

  beforeAll(async () => {
    // 1. Seed the test table
    await setupTestTable();

    // 2. Create a new workbook
    const ws = cli.json<{ id: string }>([
      "workspaces",
      "create",
      uniqueName("pull-refresh"),
    ]);
    workspaceId = ws.id;

    // 3. Connect to Postgres
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

    // 4. Init the workbook locally
    const parentDir = path.join(cli.home, "test-pull-refresh");
    fs.mkdirSync(parentDir, { recursive: true });
    const initResult = cli.json<{ directory: string }>(
      ["workspaces", "init", workspaceId],
      { cwd: parentDir },
    );
    workspaceDir = path.join(parentDir, initResult.directory);

    // 5. Link the integration_blog_posts table
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

    // Table ID from `available` is comma-joined (e.g. "public,table_name").
    // The `add` endpoint expects each part as a separate --table-id arg.
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

    // 6. Initial pull + download
    cli.run(["linked", "--workspace", workspaceId, "pull", linkedFolderId], {
      cwd: workspaceDir,
    });
    cli.run(["files", "download"], { cwd: workspaceDir });
  });

  afterAll(async () => {
    const shouldPreserve = preserveOnFailure && hasFailed;
    if (shouldPreserve) {
      console.log(`[preserve] Keeping workbook ${workspaceId} and local dir ${workspaceDir} for inspection`);
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

  it("should reflect remote database changes after re-pull and re-download", async () => {
    try {
    // --- Verify initial state ---
    const jsonFilesBefore = findJsonFiles(workspaceDir);
    expect(jsonFilesBefore).toHaveLength(3);

    const recordsBefore = jsonFilesBefore.map((f) =>
      JSON.parse(fs.readFileSync(f, "utf-8")) as Record<string, unknown>,
    );
    const aiPost = recordsBefore.find(
      (r) => r.title === "The Rise of AI-Powered Development Tools",
    );
    expect(aiPost).toBeDefined();
    expect(aiPost!.author).toBe("Sarah Chen");

    // --- Mutate the database directly ---
    const client = new Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query(
        `UPDATE integration_blog_posts
         SET author = 'Sarah Chen-Updated', updated_dt = NOW()
         WHERE title = 'The Rise of AI-Powered Development Tools'`,
      );
    } finally {
      await client.end();
    }

    // --- Re-pull from the server (fetches latest from Postgres) ---
    const pullResult = cli.run(
      ["linked", "--workspace", workspaceId, "pull", linkedFolderId],
      { cwd: workspaceDir },
    );
    expect(pullResult.exitCode).toBe(0);

    // --- Re-download files ---
    const downloadResult = cli.run(["files", "download"], {
      cwd: workspaceDir,
    });
    expect(downloadResult.exitCode).toBe(0);

    // --- Verify the updated data appears locally ---
    const jsonFilesAfter = findJsonFiles(workspaceDir);
    expect(jsonFilesAfter).toHaveLength(3);

    const recordsAfter = jsonFilesAfter.map((f) =>
      JSON.parse(fs.readFileSync(f, "utf-8")) as Record<string, unknown>,
    );
    const updatedPost = recordsAfter.find(
      (r) => r.title === "The Rise of AI-Powered Development Tools",
    );
    expect(updatedPost).toBeDefined();
    expect(updatedPost!.author).toBe("Sarah Chen-Updated");

    // --- Verify the other records are unchanged ---
    const debtPost = recordsAfter.find(
      (r) => r.title === "Why Software Companies Are Rethinking Technical Debt",
    );
    expect(debtPost).toBeDefined();
    expect(debtPost!.author).toBe("Marcus Rivera");

    const startupPost = recordsAfter.find(
      (r) => r.title === "Small Teams and Big AI: The New Startup Advantage",
    );
    expect(startupPost).toBeDefined();
    expect(startupPost!.author).toBe("Priya Kapoor");
    } catch (err) {
      hasFailed = true;
      throw err;
    }
  });
});
