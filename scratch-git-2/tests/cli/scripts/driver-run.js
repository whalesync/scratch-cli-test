#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");

const dotenv = require("dotenv");
const { Client } = require("pg");

dotenv.config({ path: path.resolve(__dirname, "../driver.env"), quiet: true });

const TABLE_NAME = "smoke_records";
const JOB_POLL_INTERVAL_MS = 1_000;
const JOB_POLL_TIMEOUT_MS = 5 * 60 * 1_000;
const JOB_POLL_NETWORK_RETRY_LIMIT = 10;

function parseArgs(argv) {
  const args = {
    help: false,
    pause: "nowhere",
    stop: "nowhere",
    noCleanup: false,
    recordCount: undefined,
    editCount: undefined,
    acceptCount: undefined,
    remoteDirtyRecord: undefined,
    failingEditRecord: undefined,
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
      args.pause =
        argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "everywhere";
      continue;
    }
    if (arg.startsWith("--pause=")) {
      args.pause = arg.slice("--pause=".length);
      continue;
    }
    if (arg === "--stop") {
      args.stop =
        argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "everywhere";
      continue;
    }
    if (arg.startsWith("--stop=")) {
      args.stop = arg.slice("--stop=".length);
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
    if (arg === "--edit-count") {
      args.editCount = argv[++i];
      continue;
    }
    if (arg === "--accept-count") {
      args.acceptCount = argv[++i];
      continue;
    }
    if (arg === "--change-remote-dirty") {
      args.remoteDirtyRecord = argv[++i];
      continue;
    }
    if (arg.startsWith("--change-remote-dirty=")) {
      args.remoteDirtyRecord = arg.slice("--change-remote-dirty=".length);
      continue;
    }
    if (arg === "--failing-edit-record") {
      args.failingEditRecord = argv[++i];
      continue;
    }
    if (arg.startsWith("--failing-edit-record=")) {
      args.failingEditRecord = arg.slice("--failing-edit-record=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/driver-run.js [options]

Creates a fresh workbook and a fresh Postgres database, pulls records locally,
edits them, accepts the changes, uploads them, triggers publish-from-git, and
waits for the publish job to complete.

Options:
  --pause=<mode>           Pause interactively at a breakpoint (waits for Enter then continues). Modes:
                             nowhere          Never pause (default)
                             everywhere       Pause after every step
                             database-created After DB is seeded, before workbook creation
                             workbook-created After workbook + connection are created, before workspace init
                             records-downloaded After pull + file download, before local edits
                             records-edited   After local JSON files are mutated, before local accept
                             remote-dirty-commit Before injecting a remote dirty commit
                             publish-plan-created After plan-publish runs, before files upload
                             upload-complete  After files upload runs and approved local files are checked, before publish-from-git
                             publish-queued   After publish-from-git, job IDs known, before job wait
                             remote-verified  After remote DB verification, before final local files download
                             local-download-complete After final local files download, before local-state verification
  --stop=<mode>            Exit cleanly at a breakpoint (same step names as --pause)
  --no-cleanup             Keep the local workspace, remote workbook, and test DB
  --count <n>              Number of sample records to create (default: 3)
  --record-count <n>       Backward-compatible alias for --count
  --edit-count <n>         Edit only the first N records (default: all). Must be <= --count.
  --accept-count <m>       Accept only the first M edited records (default: all edited). Must be <= --edit-count.
  --change-remote-dirty <n> Commit a remote dirty change to record N (simulates a concurrent external edit).
  --failing-edit-record <n> Make record N invalid locally by writing a bad timestamp (expected publish failure).
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
  console.log(`\n\n=== ${title} ===`);
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

// pause/stop: "nowhere" | "everywhere" | step-name (e.g. "database-created")
// step: one of the named breakpoints (see --help for the full list)
function stopIfNeeded(stop, step, label, details = []) {
  if (stop === "nowhere") return;
  if (stop !== "everywhere" && stop !== step) return;

  console.log(`\n[stop] ${label}`);
  for (const detail of details) {
    console.log(`  ${detail}`);
  }
  process.exit(0);
}

async function pauseIfNeeded(pause, step, label, details = []) {
  if (pause === "nowhere") {
    return;
  }
  if (pause !== "everywhere" && pause !== step) {
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

async function checkpointIfNeeded(stop, pause, step, label, details = []) {
  stopIfNeeded(stop, step, label, details);
  await pauseIfNeeded(pause, step, label, details);
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

function sortRecordFiles(files) {
  return [...files].sort((a, b) => {
    const numA = parseInt(path.basename(a).match(/\d+/)?.[0] ?? "0", 10);
    const numB = parseInt(path.basename(b).match(/\d+/)?.[0] ?? "0", 10);
    return numA !== numB ? numA - numB : a.localeCompare(b);
  });
}

function editLocalRecords(
  workspaceDir,
  runName,
  count = Infinity,
  failingRecordNumber = null,
) {
  const files = sortRecordFiles(listRecordFiles(workspaceDir));
  const touched = [];

  for (const file of files.slice(0, count)) {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record && typeof record === "object" && record.id != null) {
      record.name = `Edited Record ${record.id} (${runName})`;
      if (failingRecordNumber !== null && Number(record.id) === failingRecordNumber) {
        record.ts = "not-a-timestamp";
      }
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      touched.push(file);
    }
  }

  return touched;
}

function captureExpectedNames(files) {
  const expectedNames = new Map();

  for (const file of files) {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    expectedNames.set(file, record?.name);
  }

  return expectedNames;
}

function summarizeApprovedFilesAfterUpload(files, expectedNames) {
  const preserved = [];
  const reverted = [];
  const missing = [];

  for (const file of files) {
    const expectedName = expectedNames.get(file);
    if (!fs.existsSync(file)) {
      missing.push({ file, expectedName });
      continue;
    }

    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const currentName = record?.name;
    const row = { file, expectedName, currentName };

    if (currentName === expectedName) {
      preserved.push(row);
    } else {
      reverted.push(row);
    }
  }

  return { preserved, reverted, missing };
}

function getRecordIds(files) {
  return files.map((file) => {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number(record.id);
  });
}

function getConnectionDir(workspaceDir) {
  return path.join(workspaceDir, "POSTGRES - Smoke Postgres");
}

function listModifiedRecordPaths(workspaceDir) {
  const connectionDir = getConnectionDir(workspaceDir);
  const result = spawnSync("git", ["-C", connectionDir, "status", "--short"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(
      stderr
        ? `git status failed: ${stderr}`
        : "git status failed",
    );
  }

  return (result.stdout || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3));
}

function listReviewedDirtyPaths(workspaceDir) {
  const bareRepo = findBareRepo(workspaceDir);
  const result = spawnSync(
    "git",
    [
      "--git-dir",
      bareRepo,
      "diff",
      "--name-only",
      "main..dirty",
      "--",
      `public/${TABLE_NAME}`,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr ? `git diff failed: ${stderr}` : "git diff failed");
  }

  return (result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function findBareRepo(workspaceDir) {
  const reposDir = path.join(workspaceDir, ".repos");
  if (!fs.existsSync(reposDir)) {
    throw new Error(`No .repos directory found in ${workspaceDir}`);
  }
  const entries = fs.readdirSync(reposDir).filter((f) => f.endsWith(".git"));
  if (entries.length === 0) {
    throw new Error(`No .git repos found in ${reposDir}`);
  }
  return path.join(reposDir, entries[0]);
}

function changeRemoteDirty(workspaceDir, recordNumber, apiToken) {
  const bareRepo = findBareRepo(workspaceDir);
  const allFiles = sortRecordFiles(listRecordFiles(workspaceDir));
  const targetFile = allFiles[recordNumber - 1];
  if (!targetFile) {
    throw new Error(
      `--change-remote-dirty: record ${recordNumber} not found (only ${allFiles.length} records downloaded)`,
    );
  }

  const relPath = path.relative(workspaceDir, targetFile);
  // Strip the connection dir prefix — the bare repo stores files without it.
  const repoRelPath = relPath.split(path.sep).slice(1).join(path.sep);

  const remoteUrl = runCommand("git", [
    "--git-dir",
    bareRepo,
    "remote",
    "get-url",
    "origin",
  ]).stdout.trim();
  const tmpClone = fs.mkdtempSync(
    path.join(os.tmpdir(), "driver-remote-dirty-"),
  );

  try {
    // Clone the remote dirty branch directly — nothing local is touched.
    runCommand("git", [
      "-c",
      `http.extraHeader=Authorization: API-Token ${apiToken}`,
      "clone",
      "--branch",
      "dirty",
      "--single-branch",
      remoteUrl,
      tmpClone,
    ]);

    const cloneFile = path.join(tmpClone, repoRelPath);
    const record = JSON.parse(fs.readFileSync(cloneFile, "utf8"));
    record.name = `Remote Edit ${record.id} (external)`;
    fs.writeFileSync(cloneFile, `${JSON.stringify(record, null, 2)}\n`);

    runCommand("git", ["-C", tmpClone, "add", repoRelPath]);
    runCommand("git", [
      "-C",
      tmpClone,
      "-c",
      "user.name=External User",
      "-c",
      "user.email=external@driver.test",
      "commit",
      "-m",
      `External edit: record ${recordNumber}`,
    ]);

    runCommand("git", [
      "-C",
      tmpClone,
      "-c",
      `http.extraHeader=Authorization: API-Token ${apiToken}`,
      "push",
      "origin",
      "dirty",
    ]);

    console.log(
      `Remote dirty commit pushed to origin: record ${recordNumber} → "Remote Edit ${record.id} (external)"`,
    );
  } finally {
    fs.rmSync(tmpClone, { recursive: true, force: true });
  }
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

async function waitForJobs(serverUrl, apiToken, jobIds, options = {}) {
  const { allowFailure = false } = options;
  const start = Date.now();
  let lastSummary = "";
  let consecutiveNetworkFailures = 0;

  while (Date.now() - start < JOB_POLL_TIMEOUT_MS) {
    let response;
    try {
      response = await fetch(
        `${serverUrl.replace(/\/$/, "")}/jobs/bulk-status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `API-Token ${apiToken}`,
            "User-Agent": "Scratch-cli/1.0",
          },
          body: JSON.stringify({ jobIds }),
        },
      );
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
      if (allowFailure) {
        return hydrated;
      }
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

const VALID_BREAKPOINTS = new Set([
  "nowhere",
  "everywhere",
  "database-created",
  "workbook-created",
  "records-downloaded",
  "records-edited",
  "remote-dirty-commit",
  "publish-plan-created",
  "upload-complete",
  "publish-queued",
  "remote-verified",
  "local-download-complete",
]);

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (cliArgs.help) {
    printHelp();
    return;
  }

  if (!VALID_BREAKPOINTS.has(cliArgs.pause)) {
    throw new Error(
      `Invalid --pause value: "${cliArgs.pause}". Valid values: ${[...VALID_BREAKPOINTS].join(", ")}`,
    );
  }

  if (!VALID_BREAKPOINTS.has(cliArgs.stop)) {
    throw new Error(
      `Invalid --stop value: "${cliArgs.stop}". Valid values: ${[...VALID_BREAKPOINTS].join(", ")}`,
    );
  }

  const serverUrl =
    cliArgs.serverUrl || process.env.SCRATCH_API_URL || "http://localhost:3010";
  const databasePrefix =
    cliArgs.databaseUrl ||
    process.env.DATABASE_URL ||
    process.env.DATABASE_URL_PREFIX;
  const schema = process.env.DB_SCHEMA || "public";
  const recordCount = Number(
    cliArgs.recordCount || process.env.DRIVER_RECORD_COUNT || "3",
  );
  const editCount =
    cliArgs.editCount != null ? Number(cliArgs.editCount) : recordCount;
  const acceptCount =
    cliArgs.acceptCount != null ? Number(cliArgs.acceptCount) : editCount;
  const remoteDirtyRecord =
    cliArgs.remoteDirtyRecord != null
      ? Number(cliArgs.remoteDirtyRecord)
      : null;
  const failingEditRecord =
    cliArgs.failingEditRecord != null
      ? Number(cliArgs.failingEditRecord)
      : null;
  const binary = resolveBinary(
    cliArgs.binary || process.env.SCRATCH_CLI_BINARY,
  );
  const workspaceRoot =
    cliArgs.workspaceRoot ||
    process.env.DRIVER_WORKSPACE_ROOT ||
    path.join(os.tmpdir(), "scratchmd-cli-driver");

  if (!databasePrefix) {
    throw new Error(
      "DATABASE_URL (or DATABASE_URL_PREFIX) must point at the Postgres server root, for example postgresql://postgres:postgres@localhost:5432/",
    );
  }
  if (!Number.isFinite(recordCount) || recordCount <= 0) {
    throw new Error(`Invalid record count: ${recordCount}`);
  }
  if (!Number.isFinite(editCount) || editCount < 0) {
    throw new Error(`Invalid --edit-count: ${editCount}`);
  }
  if (!Number.isFinite(acceptCount) || acceptCount < 0) {
    throw new Error(`Invalid --accept-count: ${acceptCount}`);
  }
  if (editCount > recordCount) {
    throw new Error(
      `--edit-count (${editCount}) cannot exceed --count (${recordCount})`,
    );
  }
  if (acceptCount > editCount) {
    throw new Error(
      `--accept-count (${acceptCount}) cannot exceed --edit-count (${editCount})`,
    );
  }
  if (
    remoteDirtyRecord !== null &&
    (!Number.isFinite(remoteDirtyRecord) ||
      remoteDirtyRecord < 1 ||
      remoteDirtyRecord > recordCount)
  ) {
    throw new Error(
      `--change-remote-dirty must be a record number between 1 and ${recordCount}`,
    );
  }
  if (
    failingEditRecord !== null &&
    (!Number.isFinite(failingEditRecord) ||
      failingEditRecord < 1 ||
      failingEditRecord > editCount)
  ) {
    throw new Error(
      `--failing-edit-record must be an edited record number between 1 and ${editCount}`,
    );
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

  printSection("Driver configuration");
  console.log(`CLI binary:     ${binary}`);
  console.log(`Server URL:     ${serverUrl}`);
  console.log(`Workbook name:  ${workbookName}`);
  console.log(`Database name:  ${dbName}`);
  console.log(`Database URL:   ${databaseUrl}`);
  console.log(`Record count:   ${recordCount}`);
  console.log(`Edit count:     ${editCount}`);
  console.log(`Accept count:   ${acceptCount}`);
  if (remoteDirtyRecord !== null)
    console.log(`Remote dirty:   record ${remoteDirtyRecord}`);
  if (failingEditRecord !== null)
    console.log(`Failing edit:   record ${failingEditRecord}`);
  console.log(`Workspace root: ${workspaceRoot}`);
  console.log(`Cleanup:        ${cliArgs.noCleanup ? "disabled" : "enabled"}`);

  try {
    runCommand(binary, ["--version"]);

    printSection("Server health check");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "__server-health",
      "Server health check",
      [`Server URL: ${serverUrl}`],
    );
    await ensureServerHealthy(serverUrl);
    console.log(`Server is healthy at ${serverUrl}.`);

    printSection("Create test database");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "__create-test-database",
      "Create test database",
      [`Database: ${dbName}`, `Rows planned: ${recordCount}`],
    );
    await createDatabase(adminDbUrl, dbName);
    await seedDatabase(databaseUrl, recordCount);
    const seededRows = await readRows(databaseUrl);
    console.log(`Seeded ${seededRows.length} rows into ${TABLE_NAME}.`);

    printSection("Create workbook");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "database-created",
      "Create workbook",
      [`Database: ${dbName}`, `Rows: ${seededRows.length}`],
    );
    const createdWorkbook = sanitizeJsonOutput(
      runCli(binary, serverUrl, ["workspaces", "create", workbookName]).stdout,
    );
    state.workbookId = createdWorkbook.id;
    console.log(`Workbook ID: ${state.workbookId}`);

    printSection("Add Postgres connection");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "__add-postgres-connection",
      "Add Postgres connection",
      [`Workbook ID: ${state.workbookId}`],
    );
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

    printSection("Init local workspace");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "workbook-created",
      "Init local workspace",
      [`Workbook ID: ${state.workbookId}`, `Connection ID: ${connection.id}`],
    );
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
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "__link-test-table",
      "Link test table",
      [`Workspace: ${state.workspaceDir}`],
    );
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
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "__pull-and-download-records",
      "Pull and download records",
      [`Workspace: ${state.workspaceDir}`],
    );
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

    printSection("Edit local records");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "records-downloaded",
      "Edit local records",
      [`Workspace: ${state.workspaceDir}`, `Files downloaded: ${downloadedFiles.length}`],
    );
    const editedFiles = editLocalRecords(
      state.workspaceDir,
      runName,
      editCount,
      failingEditRecord,
    );
    console.log(
      `Edited ${editedFiles.length} of ${downloadedFiles.length} record files.`,
    );

    printSection("Accept local changes");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "records-edited",
      "Accept local changes",
      [`Edited files: ${editedFiles.length}`],
    );
    let acceptedFiles;
    if (acceptCount === editedFiles.length) {
      acceptedFiles = [...editedFiles];
      runCli(binary, serverUrl, ["files", "accept-all"], {
        cwd: state.workspaceDir,
        noJson: true,
      });
    } else {
      const filesToAccept = editedFiles.slice(0, acceptCount);
      acceptedFiles = [...filesToAccept];
      const relPaths = filesToAccept.map((file) =>
        path.relative(state.workspaceDir, file),
      );
      runCli(binary, serverUrl, ["files", "accept", ...relPaths], {
        cwd: state.workspaceDir,
        noJson: true,
      });
      console.log(
        `Accepted ${filesToAccept.length} of ${editedFiles.length} edited files (${editedFiles.length - filesToAccept.length} left unreviewed).`,
      );
    }

    if (remoteDirtyRecord !== null) {
      printSection("Inject remote dirty commit");
      await checkpointIfNeeded(
        cliArgs.stop,
        cliArgs.pause,
        "remote-dirty-commit",
        "Inject remote dirty commit",
        [`Record: ${remoteDirtyRecord}`],
      );
      changeRemoteDirty(state.workspaceDir, remoteDirtyRecord, apiToken);
    }

    printSection("Create publish plan");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "__create-publish-plan",
      "Create publish plan",
      [`Workspace: ${state.workspaceDir}`],
    );
    runCli(binary, serverUrl, ["plan-publish"], {
      cwd: state.workspaceDir,
      noJson: true,
    });

    printSection("Upload reviewed changes");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "publish-plan-created",
      "Upload reviewed changes",
      [`Workspace: ${state.workspaceDir}`],
    );
    const expectedAcceptedNames = captureExpectedNames(acceptedFiles);
    runCli(binary, serverUrl, ["files", "upload"], {
      cwd: state.workspaceDir,
      noJson: true,
    });

    printSection("Check approved local files after upload");
    const uploadCheck = summarizeApprovedFilesAfterUpload(
      acceptedFiles,
      expectedAcceptedNames,
    );
    console.log(
      `Approved files checked: ${acceptedFiles.length} (${uploadCheck.preserved.length} preserved, ${uploadCheck.reverted.length} reverted, ${uploadCheck.missing.length} missing).`,
    );
    for (const row of uploadCheck.reverted.slice(0, 5)) {
      console.log(
        `  reverted: ${path.relative(state.workspaceDir, row.file)} | expected="${row.expectedName}" | current="${row.currentName}"`,
      );
    }
    for (const row of uploadCheck.missing.slice(0, 5)) {
      console.log(
        `  missing:  ${path.relative(state.workspaceDir, row.file)} | expected="${row.expectedName}"`,
      );
    }

    printSection("Trigger publish-from-git");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "upload-complete",
      "Trigger publish-from-git",
      [
        `Approved files: ${acceptedFiles.length}`,
        `Preserved: ${uploadCheck.preserved.length}`,
        `Reverted: ${uploadCheck.reverted.length}`,
        `Missing: ${uploadCheck.missing.length}`,
      ],
    );
    const publishResult = runCli(binary, serverUrl, ["publish-from-git"], {
      cwd: state.workspaceDir,
      noJson: true,
    });
    const jobIds = extractJobIds(publishResult.stdout);
    if (jobIds.length === 0) {
      throw new Error("publish-from-git did not return any job IDs");
    }
    console.log(`Queued job IDs: ${jobIds.join(", ")}`);

    printSection("Wait for publish job completion");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "publish-queued",
      "Wait for publish job completion",
      [`Job IDs: ${jobIds.join(", ")}`],
    );
    const jobStatuses = await waitForJobs(serverUrl, apiToken, jobIds, {
      allowFailure: failingEditRecord !== null,
    });
    const failedJobs = jobStatuses.filter((job) =>
      ["failed", "canceled", "unknown"].includes(job.state),
    );
    if (failedJobs.length > 0) {
      console.log(
        `Publish reached terminal failure state for ${failedJobs.length} job(s): ${failedJobs
          .map((job) => `${job.bullJobId}:${job.state}`)
          .join(", ")}`,
      );
    } else {
      console.log("All publish jobs completed.");
    }

    printSection("Verify remote database state");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "__verify-remote-database-state",
      "Verify remote database state",
      [`Database: ${dbName}`],
    );
    const finalRows = await readRows(databaseUrl);
    const acceptedFilesForPublish = editedFiles.slice(0, acceptCount);
    const acceptedIds = getRecordIds(acceptedFilesForPublish);
    const progressSummary =
      jobStatuses
        .map((job) => job.publicProgress)
        .find((progress) => progress && typeof progress === "object") || null;
    const successfulOperationCount =
      progressSummary && typeof progressSummary.successCount === "number"
        ? progressSummary.successCount
        : acceptedIds.length;
    const successfulIds = new Set(acceptedIds.slice(0, successfulOperationCount));
    const failedOrRemainingIds = new Set(acceptedIds.slice(successfulOperationCount));
    let mismatches = 0;
    for (const row of finalRows) {
      let expected;
      if (successfulIds.has(row.id)) {
        expected = `Edited Record ${row.id} (${runName})`;
      } else {
        expected = `Record ${row.id}`;
      }
      if (row.name !== expected) {
        console.warn(
          `  Row ${row.id}: expected "${expected}", got "${row.name}"`,
        );
        mismatches += 1;
      }
    }
    if (mismatches > 0) {
      throw new Error(
        `${mismatches} row(s) did not match expected state after publish.`,
      );
    }
    console.log(
      `Verified ${finalRows.length} rows in Postgres (${successfulIds.size} published, ${failedOrRemainingIds.size} still local, ${finalRows.length - successfulIds.size - failedOrRemainingIds.size} unchanged).`,
    );

    const unreviewedFiles = editedFiles.slice(acceptCount);
    const expectedUnreviewedNames = captureExpectedNames(unreviewedFiles);

    printSection("Download published changes");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "remote-verified",
      "Download published changes",
      [`Workspace: ${state.workspaceDir}`],
    );
    runCli(binary, serverUrl, ["files", "download"], {
      cwd: state.workspaceDir,
      noJson: true,
    });

    printSection("Verify local workspace state");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "local-download-complete",
      "Verify local workspace state",
      [`Workspace: ${state.workspaceDir}`],
    );

    const approvedAfterDownload = summarizeApprovedFilesAfterUpload(
      acceptedFiles,
      expectedAcceptedNames,
    );
    const unreviewedAfterDownload = summarizeApprovedFilesAfterUpload(
      unreviewedFiles,
      expectedUnreviewedNames,
    );
    const modifiedPaths = listModifiedRecordPaths(state.workspaceDir);
    const reviewedDirtyPaths = listReviewedDirtyPaths(state.workspaceDir);
    const remainingPublishedFiles = acceptedFilesForPublish.slice(successfulOperationCount);
    const expectedReviewedDirtyPaths = remainingPublishedFiles.map((file) =>
      path.relative(getConnectionDir(state.workspaceDir), file),
    );
    const expectedModifiedPaths = unreviewedFiles.map((file) =>
      path.relative(getConnectionDir(state.workspaceDir), file),
    );

    if (
      approvedAfterDownload.reverted.length > 0 ||
      approvedAfterDownload.missing.length > 0
    ) {
      throw new Error(
        `Approved files were not preserved after final download (${approvedAfterDownload.reverted.length} reverted, ${approvedAfterDownload.missing.length} missing).`,
      );
    }

    if (
      unreviewedAfterDownload.reverted.length > 0 ||
      unreviewedAfterDownload.missing.length > 0
    ) {
      throw new Error(
        `Unreviewed files were not preserved after final download (${unreviewedAfterDownload.reverted.length} reverted, ${unreviewedAfterDownload.missing.length} missing).`,
      );
    }

    const expectedReviewedDirtySet = new Set(expectedReviewedDirtyPaths);
    const matchesReviewedDirtySet =
      reviewedDirtyPaths.length === expectedReviewedDirtyPaths.length &&
      reviewedDirtyPaths.every((value) => expectedReviewedDirtySet.has(value));

    if (!matchesReviewedDirtySet) {
      throw new Error(
        `Unexpected reviewed dirty paths after final download. Expected: ${expectedReviewedDirtyPaths.join(", ") || "(none)"}; got: ${reviewedDirtyPaths.join(", ") || "(none)"}.`,
      );
    }

    const expectedModifiedSet = new Set(expectedModifiedPaths);
    const matchesModifiedSet =
      modifiedPaths.length === expectedModifiedPaths.length &&
      modifiedPaths.every((value) => expectedModifiedSet.has(value));

    if (!matchesModifiedSet) {
      throw new Error(
        `Unexpected modified paths after final download. Expected: ${expectedModifiedPaths.join(", ") || "(none)"}; got: ${modifiedPaths.join(", ") || "(none)"}.`,
      );
    }

    console.log(
      `Local workspace verified after final download: ${successfulIds.size} published baseline, ${remainingPublishedFiles.length} failed/remaining reviewed in dirty, ${unreviewedFiles.length} unreviewed preserved in working tree, ${modifiedPaths.length} working-tree modified path(s) remaining.`,
    );

    console.log("\nDriver completed successfully.");
    console.log(`Workbook ID: ${state.workbookId}`);
    console.log(`Workspace dir: ${state.workspaceDir}`);
    console.log(`Database name: ${dbName}`);

    if (cliArgs.noCleanup) {
      console.log("\nCleanup skipped because --no-cleanup was passed.");
    }
  } finally {
    if (!cliArgs.noCleanup) {
      printSection("Cleanup");
      await checkpointIfNeeded(
        cliArgs.stop,
        cliArgs.pause,
        "__cleanup",
        "Cleanup",
        [`Workspace: ${state.workspaceDir ?? "(none)"}`],
      );

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
  console.error(`\nDriver failed: ${error.message}`);
  process.exitCode = 1;
});
