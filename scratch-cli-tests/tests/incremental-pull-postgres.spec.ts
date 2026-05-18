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
 * The Postgres connector subtracts a 60s clock-skew margin from the watermark
 * (`PG_INCREMENTAL_CLOCK_SKEW_MS`): its predicate is `WHERE updated_dt >
 * (since - 60s)`. A row edited at `t_edit` is therefore re-fetched by any
 * incremental pull whose watermark `W` satisfies `t_edit > W - 60s`. For the
 * SECOND incremental pull to fetch 0 rows, its `since` (= the FIRST incremental
 * pull's watermark) must be at least 60s after `t_edit`. So we wait > 60s
 * between editing the row and the first incremental pull. 70s gives margin for
 * job-scheduling latency and the strict `>` boundary.
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

describeIfPostgres(
  "Incremental pull (Postgres) — full bootstrap, then incremental fetches only changed rows",
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
      const jobIds =
        resp.jobIds ?? (resp.jobId ? [resp.jobId] : []);
      expect(jobIds.length).toBeGreaterThan(0);

      const job = await waitForJob(jobIds[0]);
      expect(job.state).toBe("completed");
      expect(job.publicProgress).toBeDefined();
      return job.publicProgress!;
    }

    beforeAll(async () => {
      // 1. Seed integration_products from the SQL files (rows backdated to 2020).
      await setupIncrementalProductsTable();

      // 2. Create a workspace, connect Postgres, init locally, link the table —
      //    all via the CLI (mirrors pull-refresh.spec.ts).
      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("incremental-pg"),
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

      const parentDir = path.join(cli.home, "test-incremental-pg");
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

      // 3. Declare `updated_dt` as the last-modified field. Postgres has no
      //    last-modified convention, so the connector reports
      //    supportsIncrementalPull() = false until this is set (no CLI command
      //    for advanced settings — set it via the data-folder API).
      await scratchApi("PATCH", `/data-folder/${linkedFolderId}`, {
        options: { modifiedAtField: "updated_dt" },
      });

      // 4. Full pull. This both proves the baseline and bootstraps the
      //    incremental watermark (a full scan advances lastIncrementalPullAt),
      //    so the first incremental pull is not demoted as a bootstrap run.
      const fullProgress = await triggerPull("full");
      expect(fullProgress.totalFiles).toBe(5);

      // Materialize the files locally via the CLI and confirm all 5 landed.
      cli.run(["files", "download"], { cwd: workspaceDir });
      expect(findJsonFiles(workspaceDir)).toHaveLength(5);
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

    it("fetches 0 with no changes, then only the edited row, then 0 once the watermark advances", async () => {
      try {
        // --- Baseline incremental pull: nothing changed since the full pull ---
        // The full pull (beforeAll) bootstrapped the watermark to ~now and
        // every seeded row is backdated to 2020, so an incremental pull here
        // must fetch nothing. This also surfaces a full-scan demotion early
        // (see the mode assertion below) and advances the watermark, which the
        // edit/re-pull steps below build on.
        const baselineIncremental = await triggerPull("incremental");
        // If incremental support is gated off (the INCREMENTAL_POLLING_ENABLED
        // feature flag must be enabled for the test user, and modifiedAtField
        // must resolve), the job silently demotes to a full scan. Fail loudly
        // with the cause rather than as a confusing count mismatch.
        expect(baselineIncremental.mode).toBe("incremental");
        expect(baselineIncremental.totalFiles).toBe(0);

        // --- Edit exactly one row, bumping its updated_dt to now ---
        const client = new Client({ connectionString: postgresUrl });
        await client.connect();
        try {
          const res = await client.query(
            `UPDATE integration_products
               SET price = 99.99, updated_dt = NOW()
             WHERE name = 'Aluminum Water Bottle'`,
          );
          expect(res.rowCount).toBe(1);
        } finally {
          await client.end();
        }

        // --- Wait out the connector's 60s clock-skew margin ---
        // (see CLOCK_SKEW_WAIT_MS). Without this the second incremental pull
        // would re-fetch the just-edited row.
        await new Promise((r) => setTimeout(r, CLOCK_SKEW_WAIT_MS));

        // --- Incremental pull #1: only the edited row should come back ---
        const firstIncremental = await triggerPull("incremental");
        expect(firstIncremental.mode).toBe("incremental");
        expect(firstIncremental.totalFiles).toBe(1);

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
