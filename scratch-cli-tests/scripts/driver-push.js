#!/usr/bin/env node

/**
 * driver-push.js
 *
 * Re-edits local record files in an existing driver workspace and
 * pushes the changes through the full publish pipeline.
 *
 * Use this for edit-push-repeat testing after driver-run / driver-setup has already
 * set up a workspace (with --no-cleanup or --stop/--pause).
 *
 * Typical loop:
 *   1. yarn driver:run -- --count 1000 --no-cleanup
 *   2. yarn driver:push -- --workspace <path>   (repeat as needed)
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");

const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../driver.env"), quiet: true });

const POSTS_TABLE_NAME = "posts";

const VALID_BREAKPOINTS = new Set([
  "nowhere",
  "everywhere",
  "records-edited",
  "upload-complete",
]);

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    help: false,
    workspace: undefined,
    pause: "nowhere",
    stop: "nowhere",
    noEdit: false,
    serverUrl: undefined,
    binary: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--workspace") {
      args.workspace = argv[++i];
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
    if (arg === "--server-url") {
      args.serverUrl = argv[++i];
      continue;
    }
    if (arg === "--binary") {
      args.binary = argv[++i];
      continue;
    }
    if (arg === "--no-edit") {
      args.noEdit = true;
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

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/driver-push.js [options]

Re-edits local record files in an existing driver workspace and runs
the full publish pipeline: accept-all → upload (via /upload-patch) → publish
(via /publish-v2/plan-job + /run-job).

Use after driver-setup has set up a workspace (--no-cleanup or --pause).

Options:
  --workspace <path>       Path to the local workspace directory (required)
  --pause=<mode>           Pause interactively at a breakpoint (waits for Enter then continues). Modes:
                             nowhere            Never pause (default)
                             everywhere         Pause after every step
                             records-edited     After local JSON files re-mutated
                             upload-complete    After files upload runs, before files publish
  --stop=<mode>            Exit cleanly at a breakpoint (same step names as --pause)
  --no-edit                Skip the re-edit step — use when you've edited files manually
  --server-url <url>       Override SCRATCH_API_URL
  --binary <path-or-name>  Override SCRATCH_CLI_BINARY
  --help, -h               Show this help
`);
}

// ── Utilities ───────────────────────────────────────────────────────────────

function pad(value) {
  return String(value).padStart(2, "0");
}

function makeRunName(now = new Date()) {
  return [
    "EDIT",
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("-");
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
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

    if (looksLikePath && canExecuteBinary(binaryArg)) return binaryArg;
    if (!looksLikePath && repoBinaryReady) return repoBinary;
    if (canExecuteBinary(binaryArg)) return binaryArg;
  }

  if (repoBinaryReady) return repoBinary;
  return "scratchmd-local";
}

function runCommand(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const full = [command, ...args].join(" ");
  console.log(`$ ${full}`);

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs || 10 * 60 * 1_000,
  });

  if (result.stdout && result.stdout.trim()) {
    process.stdout.write(result.stdout);
    if (!result.stdout.endsWith("\n")) process.stdout.write("\n");
  }
  if (result.stderr && result.stderr.trim()) {
    process.stderr.write(result.stderr);
    if (!result.stderr.endsWith("\n")) process.stderr.write("\n");
  }

  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Command failed with exit ${result.status}: ${full}`);
  }

  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

function runCli(binary, serverUrl, args, options = {}) {
  const fullArgs = [...args, "--scratch-url", serverUrl];
  if (!options.noJson) fullArgs.push("--json");
  return runCommand(binary, fullArgs, options);
}

function stopIfNeeded(stop, step, label, details = []) {
  if (stop === "nowhere") return;
  if (stop !== "everywhere" && stop !== step) return;

  console.log(`\n[stop] ${label}`);
  for (const detail of details) console.log(`  ${detail}`);
  process.exit(0);
}

async function pauseIfNeeded(pause, step, label, details = []) {
  if (pause === "nowhere") return;
  if (pause !== "everywhere" && pause !== step) return;

  console.log(`\n[pause] ${label}`);
  for (const detail of details) console.log(`  ${detail}`);

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

function listRecordFiles(workspaceDir) {
  const postsDir = path.join(
    workspaceDir,
    "Smoke Postgres",
    "public",
    POSTS_TABLE_NAME,
  );
  if (!fs.existsSync(postsDir)) {
    throw new Error(`Posts directory not found: ${postsDir}`);
  }
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.endsWith(".json")) files.push(fullPath);
    }
  }
  walk(postsDir);
  return files;
}

function editLocalRecords(workspaceDir, runName) {
  const files = listRecordFiles(workspaceDir);
  const touched = [];
  for (const file of files) {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record && typeof record === "object" && record.id != null) {
      record.name = `Edited Post ${record.id} (${runName})`;
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      touched.push(file);
    }
  }
  return touched;
}

// (extractJobIds / readApiToken / waitForJobs removed: `scratchmd files
// publish` polls jobs internally and exits non-zero on failure.)

// ── Main ────────────────────────────────────────────────────────────────────

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

  const workspaceDir = cliArgs.workspace;
  if (!workspaceDir) {
    throw new Error(
      "--workspace <path> is required. Pass the path to the local workspace directory.",
    );
  }
  if (!fs.existsSync(workspaceDir)) {
    throw new Error(`Workspace directory does not exist: ${workspaceDir}`);
  }

  const serverUrl =
    cliArgs.serverUrl || process.env.SCRATCH_API_URL || "http://localhost:3010";
  const binary = resolveBinary(
    cliArgs.binary || process.env.SCRATCH_CLI_BINARY,
  );
  const runName = makeRunName();

  printSection("Re-edit configuration");
  console.log(`CLI binary:    ${binary}`);
  console.log(`Server URL:    ${serverUrl}`);
  console.log(`Workspace dir: ${workspaceDir}`);
  console.log(`Run name:      ${runName}`);

  runCommand(binary, ["--version"]);

  if (cliArgs.noEdit) {
    printSection("Skipping re-edit (--no-edit)");
    console.log("Using existing local file changes.");
  } else {
    printSection("Re-edit local records");
    const editedFiles = editLocalRecords(workspaceDir, runName);
    if (editedFiles.length === 0) {
      throw new Error(
        "No record files found in workspace. Is the workspace path correct?",
      );
    }
    console.log(`Edited ${editedFiles.length} record files.`);

    stopIfNeeded(cliArgs.stop, "records-edited", "Local records re-edited", [
      `Workspace: ${workspaceDir}`,
      `Edited files: ${editedFiles.length}`,
      `Run name: ${runName}`,
    ]);
    await pauseIfNeeded(
      cliArgs.pause,
      "records-edited",
      "Local records re-edited",
      [
        `Workspace: ${workspaceDir}`,
        `Edited files: ${editedFiles.length}`,
        `Run name: ${runName}`,
      ],
    );
  }

  printSection("Accept local changes");
  runCli(binary, serverUrl, ["files", "accept-all"], {
    cwd: workspaceDir,
    noJson: true,
  });

  printSection("Upload reviewed changes");
  runCli(binary, serverUrl, ["files", "upload"], {
    cwd: workspaceDir,
    noJson: true,
  });

  stopIfNeeded(cliArgs.stop, "upload-complete", "Upload complete", [
    `Workspace: ${workspaceDir}`,
  ]);
  await pauseIfNeeded(cliArgs.pause, "upload-complete", "Upload complete", [
    `Workspace: ${workspaceDir}`,
  ]);

  printSection("Publish accepted changes");
  // `files publish` drives `/publish-v2/plan-job` then `/run-job` per
  // connection and polls each to terminal internally.
  runCli(binary, serverUrl, ["files", "publish"], {
    cwd: workspaceDir,
    noJson: true,
  });
  console.log("All publish jobs completed.");

  console.log(`\nRe-edit cycle completed. Run name: ${runName}`);
  console.log("Run this command again to do another edit-push cycle.");
}

main().catch((error) => {
  console.error(`\nDriver push failed: ${error.message}`);
  process.exitCode = 1;
});
