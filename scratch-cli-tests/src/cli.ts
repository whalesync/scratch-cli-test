import {
  execSync,
  ExecSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  recordMostRecentlySettledBuildVersion,
  readTestState,
} from "./test-state";
import { waitForInFlightDeployToSettleSynchronously } from "./stack-health";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Default allowance for a CLI command. Fine for everything that completes in a
 * single request/response.
 */
const DEFAULT_CLI_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Allowance for commands that enqueue a server-side job and then poll it.
 *
 * These stall — rather than fail — whenever the worker service isn't draining
 * the queue, which is exactly what happens during a test-env redeploy (a Cloud
 * Run rollout takes ~2-3 minutes). The CLI itself polls for up to 30 minutes
 * (`scratch-git-2/src/cli/api/mod.rs`, `poll_job`), so the old blanket 60s cap
 * meant the harness gave up ~29 minutes before the tool it was testing would
 * have. This allowance is deliberately longer than a rollout and still far
 * shorter than the CLI's own patience, so a genuine hang is still caught.
 */
const ASYNC_JOB_POLLING_CLI_COMMAND_TIMEOUT_MS = 300_000;

/**
 * Commands that dispatch a job and poll it to completion — i.e. every call site
 * of `poll_job` in `scratch-git-2/src/cli/`, expressed as
 * `[command group, action]`.
 */
const ASYNC_JOB_POLLING_CLI_COMMANDS: ReadonlyArray<readonly [string, string]> =
  [
    ["files", "publish"],
    ["files", "upload"],
    ["linked", "pull"],
    ["linked", "publish"],
    ["syncs", "run"],
  ];

/**
 * Whether `args` invokes a job-polling command.
 *
 * The action is matched anywhere after the group rather than at a fixed index,
 * because parent-level flags may sit between them (e.g.
 * `linked --workspace <id> pull <folder>`). A value that happens to equal an
 * action name would match too — harmless, since the only consequence is a more
 * generous timeout and a health probe.
 */
function isAsyncJobPollingCliCommand(args: string[]): boolean {
  return ASYNC_JOB_POLLING_CLI_COMMANDS.some(
    ([commandGroup, action]) =>
      args[0] === commandGroup && args.slice(1).includes(action),
  );
}

function defaultTimeoutMsForCliCommand(args: string[]): number {
  return isAsyncJobPollingCliCommand(args)
    ? ASYNC_JOB_POLLING_CLI_COMMAND_TIMEOUT_MS
    : DEFAULT_CLI_COMMAND_TIMEOUT_MS;
}

export interface RunOptions {
  cwd?: string;
  expectError?: boolean;
  noJson?: boolean;
  /** Override the timeout for this command. Defaults by command kind. */
  timeoutMs?: number;
  /**
   * Skip the pre-command deploy-settle gate. Only useful for tests that
   * deliberately exercise an unhealthy stack.
   */
  skipDeploySettleGate?: boolean;
}

export class ScratchCli {
  private binaryPath: string;
  private serverUrl: string;
  private tempHome: string;

  constructor() {
    const state = readTestState();
    this.binaryPath = state.binaryPath;
    this.serverUrl = state.serverUrl;
    this.tempHome = state.tempHome;
  }

  /**
   * Run the CLI with the given arguments.
   * --json and --scratch-url are automatically appended.
   * HOME is pointed at the temp directory with pre-seeded credentials.
   */
  run(args: string[], opts?: RunOptions): ExecResult {
    const fullArgs = [
      ...args,
      ...(opts?.noJson ? [] : ["--json"]),
      "--scratch-url",
      this.serverUrl,
    ];

    const cmd = `${this.binaryPath} ${fullArgs.map(shellEscape).join(" ")}`;
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMsForCliCommand(args);

    if (isAsyncJobPollingCliCommand(args) && !opts?.skipDeploySettleGate) {
      this.waitForStackToSettleBeforeAsyncCommand();
    }

    const execOpts: ExecSyncOptionsWithStringEncoding = {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: this.tempHome, // Use temp HOME so CLI reads our seeded credentials
      },
      cwd: opts?.cwd,
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    };

    if (process.env.DEBUG) {
      console.log(`[cli] ${cmd}`);
    }

    try {
      const stdout = execSync(cmd, execOpts);
      if (process.env.DEBUG) {
        console.log(`[cli:out] ${stdout}`);
      }
      return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
    } catch (err: any) {
      // A harness timeout is never the error a test is asking for with
      // `expectError`, so it throws either way rather than being handed back as
      // if the CLI had rejected the command on its merits.
      if (wasKilledByHarnessTimeout(err)) {
        throw new Error(buildTimeoutErrorMessage(cmd, timeoutMs, err));
      }

      if (opts?.expectError) {
        return {
          stdout: (err.stdout || "").trim(),
          stderr: (err.stderr || "").trim(),
          exitCode: err.status ?? 1,
        };
      }
      throw new Error(
        `CLI command failed (exit ${err.status}):\n` +
          `  cmd: ${cmd}\n` +
          `  stdout: ${err.stdout}\n` +
          `  stderr: ${err.stderr}`,
      );
    }
  }

  /** Run and parse JSON output. Extracts the first JSON object/array if extra text follows. */
  json<T = unknown>(args: string[], opts?: RunOptions): T {
    const result = this.run(args, opts);
    const stdout = result.stdout;

    // Try parsing the full output first
    try {
      return JSON.parse(stdout) as T;
    } catch {
      // Some commands (e.g. linked add) output JSON followed by extra text.
      // Extract the first complete JSON value.
      const start =
        stdout.indexOf("{") === -1 ? stdout.indexOf("[") : stdout.indexOf("{");
      if (start === -1)
        throw new Error(`No JSON found in CLI output:\n${stdout}`);

      const opener = stdout[start];
      const closer = opener === "{" ? "}" : "]";
      let depth = 0;
      for (let i = start; i < stdout.length; i++) {
        if (stdout[i] === opener) depth++;
        else if (stdout[i] === closer) depth--;
        if (depth === 0) {
          return JSON.parse(stdout.slice(start, i + 1)) as T;
        }
      }
      throw new Error(`Incomplete JSON in CLI output:\n${stdout}`);
    }
  }

  /** Get the temp HOME path (for cwd-based tests like files download/upload) */
  get home(): string {
    return this.tempHome;
  }

  /**
   * Before dispatching a job the worker has to drain, make sure the stack isn't
   * mid-rollout. Reads the expected build version from the state file each time
   * so a rollout ridden out by an earlier suite isn't waited on again.
   */
  private waitForStackToSettleBeforeAsyncCommand(): void {
    let expectedBuildVersion: string | null = null;
    try {
      expectedBuildVersion = readTestState().mostRecentlySettledBuildVersion;
    } catch {
      return; // no usable state — never block a test on the gate itself
    }

    const outcome = waitForInFlightDeployToSettleSynchronously(
      this.serverUrl,
      expectedBuildVersion,
    );

    if (outcome.deployWasDetected && outcome.settledBuildVersion !== null) {
      recordMostRecentlySettledBuildVersion(outcome.settledBuildVersion);
    }
  }
}

function wasKilledByHarnessTimeout(err: any): boolean {
  // execSync surfaces a timeout as code ETIMEDOUT with signal SIGTERM and a
  // null exit status — note it does NOT set `killed` (that's the async
  // child_process APIs). The status/signal pair is kept as a fallback for a
  // SIGTERM that arrives without the ETIMEDOUT code.
  if (err?.code === "ETIMEDOUT") return true;
  return err?.signal === "SIGTERM" && err?.status === null;
}

function buildTimeoutErrorMessage(
  cmd: string,
  timeoutMs: number,
  err: any,
): string {
  return (
    `CLI command TIMED OUT after ${Math.round(timeoutMs / 1000)}s ` +
    `(killed with ${err?.signal ?? "SIGTERM"} by the test harness, not by the CLI).\n` +
    `  The CLI polls server-side jobs for up to 30 minutes, so a harness timeout on a\n` +
    `  job-backed command almost always means the job was never drained — most often\n` +
    `  because the worker service was redeploying. Check #feed-scratch-test for a\n` +
    `  deploy overlapping this run, and see any [stack-health] warnings above.\n` +
    `  cmd: ${cmd}\n` +
    `  stdout: ${err?.stdout ?? ""}\n` +
    `  stderr: ${err?.stderr ?? ""}`
  );
}

function shellEscape(arg: string): string {
  if (!/[^a-zA-Z0-9_\-=/.:]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
