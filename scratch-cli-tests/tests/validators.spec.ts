import fs from "node:fs";
import path from "node:path";
import { ScratchCli } from "../src/cli";
import {
  deleteWorkspace,
  TEST_CONNECTOR_SERVICE,
  uniqueName,
} from "../src/helpers";
import { setupTestTable, teardownTestTable } from "../src/postgres";

const cli = new ScratchCli();
const postgresUrl = process.env.DATABASE_URL;
const describeIfPostgres = postgresUrl ? describe : describe.skip;

const VALIDATION_SCRIPTS_DIR = path.resolve(
  __dirname,
  "..",
  "validation-scripts",
);
const SCRIPT_CHECK_STATUS = "test-check-status-published.py";
const SCRIPT_DISALLOWED_BUILTINS = "test-disallowed-builtins.py";
const SCRIPT_INFINITE_LOOP = "test-infinite-loop.py";
const ALL_SCRIPTS = [
  SCRIPT_CHECK_STATUS,
  SCRIPT_DISALLOWED_BUILTINS,
  SCRIPT_INFINITE_LOOP,
];

interface Violation {
  file: string;
  field_path: string;
  validator_kind: string;
  level: "error" | "warning";
  message?: string;
  description?: string;
  fixable: boolean;
}

const validatorRef = (script: string) => `python:validators/${script}`;

/** Find all JSON record files in a workspace (skipping dot-dirs and .schema.json). */
function findJsonRecords(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      out.push(...findJsonRecords(full));
    } else if (entry.name.endsWith(".json") && !entry.name.startsWith(".")) {
      out.push(full);
    }
  }
  return out;
}

describeIfPostgres("Validators (custom Python)", () => {
  let workspaceId: string;
  let workspaceParentDir: string;
  let workspaceDir: string;
  let folderArg: string; // "<connection-dir>/<subfolder>"
  let publishedFile: string;
  let draftFile: string;
  let validationJsonPath: string;

  beforeAll(async () => {
    await setupTestTable();

    // 1. Create the workspace on the server.
    const ws = cli.json<{ id: string }>([
      "workspaces",
      "create",
      uniqueName("validators"),
    ]);
    workspaceId = ws.id;

    // 2. Attach a Postgres connection so we have a real table to link.
    const conn = cli.json<{ id: string }>([
      "connections",
      "--workspace",
      workspaceId,
      "add",
      "--service",
      TEST_CONNECTOR_SERVICE,
      "--param",
      `connectionString=${postgresUrl}`,
    ]);

    // 3. Init the workspace on disk — this is the "real workspace folder"
    //    that the rest of the test runs inside.
    workspaceParentDir = path.join(cli.home, "validators-test-workspace");
    fs.mkdirSync(workspaceParentDir, { recursive: true });
    const initResult = cli.json<{ directory: string }>(
      ["workspaces", "init", workspaceId],
      { cwd: workspaceParentDir },
    );
    workspaceDir = path.join(workspaceParentDir, initResult.directory);

    // 4. Link integration_blog_posts → pull → download files.
    const tables = cli.json<Array<{ id: string; displayName: string }>>([
      "linked",
      "--workspace",
      workspaceId,
      "available",
      conn.id,
    ]);
    const blogPostsTable = tables.find(
      (t) => t.displayName === "integration_blog_posts",
    )!;
    const tableIdParts = blogPostsTable.id.split(",");
    const linked = cli.json<{ id: string }>(
      [
        "linked",
        "--workspace",
        workspaceId,
        "add",
        "--connection-id",
        conn.id,
        ...tableIdParts.flatMap((p: string) => ["--table-id", p]),
        "--name",
        blogPostsTable.displayName,
      ],
      { cwd: workspaceDir },
    );
    cli.run(["linked", "--workspace", workspaceId, "pull", linked.id], {
      cwd: workspaceDir,
    });
    cli.run(["files", "download"], { cwd: workspaceDir });

    // 5. Discover where the records ended up on disk and derive the
    //    `<connection>/<subfolder>` value for the --folder flag. The CLI splits
    //    --folder on the FIRST slash: `conn = before`, `sub = everything after`
    //    (sub itself may contain slashes — e.g. Postgres uses `<schema>/<table>`).
    //    Deriving from the filesystem is more robust than guessing.
    const records = findJsonRecords(workspaceDir);
    if (records.length === 0) {
      throw new Error("Test setup downloaded no records");
    }
    console.log(
      "[debug] discovered records:",
      records.map((r) => path.relative(workspaceDir, r)),
    );
    const firstRel = path.relative(workspaceDir, records[0]).split(path.sep);
    const connDir = firstRel[0];
    const subSegments = firstRel.slice(1, -1);
    const subDirPosix = subSegments.join("/");
    folderArg = subDirPosix ? `${connDir}/${subDirPosix}` : connDir;

    // 6. Find one published record and the draft record by inspecting content.
    const withData = records.map((p) => ({
      basename: path.basename(p),
      data: JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>,
    }));
    publishedFile = withData.find((r) => r.data.publish_status === "published")!
      .basename;
    draftFile = withData.find((r) => r.data.publish_status === "draft")!
      .basename;

    // 7. Copy the validator scripts into the location the CLI expects:
    //    <workspace>/.scratch/workspace/validators/<script>.py.
    const validatorsDir = path.join(
      workspaceDir,
      ".scratch",
      "workspace",
      "validators",
    );
    fs.mkdirSync(validatorsDir, { recursive: true });
    for (const script of ALL_SCRIPTS) {
      fs.copyFileSync(
        path.join(VALIDATION_SCRIPTS_DIR, script),
        path.join(validatorsDir, script),
      );
    }

    // 8. Drop a validation.json onto disk so the "load from disk" tests run
    //    end-to-end (config + record both come from the working copy).
    const scratchFolderDir = path.join(
      workspaceDir,
      ".scratch",
      "connections",
      "scratch",
      connDir,
      ...subSegments,
    );
    fs.mkdirSync(scratchFolderDir, { recursive: true });
    validationJsonPath = path.join(scratchFolderDir, "validation.json");
    fs.writeFileSync(
      validationJsonPath,
      JSON.stringify([
        {
          validator: validatorRef(SCRIPT_CHECK_STATUS),
          field: "publish_status",
        },
      ]),
    );
  });

  afterAll(async () => {
    if (workspaceId) deleteWorkspace(cli, workspaceId);
    if (workspaceParentDir) {
      try {
        fs.rmSync(workspaceParentDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    await teardownTestTable();
  });

  describe("custom field validator — disk-loaded validation.json", () => {
    it("returns no violations for a record whose field passes", () => {
      const violations = cli.json<Violation[]>(
        [
          "validation", "dry-run",
          "--workspace",
          workspaceDir,
          "--folder",
          folderArg,
          "--file",
          publishedFile,
        ],
        { cwd: workspaceDir },
      );
      expect(violations).toEqual([]);
    });

    it("returns the violation produced by the script for a draft record", () => {
      const violations = cli.json<Violation[]>(
        [
          "validation", "dry-run",
          "--workspace",
          workspaceDir,
          "--folder",
          folderArg,
          "--file",
          draftFile,
        ],
        { cwd: workspaceDir },
      );

      expect(violations).toHaveLength(1);
      const [v] = violations;
      expect(v.file).toBe(draftFile);
      expect(v.field_path).toBe("publish_status");
      expect(v.validator_kind).toBe(validatorRef(SCRIPT_CHECK_STATUS));
      expect(v.level).toBe("error");
      expect(v.fixable).toBe(false);
      expect(v.message).toContain("'published'");
      expect(v.message).toContain("'draft'");
    });
  });

  describe("sandbox enforcement", () => {
    it("rejects scripts that call disallowed built-ins (eval / exec)", () => {
      const result = cli.run(
        [
          "validation", "dry-run",
          "--workspace",
          workspaceDir,
          "--folder",
          folderArg,
          "--file",
          publishedFile,
          "--validation",
          JSON.stringify([
            {
              validator: validatorRef(SCRIPT_DISALLOWED_BUILTINS),
              field: "publish_status",
            },
          ]),
        ],
        { cwd: workspaceDir, expectError: true },
      );

      expect(result.exitCode).not.toBe(0);

      const combined = `${result.stdout}\n${result.stderr}`;
      // `eval` is stripped from __builtins__ before the script runs, so the
      // call raises NameError. The CLI wraps that as a Rust error and exits
      // with a non-zero status code.
      expect(combined).toMatch(/eval/i);
      expect(combined).toMatch(/NameError|not defined/i);
      // The script's success-path message must NOT surface — that string
      // only appears if the sandbox actually let eval/exec return a value.
      expect(combined).not.toContain("sandbox let eval/exec through");
    });

    it("kills a runaway script via the cooperative timeout", () => {
      const startedAt = Date.now();
      const result = cli.run(
        [
          "validation", "dry-run",
          "--workspace",
          workspaceDir,
          "--folder",
          folderArg,
          "--file",
          publishedFile,
          "--validation",
          JSON.stringify([
            {
              validator: validatorRef(SCRIPT_INFINITE_LOOP),
              field: "publish_status",
            },
          ]),
        ],
        { cwd: workspaceDir, expectError: true },
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result.exitCode).not.toBe(0);

      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined.toLowerCase()).toContain("timed out");
      // The resolved validator path (without the `python:` scheme prefix) is
      // embedded in the timeout error so it's clear which script tripped.
      expect(combined).toContain(`validators/${SCRIPT_INFINITE_LOOP}`);

      // 5s cooperative + 2s backstop = ~7s ceiling. Generous slack for CI
      // cold-starts.
      expect(elapsedMs).toBeLessThan(20_000);
    });
  });
});
