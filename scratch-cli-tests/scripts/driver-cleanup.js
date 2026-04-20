#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");

const dotenv = require("dotenv");
const { Client } = require("pg");

dotenv.config({ path: path.resolve(__dirname, "../driver.env"), quiet: true });

const DEFAULT_PATTERN = "^TEST-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}$";

function parseArgs(argv) {
  const args = {
    help: false,
    yes: false,
    dryRun: false,
    pattern: DEFAULT_PATTERN,
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
    if (arg === "--yes") {
      args.yes = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--pattern") {
      args.pattern = argv[++i];
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
Usage: node scripts/driver-cleanup.js [options]

Fetches workbooks from the target Scratch server, finds names matching the
driver naming pattern, and removes:
  - remote workbooks
  - matching Postgres databases
  - matching local workspace folders

Options:
  --pattern <regex>        Regex for workbook/database/folder names
                           (default: ${DEFAULT_PATTERN})
  --dry-run                Show what would be deleted without deleting it
  --yes                    Skip confirmation prompt
  --server-url <url>       Override SCRATCH_API_URL
  --binary <path-or-name>  Override SCRATCH_CLI_BINARY
  --database-url <url>     Override DATABASE_URL / DATABASE_URL_PREFIX
  --workspace-root <path>  Parent directory for local workspace folders
  --help, -h               Show this help
`);
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

function buildAdminDbUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = "/postgres";
  url.search = "";
  return url.toString();
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

function runCommand(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs || 10 * 60 * 1_000,
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const full = [command, ...args].join(" ");
    const stderr = (result.stderr || "").trim();
    throw new Error(
      stderr
        ? `Command failed with exit ${result.status}: ${full}\n${stderr}`
        : `Command failed with exit ${result.status}: ${full}`,
    );
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

async function ensureServerHealthy(serverUrl) {
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/health`);
  if (!response.ok) {
    throw new Error(
      `Scratch server health check failed with HTTP ${response.status} at ${serverUrl}/health`,
    );
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
    await client.query(
      `DROP DATABASE IF EXISTS "${dbName.replace(/"/g, '""')}"`,
    );
  } finally {
    await client.end();
  }
}

async function confirmProceed(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${message} [y/N]: `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
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
  const workspaceRoot =
    cliArgs.workspaceRoot ||
    process.env.DRIVER_WORKSPACE_ROOT ||
    path.join(os.tmpdir(), "scratchmd-cli-driver");
  const binary = resolveBinary(
    cliArgs.binary || process.env.SCRATCH_CLI_BINARY,
  );
  const namePattern = new RegExp(cliArgs.pattern);

  if (!databasePrefix) {
    throw new Error(
      "DATABASE_URL (or DATABASE_URL_PREFIX) must point at the Postgres server root, for example postgresql://postgres:postgres@localhost:5432/",
    );
  }

  const adminDbUrl = buildAdminDbUrl(databasePrefix);

  console.log("\n=== Driver cleanup configuration ===");
  console.log(`CLI binary:     ${binary}`);
  console.log(`Server URL:     ${serverUrl}`);
  console.log(`Pattern:        ${cliArgs.pattern}`);
  console.log(`Workspace root: ${workspaceRoot}`);
  console.log(`Database root:  ${databasePrefix}`);
  console.log(`Mode:           ${cliArgs.dryRun ? "dry-run" : "delete"}`);

  runCommand(binary, ["--version"]);
  await ensureServerHealthy(serverUrl);

  const listOutput = sanitizeJsonOutput(
    runCli(binary, serverUrl, ["workspaces", "list"]).stdout,
  );
  const workbooks = Array.isArray(listOutput.workbooks)
    ? listOutput.workbooks
    : [];
  const matches = workbooks.filter((workbook) =>
    namePattern.test(workbook.name || ""),
  );

  console.log(`\nFound ${matches.length} matching workspace(s).`);
  if (matches.length === 0) {
    return;
  }

  for (const workbook of matches) {
    console.log(`  - ${workbook.name} (${workbook.id})`);
  }

  if (!cliArgs.dryRun && !cliArgs.yes) {
    const ok = await confirmProceed(
      `Delete ${matches.length} matching workspace(s), database(s), and local folder(s)?`,
    );
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  for (const workbook of matches) {
    const localPath = path.join(workspaceRoot, workbook.name);

    console.log(
      `\n=== ${cliArgs.dryRun ? "Would clean" : "Cleaning"} ${workbook.name} ===`,
    );
    console.log(`Remote workspace: ${workbook.id}`);
    console.log(`Database: ${workbook.name}`);
    console.log(`Local folder: ${localPath}`);

    if (cliArgs.dryRun) {
      continue;
    }

    try {
      runCli(
        binary,
        serverUrl,
        ["workspaces", "unsync", workbook.id, "--yes"],
        {
          noJson: true,
        },
      );
    } catch (error) {
      console.warn(
        `[cleanup] Unsync skipped for ${workbook.id}: ${error.message}`,
      );
    }

    try {
      if (fs.existsSync(localPath)) {
        fs.rmSync(localPath, { recursive: true, force: true });
      }
    } catch (error) {
      console.warn(
        `[cleanup] Failed to remove local folder ${localPath}: ${error.message}`,
      );
    }

    try {
      runCli(binary, serverUrl, ["workspaces", "delete", workbook.id], {
        noJson: true,
      });
    } catch (error) {
      console.warn(
        `[cleanup] Failed to delete remote workspace ${workbook.id}: ${error.message}`,
      );
    }

    try {
      await dropDatabase(adminDbUrl, workbook.name);
    } catch (error) {
      console.warn(
        `[cleanup] Failed to drop database ${workbook.name}: ${error.message}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(`\nDriver cleanup failed: ${error.message}`);
  process.exitCode = 1;
});
