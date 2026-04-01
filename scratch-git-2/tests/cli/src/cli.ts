import {
  execSync,
  ExecSyncOptionsWithStringEncoding,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_FILE = path.join(os.tmpdir(), "scratch-cli-tests-state.json");

interface TestState {
  binaryPath: string;
  serverUrl: string;
  tempHome: string;
}

function loadState(): TestState {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ScratchCli {
  private binaryPath: string;
  private serverUrl: string;
  private tempHome: string;

  constructor() {
    const state = loadState();
    this.binaryPath = state.binaryPath;
    this.serverUrl = state.serverUrl;
    this.tempHome = state.tempHome;
  }

  /**
   * Run the CLI with the given arguments.
   * --json and --scratch-url are automatically appended.
   * HOME is pointed at the temp directory with pre-seeded credentials.
   */
  run(
    args: string[],
    opts?: { cwd?: string; expectError?: boolean; noJson?: boolean },
  ): ExecResult {
    const fullArgs = [
      ...args,
      ...(opts?.noJson ? [] : ["--json"]),
      "--scratch-url",
      this.serverUrl,
    ];

    const cmd = `${this.binaryPath} ${fullArgs.map(shellEscape).join(" ")}`;

    const execOpts: ExecSyncOptionsWithStringEncoding = {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: this.tempHome, // Use temp HOME so CLI reads our seeded credentials
      },
      cwd: opts?.cwd,
      timeout: 60_000,
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
  json<T = unknown>(
    args: string[],
    opts?: { cwd?: string; expectError?: boolean },
  ): T {
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
}

function shellEscape(arg: string): string {
  if (!/[^a-zA-Z0-9_\-=/.:]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
