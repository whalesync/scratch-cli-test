import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_FILE = path.join(os.tmpdir(), "scratch-cli-tests-state.json");
const DRIVER_SCRIPT = path.resolve(__dirname, "../scripts/driver-run.js");

interface TestState {
  binaryPath: string;
  serverUrl: string;
  tempHome: string;
}

function loadState(): TestState {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

export interface DriverOptions {
  /** Number of records to seed (default: 1) */
  count?: number;
  /** Number of records to edit (default: count) */
  editCount?: number;
  /** Number of records to create (default: 0) */
  createCount?: number;
  /** Number of records to delete (default: 0) */
  deleteCount?: number;
  /**
   * Set post N's authorId to a pseudo-reference pointing at an author file, testing the
   * backfill path in the publish plan. Format: "<postIndex>-<authorTarget>" where authorTarget
   * is 1 (existing seeded author) or 0 (create a new local author file).
   */
  addFk?: string;
}

/**
 * Run the driver script as a subprocess with the binary and credentials
 * resolved by global test setup. Creates and cleans up its own workspace root.
 * Throws if the driver exits non-zero.
 */
export function runDriver(options: DriverOptions = {}): void {
  const state = loadState();

  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "scratch-driver-test-"),
  );

  try {
    const args: string[] = [
      DRIVER_SCRIPT,
      "--count",
      String(options.count ?? 1),
    ];

    if (options.editCount !== undefined) {
      args.push("--edit-count", String(options.editCount));
    }
    if (options.createCount !== undefined) {
      args.push("--create-count", String(options.createCount));
    }
    if (options.deleteCount !== undefined) {
      args.push("--delete-count", String(options.deleteCount));
    }
    if (options.addFk !== undefined) {
      args.push("--add-fk", options.addFk);
    }

    args.push("--workspace-root", workspaceRoot);

    const result = spawnSync("node", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1_000,
      env: {
        ...process.env,
        HOME: state.tempHome,
        SCRATCH_API_URL: state.serverUrl,
        SCRATCH_CLI_BINARY: state.binaryPath,
        // Clear Jest's NODE_OPTIONS so they don't interfere with fetch in the driver subprocess.
        NODE_OPTIONS: "",
      },
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      throw new Error(
        `Driver exited with status ${result.status}:\n${output}`,
      );
    }
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
