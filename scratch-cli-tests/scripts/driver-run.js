#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");

const dotenv = require("dotenv");
const { Client } = require("pg");

dotenv.config({ path: path.resolve(__dirname, "../driver.env"), quiet: true });

const POSTS_TABLE_NAME = "posts";
const AUTHORS_TABLE_NAME = "authors";
const JOB_POLL_INTERVAL_MS = 1_000;
const JOB_POLL_TIMEOUT_MS = 5 * 60 * 1_000;
const JOB_POLL_NETWORK_RETRY_LIMIT = 10;

function parseArgs(argv) {
  const args = {
    help: false,
    pause: "nowhere",
    stop: "nowhere",
    noCleanup: false,
    addFk: undefined,
    recordCount: undefined,
    editCount: undefined,
    acceptCount: undefined,
    createCount: undefined,
    deleteCount: undefined,
    setAuthorRecord: undefined,
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
    if (arg === "--create-count") {
      args.createCount = argv[++i];
      continue;
    }
    if (arg === "--delete-count") {
      args.deleteCount = argv[++i];
      continue;
    }
    if (arg === "--set-author-record") {
      args.setAuthorRecord = argv[++i];
      continue;
    }
    if (arg.startsWith("--set-author-record=")) {
      args.setAuthorRecord = arg.slice("--set-author-record=".length);
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
    if (arg === "--add-fk") {
      args.addFk = argv[++i];
      continue;
    }
    if (arg.startsWith("--add-fk=")) {
      args.addFk = arg.slice("--add-fk=".length);
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
                             records-deleted  After local JSON files are deleted, before local accept
                             records-created  After new local JSON files are created, before local accept
                             remote-dirty-commit Before injecting a remote dirty commit
                             publish-plan-created After plan-publish runs, before files upload
                             upload-complete  After files upload runs and approved local files are checked, before publish-from-git
                             publish-queued   After publish-from-git, job IDs known, before job wait
                             remote-verified  After remote DB verification, before local-state verification
                             local-download-complete After the post-publish local files download, before remote DB verification
  --stop=<mode>            Exit cleanly at a breakpoint (same step names as --pause)
  --no-cleanup             Keep the local workspace, remote workbook, and test DB
  --count <n>              Number of sample records to create (default: 3)
  --record-count <n>       Backward-compatible alias for --count
  --edit-count <n>         Edit only the first N records (default: all). Must be <= --count.
  --accept-count <m>       Accept only the first M edited records (default: all edited). Must be <= --edit-count.
  --create-count <n>       Include N new local records in the same publish cycle as the edited records.
  --delete-count <n>       Delete N existing local records in the same publish cycle before upload.
  --set-author-record <n>  Set post N to reference the seeded author (authorId=1) during local edits.
  --change-remote-dirty <n> Commit a remote dirty change to record N (simulates a concurrent external edit).
  --failing-edit-record <n> Make record N invalid locally by writing a bad timestamp (expected publish failure).
  --add-fk <postN>-<authorM>
                           Set post N's authorId to a pseudo-reference (@/path) pointing at an author file,
                           testing the backfill path in the publish plan. authorM values:
                             1  Point at the seeded existing author (id 1 in the DB).
                             0  Create a new local author file and point at it (tests create + backfill).
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
    `^\\s{2}${escapeRegex(hostname)}:\\s*$([\\s\\S]*)`,
    "m",
  );
  const defaultRegex = /^  default:\s*$([\s\S]*)/m;
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
  const repoBinary = path.resolve(
    __dirname,
    "../../scratch-git-2/target/debug/scratchmd",
  );
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

async function seedDatabase(databaseUrl, recordCount, setAuthorRecord = null) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `DROP TABLE IF EXISTS ${quoteIdent(POSTS_TABLE_NAME)} CASCADE`,
    );
    await client.query(
      `DROP TABLE IF EXISTS ${quoteIdent(AUTHORS_TABLE_NAME)} CASCADE`,
    );
    await client.query(`
      CREATE TABLE ${quoteIdent(AUTHORS_TABLE_NAME)} (
        id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL,
        "lastUpdated" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION set_authors_last_updated()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW."lastUpdated" = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER set_authors_last_updated
      BEFORE UPDATE ON ${quoteIdent(AUTHORS_TABLE_NAME)}
      FOR EACH ROW
      EXECUTE FUNCTION set_authors_last_updated()
    `);
    await client.query(
      `INSERT INTO ${quoteIdent(AUTHORS_TABLE_NAME)} (name) VALUES ($1)`,
      ["Author 1"],
    );

    await client.query(`
      CREATE TABLE ${quoteIdent(POSTS_TABLE_NAME)} (
        id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "authorId" INTEGER REFERENCES ${quoteIdent(AUTHORS_TABLE_NAME)} (id),
        "lastUpdated" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION set_posts_last_updated()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW."lastUpdated" = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER set_posts_last_updated
      BEFORE UPDATE ON ${quoteIdent(POSTS_TABLE_NAME)}
      FOR EACH ROW
      EXECUTE FUNCTION set_posts_last_updated()
    `);

    for (let index = 1; index <= recordCount; index += 1) {
      await client.query(
        `INSERT INTO ${quoteIdent(POSTS_TABLE_NAME)} (name, "authorId") VALUES ($1, $2)`,
        [
          `Post ${index}`,
          setAuthorRecord !== null && index === setAuthorRecord ? 1 : null,
        ],
      );
    }
  } finally {
    await client.end();
  }
}

async function readPostRows(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT id, name, ts, "authorId", "lastUpdated" FROM ${quoteIdent(POSTS_TABLE_NAME)} ORDER BY id ASC`,
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function readAuthorRows(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT id, name, "lastUpdated" FROM ${quoteIdent(AUTHORS_TABLE_NAME)} ORDER BY id ASC`,
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeTimestamp(value) {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return String(value);
}

function normalizeNullableId(value) {
  if (value == null || value === "") {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : value;
}

function listJsonFiles(dir) {
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

  walk(dir);
  return files;
}

function getTableDir(workspaceDir, tableName) {
  return path.join(getConnectionDir(workspaceDir), "public", tableName);
}

function listRecordFiles(workspaceDir) {
  const postsDir = getTableDir(workspaceDir, POSTS_TABLE_NAME);
  if (!fs.existsSync(postsDir)) {
    throw new Error(`Posts directory not found: ${postsDir}`);
  }
  return listJsonFiles(postsDir);
}

function listAuthorFiles(workspaceDir) {
  const authorsDir = getTableDir(workspaceDir, AUTHORS_TABLE_NAME);
  if (!fs.existsSync(authorsDir)) {
    throw new Error(`Authors directory not found: ${authorsDir}`);
  }
  return listJsonFiles(authorsDir);
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
    const record = readJsonFile(file);
    if (record && typeof record === "object" && record.id != null) {
      record.name = `Edited Post ${record.id} (${runName})`;
      if (failingRecordNumber !== null && Number(record.id) === failingRecordNumber) {
        record.ts = "not-a-timestamp";
      }
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      touched.push(file);
    }
  }

  return touched;
}

function createLocalRecords(workspaceDir, runName, count = 1) {
  const recordsDir = getTableDir(workspaceDir, POSTS_TABLE_NAME);
  if (!fs.existsSync(recordsDir)) {
    throw new Error(`Posts directory not found: ${recordsDir}`);
  }

  const existingBasenames = new Set(
    fs.readdirSync(recordsDir).filter((entry) => entry.endsWith(".json")),
  );
  const created = [];
  let nextFileNumber = 1;

  while (created.length < count) {
    const fileName = `post-create-${nextFileNumber}.json`;
    nextFileNumber += 1;
    if (existingBasenames.has(fileName)) {
      continue;
    }

    const record = {
      name: `Created Post ${created.length + 1} (${runName})`,
      ts: new Date(Date.now() + created.length).toISOString(),
    };
    const file = path.join(recordsDir, fileName);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    existingBasenames.add(fileName);
    created.push(file);
  }

  return created;
}

function deleteLocalRecords(workspaceDir, count = 1) {
  const files = sortRecordFiles(listRecordFiles(workspaceDir));
  const deleted = [];

  for (const file of files.slice(0, count)) {
    const record = readJsonFile(file);
    const recordId =
      record && typeof record === "object" && record.id != null
        ? Number(record.id)
        : null;
    fs.unlinkSync(file);
    deleted.push({
      file,
      recordId,
      name: record?.name ?? null,
      lastUpdated: normalizeTimestamp(record?.lastUpdated),
    });
  }

  return deleted;
}

function captureExpectedNames(files) {
  const expectedNames = new Map();

  for (const file of files) {
    const record = readJsonFile(file);
    expectedNames.set(file, record?.name);
  }

  return expectedNames;
}

function captureExpectedLastUpdatedById(files) {
  const expectedLastUpdatedById = new Map();

  for (const file of files) {
    const record = readJsonFile(file);
    if (record && typeof record === "object" && record.id != null) {
      expectedLastUpdatedById.set(
        Number(record.id),
        normalizeTimestamp(record.lastUpdated),
      );
    }
  }

  return expectedLastUpdatedById;
}

function captureExpectedAuthorIdsById(files) {
  const expectedAuthorIdsById = new Map();

  for (const file of files) {
    const record = readJsonFile(file);
    if (record && typeof record === "object" && record.id != null) {
      expectedAuthorIdsById.set(
        Number(record.id),
        normalizeNullableId(record.authorId),
      );
    }
  }

  return expectedAuthorIdsById;
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

    const record = readJsonFile(file);
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
    const record = readJsonFile(file);
    return Number(record.id);
  });
}

function getConnectionDir(workspaceDir) {
  return path.join(workspaceDir, "Smoke Postgres");
}

function getMasterConnectionDir(workspaceDir) {
  return path.join(
    workspaceDir,
    ".scratch",
    "connections",
    "master",
    "Smoke Postgres",
  );
}

function getDirtyConnectionDir(workspaceDir) {
  return path.join(
    workspaceDir,
    ".scratch",
    "connections",
    "dirty",
    "Smoke Postgres",
  );
}

function getLocalConnectionDir(workspaceDir, location) {
  if (location === "working") {
    return getConnectionDir(workspaceDir);
  }
  if (location === "master") {
    return getMasterConnectionDir(workspaceDir);
  }
  if (location === "dirty") {
    return getDirtyConnectionDir(workspaceDir);
  }
  throw new Error(`Unknown local connection location: ${location}`);
}

function getLocalRecordPath(workspaceDir, workingFile, location) {
  const relPath = path.relative(getConnectionDir(workspaceDir), workingFile);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    throw new Error(
      `Could not map ${workingFile} into ${location} record path from ${workspaceDir}`,
    );
  }
  return path.join(getLocalConnectionDir(workspaceDir, location), relPath);
}

function verifyLocalLastUpdated(
  workspaceDir,
  files,
  previousLastUpdatedById,
  expectedAuthorIdsById,
  remoteRowsById,
  successfulIds,
  // IDs whose authorId check is skipped in local files (dirty/working) because the
  // server doesn't write resolved pseudo-ref values back to the dirty branch.
  skipLocalAuthorIdIds = new Set(),
) {
  const verified = [];
  const mismatches = [];

  for (const file of files) {
    const workingRecord = readJsonFile(file);
    const recordId = Number(workingRecord?.id);
    if (!successfulIds.has(recordId)) {
      continue;
    }

    const remoteRow = remoteRowsById.get(recordId);
    const expectedLastUpdated = normalizeTimestamp(remoteRow?.lastUpdated);
    const previousLastUpdated = previousLastUpdatedById.get(recordId) ?? null;
    const expectedAuthorId = expectedAuthorIdsById.get(recordId) ?? null;
    const remoteAuthorId = normalizeNullableId(remoteRow?.authorId);

    if (!expectedLastUpdated) {
      mismatches.push({
        id: recordId,
        file,
        location: "remote",
        expected: "(non-empty lastUpdated)",
        actual: String(remoteRow?.lastUpdated ?? null),
        previous: previousLastUpdated,
      });
      continue;
    }

    if (previousLastUpdated === expectedLastUpdated) {
      mismatches.push({
        id: recordId,
        file,
        location: "remote",
        expected: "(changed lastUpdated)",
        actual: expectedLastUpdated,
        previous: previousLastUpdated,
      });
      continue;
    }

    if (remoteAuthorId !== expectedAuthorId) {
      mismatches.push({
        id: recordId,
        file,
        location: "remote-authorId",
        expected: expectedAuthorId,
        actual: remoteAuthorId,
        previous: null,
      });
      continue;
    }

    let recordOk = true;
    for (const location of ["master", "dirty", "working"]) {
      const targetFile =
        location === "working"
          ? file
          : getLocalRecordPath(workspaceDir, file, location);

      if (!fs.existsSync(targetFile)) {
        mismatches.push({
          id: recordId,
          file,
          location,
          expected: expectedLastUpdated,
          actual: "(missing file)",
          previous: previousLastUpdated,
        });
        recordOk = false;
        continue;
      }

      const localRecord = readJsonFile(targetFile);
      const actualAuthorId = normalizeNullableId(localRecord?.authorId);
      const actualLastUpdated = normalizeTimestamp(localRecord?.lastUpdated);
      if (!skipLocalAuthorIdIds.has(recordId) && actualAuthorId !== expectedAuthorId) {
        mismatches.push({
          id: recordId,
          file,
          location: `${location}-authorId`,
          expected: expectedAuthorId,
          actual: actualAuthorId,
          previous: null,
        });
        recordOk = false;
      }
      if (actualLastUpdated !== expectedLastUpdated) {
        mismatches.push({
          id: recordId,
          file,
          location,
          expected: expectedLastUpdated,
          actual: actualLastUpdated,
          previous: previousLastUpdated,
        });
        recordOk = false;
      }
    }

    if (recordOk) {
      verified.push({
        id: recordId,
        file,
        lastUpdated: expectedLastUpdated,
        previous: previousLastUpdated,
      });
    }
  }

  return { verified, mismatches };
}

function verifyLocalCreatedRows(
  workspaceDir,
  files,
  expectedNames,
  remoteRowsByName,
) {
  const verified = [];
  const mismatches = [];

  for (const file of files) {
    const expectedName = expectedNames.get(file) ?? null;
    const remoteRow = remoteRowsByName.get(expectedName);

    if (!remoteRow) {
      mismatches.push({
        file,
        location: "remote",
        expectedName,
        expectedId: "(created row)",
        actualId: "(missing remote row)",
        expectedLastUpdated: "(non-empty lastUpdated)",
        actualLastUpdated: null,
      });
      continue;
    }

    const expectedId = Number(remoteRow.id);
    const expectedLastUpdated = normalizeTimestamp(remoteRow.lastUpdated);
    let recordOk = true;

    if (!Number.isFinite(expectedId)) {
      mismatches.push({
        file,
        location: "remote",
        expectedName,
        expectedId: "(numeric id)",
        actualId: remoteRow.id,
        expectedLastUpdated: "(non-empty lastUpdated)",
        actualLastUpdated: remoteRow.lastUpdated,
      });
      continue;
    }

    if (!expectedLastUpdated) {
      mismatches.push({
        file,
        location: "remote",
        expectedName,
        expectedId,
        actualId: remoteRow.id,
        expectedLastUpdated: "(non-empty lastUpdated)",
        actualLastUpdated: remoteRow.lastUpdated,
      });
      continue;
    }

    for (const location of ["master", "dirty", "working"]) {
      const targetFile =
        location === "working"
          ? file
          : getLocalRecordPath(workspaceDir, file, location);

      if (!fs.existsSync(targetFile)) {
        mismatches.push({
          file,
          location,
          expectedName,
          expectedId,
          actualId: "(missing file)",
          expectedLastUpdated,
          actualLastUpdated: "(missing file)",
        });
        recordOk = false;
        continue;
      }

      const localRecord = readJsonFile(targetFile);
      const actualId =
        localRecord && localRecord.id != null ? Number(localRecord.id) : null;
      const actualName = localRecord?.name ?? null;
      const actualLastUpdated = normalizeTimestamp(localRecord?.lastUpdated);

      if (
        actualId !== expectedId ||
        actualName !== expectedName ||
        actualLastUpdated !== expectedLastUpdated
      ) {
        mismatches.push({
          file,
          location,
          expectedName,
          actualName,
          expectedId,
          actualId,
          expectedLastUpdated,
          actualLastUpdated,
        });
        recordOk = false;
      }
    }

    if (recordOk) {
      verified.push({
        file,
        id: expectedId,
        name: expectedName,
        lastUpdated: expectedLastUpdated,
      });
    }
  }

  return { verified, mismatches };
}

function verifyLocalDeletedRows(workspaceDir, deletedEntries) {
  const verified = [];
  const mismatches = [];

  for (const entry of deletedEntries) {
    const locationsWithFile = [];
    for (const location of ["master", "dirty", "working"]) {
      const targetFile =
        location === "working"
          ? entry.file
          : getLocalRecordPath(workspaceDir, entry.file, location);
      if (fs.existsSync(targetFile)) {
        locationsWithFile.push(location);
      }
    }

    if (locationsWithFile.length > 0) {
      mismatches.push({
        file: entry.file,
        id: entry.recordId,
        locations: locationsWithFile,
      });
    } else {
      verified.push({
        file: entry.file,
        id: entry.recordId,
      });
    }
  }

  return { verified, mismatches };
}

function summarizeDeletedFilesAfterUpload(deletedEntries) {
  const missing = [];
  const present = [];

  for (const entry of deletedEntries) {
    if (fs.existsSync(entry.file)) {
      present.push(entry);
    } else {
      missing.push(entry);
    }
  }

  return { missing, present };
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
      `public/${POSTS_TABLE_NAME}`,
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

function findTable(tables, tableName) {
  const exact = tables.find(
    (table) => table.displayName === tableName || table.name === tableName,
  );
  if (exact) {
    return exact;
  }

  const suffix = tables.find(
    (table) =>
      typeof table.id === "string" &&
      (table.id.endsWith(`/${tableName}`) ||
        table.id.endsWith(`:${tableName}`)),
  );
  if (suffix) {
    return suffix;
  }

  throw new Error(
    `Could not find table ${tableName}. Available: ${tables.map((table) => table.displayName || table.id).join(", ")}`,
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
  "records-deleted",
  "records-created",
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
  const createCount =
    cliArgs.createCount != null ? Number(cliArgs.createCount) : 0;
  const deleteCount =
    cliArgs.deleteCount != null ? Number(cliArgs.deleteCount) : 0;
  const setAuthorRecord =
    cliArgs.setAuthorRecord != null ? Number(cliArgs.setAuthorRecord) : null;
  const remoteDirtyRecord =
    cliArgs.remoteDirtyRecord != null
      ? Number(cliArgs.remoteDirtyRecord)
      : null;
  const failingEditRecord =
    cliArgs.failingEditRecord != null
      ? Number(cliArgs.failingEditRecord)
      : null;
  let addFk = null;
  if (cliArgs.addFk !== undefined) {
    const parts = String(cliArgs.addFk).split("-");
    if (parts.length !== 2) {
      throw new Error(`--add-fk must be in format <postIndex>-<authorTarget>, e.g. "1-1" or "2-0"`);
    }
    const postIndex = parseInt(parts[0], 10);
    const authorTarget = parseInt(parts[1], 10);
    if (!Number.isFinite(postIndex) || postIndex < 1) {
      throw new Error(`--add-fk: post index "${parts[0]}" must be a positive integer`);
    }
    if (authorTarget !== 0 && authorTarget !== 1) {
      throw new Error(`--add-fk: author target must be 0 (new) or 1 (existing), got "${parts[1]}"`);
    }
    addFk = { postIndex, authorTarget };
  }
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
  if (!Number.isFinite(createCount) || createCount < 0) {
    throw new Error(`Invalid --create-count: ${createCount}`);
  }
  if (!Number.isFinite(deleteCount) || deleteCount < 0) {
    throw new Error(`Invalid --delete-count: ${deleteCount}`);
  }
  if (
    setAuthorRecord !== null &&
    (!Number.isFinite(setAuthorRecord) ||
      setAuthorRecord < 1 ||
      setAuthorRecord > recordCount)
  ) {
    throw new Error(
      `--set-author-record must be a post number between 1 and ${recordCount}`,
    );
  }
  if (editCount > recordCount) {
    throw new Error(
      `--edit-count (${editCount}) cannot exceed --count (${recordCount})`,
    );
  }
  if (deleteCount > recordCount) {
    throw new Error(
      `--delete-count (${deleteCount}) cannot exceed --count (${recordCount})`,
    );
  }
  if (acceptCount > editCount) {
    throw new Error(
      `--accept-count (${acceptCount}) cannot exceed --edit-count (${editCount})`,
    );
  }
  if (
    addFk !== null &&
    addFk.postIndex > recordCount
  ) {
    throw new Error(
      `--add-fk: post index ${addFk.postIndex} exceeds --count (${recordCount})`,
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
  console.log(`Create count:   ${createCount}`);
  console.log(`Delete count:   ${deleteCount}`);
  if (setAuthorRecord !== null)
    console.log(`Set author:     post ${setAuthorRecord} -> author 1`);
  if (remoteDirtyRecord !== null)
    console.log(`Remote dirty:   record ${remoteDirtyRecord}`);
  if (failingEditRecord !== null)
    console.log(`Failing edit:   record ${failingEditRecord}`);
  if (addFk !== null)
    console.log(`Add FK:         post ${addFk.postIndex} -> ${addFk.authorTarget === 0 ? "new author (pseudo-ref create)" : "existing author 1 (pseudo-ref backfill)"}`);
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
    await seedDatabase(databaseUrl, recordCount, setAuthorRecord);
    const seededRows = await readPostRows(databaseUrl);
    const seededAuthors = await readAuthorRows(databaseUrl);
    console.log(
      `Seeded ${seededRows.length} rows into ${POSTS_TABLE_NAME} and ${seededAuthors.length} row into ${AUTHORS_TABLE_NAME}.`,
    );

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
    const authorsTable = findTable(tables, AUTHORS_TABLE_NAME);
    const postsTable = findTable(tables, POSTS_TABLE_NAME);
    const linkedAuthorsFolder = sanitizeJsonOutput(
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
          ...tableIdArgs(authorsTable.id),
          "--name",
          AUTHORS_TABLE_NAME,
        ],
        { cwd: state.workspaceDir },
      ).stdout,
    );
    const linkedPostsFolder = sanitizeJsonOutput(
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
          ...tableIdArgs(postsTable.id),
          "--name",
          POSTS_TABLE_NAME,
        ],
        { cwd: state.workspaceDir },
      ).stdout,
    );
    console.log(`Linked authors folder ID: ${linkedAuthorsFolder.id}`);
    console.log(`Linked posts folder ID: ${linkedPostsFolder.id}`);

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
      ["linked", "--workspace", state.workbookId, "pull", linkedAuthorsFolder.id],
      { cwd: state.workspaceDir, noJson: true },
    );
    runCli(
      binary,
      serverUrl,
      ["linked", "--workspace", state.workbookId, "pull", linkedPostsFolder.id],
      { cwd: state.workspaceDir, noJson: true },
    );
    runCli(binary, serverUrl, ["files", "download"], {
      cwd: state.workspaceDir,
      noJson: true,
    });

    const downloadedFiles = listRecordFiles(state.workspaceDir);
    const downloadedAuthorFiles = listAuthorFiles(state.workspaceDir);
    if (downloadedAuthorFiles.length !== 1) {
      throw new Error(
        `Expected 1 downloaded author file, got ${downloadedAuthorFiles.length}.`,
      );
    }
    console.log(
      `Downloaded ${downloadedFiles.length} local post files and ${downloadedAuthorFiles.length} local author file.`,
    );

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
      `Edited ${editedFiles.length} of ${downloadedFiles.length} post files.`,
    );

    let deletedEntries = [];
    if (deleteCount > 0) {
      printSection("Delete local records");
      await checkpointIfNeeded(
        cliArgs.stop,
        cliArgs.pause,
        "records-edited",
        "Delete local records",
        [
          `Workspace: ${state.workspaceDir}`,
          `Edited files: ${editedFiles.length}`,
          `Delete files planned: ${deleteCount}`,
        ],
      );
      deletedEntries = deleteLocalRecords(state.workspaceDir, deleteCount);
      console.log(`Deleted ${deletedEntries.length} local post files.`);
    }

    let createdFiles = [];
    if (createCount > 0) {
      printSection("Create local records");
      await checkpointIfNeeded(
        cliArgs.stop,
        cliArgs.pause,
        deleteCount > 0 ? "records-deleted" : "records-edited",
        "Create local records",
        [
          `Workspace: ${state.workspaceDir}`,
          `Edited files: ${editedFiles.length}`,
          `Deleted files: ${deletedEntries.length}`,
          `Create files planned: ${createCount}`,
        ],
      );
      createdFiles = createLocalRecords(state.workspaceDir, runName, createCount);
      console.log(`Created ${createdFiles.length} new local post files.`);
    }

    let addFkPostFile = null;
    let addFkAuthorFile = null;
    let addFkIsNewAuthor = false;
    if (addFk !== null) {
      printSection("Add FK pseudo-reference");
      const allPostFiles = sortRecordFiles(listRecordFiles(state.workspaceDir));
      const targetPostFile = allPostFiles[addFk.postIndex - 1];
      if (!targetPostFile) {
        throw new Error(
          `--add-fk: post ${addFk.postIndex} not found (${allPostFiles.length} post file(s) remain after deletions)`,
        );
      }

      if (addFk.authorTarget === 0) {
        const authorsDir = getTableDir(state.workspaceDir, AUTHORS_TABLE_NAME);
        addFkAuthorFile = path.join(authorsDir, "author-create-1.json");
        fs.writeFileSync(
          addFkAuthorFile,
          `${JSON.stringify({ name: `New Author (${runName})` }, null, 2)}\n`,
        );
        addFkIsNewAuthor = true;
        console.log(`Created new author file: ${path.relative(state.workspaceDir, addFkAuthorFile)}`);
      } else {
        const authorFiles = listAuthorFiles(state.workspaceDir);
        if (authorFiles.length === 0) throw new Error("--add-fk: no author files found in workspace");
        addFkAuthorFile = [...authorFiles].sort()[0];
        addFkIsNewAuthor = false;
      }

      const authorRelPath = path.relative(getConnectionDir(state.workspaceDir), addFkAuthorFile)
        .split(path.sep)
        .join("/");
      const pseudoRef = `@/${authorRelPath}`;

      const postRecord = readJsonFile(targetPostFile);
      postRecord.authorId = pseudoRef;
      fs.writeFileSync(targetPostFile, `${JSON.stringify(postRecord, null, 2)}\n`);
      addFkPostFile = targetPostFile;

      console.log(
        `Set post ${addFk.postIndex} authorId = "${pseudoRef}" (${addFkIsNewAuthor ? "new author" : "existing author"})`,
      );
    }

    printSection("Accept local changes");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      createCount > 0
        ? "records-created"
        : deleteCount > 0
          ? "records-deleted"
          : "records-edited",
      "Accept local changes",
      [
        `Edited files: ${editedFiles.length}`,
        `Deleted files: ${deletedEntries.length}`,
        `Created files: ${createdFiles.length}`,
      ],
    );
    const deletedFilePaths = new Set(deletedEntries.map((entry) => entry.file));
    const acceptedEditedFiles = editedFiles
      .slice(0, acceptCount)
      .filter((file) => !deletedFilePaths.has(file));
    const acceptedCreatedFiles = [...createdFiles];
    const acceptedDeletedEntries = [...deletedEntries];
    let acceptedFiles;
    if (acceptCount === editedFiles.length) {
      acceptedFiles = [...acceptedEditedFiles, ...acceptedCreatedFiles];
      runCli(binary, serverUrl, ["files", "accept-all"], {
        cwd: state.workspaceDir,
        noJson: true,
      });
    } else {
      const filesToAccept = [
        ...acceptedEditedFiles,
        ...acceptedCreatedFiles,
        ...acceptedDeletedEntries.map((entry) => entry.file),
        ...(addFkPostFile && !acceptedEditedFiles.includes(addFkPostFile) ? [addFkPostFile] : []),
        ...(addFkIsNewAuthor && addFkAuthorFile ? [addFkAuthorFile] : []),
      ];
      acceptedFiles = [...acceptedEditedFiles, ...acceptedCreatedFiles];
      if (filesToAccept.length > 0) {
        const relPaths = filesToAccept.map((file) =>
          path.relative(state.workspaceDir, file),
        );
        runCli(binary, serverUrl, ["files", "accept", ...relPaths], {
          cwd: state.workspaceDir,
          noJson: true,
        });
      }
      console.log(
        `Accepted ${acceptedEditedFiles.length} of ${editedFiles.length} edited files, ${acceptedDeletedEntries.length} deleted files, plus ${acceptedCreatedFiles.length} created files (${editedFiles.length - acceptedEditedFiles.length - acceptedDeletedEntries.filter((entry) => editedFiles.includes(entry.file)).length} edited files left unreviewed).`,
      );
    }

    if (addFkPostFile && !acceptedEditedFiles.includes(addFkPostFile)) {
      acceptedEditedFiles.push(addFkPostFile);
      acceptedFiles.push(addFkPostFile);
    }
    if (addFkIsNewAuthor && addFkAuthorFile && !acceptedFiles.includes(addFkAuthorFile)) {
      acceptedFiles.push(addFkAuthorFile);
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
    const expectedAcceptedLastUpdatedById =
      captureExpectedLastUpdatedById(acceptedEditedFiles);
    const expectedAcceptedAuthorIdsById =
      captureExpectedAuthorIdsById(acceptedEditedFiles);
    if (addFk !== null && addFkPostFile !== null) {
      const postId = Number(readJsonFile(addFkPostFile).id);
      // For M=1 (existing author) the resolved ID is always 1 (seeded).
      // For M=0 (new author) we set null as a placeholder and resolve after download.
      expectedAcceptedAuthorIdsById.set(postId, addFk.authorTarget === 1 ? 1 : null);
    }
    const expectedCreatedNames = captureExpectedNames(createdFiles);
    runCli(binary, serverUrl, ["files", "upload"], {
      cwd: state.workspaceDir,
      noJson: true,
    });

    printSection("Check approved local files after upload");
    const uploadCheck = summarizeApprovedFilesAfterUpload(
      acceptedFiles,
      expectedAcceptedNames,
    );
    const deletedUploadCheck = summarizeDeletedFilesAfterUpload(
      acceptedDeletedEntries,
    );
    console.log(
      `Approved files checked: ${acceptedFiles.length + acceptedDeletedEntries.length} (${uploadCheck.preserved.length} preserved, ${deletedUploadCheck.missing.length} deleted, ${uploadCheck.reverted.length} reverted, ${uploadCheck.missing.length} missing, ${deletedUploadCheck.present.length} unexpectedly present deletes).`,
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
    for (const row of deletedUploadCheck.present.slice(0, 5)) {
      console.log(
        `  delete-present: ${path.relative(state.workspaceDir, row.file)} | expected missing after upload`,
      );
    }

    printSection("Trigger publish-from-git");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "upload-complete",
      "Trigger publish-from-git",
      [
        `Approved files: ${acceptedFiles.length + acceptedDeletedEntries.length}`,
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

    printSection("Download published changes");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "local-download-complete",
      "Download published changes",
      [`Workspace: ${state.workspaceDir}`],
    );
    runCli(binary, serverUrl, ["files", "download"], {
      cwd: state.workspaceDir,
      noJson: true,
    });

    if (addFk !== null && addFkIsNewAuthor && addFkAuthorFile) {
      const resolvedAuthorRecord = fs.existsSync(addFkAuthorFile)
        ? readJsonFile(addFkAuthorFile)
        : null;
      const resolvedAuthorId = normalizeNullableId(resolvedAuthorRecord?.id);
      if (resolvedAuthorId === null) {
        throw new Error(
          `--add-fk: new author file "${path.relative(state.workspaceDir, addFkAuthorFile)}" has no id after publish + download`,
        );
      }
      const postId = Number(readJsonFile(addFkPostFile).id);
      expectedAcceptedAuthorIdsById.set(postId, resolvedAuthorId);
      console.log(`Resolved new author id: ${resolvedAuthorId} → will verify post ${addFk.postIndex} authorId = ${resolvedAuthorId}`);
    }

    printSection("Verify remote database state");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "__verify-remote-database-state",
      "Verify remote database state",
      [`Database: ${dbName}`],
    );
    const finalRows = await readPostRows(databaseUrl);
    const finalAuthorRows = await readAuthorRows(databaseUrl);
    const expectedAuthorRowCount = addFk !== null && addFk.authorTarget === 0 ? 2 : 1;
    if (finalAuthorRows.length !== expectedAuthorRowCount) {
      throw new Error(
        `Expected ${expectedAuthorRowCount} author row(s), got ${finalAuthorRows.length}: ${finalAuthorRows.map((r) => `${r.id}:${r.name}`).join(", ") || "(none)"}.`,
      );
    }
    if (expectedAuthorRowCount === 1 && finalAuthorRows[0]?.name !== "Author 1") {
      throw new Error(
        `Expected author row named "Author 1", got "${finalAuthorRows[0]?.name}".`,
      );
    }
    const baselineRowIds = new Set(seededRows.map((row) => Number(row.id)));
    const acceptedFilesForPublish = acceptedEditedFiles;
    const finalRowsById = new Map(finalRows.map((row) => [Number(row.id), row]));
    const acceptedIdsByFile = new Map(
      acceptedFilesForPublish.map((file) => [file, Number(readJsonFile(file).id)]),
    );
    const successfulIds = new Set();
    const failedOrRemainingIds = new Set();
    for (const [file, recordId] of acceptedIdsByFile) {
      const remoteRow = finalRowsById.get(recordId);
      const expectedName = expectedAcceptedNames.get(file);
      const previousLastUpdated =
        expectedAcceptedLastUpdatedById.get(recordId) ?? null;
      const currentLastUpdated = normalizeTimestamp(remoteRow?.lastUpdated);
      const expectedAuthorId =
        expectedAcceptedAuthorIdsById.get(recordId) ?? null;
      const currentAuthorId = normalizeNullableId(remoteRow?.authorId);

      if (
        remoteRow?.name === expectedName &&
        currentAuthorId === expectedAuthorId &&
        currentLastUpdated &&
        previousLastUpdated !== currentLastUpdated
      ) {
        successfulIds.add(recordId);
      } else {
        failedOrRemainingIds.add(recordId);
      }
    }

    const createdRows = finalRows.filter(
      (row) => !baselineRowIds.has(Number(row.id)),
    );
    const deletedIds = new Set(
      acceptedDeletedEntries
        .map((entry) => entry.recordId)
        .filter((recordId) => Number.isFinite(recordId)),
    );
    let mismatches = 0;
    let lastUpdatedMismatches = 0;
    for (const row of finalRows) {
      if (!baselineRowIds.has(Number(row.id))) {
        continue;
      }
      if (deletedIds.has(row.id)) {
        console.warn(
          `  Row ${row.id}: expected deleted, got "${row.name}"`,
        );
        mismatches += 1;
        continue;
      }

      let expected;
      let expectedAuthorId;
      if (successfulIds.has(row.id)) {
        expected = `Edited Post ${row.id} (${runName})`;
        expectedAuthorId =
          expectedAcceptedAuthorIdsById.get(Number(row.id)) ?? null;
      } else {
        expected = `Post ${row.id}`;
        expectedAuthorId = null;
      }
      if (row.name !== expected) {
        console.warn(
          `  Row ${row.id}: expected "${expected}", got "${row.name}"`,
        );
        mismatches += 1;
      }
      if (normalizeNullableId(row.authorId) !== expectedAuthorId) {
        console.warn(
          `  Row ${row.id}: expected authorId "${expectedAuthorId}", got "${normalizeNullableId(row.authorId)}"`,
        );
        mismatches += 1;
      }

      if (successfulIds.has(row.id)) {
        const previousLastUpdated =
          expectedAcceptedLastUpdatedById.get(Number(row.id)) ?? null;
        const currentLastUpdated = normalizeTimestamp(row.lastUpdated);
        if (!currentLastUpdated || previousLastUpdated === currentLastUpdated) {
          console.warn(
            `  Row ${row.id}: expected lastUpdated to change after publish | previous="${previousLastUpdated}" | current="${currentLastUpdated}"`,
          );
          lastUpdatedMismatches += 1;
        }
      }
    }

    const expectedCreatedNameList = Array.from(expectedCreatedNames.values()).sort();
    const actualCreatedNameList = createdRows
      .map((row) => row.name)
      .sort((a, b) => a.localeCompare(b));
    if (createdRows.length !== createdFiles.length) {
      mismatches += 1;
      console.warn(
        `  Created rows: expected ${createdFiles.length}, got ${createdRows.length}`,
      );
    }
    if (
      actualCreatedNameList.length !== expectedCreatedNameList.length ||
      actualCreatedNameList.some(
        (value, index) => value !== expectedCreatedNameList[index],
      )
    ) {
      mismatches += 1;
      console.warn(
        `  Created row names: expected "${expectedCreatedNameList.join(", ")}", got "${actualCreatedNameList.join(", ")}"`,
      );
    }
    for (const row of createdRows) {
      if (normalizeNullableId(row.authorId) !== null) {
        mismatches += 1;
        console.warn(
          `  Created row ${row.id}: expected authorId to remain null, got "${normalizeNullableId(row.authorId)}"`,
        );
      }
      if (!normalizeTimestamp(row.lastUpdated)) {
        lastUpdatedMismatches += 1;
        console.warn(
          `  Created row ${row.id}: expected non-empty lastUpdated after publish`,
        );
      }
    }

    if (mismatches > 0 || lastUpdatedMismatches > 0) {
      throw new Error(
        `${mismatches} row(s) had unexpected names and ${lastUpdatedMismatches} row(s) did not advance lastUpdated after publish.`,
      );
    }
    const unchangedExistingCount =
      baselineRowIds.size -
      successfulIds.size -
      failedOrRemainingIds.size -
      deletedIds.size;
    console.log(
      `Verified ${finalRows.length} rows in ${POSTS_TABLE_NAME} and ${finalAuthorRows.length} row in ${AUTHORS_TABLE_NAME} (${successfulIds.size} updated, ${deletedIds.size} deleted, ${createdRows.length} created, ${failedOrRemainingIds.size} still local, ${unchangedExistingCount} unchanged existing rows, ${successfulIds.size + createdRows.length} refreshed lastUpdated value(s)).`,
    );

    const unreviewedFiles = editedFiles
      .slice(acceptCount)
      .filter((file) => !deletedFilePaths.has(file));
    const expectedUnreviewedNames = captureExpectedNames(unreviewedFiles);

    printSection("Verify local workspace state");
    await checkpointIfNeeded(
      cliArgs.stop,
      cliArgs.pause,
      "remote-verified",
      "Verify local workspace state",
      [`Workspace: ${state.workspaceDir}`],
    );

    const approvedAfterDownload = summarizeApprovedFilesAfterUpload(
      acceptedFiles,
      expectedAcceptedNames,
    );
    const deletedAfterDownload = verifyLocalDeletedRows(
      state.workspaceDir,
      acceptedDeletedEntries,
    );
    const unreviewedAfterDownload = summarizeApprovedFilesAfterUpload(
      unreviewedFiles,
      expectedUnreviewedNames,
    );
    const modifiedPaths = listModifiedRecordPaths(state.workspaceDir);
    const reviewedDirtyPaths = listReviewedDirtyPaths(state.workspaceDir);
    const remainingPublishedFiles = acceptedFilesForPublish.filter((file) =>
      failedOrRemainingIds.has(acceptedIdsByFile.get(file)),
    );
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
    if (deletedAfterDownload.mismatches.length > 0) {
      const details = deletedAfterDownload.mismatches
        .map(
          (row) =>
            `file=${path.relative(state.workspaceDir, row.file)} id=${row.id} presentIn=${row.locations.join(",")}`,
        )
        .join("; ");
      throw new Error(
        `Deleted files were still present after final download: ${details}`,
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

    const pseudoRefPostIds = addFk !== null && addFkPostFile !== null
      ? new Set([Number(readJsonFile(addFkPostFile).id)])
      : new Set();
    const localLastUpdatedCheck = verifyLocalLastUpdated(
      state.workspaceDir,
      acceptedFilesForPublish,
      expectedAcceptedLastUpdatedById,
      expectedAcceptedAuthorIdsById,
      finalRowsById,
      successfulIds,
      pseudoRefPostIds,
    );
    if (localLastUpdatedCheck.mismatches.length > 0) {
      const details = localLastUpdatedCheck.mismatches
        .map(
          (row) =>
            `${row.location}: id=${row.id} expected="${row.expected}" actual="${row.actual}" previous="${row.previous}"`,
        )
        .join("; ");
      throw new Error(
        `Local lastUpdated mismatch after post-publish download: ${details}`,
      );
    }

    const createdRowsByName = new Map(createdRows.map((row) => [row.name, row]));
    const localCreatedCheck = verifyLocalCreatedRows(
      state.workspaceDir,
      createdFiles,
      expectedCreatedNames,
      createdRowsByName,
    );
    if (localCreatedCheck.mismatches.length > 0) {
      const details = localCreatedCheck.mismatches
        .map(
          (row) =>
            `${row.location}: file=${path.relative(state.workspaceDir, row.file)} expectedName="${row.expectedName}" actualName="${row.actualName ?? "(missing)"}" expectedId="${row.expectedId}" actualId="${row.actualId}" expectedLastUpdated="${row.expectedLastUpdated}" actualLastUpdated="${row.actualLastUpdated}"`,
        )
        .join("; ");
      throw new Error(
        `Local created-record mismatch after post-publish download: ${details}`,
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

    const finalAuthorFiles = listAuthorFiles(state.workspaceDir);
    const expectedAuthorFileCount = addFk !== null && addFk.authorTarget === 0 ? 2 : 1;
    if (finalAuthorFiles.length !== expectedAuthorFileCount) {
      throw new Error(
        `Expected ${expectedAuthorFileCount} author file(s) after final download, got ${finalAuthorFiles.length}.`,
      );
    }

    console.log(
      `Local workspace verified after final download: ${successfulIds.size} published baseline, ${deletedAfterDownload.verified.length} deleted, ${remainingPublishedFiles.length} failed/remaining reviewed in dirty, ${unreviewedFiles.length} unreviewed preserved in working tree, ${modifiedPaths.length} working-tree modified path(s) remaining.`,
    );
    if (localLastUpdatedCheck.verified.length > 0) {
      console.log(
        `Verified refreshed lastUpdated in local master, dirty, and working tree for ${localLastUpdatedCheck.verified.length} published record(s).`,
      );
    }
    if (localCreatedCheck.verified.length > 0) {
      console.log(
        `Verified created records in local master, dirty, and working tree for ${localCreatedCheck.verified.length} file(s).`,
      );
    }
    if (deletedAfterDownload.verified.length > 0) {
      console.log(
        `Verified deleted records were removed from local master, dirty, and working tree for ${deletedAfterDownload.verified.length} file(s).`,
      );
    }

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
  const cause = error.cause ? ` (cause: ${error.cause})` : "";
  console.error(`\nDriver failed: ${error.message}${cause}`);
  process.exitCode = 1;
});
