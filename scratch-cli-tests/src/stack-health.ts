import { execFileSync } from "node:child_process";

/**
 * Detecting test-env deploys while the suite is running.
 *
 * These tests run against a shared remote stack (test-api.scratch.md) on a
 * schedule, so a merge to master can redeploy the stack mid-run. When the
 * worker service restarts, an already-enqueued publish/pull job simply stops
 * being drained: the CLI keeps polling (it waits up to 30 minutes) but the test
 * harness kills it far sooner, which surfaces as an inscrutable `exit null`.
 *
 * The api service reports its build in `/health`, and every service is deployed
 * from the same pipeline, so a changed `build_version` is a reliable proxy for
 * "a rollout is in flight". We use it two ways:
 *   - as a gate before async, job-backed commands (wait for the rollout to
 *     settle instead of issuing a command the worker can't service), and
 *   - as an after-the-fact annotation in global-teardown, so a run that
 *     overlapped a deploy says so instead of leaving it to manual triage.
 */

/** How long a single `/health` probe may take before we treat it as unreachable. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/** How long the gate will wait for an in-flight rollout to settle. A test-env
 *  Cloud Run rollout takes roughly 2-3 minutes end to end. */
export const DEPLOY_SETTLE_WAIT_BUDGET_MS = 180_000;

/** Gap between probes while waiting for a rollout to settle. */
const DEPLOY_SETTLE_POLL_INTERVAL_MS = 3_000;

/**
 * Consecutive probes that must agree on the same reachable build version before
 * we call the rollout settled. Cloud Run shifts traffic gradually, so a single
 * matching probe can still be followed by one served from the old revision.
 */
const CONSECUTIVE_AGREEING_PROBES_REQUIRED_TO_SETTLE = 2;

export interface StackHealthProbeResult {
  reachable: boolean;
  httpStatus: number;
  buildVersion: string | null;
  errorMessage: string | null;
}

/**
 * Runs in a throwaway `node -e` subprocess so the probe can be called from the
 * synchronous `ScratchCli.run` path (there is no synchronous `fetch`).
 */
const HEALTH_PROBE_SUBPROCESS_SCRIPT = `
const healthUrl = process.argv[1];
const timeoutMs = Number(process.argv[2]);
fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) })
  .then(async (response) => {
    let body = {};
    if (response.ok) {
      try {
        body = await response.json();
      } catch {
        body = {};
      }
    }
    process.stdout.write(
      JSON.stringify({
        reachable: response.ok,
        httpStatus: response.status,
        buildVersion: body.build_version ?? null,
        errorMessage: null,
      }),
    );
  })
  .catch((err) => {
    process.stdout.write(
      JSON.stringify({
        reachable: false,
        httpStatus: 0,
        buildVersion: null,
        errorMessage: err && err.message ? err.message : String(err),
      }),
    );
  });
`;

function healthUrlFor(serverUrl: string): string {
  return new URL("/health", serverUrl).toString();
}

/** Async probe, for the Jest global hooks. */
export async function probeStackHealth(
  serverUrl: string,
): Promise<StackHealthProbeResult> {
  try {
    const response = await fetch(healthUrlFor(serverUrl), {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        reachable: false,
        httpStatus: response.status,
        buildVersion: null,
        errorMessage: null,
      };
    }
    const body = (await response.json().catch(() => ({}))) as {
      build_version?: string;
    };
    return {
      reachable: true,
      httpStatus: response.status,
      buildVersion: body.build_version ?? null,
      errorMessage: null,
    };
  } catch (err) {
    return {
      reachable: false,
      httpStatus: 0,
      buildVersion: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Synchronous probe, for use from `ScratchCli.run` (which is `execSync`-based). */
export function probeStackHealthSynchronously(
  serverUrl: string,
): StackHealthProbeResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        "-e",
        HEALTH_PROBE_SUBPROCESS_SCRIPT,
        healthUrlFor(serverUrl),
        String(HEALTH_PROBE_TIMEOUT_MS),
      ],
      {
        encoding: "utf-8",
        timeout: HEALTH_PROBE_TIMEOUT_MS + 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return JSON.parse(stdout) as StackHealthProbeResult;
  } catch (err) {
    return {
      reachable: false,
      httpStatus: 0,
      buildVersion: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function sleepSynchronously(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

export interface DeploySettleWaitOutcome {
  /** True when the stack was unreachable or on a different build than expected. */
  deployWasDetected: boolean;
  /** The build version the stack settled on, when we managed to observe one. */
  settledBuildVersion: string | null;
  waitedMs: number;
  /** True when the settle budget ran out before the stack stabilized. */
  budgetExhausted: boolean;
}

/**
 * Block until the stack looks settled, when (and only when) it currently looks
 * like a deploy is in flight.
 *
 * Returns immediately in the common case — a reachable stack still serving
 * `expectedBuildVersion`. Also returns immediately when `expectedBuildVersion`
 * is `null`, i.e. the server doesn't report a build version at all, so local
 * runs against a dev server are never gated.
 */
export function waitForInFlightDeployToSettleSynchronously(
  serverUrl: string,
  expectedBuildVersion: string | null,
  settleBudgetMs: number = DEPLOY_SETTLE_WAIT_BUDGET_MS,
): DeploySettleWaitOutcome {
  if (expectedBuildVersion === null) {
    return {
      deployWasDetected: false,
      settledBuildVersion: null,
      waitedMs: 0,
      budgetExhausted: false,
    };
  }

  const firstProbe = probeStackHealthSynchronously(serverUrl);
  if (firstProbe.reachable && firstProbe.buildVersion === expectedBuildVersion) {
    return {
      deployWasDetected: false,
      settledBuildVersion: firstProbe.buildVersion,
      waitedMs: 0,
      budgetExhausted: false,
    };
  }

  console.warn(
    `[stack-health] Stack does not look settled (expected build ${expectedBuildVersion}, ` +
      `saw ${describeProbe(firstProbe)}). A test-env deploy is probably in flight — ` +
      `waiting up to ${Math.round(settleBudgetMs / 1000)}s before issuing the next async command.`,
  );

  const waitStartedAtMs = Date.now();
  let previouslySeenBuildVersion: string | null = null;
  let consecutiveAgreeingProbes = 0;

  while (Date.now() - waitStartedAtMs < settleBudgetMs) {
    sleepSynchronously(DEPLOY_SETTLE_POLL_INTERVAL_MS);
    const probe = probeStackHealthSynchronously(serverUrl);

    if (!probe.reachable || probe.buildVersion === null) {
      consecutiveAgreeingProbes = 0;
      previouslySeenBuildVersion = null;
      continue;
    }

    if (probe.buildVersion === previouslySeenBuildVersion) {
      consecutiveAgreeingProbes += 1;
    } else {
      previouslySeenBuildVersion = probe.buildVersion;
      consecutiveAgreeingProbes = 1;
    }

    if (consecutiveAgreeingProbes >= CONSECUTIVE_AGREEING_PROBES_REQUIRED_TO_SETTLE) {
      const waitedMs = Date.now() - waitStartedAtMs;
      console.warn(
        `[stack-health] Stack settled on build ${probe.buildVersion} after ${Math.round(waitedMs / 1000)}s.`,
      );
      return {
        deployWasDetected: true,
        settledBuildVersion: probe.buildVersion,
        waitedMs,
        budgetExhausted: false,
      };
    }
  }

  const waitedMs = Date.now() - waitStartedAtMs;
  console.warn(
    `[stack-health] Stack still unsettled after ${Math.round(waitedMs / 1000)}s — ` +
      `proceeding anyway. A failure just after this line is very likely a deploy collision, not a code bug.`,
  );
  return {
    deployWasDetected: true,
    settledBuildVersion: previouslySeenBuildVersion,
    waitedMs,
    budgetExhausted: true,
  };
}

function describeProbe(probe: StackHealthProbeResult): string {
  if (probe.reachable) {
    return `build ${probe.buildVersion ?? "unknown"}`;
  }
  if (probe.errorMessage) {
    return `unreachable (${probe.errorMessage})`;
  }
  return `unreachable (HTTP ${probe.httpStatus})`;
}
