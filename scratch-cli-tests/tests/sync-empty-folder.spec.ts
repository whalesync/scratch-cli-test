import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { ScratchCli } from "../src/cli";
import {
  deleteWorkspace,
  TEST_CONNECTOR_SERVICE,
  uniqueName,
} from "../src/helpers";

// Regression coverage for DEV-10496 / the scratch-git `files-paginated` fix.
//
// Git does not track empty directories, so a data folder that has been pulled
// but holds zero records has its schema written under `.scratch/<folder>/schema.json`
// yet NO tree object for the folder path itself. A path-scoped read of that folder
// used to return HTTP 404 from scratch-git's read endpoints (`files_paginated`,
// `list`, `files_from_folder`); the fix makes them return an empty result instead.
//
// The only CLI command that drives the server into those endpoints against a
// single folder is a server-side sync (`syncs run` -> SyncService reads the
// source and destination folders via files-paginated). The SOURCE read is NOT
// wrapped in the app-level 404 workaround that guards the destination read, so a
// sync whose source folder is empty fails outright on the pre-fix 404 and only
// succeeds once scratch-git returns an empty page. That makes this test a true
// end-to-end check of the fix rather than a check of the app-level workaround.

const cli = new ScratchCli();
const postgresUrl = process.env.DATABASE_URL;

const describeIfPostgres = postgresUrl ? describe : describe.skip;

// Both tables are created with ZERO rows so that, after `linked pull`, each data
// folder is empty in git (schema lives under .scratch/, no record files).
const SOURCE_TABLE = "integration_empty_source";
const DEST_TABLE = "integration_empty_dest";

async function withPgClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function setupEmptyTables(): Promise<void> {
  await withPgClient(async (client) => {
    for (const table of [SOURCE_TABLE, DEST_TABLE]) {
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
      // A primary key is required for the Postgres connector to derive an id
      // column. No rows are inserted — the folder is intentionally empty.
      await client.query(
        `CREATE TABLE ${table} (id SERIAL PRIMARY KEY, name TEXT)`,
      );
    }
  });
}

async function teardownEmptyTables(): Promise<void> {
  await withPgClient(async (client) => {
    for (const table of [SOURCE_TABLE, DEST_TABLE]) {
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
  });
}

/** Link a table and pull it (0 rows => folder exists with a schema but no record files). */
function linkAndPullEmptyTable(
  workspaceId: string,
  workspaceDir: string,
  connectionId: string,
  tableDisplayName: string,
): string {
  const tables = cli.json<Array<{ id: string; displayName: string }>>([
    "linked",
    "--workspace",
    workspaceId,
    "available",
    connectionId,
  ]);
  const table = tables.find((t) => t.displayName === tableDisplayName);
  if (!table) {
    throw new Error(
      `Table "${tableDisplayName}" not found among available tables: ${tables
        .map((t) => t.displayName)
        .join(", ")}`,
    );
  }

  // Table ID from `available` is comma-joined (e.g. "public,integration_empty_source").
  const tableIdParts = table.id.split(",");
  const linked = cli.json<{ id: string }>(
    [
      "linked",
      "--workspace",
      workspaceId,
      "add",
      "--connection-id",
      connectionId,
      ...tableIdParts.flatMap((part) => ["--table-id", part]),
      "--name",
      table.displayName,
    ],
    { cwd: workspaceDir },
  );

  // Pull writes the schema to .scratch/ but commits no record files for a 0-row table.
  cli.run(["linked", "--workspace", workspaceId, "pull", linked.id], {
    cwd: workspaceDir,
  });

  return linked.id;
}

describeIfPostgres(
  "Sync from an empty folder (files-paginated 404 regression)",
  () => {
    let workspaceId: string;
    let connectionId: string;
    let workspaceDir: string;
    let sourceFolderId: string;
    let destFolderId: string;

    beforeAll(async () => {
      await setupEmptyTables();

      // 1. Create workspace
      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("empty-folder-sync"),
      ]);
      workspaceId = ws.id;

      // 2. Add database connection
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

      // 3. Init (clone) the workspace locally
      const parentDir = path.join(cli.home, "test-workspace-empty-folder");
      fs.mkdirSync(parentDir, { recursive: true });
      const initResult = cli.json<{ directory: string }>(
        ["workspaces", "init", workspaceId],
        { cwd: parentDir },
      );
      workspaceDir = path.join(parentDir, initResult.directory);

      // 4. Link + pull both empty tables (each leaves an empty-in-git data folder)
      sourceFolderId = linkAndPullEmptyTable(
        workspaceId,
        workspaceDir,
        connectionId,
        SOURCE_TABLE,
      );
      destFolderId = linkAndPullEmptyTable(
        workspaceId,
        workspaceDir,
        connectionId,
        DEST_TABLE,
      );
    });

    afterAll(async () => {
      if (workspaceId) deleteWorkspace(cli, workspaceId);
      if (workspaceDir) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownEmptyTables();
    });

    it("runs a sync whose source folder is empty without erroring on a 404", () => {
      // Minimal v1 sync: source -> destination with a single column mapping.
      // validateMappings is false so `create` doesn't need the column ids to
      // resolve against the schema; and because the source folder has zero
      // records the mapping is never actually applied at run time. The point of
      // the test is purely that reading the empty source folder no longer 404s.
      const config = {
        displayName: uniqueName("empty-source-sync"),
        validateMappings: false,
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: sourceFolderId,
              destinationDataFolderId: destFolderId,
              columnMappings: [
                { sourceColumnId: "name", destinationColumnId: "name" },
              ],
            },
          ],
        },
      };

      const created = cli.json<{ id: string }>(
        [
          "syncs",
          "--workspace",
          workspaceId,
          "create",
          "--config",
          JSON.stringify(config),
        ],
        { cwd: workspaceDir },
      );
      expect(created.id).toBeTruthy();

      // Before the fix this throws: the sync job's Pass-1 source read hits
      // scratch-git's files-paginated for the empty source folder, which returned
      // 404 (no git tree) and failed the whole job — so `syncs run` exits non-zero
      // and `cli.json` throws. After the fix the read returns an empty page, so the
      // sync completes with zero source records (nothing to create).
      const result = cli.json<{ success: boolean }>(
        ["syncs", "--workspace", workspaceId, "run", created.id],
        { cwd: workspaceDir },
      );
      expect(result.success).toBe(true);
    });
  },
);
