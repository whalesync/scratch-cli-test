import fs from "node:fs";
import { probeStackHealth } from "./stack-health";
import {
  readTestState,
  TEST_STATE_FILE_PATH,
  testStateFileExists,
} from "./test-state";

export default async function globalTeardown() {
  if (!testStateFileExists()) return;

  const state = readTestState();

  // Before dropping the state, compare the build the stack is serving now
  // against the one it served at setup. A change means the test-env was
  // redeployed mid-run, which is the single most common cause of an otherwise
  // inexplicable stall in these suites — say so rather than leaving it to
  // manual triage of the CI trace.
  await reportDeployThatOverlappedTheRun(state.serverUrl, state.buildVersionObservedAtGlobalSetup);

  fs.unlinkSync(TEST_STATE_FILE_PATH);

  // Clean up temp HOME with credentials
  if (state.tempHome) {
    try {
      fs.rmSync(state.tempHome, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

async function reportDeployThatOverlappedTheRun(
  serverUrl: string,
  buildVersionObservedAtGlobalSetup: string | null,
): Promise<void> {
  if (buildVersionObservedAtGlobalSetup === null) return;

  try {
    const probe = await probeStackHealth(serverUrl);
    if (!probe.reachable || probe.buildVersion === null) return;
    if (probe.buildVersion === buildVersionObservedAtGlobalSetup) return;

    console.warn(
      [
        "",
        "==================================================================",
        "[stack-health] A DEPLOY OVERLAPPED THIS RUN.",
        `  build at start: ${buildVersionObservedAtGlobalSetup}`,
        `  build at end:   ${probe.buildVersion}`,
        "  Any stall or timeout above is far more likely a deploy collision",
        "  than a code or test bug. Confirm against #feed-scratch-test before",
        "  investigating further.",
        "==================================================================",
        "",
      ].join("\n"),
    );
  } catch {
    // best effort — teardown must never fail the run
  }
}
