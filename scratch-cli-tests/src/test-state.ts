import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Scratch file that global-setup writes and the suites + global-teardown read.
 * It is the only channel between the Jest global hooks (which run in their own
 * process) and the test workers.
 */
export const TEST_STATE_FILE_PATH = path.join(
  os.tmpdir(),
  "scratch-cli-tests-state.json",
);

export interface TestState {
  binaryPath: string;
  serverUrl: string;
  tempHome: string;
  /**
   * `build_version` reported by `${serverUrl}/health` when global-setup ran.
   * Never mutated afterwards, so global-teardown can tell whether the stack was
   * redeployed at any point during the run. `null` when the server does not
   * report one (e.g. an older local build).
   */
  buildVersionObservedAtGlobalSetup: string | null;
  /**
   * The most recent build version the harness has observed and accepted as
   * settled. Updated whenever the deploy-settle gate rides out a rollout, so a
   * single deploy is only waited on once rather than before every async command.
   */
  mostRecentlySettledBuildVersion: string | null;
}

export function readTestState(): TestState {
  return JSON.parse(fs.readFileSync(TEST_STATE_FILE_PATH, "utf-8")) as TestState;
}

export function writeTestState(state: TestState): void {
  fs.writeFileSync(TEST_STATE_FILE_PATH, JSON.stringify(state));
}

export function testStateFileExists(): boolean {
  return fs.existsSync(TEST_STATE_FILE_PATH);
}

/**
 * Record a newly-settled build version so later suites don't re-wait on the same
 * rollout. Best-effort: a failure here must never fail a test.
 */
export function recordMostRecentlySettledBuildVersion(
  settledBuildVersion: string | null,
): void {
  try {
    const state = readTestState();
    state.mostRecentlySettledBuildVersion = settledBuildVersion;
    writeTestState(state);
  } catch {
    // best effort — the gate still works off its in-memory value this run
  }
}
