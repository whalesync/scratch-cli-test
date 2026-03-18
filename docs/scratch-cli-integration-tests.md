# Scratch CLI Integration Tests — Design Document

## Overview

Black-box integration tests for the `scratchmd` Go CLI binary, modeled after the `scratch-git-tests` suite. Tests are written in TypeScript with Jest and exercise the CLI by **shelling out to the compiled `scratchmd` binary**, parsing its `--json` output.

Authentication uses a **Scratch API key** injected into the CLI's credentials file during global setup, bypassing the OAuth device-code flow entirely.

## Directory Structure

```
scratch-cli-tests/
├── package.json
├── tsconfig.json
├── jest.config.js
├── .env.integration.example  # Checked in — documents required variables
├── .env.integration           # Git-ignored — local secrets
├── src/
│   ├── cli.ts              # ScratchCli — typed wrapper that shells out to the scratchmd binary
│   ├── helpers.ts           # Unique-name generators, job polling, temp directory management
│   ├── global-setup.ts      # Load .env, build binary, write credentials, health-check server
│   └── global-teardown.ts   # Clean up temp credentials and test artifacts
└── tests/
    ├── workspaces.spec.ts
    ├── connections.spec.ts
    ├── linked-folders.spec.ts
    └── files.spec.ts
```

## Environment Configuration

Tests target different environments via environment variables:

| Variable             | Required | Description                         | Examples                                                                               |
| -------------------- | -------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `SCRATCH_API_KEY`    | **yes**  | API key for authentication          | `sk_test_abc123`                                                                       |
| `SCRATCH_API_URL`    | no       | Base URL of the Scratch server      | `http://localhost:3010` (default), `https://test.scratch.md`, `https://app.scratch.md` |
| `TEST_AIRTABLE_PAT`  | no\*     | Airtable Personal Access Token      | Required for connection/linked/files suites                                            |
| `SCRATCH_CLI_BINARY` | no       | Path to prebuilt `scratchmd` binary | Skips `go build` if set                                                                |
| `DEBUG`              | no       | Set to `1` for verbose CLI output   |                                                                                        |

\* If `TEST_AIRTABLE_PAT` is not set, the connections, linked folders, and files suites will be skipped.

### Running Tests

```bash
# Against localhost (default)
SCRATCH_API_KEY=sk_test_... yarn test

# Against test environment
SCRATCH_API_URL=https://test.scratch.md SCRATCH_API_KEY=sk_test_... yarn test

# Against production
SCRATCH_API_URL=https://app.scratch.md SCRATCH_API_KEY=sk_live_... yarn test

# Single suite
SCRATCH_API_KEY=sk_test_... yarn test -- --testPathPattern=workspaces

# With a prebuilt binary (skip go build)
SCRATCH_CLI_BINARY=/usr/local/bin/scratchmd SCRATCH_API_KEY=sk_test_... yarn test

# Debug — show raw CLI stdout/stderr
DEBUG=1 SCRATCH_API_KEY=sk_test_... yarn test
```

## Package Setup

### `package.json`

```json
{
  "name": "scratch-cli-tests",
  "version": "1.0.0",
  "description": "Integration tests for the scratchmd CLI binary",
  "private": true,
  "license": "UNLICENSED",
  "scripts": {
    "test": "jest --runInBand --forceExit",
    "test:watch": "jest --runInBand --watch --forceExit"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/node": "^20.10.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5",
    "typescript": "^5.9.3"
  }
}
```

### `jest.config.js`

```js
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.spec.ts"],
  globalSetup: "./src/global-setup.ts",
  globalTeardown: "./src/global-teardown.ts",
  testTimeout: 120000, // 120s — pull/publish operations can be slow
};
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["jest", "node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

## Global Setup & Teardown

### `src/global-setup.ts`

The global setup handles three responsibilities:

1. **Build the CLI binary** (unless `SCRATCH_CLI_BINARY` is set)
2. **Write a credentials file** so the CLI can authenticate without `auth login`
3. **Health-check the target server**

```ts
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml"; // or use a simple string template

const STATE_FILE = path.join(os.tmpdir(), "scratch-cli-tests-state.json");

export default async function globalSetup() {
  const apiKey = process.env.SCRATCH_API_KEY;
  if (!apiKey) {
    throw new Error("SCRATCH_API_KEY environment variable is required");
  }

  const serverUrl = process.env.SCRATCH_API_URL || "http://localhost:3010";

  // 1. Resolve or build the CLI binary
  let binaryPath = process.env.SCRATCH_CLI_BINARY;
  if (!binaryPath) {
    const cliDir = path.resolve(__dirname, "../../scratch-cli");
    console.log("Building scratchmd binary...");
    execSync("go build -o ./scratchmd ./cmd/scratchmd", {
      cwd: cliDir,
      stdio: "inherit",
    });
    binaryPath = path.join(cliDir, "scratchmd");
  }

  // Verify binary exists and is executable
  execSync(`${binaryPath} --version`, { stdio: "pipe" });

  // 2. Write credentials file to an isolated temp HOME
  //    so tests don't interfere with the developer's real credentials
  const tempHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "scratch-cli-test-home-"),
  );
  const credsDir = path.join(tempHome, ".scratchmd");
  fs.mkdirSync(credsDir, { recursive: true });

  // The CLI credentials.yaml format (v2): keyed by normalized server hostname
  const hostname = new URL(serverUrl).hostname;
  const credsContent = [
    "# Auto-generated by scratch-cli-tests",
    'version: "2.0.0"',
    "environments:",
    `  ${hostname}:`,
    `    apiToken: "${apiKey}"`,
    "",
  ].join("\n");

  fs.writeFileSync(path.join(credsDir, "credentials.yaml"), credsContent, {
    mode: 0o600,
  });

  // 3. Health check the target server
  const healthUrl = `${serverUrl}/health`;
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) break;
    } catch {
      // not ready
    }
    if (i === maxAttempts - 1) {
      throw new Error(
        `Server at ${serverUrl} did not become healthy within 15s`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Save state for test helpers and teardown
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ binaryPath, serverUrl, tempHome }),
  );
}
```

### `src/global-teardown.ts`

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_FILE = path.join(os.tmpdir(), "scratch-cli-tests-state.json");

export default async function globalTeardown() {
  if (!fs.existsSync(STATE_FILE)) return;

  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  fs.unlinkSync(STATE_FILE);

  // Clean up temp HOME with credentials
  if (state.tempHome) {
    try {
      fs.rmSync(state.tempHome, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
```

## CLI Wrapper

### `src/cli.ts`

The core abstraction — a typed class that shells out to the `scratchmd` binary, passes `--json` for machine-readable output, and parses the result.

```ts
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
    opts?: { cwd?: string; expectError?: boolean },
  ): ExecResult {
    const fullArgs = [...args, "--json", "--scratch-url", this.serverUrl];

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

  /** Run and parse JSON output */
  json<T = unknown>(
    args: string[],
    opts?: { cwd?: string; expectError?: boolean },
  ): T {
    const result = this.run(args, opts);
    return JSON.parse(result.stdout) as T;
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
```

### `src/helpers.ts`

```ts
import crypto from "node:crypto";
import { ScratchCli } from "./cli";

let counter = 0;

/** Generate a unique name for test isolation */
export function uniqueName(prefix = "cli-test"): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${prefix}-${ts}-${rand}-${counter++}`;
}

/**
 * Delete a workspace, used in afterAll/afterEach cleanup.
 * Silently ignores failures.
 */
export function deleteWorkspace(cli: ScratchCli, workspaceId: string): void {
  try {
    cli.run(["workspaces", "delete", workspaceId, "--yes"]);
  } catch {
    // best effort
  }
}
```

## Test Suites

All tests instantiate a `ScratchCli` that shells out to the real binary with `--json` output. The CLI reads credentials from the temp HOME seeded in global setup.

### 1. Workspaces (`tests/workspaces.spec.ts`)

CRUD lifecycle tests for workspaces.

```ts
import { ScratchCli } from "../src/cli";
import { uniqueName, deleteWorkspace } from "../src/helpers";

const cli = new ScratchCli();

describe("Workspaces", () => {
  let workspaceId: string;

  afterEach(() => {
    if (workspaceId) {
      deleteWorkspace(cli, workspaceId);
      workspaceId = "";
    }
  });

  describe("create", () => {
    it("should create a workspace with a name", () => {
      const name = uniqueName("ws");
      const result = cli.json<{ id: string; name: string }>([
        "workspaces",
        "create",
        "--name",
        name,
      ]);
      workspaceId = result.id;
      expect(result.name).toBe(name);
      expect(result.id).toBeTruthy();
    });
  });

  describe("show", () => {
    it("should retrieve a workspace by ID", () => {
      const name = uniqueName("ws");
      const created = cli.json<{ id: string }>([
        "workspaces",
        "create",
        "--name",
        name,
      ]);
      workspaceId = created.id;

      const shown = cli.json<{ id: string; name: string; version: number }>([
        "workspaces",
        "show",
        workspaceId,
      ]);
      expect(shown.id).toBe(workspaceId);
      expect(shown.name).toBe(name);
      expect(shown.version).toBe(2);
    });

    it("should fail for a non-existent workspace", () => {
      const result = cli.run(["workspaces", "show", "wkb_nonexistent"], {
        expectError: true,
      });
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("list", () => {
    it("should include the created workspace in the list", () => {
      const name = uniqueName("ws");
      const created = cli.json<{ id: string }>([
        "workspaces",
        "create",
        "--name",
        name,
      ]);
      workspaceId = created.id;

      const list = cli.json<{
        workspaces: Array<{ id: string; name: string }>;
      }>(["workspaces", "list"]);
      expect(list.workspaces.some((ws) => ws.id === workspaceId)).toBe(true);
    });
  });

  describe("delete", () => {
    it("should delete a workspace", () => {
      const name = uniqueName("ws");
      const created = cli.json<{ id: string }>([
        "workspaces",
        "create",
        "--name",
        name,
      ]);
      const id = created.id;

      cli.run(["workspaces", "delete", id, "--yes"]);

      const result = cli.run(["workspaces", "show", id], { expectError: true });
      expect(result.exitCode).not.toBe(0);
      workspaceId = ""; // already deleted
    });
  });
});
```

---

### 2. Connections (`tests/connections.spec.ts`)

Tests require a live external service credential via `TEST_AIRTABLE_PAT`. Suite is skipped if not set.

```ts
import { ScratchCli } from "../src/cli";
import { uniqueName, deleteWorkspace } from "../src/helpers";

const cli = new ScratchCli();
const airtablePat = process.env.TEST_AIRTABLE_PAT;

const describeIfAirtable = airtablePat ? describe : describe.skip;

describeIfAirtable("Connections", () => {
  let workspaceId: string;
  let connectionId: string;

  beforeAll(() => {
    const ws = cli.json<{ id: string }>([
      "workspaces",
      "create",
      "--name",
      uniqueName("conn"),
    ]);
    workspaceId = ws.id;
  });

  afterAll(() => {
    if (workspaceId) deleteWorkspace(cli, workspaceId);
  });

  describe("add", () => {
    it("should create an Airtable connection", () => {
      const result = cli.json<{ id: string; service: string }>([
        "connections",
        "add",
        "--workspace",
        workspaceId,
        "--service",
        "AIRTABLE",
        "--param",
        `apiKey=${airtablePat}`,
        "--name",
        uniqueName("airtable"),
      ]);
      connectionId = result.id;
      expect(result.service).toBe("AIRTABLE");
      expect(result.id).toBeTruthy();
    });
  });

  describe("list", () => {
    it("should list connections for the workspace", () => {
      const result = cli.json<Array<{ id: string }>>([
        "connections",
        "list",
        "--workspace",
        workspaceId,
      ]);
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.some((c) => c.id === connectionId)).toBe(true);
    });
  });

  describe("show", () => {
    it("should show connection details", () => {
      const result = cli.json<{ id: string; service: string }>([
        "connections",
        "show",
        connectionId,
        "--workspace",
        workspaceId,
      ]);
      expect(result.id).toBe(connectionId);
      expect(result.service).toBe("AIRTABLE");
    });
  });

  describe("remove", () => {
    it("should remove a connection", () => {
      cli.run([
        "connections",
        "remove",
        connectionId,
        "--workspace",
        workspaceId,
        "--yes",
      ]);

      const list = cli.json<Array<{ id: string }>>([
        "connections",
        "list",
        "--workspace",
        workspaceId,
      ]);
      expect(list.some((c) => c.id === connectionId)).toBe(false);
    });
  });
});
```

---

### 3. Linked Folders (`tests/linked-folders.spec.ts`)

Depends on a live Airtable connection. Exercises the full linked table lifecycle.

```ts
import { ScratchCli } from "../src/cli";
import { uniqueName, deleteWorkspace } from "../src/helpers";

const cli = new ScratchCli();
const airtablePat = process.env.TEST_AIRTABLE_PAT;

const describeIfAirtable = airtablePat ? describe : describe.skip;

describeIfAirtable("Linked Folders", () => {
  let workspaceId: string;
  let connectionId: string;
  let linkedFolderId: string;

  beforeAll(() => {
    // Create workspace
    const ws = cli.json<{ id: string }>([
      "workspaces",
      "create",
      "--name",
      uniqueName("linked"),
    ]);
    workspaceId = ws.id;

    // Add Airtable connection
    const conn = cli.json<{ id: string }>([
      "connections",
      "add",
      "--workspace",
      workspaceId,
      "--service",
      "AIRTABLE",
      "--param",
      `apiKey=${airtablePat}`,
    ]);
    connectionId = conn.id;
  });

  afterAll(() => {
    if (workspaceId) deleteWorkspace(cli, workspaceId);
  });

  describe("available", () => {
    it("should list available tables from the connection", () => {
      const result = cli.json<{
        tables: Array<{ id: string; displayName: string }>;
      }>(["linked", "available", connectionId, "--workspace", workspaceId]);
      expect(result.tables.length).toBeGreaterThan(0);
    });
  });

  describe("add", () => {
    it("should link a table to the workspace", () => {
      // First discover available tables
      const tables = cli.json<{
        tables: Array<{ id: string; displayName: string }>;
      }>(["linked", "available", connectionId, "--workspace", workspaceId]);
      const firstTable = tables.tables[0];

      const result = cli.json<{ id: string; name: string }>([
        "linked",
        "add",
        "--workspace",
        workspaceId,
        "--connection",
        connectionId,
        "--table",
        firstTable.id,
        "--name",
        firstTable.displayName,
      ]);
      linkedFolderId = result.id;
      expect(result.name).toBe(firstTable.displayName);
    });
  });

  describe("list", () => {
    it("should list linked folders grouped by connector", () => {
      const result = cli.json<Array<{ dataFolders: Array<{ id: string }> }>>([
        "linked",
        "list",
        "--workspace",
        workspaceId,
      ]);
      const allFolders = result.flatMap((g) => g.dataFolders);
      expect(allFolders.some((f) => f.id === linkedFolderId)).toBe(true);
    });
  });

  describe("show", () => {
    it("should show linked folder details with change counts", () => {
      const result = cli.json<{
        id: string;
        creates: number;
        updates: number;
        deletes: number;
      }>(["linked", "show", linkedFolderId, "--workspace", workspaceId]);
      expect(result.id).toBe(linkedFolderId);
      expect(typeof result.creates).toBe("number");
    });
  });

  describe("pull", () => {
    it("should pull data from the remote and complete successfully", () => {
      // `linked pull` with --json waits for the job and prints the result
      const result = cli.run([
        "linked",
        "pull",
        linkedFolderId,
        "--workspace",
        workspaceId,
      ]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("remove", () => {
    it("should unlink a folder from the workspace", () => {
      cli.run([
        "linked",
        "remove",
        linkedFolderId,
        "--workspace",
        workspaceId,
        "--yes",
      ]);

      const list = cli.json<Array<{ dataFolders: Array<{ id: string }> }>>([
        "linked",
        "list",
        "--workspace",
        workspaceId,
      ]);
      const allFolders = list.flatMap((g) => g.dataFolders);
      expect(allFolders.some((f) => f.id === linkedFolderId)).toBe(false);
    });
  });
});
```

---

### 4. Files (`tests/files.spec.ts`)

Tests the `files download` and `files upload` commands, which operate via git clone/fetch/push. These tests use `workspaces init` to clone the workspace locally, then exercise the download/upload round-trip.

```ts
import fs from "node:fs";
import path from "node:path";
import { ScratchCli } from "../src/cli";
import { uniqueName, deleteWorkspace } from "../src/helpers";

const cli = new ScratchCli();
const airtablePat = process.env.TEST_AIRTABLE_PAT;

const describeIfAirtable = airtablePat ? describe : describe.skip;

describeIfAirtable("Files", () => {
  let workspaceId: string;
  let connectionId: string;
  let linkedFolderId: string;
  let workspaceDir: string;

  beforeAll(() => {
    // Full setup: workspace → connection → linked folder → pull
    const ws = cli.json<{ id: string }>([
      "workspaces",
      "create",
      "--name",
      uniqueName("files"),
    ]);
    workspaceId = ws.id;

    const conn = cli.json<{ id: string }>([
      "connections",
      "add",
      "--workspace",
      workspaceId,
      "--service",
      "AIRTABLE",
      "--param",
      `apiKey=${airtablePat}`,
    ]);
    connectionId = conn.id;

    const tables = cli.json<{
      tables: Array<{ id: string; displayName: string }>;
    }>(["linked", "available", connectionId, "--workspace", workspaceId]);
    const firstTable = tables.tables[0];

    const linked = cli.json<{ id: string }>([
      "linked",
      "add",
      "--workspace",
      workspaceId,
      "--connection",
      connectionId,
      "--table",
      firstTable.id,
      "--name",
      firstTable.displayName,
    ]);
    linkedFolderId = linked.id;

    // Pull data from Airtable
    cli.run(["linked", "pull", linkedFolderId, "--workspace", workspaceId]);

    // Init (clone) workspace locally
    workspaceDir = path.join(cli.home, "test-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    cli.run(["workspaces", "init", workspaceId], { cwd: workspaceDir });
  });

  afterAll(() => {
    if (workspaceId) deleteWorkspace(cli, workspaceId);
    if (workspaceDir) {
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  describe("download", () => {
    it("should download files from the workspace", () => {
      const result = cli.run(["files", "download"], { cwd: workspaceDir });
      expect(result.exitCode).toBe(0);
    });

    it("should have files on disk after download", () => {
      // V2 workspaces have connector subdirectories with data folders inside
      const entries = fs.readdirSync(workspaceDir);
      // Should have at least the .scratchmd marker and a connector directory
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((e) => e === ".scratchmd")).toBe(true);
    });
  });

  describe("upload", () => {
    it("should upload with no local changes (no-op)", () => {
      const result = cli.run(["files", "upload"], { cwd: workspaceDir });
      expect(result.exitCode).toBe(0);
    });
  });

  describe("round-trip", () => {
    it("should handle download → local edit → upload → download cycle", () => {
      // Find a markdown file in the workspace
      const findMdFiles = (dir: string): string[] => {
        const results: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            results.push(...findMdFiles(fullPath));
          } else if (entry.name.endsWith(".md")) {
            results.push(fullPath);
          }
        }
        return results;
      };

      const mdFiles = findMdFiles(workspaceDir);
      if (mdFiles.length === 0) {
        console.warn("No markdown files found — skipping round-trip test");
        return;
      }

      // Append to a file
      const targetFile = mdFiles[0];
      const original = fs.readFileSync(targetFile, "utf-8");
      fs.writeFileSync(targetFile, original + "\n<!-- test edit -->");

      // Upload
      const uploadResult = cli.run(["files", "upload"], { cwd: workspaceDir });
      expect(uploadResult.exitCode).toBe(0);

      // Restore original content and download to verify
      fs.writeFileSync(targetFile, original);
      const downloadResult = cli.run(["files", "download"], {
        cwd: workspaceDir,
      });
      expect(downloadResult.exitCode).toBe(0);

      // File should contain our edit (merged from server)
      const afterDownload = fs.readFileSync(targetFile, "utf-8");
      expect(afterDownload).toContain("<!-- test edit -->");
    });
  });
});
```

## Key Design Decisions

### Why shell out to the binary instead of HTTP calls?

- Tests the **full CLI stack**: argument parsing, flag handling, credential loading, `--json` serialization, exit codes
- Catches regressions in the Cobra command wiring, not just the server API
- Exercises the same code path real users run
- The `files download/upload` commands involve git operations that can't be tested via HTTP alone

### Credential injection via temp HOME

The CLI reads credentials from `~/.scratchmd/credentials.yaml`. Instead of modifying the developer's real credentials file, global setup creates a temp directory, seeds it with the API key, and sets `HOME` to that directory when invoking the CLI. This provides full isolation.

### `--json` for machine-readable output

Every CLI command supports `--json` which outputs structured JSON instead of human-readable tables. Tests always pass `--json` and parse the result with `JSON.parse()`.

### `--yes` for non-interactive operations

Delete commands (`workspaces delete`, `connections remove`, `linked remove`) prompt for confirmation. Tests always pass `--yes` to skip the prompt.

### `--scratch-url` for environment targeting

The CLI accepts `--scratch-url` as a persistent flag to override the server URL. This is how tests point at localhost, test, or production.

## Test Isolation & Safety

### Resource Cleanup

- Every test suite creates its own workspace in `beforeAll` and deletes it in `afterAll`
- Workspace deletion cascades to connections, linked folders, and the git repo
- Cleanup uses `--yes` and is wrapped in try/catch

### Unique Naming

All resources use `uniqueName()` with a `cli-test-` prefix for easy identification and manual cleanup.

### Temp Directories

- Credentials live in a temp HOME, cleaned up in global teardown
- File test workspace directories are cleaned up in `afterAll`
- No interference with the developer's real `~/.scratchmd/` directory

## Future Enhancements

1. **`workspaces init` deep tests** — Verify `.scratchmd` marker files are correctly written for V1 vs V2 workspaces, connector subdirectory structure
2. **Syncs suite** — `syncs create/show/list/run/delete` once a stable two-connection fixture exists
3. **Error handling tests** — Invalid API keys, expired tokens, unreachable server, missing `--workspace` flag
4. **Concurrency tests** — Parallel pull/publish operations
5. **CI integration** — Run against test environment in GitLab CI on a schedule, using a prebuilt binary (`SCRATCH_CLI_BINARY`)
6. **`--json` output schema validation** — Validate JSON output against TypeScript interfaces to catch serialization regressions
