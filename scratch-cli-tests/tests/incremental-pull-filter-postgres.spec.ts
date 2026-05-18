import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { ScratchCli } from "../src/cli";
import {
  deleteWorkspace,
  TEST_CONNECTOR_SERVICE,
  uniqueName,
} from "../src/helpers";
import {
  setupIncrementalProductsTable,
  teardownProductsTable,
} from "../src/postgres";

const cli = new ScratchCli();
const postgresUrl = process.env.DATABASE_URL;
const preserveOnFailure = process.env.PRESERVE_WORKBOOK_ON_FAILURE === "true";

const describeIfPostgres = postgresUrl ? describe : describe.skip;

const serverUrl = process.env.SCRATCH_API_URL || "http://localhost:3010";
const apiKey = process.env.SCRATCH_API_KEY;

/**
 * Connector-side SQL WHERE filter declared on the folder. The Postgres
 * connector ANDs this with the incremental modified-since predicate, so the
 * effective incremental query is:
 *
 *   WHERE (price > 20) AND (updated_dt > since - 60s)
 *
 * Of the 5 seeded products only two match `price > 20` (Aluminum Water Bottle
 * 24.99, Wireless Charging Pad 39.95).
 */
const FOLDER_FILTER = "price > 20";

/**
 * Postgres incremental clock-skew margin (PG_INCREMENTAL_CLOCK_SKEW_MS = 60s):
 * predicate lower bound is `since - 60s`. For the second incremental pull to
 * fetch 0 rows, > 60s must elapse between the edit and the first incremental
 * pull's watermark capture. 70s gives margin for job latency / the strict `>`.
 */
const CLOCK_SKEW_WAIT_MS = 70_000;

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
    throw new Error(`API ${method} ${urlPath} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

interface PullPublicProgress {
  totalFiles: number;
  /** Effective per-folder mode after capability/bootstrap resolution. */
  mode?: "full" | "incremental";
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
}

interface JobEntity {
  state: string;
  failedReason?: string | null;
  publicProgress?: PullPublicProgress;
}

/** Poll a job until it reaches a terminal state (completed, failed, canceled). */
async function waitForJob(
  jobId: string,
  timeoutMs = 60_000,
): Promise<JobEntity> {
  const start = Date.now();
  const terminalStates = ["completed", "failed", "canceled"];
  while (Date.now() - start < timeoutMs) {
    const job = await scratchApi<JobEntity>("GET", `/jobs/${jobId}/progress`);
    if (terminalStates.includes(job.state)) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`);
}

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

/** Parse every downloaded record file into {name, price} objects. */
function readProducts(
  dir: string,
): Array<{ name: unknown; price: unknown }> {
  return findJsonFiles(dir).map(
    (f) => JSON.parse(fs.readFileSync(f, "utf-8")) as { name: unknown; price: unknown },
  );
}

describeIfPostgres(
  "Incremental pull + filter (Postgres) — incremental and the folder filter AND together",
  () => {
    let workspaceId: string;
    let connectionId: string;
    let linkedFolderId: string;
    let workspaceDir: string;
    let hasFailed = false;

    /** Trigger a pull via the API so we can read the job's record-fetch count. */
    async function triggerPull(
      mode: "full" | "incremental",
    ): Promise<PullPublicProgress> {
      const resp = await scratchApi<{ jobId?: string; jobIds?: string[] }>(
        "POST",
        `/workbook/${workspaceId}/pull-files`,
        { dataFolderIds: [linkedFolderId], mode },
      );
      const jobIds = resp.jobIds ?? (resp.jobId ? [resp.jobId] : []);
      expect(jobIds.length).toBeGreaterThan(0);

      const job = await waitForJob(jobIds[0]);
      expect(job.state).toBe("completed");
      expect(job.publicProgress).toBeDefined();
      return job.publicProgress!;
    }

    beforeAll(async () => {
      // 1. Seed integration_products from the SQL files (5 rows, backdated 2020).
      await setupIncrementalProductsTable();

      // 2. Workspace + connection + init + link, all via the CLI.
      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("incremental-filter-pg"),
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

      const parentDir = path.join(cli.home, "test-incremental-filter-pg");
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
      const productsTable = tables.find(
        (t) => t.displayName === "integration_products",
      )!;
      const tableIdParts = productsTable.id.split(",");
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
          productsTable.displayName,
        ],
        { cwd: workspaceDir },
      );
      linkedFolderId = linked.id;

      // 3. Declare the last-modified field AND the connector filter together.
      //    updateFolder merges: options carries modifiedAtField, the top-level
      //    `filter` is trimmed into options.filter.
      await scratchApi("PATCH", `/data-folder/${linkedFolderId}`, {
        options: { modifiedAtField: "updated_dt" },
        filter: FOLDER_FILTER,
      });

      // 4. Full pull. The filter applies to full pulls too, so only the two
      //    `price > 20` rows are pulled — and this bootstraps the watermark.
      const fullProgress = await triggerPull("full");
      expect(fullProgress.totalFiles).toBe(2);

      cli.run(["files", "download"], { cwd: workspaceDir });
      const initial = readProducts(workspaceDir);
      expect(initial.map((p) => p.name).sort()).toEqual([
        "Aluminum Water Bottle",
        "Wireless Charging Pad",
      ]);
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
      await teardownProductsTable();
    });

    it("incremental pulls only the row that matches the filter AND changed since the watermark", async () => {
      try {
        const client = new Client({ connectionString: postgresUrl });
        await client.connect();
        try {
          // (a) Matches the filter AND modified → MUST be fetched.
          const matched = await client.query(
            `UPDATE integration_products
               SET price = 44.95, updated_dt = NOW()
             WHERE name = 'Wireless Charging Pad'`,
          );
          expect(matched.rowCount).toBe(1);

          // (b) Modified but does NOT match the filter (price stays <= 20) →
          //     must be EXCLUDED by the ANDed predicate even though it changed.
          const unmatched = await client.query(
            `UPDATE integration_products
               SET price = 9.50, updated_dt = NOW()
             WHERE name = 'Recycled Notebook'`,
          );
          expect(unmatched.rowCount).toBe(1);

          // (c) "Aluminum Water Bottle" matches the filter but is left
          //     unmodified → must be EXCLUDED by the modified-since half.
        } finally {
          await client.end();
        }

        // Wait out the 60s clock-skew margin (see CLOCK_SKEW_WAIT_MS).
        await new Promise((r) => setTimeout(r, CLOCK_SKEW_WAIT_MS));

        // --- Incremental pull #1: exactly the matched+modified row ---
        const firstIncremental = await triggerPull("incremental");
        // mode must stay incremental — a demotion to full would re-pull both
        // filter-matching rows (totalFiles 2) and surface here, not as a
        // confusing count mismatch.
        expect(firstIncremental.mode).toBe("incremental");
        expect(firstIncremental.totalFiles).toBe(1);

        cli.run(["files", "download"], { cwd: workspaceDir });
        const afterInc = readProducts(workspaceDir);

        // The filtered-out notebook was never pulled (not at full, not now).
        expect(afterInc.map((p) => p.name).sort()).toEqual([
          "Aluminum Water Bottle",
          "Wireless Charging Pad",
        ]);
        // Only the charging pad's price advanced; the bottle is untouched.
        const pad = afterInc.find((p) => p.name === "Wireless Charging Pad")!;
        const bottle = afterInc.find((p) => p.name === "Aluminum Water Bottle")!;
        expect(Number(pad.price)).toBe(44.95);
        expect(Number(bottle.price)).toBe(24.99);

        // --- Incremental pull #2: watermark advanced, nothing to fetch ---
        const secondIncremental = await triggerPull("incremental");
        expect(secondIncremental.mode).toBe("incremental");
        expect(secondIncremental.totalFiles).toBe(0);
      } catch (err) {
        hasFailed = true;
        throw err;
      }
    }, 180_000);
  },
);
