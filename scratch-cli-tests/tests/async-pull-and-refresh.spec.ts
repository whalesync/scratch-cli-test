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

const serverUrl = process.env.SCRATCH_API_URL || "http://localhost:3010";
const apiKey = process.env.SCRATCH_API_KEY;

/** Call the Scratch server API directly with the test API token. */
async function scratchApi<T>(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${serverUrl}${urlPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `API-Token ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `API ${method} ${urlPath} failed (${res.status}): ${text}`,
    );
  }
  return (await res.json()) as T;
}

interface JobEntity {
  dbJobId: string;
  state: string;
  failedReason?: string | null;
}

/** Poll a job until it reaches a terminal state (completed, failed, canceled). */
async function waitForJob(
  jobId: string,
  timeoutMs = 30_000,
): Promise<JobEntity> {
  const start = Date.now();
  const terminalStates = ["completed", "failed", "canceled"];
  while (Date.now() - start < timeoutMs) {
    const job = await scratchApi<JobEntity>(
      "GET",
      `/jobs/${jobId}/progress`,
    );
    if (terminalStates.includes(job.state)) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`);
}

describeIfPostgres(
  "Async pull and refresh — pull via API, download via CLI",
  () => {
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
        uniqueName("async-pull"),
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
      const parentDir = path.join(cli.home, "test-async-pull");
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

      // 6. Initial pull (via CLI) + download
      cli.run(
        ["linked", "--workspace", workspaceId, "pull", linkedFolderId],
        { cwd: workspaceDir },
      );
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

    it("should reflect remote database changes after API-triggered pull and CLI download", async () => {
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

        // --- Trigger pull via the Scratch API (not the CLI) ---
        const pullResponse = await scratchApi<{
          jobId?: string;
          jobIds?: string[];
        }>("POST", `/workbook/${workspaceId}/pull-files`, {
          dataFolderIds: [linkedFolderId],
        });

        // Wait for the pull job(s) to complete
        const jobIds = pullResponse.jobIds ?? (pullResponse.jobId ? [pullResponse.jobId] : []);
        expect(jobIds.length).toBeGreaterThan(0);

        for (const jobId of jobIds) {
          const job = await waitForJob(jobId);
          expect(job.state).toBe("completed");
        }

        // --- Re-download files via CLI ---
        const downloadResult = cli.json<{ filesUpdated: number }>(
          ["files", "download"],
          { cwd: workspaceDir },
        );
        expect(downloadResult.filesUpdated).toBeGreaterThan(0);

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
          (r) =>
            r.title ===
            "Why Software Companies Are Rethinking Technical Debt",
        );
        expect(debtPost).toBeDefined();
        expect(debtPost!.author).toBe("Marcus Rivera");

        const startupPost = recordsAfter.find(
          (r) =>
            r.title ===
            "Small Teams and Big AI: The New Startup Advantage",
        );
        expect(startupPost).toBeDefined();
        expect(startupPost!.author).toBe("Priya Kapoor");
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    });
  },
);
