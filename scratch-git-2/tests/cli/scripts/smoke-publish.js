#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");

const dotenv = require("dotenv");
const { Client } = require("pg");

dotenv.config({ path: path.resolve(__dirname, "../smoke.env"), quiet: true });

const TABLE_NAME = "smoke_records";
const JOB_POLL_INTERVAL_MS = 1_000;
const JOB_POLL_TIMEOUT_MS = 5 * 60 * 1_000;
const JOB_POLL_NETWORK_RETRY_LIMIT = 10;

function parseArgs(argv) {
  const args = {
    help: false,
    pause: false,
    noCleanup: false,
    recordCount: undefined,
    serverUrl: undefined,
    binary: undefined,
    databaseUrl: undefined,
    workspaceRoot: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--pause") {
      args.pause = true;
      continue;
    }
    if (arg === "--no-cleanup") {
      args.noCleanup = true;
      continue;
    }
    if (arg === "--record-count") {
      args.recordCount = argv[++i];
      continue;
    }
    if (arg === "--count") {
      args.recordCount = argv[++i];
      continue;
    }
    if (arg === "--server-url") {
      args.serverUrl = argv[++i];
      continue;
    }
    if (arg === "--binary") {
      args.binary = argv[++i];
      continue;
    }
    if (arg === "--database-url") {
      args.databaseUrl = argv[++i];
      continue;
    }
    if (arg === "--workspace-root") {
      args.workspaceRoot = argv[++i];
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/smoke-publish.js [options]

Creates a fresh workbook and a fresh Postgres database, pulls records locally,
edits them, accepts the changes, uploads them, triggers publish-from-git, and
waits for the publish job to complete.

Options:
  --pause                  Pause after each major step for manual inspection
  --no-cleanup             Keep the local workspace, remote workbook, and test DB
  --count <n>              Number of sample records to create (default: 3)
  --record-count <n>       Backward-compatible alias for --count
  --server-url <url>       Override SCRATCH_API_URL
  --binary <path-or-name>  Override SCRATCH_CLI_BINARY
  --database-url <url>     Override DATABASE_URL / DATABASE_URL_PREFIX
  --workspace-root <path>  Parent directory for local workspace init
  --help, -h               Show this help
`);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function makeRunName(now = new Date()) {
  return [
    "TEST",
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("-");
}

function sanitizeJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Expected JSON output but got empty stdout");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");
    const start =
      objectStart === -1
        ? arrayStart
        : arrayStart === -1
          ? objectStart
          : Math.min(objectStart, arrayStart);

    if (start === -1) {
      throw new Error(`No JSON found in output:\n${trimmed}`);
    }

    const opener = trimmed[start];
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;

    for (let i = start; i < trimmed.length; i += 1) {
      if (trimmed[i] === opener) depth += 1;
      if (trimmed[i] === closer) depth -= 1;
      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, i + 1));
      }
    }

    throw new Error(`Incomplete JSON in output:\n${trimmed}`);
  }
}

function quoteIdent(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function resolveWorkspaceDir(parentDir, initDirectory) {
  if (path.isAbsolute(initDirectory)) {
    return initDirectory;
  }
  return path.join(parentDir, initDirectory);
}

function buildDbUrl(baseUrl, dbName, schema) {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  if (schema) {
    url.searchParams.set("schema", schema);
  }
  return url.toString();
}

function buildAdminDbUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = "/postgres";
  url.search = "";
  return url.toString();
}

function readApiToken(serverUrl) {
  const credsPath = path.join(os.homedir(), ".scratchmd", "credentials.yaml");
  if (!fs.existsSync(credsPath)) {
    throw new Error(
      `No CLI credentials found at ${credsPath}. Run scratchmd-local auth login first.`,
    );
  }

  const hostname = new URL(serverUrl).hostname;
  const content = fs.readFileSync(credsPath, "utf8");
  const blockRegex = new RegExp(
    `^\\s{2}${escapeRegex(hostname)}:\\s*$([\\s\\S]*?)(?=^\\s{2}\\S|\\Z)`,
    "m",
  );
  const defaultRegex = /^  default:\s*$([\s\S]*?)(?=^  \S|\Z)/m;
  const blockMatch = content.match(blockRegex) || content.match(defaultRegex);
  if (!blockMatch) {
    throw new Error(
      `No CLI credentials entry found for ${hostname} in ${credsPath}. Run scratchmd-local auth login first.`,
    );
  }

  const tokenMatch = blockMatch[1].match(
    /^\s{4}apiToken:\s*"?([^"\n]+)"?\s*$/m,
  );
  if (!tokenMatch) {
    throw new Error(`apiToken missing for ${hostname} in ${credsPath}.`);
  }

  return tokenMatch[1].trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canExecuteBinary(candidate) {
  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return !result.error && result.status === 0;
}

function resolveBinary(binaryArg) {
  const repoBinary = path.resolve(__dirname, "../../../target/debug/scratchmd");
  const repoBinaryReady =
    fs.existsSync(repoBinary) && canExecuteBinary(repoBinary);

  if (binaryArg) {
    const looksLikePath =
      binaryArg.includes("/") ||
      binaryArg.startsWith(".") ||
      path.isAbsolute(binaryArg);

    if (looksLikePath && canExecuteBinary(binaryArg)) {
      return binaryArg;
    }

    // If the override is just a bare command name like "scratchmd-local",
    // prefer the repo build so an unrelated PATH entry can't shadow it.
    if (!looksLikePath && repoBinaryReady) {
      return repoBinary;
    }

    if (canExecuteBinary(binaryArg)) {
      return binaryArg;
    }
  }

  if (repoBinaryReady) {
    return repoBinary;
  }

  return "scratchmd-local";
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

function runCommand(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const full = [command, ...args].join(" ");
  console.log(`$ ${full}`);

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs || 10 * 60 * 1_000,
  });

  if (result.stdout && result.stdout.trim()) {
    process.stdout.write(result.stdout);
    if (!result.stdout.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
  if (result.stderr && result.stderr.trim()) {
    process.stderr.write(result.stderr);
    if (!result.stderr.endsWith("\n")) {
      process.stderr.write("\n");
    }
  }

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Command failed with exit ${result.status}: ${full}`);
  }

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function runCli(binary, serverUrl, args, options = {}) {
  const fullArgs = [...args, "--scratch-url", serverUrl];
  if (!options.noJson) {
    fullArgs.push("--json");
  }
  return runCommand(binary, fullArgs, options);
}

async function pauseIfNeeded(enabled, label, details = []) {
  if (!enabled) {
    return;
  }

  console.log(`\n[pause] ${label}`);
  for (const detail of details) {
    console.log(`  ${detail}`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await rl.question("Press Enter to continue...");
  } finally {
    rl.close();
  }
}

async function createDatabase(adminDbUrl, dbName) {
  const client = new Client({ connectionString: adminDbUrl });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}`);
    await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(adminDbUrl, dbName) {
  const client = new Client({ connectionString: adminDbUrl });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}`);
  } finally {
    await client.end();
  }
}

async function seedDatabase(databaseUrl, recordCount) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `DROP TABLE IF EXISTS ${quoteIdent(TABLE_NAME)} CASCADE`,
    );
    await client.query(`
      CREATE TABLE ${quoteIdent(TABLE_NAME)} (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (let index = 1; index <= recordCount; index += 1) {
      await client.query(
        `INSERT INTO ${quoteIdent(TABLE_NAME)} (id, name) VALUES ($1, $2)`,
        [index, `Record ${index}`],
      );
    }
  } finally {
    await client.end();
  }
}

async function readRows(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT id, name, ts FROM ${quoteIdent(TABLE_NAME)} ORDER BY id ASC`,
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

function listRecordFiles(workspaceDir) {
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  }

  walk(workspaceDir);
  return files;
}

function editLocalRecords(workspaceDir, runName) {
  const files = listRecordFiles(workspaceDir);
  const touched = [];

  for (const file of files) {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record && typeof record === "object" && record.id != null) {
      record.name = `Edited Record ${record.id} (${runName})`;
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      touched.push(file);
    }
  }

  return touched;
}

function findTable(tables) {
  const exact = tables.find(
    (table) => table.displayName === TABLE_NAME || table.name === TABLE_NAME,
  );
  if (exact) {
    return exact;
  }

  const suffix = tables.find(
    (table) =>
      typeof table.id === "string" &&
      (table.id.endsWith(`/${TABLE_NAME}`) ||
        table.id.endsWith(`:${TABLE_NAME}`)),
  );
  if (suffix) {
    return suffix;
  }

  throw new Error(
    `Could not find table ${TABLE_NAME}. Available: ${tables.map((table) => table.displayName || table.id).join(", ")}`,
  );
}

function tableIdArgs(tableId) {
  return String(tableId)
    .split(",")
    .filter((part) => part.length > 0)
    .flatMap((part) => ["--table-id", part]);
}

async function waitForJobs(serverUrl, apiToken, jobIds) {
  const start = Date.now();
  let lastSummary = "";
  let consecutiveNetworkFailures = 0;

  while (Date.now() - start < JOB_POLL_TIMEOUT_MS) {
    let response;
    try {
      response = await fetch(`${serverUrl.replace(/\/$/, "")}/jobs/bulk-status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `API-Token ${apiToken}`,
          "User-Agent": "Scratch-cli/1.0",
        },
        body: JSON.stringify({ jobIds }),
      });
      consecutiveNetworkFailures = 0;
    } catch (error) {
      consecutiveNetworkFailures += 1;
      const message =
        error instanceof Error
          ? `${error.message}${error.cause ? ` (cause: ${String(error.cause)})` : ""}`
          : String(error);
      console.warn(
        `[jobs] bulk-status poll failed (${consecutiveNetworkFailures}/${JOB_POLL_NETWORK_RETRY_LIMIT}): ${message}`,
      );

      if (consecutiveNetworkFailures >= JOB_POLL_NETWORK_RETRY_LIMIT) {
        throw new Error(`Job polling failed repeatedly: ${message}`);
      }

      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
      continue;
    }

    if (!response.ok) {
      throw new Error(`Job polling failed with HTTP ${response.status}`);
    }

    const statuses = await response.json();
    const byId = new Map(statuses.map((job) => [job.bullJobId, job]));
    const hydrated = jobIds.map(
      (jobId) => byId.get(jobId) || { bullJobId: jobId, state: "created" },
    );
    const summary = hydrated
      .map((job) => `${job.bullJobId}:${job.state}`)
      .join(", ");

    if (summary !== lastSummary) {
      console.log(`[jobs] ${summary}`);
      lastSummary = summary;
    }

    if (hydrated.every((job) => job.state === "completed")) {
      return hydrated;
    }

    if (
      hydrated.some((job) =>
        ["failed", "canceled", "unknown"].includes(job.state),
      )
    ) {
      throw new Error(`One or more jobs failed: ${summary}`);
    }

    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out waiting for publish job completion after ${JOB_POLL_TIMEOUT_MS / 1000}s`,
  );
}

async function ensureServerHealthy(serverUrl) {
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/health`);
  if (!response.ok) {
    throw new Error(
      `Scratch server health check failed with HTTP ${response.status} at ${serverUrl}/health`,
    );
  }
}

function extractJobIds(stdout) {
  const matches = Array.from(
    stdout.matchAll(/jobId:\s*([^) \n]+)/g),
    (match) => match[1],
  );
  return Array.from(new Set(matches));
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (cliArgs.help) {
    printHelp();
    return;
  }

  const serverUrl =
    cliArgs.serverUrl || process.env.SCRATCH_API_URL || "http://localhost:3010";
  const databasePrefix =
    cliArgs.databaseUrl ||
    process.env.DATABASE_URL ||
    process.env.DATABASE_URL_PREFIX;
  const schema = process.env.DB_SCHEMA || "public";
  const recordCount = Number(
    cliArgs.recordCount || process.env.SMOKE_RECORD_COUNT || "3",
  );
  const binary = resolveBinary(
    cliArgs.binary || process.env.SCRATCH_CLI_BINARY,
  );
  const workspaceRoot =
    cliArgs.workspaceRoot ||
    process.env.SMOKE_WORKSPACE_ROOT ||
    path.join(os.tmpdir(), "scratchmd-cli-smoke");

  if (!databasePrefix) {
    throw new Error(
      "DATABASE_URL (or DATABASE_URL_PREFIX) must point at the Postgres server root, for example postgresql://postgres:postgres@localhost:5432/",
    );
  }
  if (!Number.isFinite(recordCount) || recordCount <= 0) {
    throw new Error(`Invalid record count: ${recordCount}`);
  }

  const runName = makeRunName();
  const workbookName = runName;
  const dbName = runName;
  const adminDbUrl = buildAdminDbUrl(databasePrefix);
  const databaseUrl = buildDbUrl(databasePrefix, dbName, schema);
  const apiToken = readApiToken(serverUrl);

  const state = {
    workbookId: null,
    workspaceDir: null,
    workspaceParent: workspaceRoot,
    dbName,
    databaseUrl,
  };

  fs.mkdirSync(workspaceRoot, { recursive: true });

  printSection("Smoke test configuration");
  console.log(`CLI binary:     ${binary}`);
  console.log(`Server URL:     ${serverUrl}`);
  console.log(`Workbook name:  ${workbookName}`);
  console.log(`Database name:  ${dbName}`);
  console.log(`Database URL:   ${databaseUrl}`);
  console.log(`Record count:   ${recordCount}`);
  console.log(`Workspace root: ${workspaceRoot}`);
  console.log(`Cleanup:        ${cliArgs.noCleanup ? "disabled" : "enabled"}`);

  try {
    runCommand(binary, ["--version"]);

    printSection("Server health check");
    await ensureServerHealthy(serverUrl);
    console.log(`Server is healthy at ${serverUrl}.`);

    printSection("Create test database");
    await createDatabase(adminDbUrl, dbName);
    await seedDatabase(databaseUrl, recordCount);
    const seededRows = await readRows(databaseUrl);
    console.log(`Seeded ${seededRows.length} rows into ${TABLE_NAME}.`);

    await pauseIfNeeded(cliArgs.pause, "Database created", [
      `Database: ${dbName}`,
      `Rows: ${seededRows.length}`,
    ]);

    printSection("Create workbook");
    const createdWorkbook = sanitizeJsonOutput(
      runCli(binary, serverUrl, ["workspaces", "create", workbookName]).stdout,
    );
    state.workbookId = createdWorkbook.id;
    console.log(`Workbook ID: ${state.workbookId}`);

    printSection("Add Postgres connection");
    const connection = sanitizeJsonOutput(
      runCli(binary, serverUrl, [
        "connections",
        "--workspace",
        state.workbookId,
        "add",
        "--service",
        "POSTGRES",
        "--param",
        `connectionString=${databaseUrl}`,
        "--name",
        "Smoke Postgres",
      ]).stdout,
    );
    console.log(`Connection ID: ${connection.id}`);

    await pauseIfNeeded(cliArgs.pause, "Workbook and connection created", [
      `Workbook ID: ${state.workbookId}`,
      `Connection ID: ${connection.id}`,
    ]);

    printSection("Init local workspace");
    const initResult = sanitizeJsonOutput(
      runCli(binary, serverUrl, [
        "workspaces",
        "init",
        state.workbookId,
        "--output",
        workspaceRoot,
      ]).stdout,
    );
    state.workspaceDir = resolveWorkspaceDir(
      workspaceRoot,
      initResult.directory,
    );
    console.log(`Workspace dir: ${state.workspaceDir}`);

    printSection("Link test table");
    const tables = sanitizeJsonOutput(
      runCli(
        binary,
        serverUrl,
        ["linked", "--workspace", state.workbookId, "available", connection.id],
        { cwd: state.workspaceDir },
      ).stdout,
    );
    const table = findTable(tables);
    const linkedFolder = sanitizeJsonOutput(
      runCli(
        binary,
        serverUrl,
        [
          "linked",
          "--workspace",
          state.workbookId,
          "add",
          "--connection-id",
          connection.id,
          ...tableIdArgs(table.id),
          "--name",
          TABLE_NAME,
        ],
        { cwd: state.workspaceDir },
      ).stdout,
    );
    console.log(`Linked folder ID: ${linkedFolder.id}`);

    printSection("Pull and download records");
    runCli(
      binary,
      serverUrl,
      ["linked", "--workspace", state.workbookId, "pull", linkedFolder.id],
      { cwd: state.workspaceDir, noJson: true },
    );
    runCli(binary, serverUrl, ["files", "download"], {
      cwd: state.workspaceDir,
      noJson: true,
    });

    const downloadedFiles = listRecordFiles(state.workspaceDir);
    console.log(`Downloaded ${downloadedFiles.length} local record files.`);

    await pauseIfNeeded(cliArgs.pause, "Records downloaded locally", [
      `Workspace: ${state.workspaceDir}`,
      `Files: ${downloadedFiles.length}`,
    ]);

    printSection("Edit local records");
    const editedFiles = editLocalRecords(state.workspaceDir, runName);
    console.log(`Edited ${editedFiles.length} record files.`);

    await pauseIfNeeded(cliArgs.pause, "Local records edited", [
      `Edited files: ${editedFiles.length}`,
    ]);

    printSection("Accept local changes");
    runCli(binary, serverUrl, ["files", "accept-all"], {
      cwd: state.workspaceDir,
      noJson: true,
    });

    printSection("Create publish plan");
    runCli(binary, serverUrl, ["plan-publish"], {
      cwd: state.workspaceDir,
      noJson: true,
    });

    await pauseIfNeeded(cliArgs.pause, "Publish plan created", [
      `Workspace: ${state.workspaceDir}`,
    ]);

    printSection("Upload reviewed changes");
    runCli(binary, serverUrl, ["files", "upload"], {
      cwd: state.workspaceDir,
      noJson: true,
    });

    printSection("Trigger publish-from-git");
    const publishResult = runCli(binary, serverUrl, ["publish-from-git"], {
      cwd: state.workspaceDir,
      noJson: true,
    });
    const jobIds = extractJobIds(publishResult.stdout);
    if (jobIds.length === 0) {
      throw new Error("publish-from-git did not return any job IDs");
    }
    console.log(`Queued job IDs: ${jobIds.join(", ")}`);

    await pauseIfNeeded(cliArgs.pause, "Publish job queued", [
      `Job IDs: ${jobIds.join(", ")}`,
    ]);

    printSection("Wait for publish job completion");
    await waitForJobs(serverUrl, apiToken, jobIds);
    console.log("All publish jobs completed.");

    printSection("Verify remote database state");
    const finalRows = await readRows(databaseUrl);
    for (const row of finalRows) {
      const expected = `Edited Record ${row.id} (${runName})`;
      if (row.name !== expected) {
        throw new Error(
          `Row ${row.id} mismatch. Expected "${expected}" but found "${row.name}"`,
        );
      }
    }
    console.log(`Verified ${finalRows.length} published rows in Postgres.`);

    console.log("\nSmoke test completed successfully.");
    console.log(`Workbook ID: ${state.workbookId}`);
    console.log(`Workspace dir: ${state.workspaceDir}`);
    console.log(`Database name: ${dbName}`);

    if (cliArgs.noCleanup) {
      console.log("\nCleanup skipped because --no-cleanup was passed.");
    }
  } finally {
    if (!cliArgs.noCleanup) {
      printSection("Cleanup");

      if (state.workspaceDir && state.workbookId) {
        try {
          runCli(
            binary,
            serverUrl,
            ["workspaces", "unsync", state.workbookId, "--yes"],
            {
              noJson: true,
            },
          );
        } catch (error) {
          console.warn(
            `[cleanup] Failed to unsync workspace: ${error.message}`,
          );
        }
      }

      if (state.workbookId) {
        try {
          runCli(
            binary,
            serverUrl,
            ["workspaces", "delete", state.workbookId],
            {
              noJson: true,
            },
          );
        } catch (error) {
          console.warn(
            `[cleanup] Failed to delete workspace: ${error.message}`,
          );
        }
      }

      try {
        await dropDatabase(adminDbUrl, dbName);
      } catch (error) {
        console.warn(
          `[cleanup] Failed to drop database ${dbName}: ${error.message}`,
        );
      }
    }
  }
}

main().catch((error) => {
  console.error(`\nSmoke test failed: ${error.message}`);
  process.exitCode = 1;
});
