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

/** Recursively list all files under a directory for debugging. */
function listAllFiles(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && entry.name !== ".git") {
      results.push(`${rel}/`);
      results.push(...listAllFiles(path.join(dir, entry.name), rel));
    } else if (!entry.isDirectory()) {
      results.push(rel);
    }
  }
  return results;
}

/** Recursively find all .json record files under a directory (skipping dot-dirs and .schema.json). */
function findJsonFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      results.push(...findJsonFiles(fullPath));
    } else if (entry.name.endsWith(".json") && !entry.name.startsWith(".")) {
      results.push(fullPath);
    }
  }
  return results;
}

describeIfPostgres("Files", () => {
  let workspaceId: string;
  let connectionId: string;
  let linkedFolderId: string;
  let workspaceDir: string;

  beforeAll(async () => {
    await setupTestTable();

    // 1. Create workspace
    const ws = cli.json<{ id: string }>([
      "workspaces",
      "create",
      uniqueName("files"),
    ]);
    workspaceId = ws.id;

    // 2. Add database connection
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
    connectionId = conn.id;

    // 3. Init (clone) the workspace locally
    const parentDir = path.join(cli.home, "test-workspace");
    fs.mkdirSync(parentDir, { recursive: true });
    const initResult = cli.json<{ directory: string }>(
      ["workspaces", "init", workspaceId],
      { cwd: parentDir },
    );
    workspaceDir = path.join(parentDir, initResult.directory);
    console.log("[debug] workspaceDir:", workspaceDir);

    // 4. Link the integration_blog_posts table (must run from workspace dir)
    const tables = cli.json<Array<{ id: string; displayName: string }>>([
      "linked",
      "--workspace",
      workspaceId,
      "available",
      connectionId,
    ]);
    const blogPostsTable = tables.find(
      (t) => t.displayName === "integration_blog_posts",
    )!;

    // Table ID from `available` is comma-joined (e.g. "public,integration_blog_posts").
    // The `add` endpoint expects each part as a separate --table-id arg.
    const tableIdParts = blogPostsTable.id.split(",");
    const linked = cli.json<{ id: string }>(
      [
        "linked",
        "--workspace",
        workspaceId,
        "add",
        "--connection-id",
        connectionId,
        ...tableIdParts.flatMap((part: string) => ["--table-id", part]),
        "--name",
        blogPostsTable.displayName,
      ],
      { cwd: workspaceDir },
    );
    linkedFolderId = linked.id;

    // 5. Pull data and download files
    cli.run(["linked", "--workspace", workspaceId, "pull", linkedFolderId], {
      cwd: workspaceDir,
    });
    cli.run(["files", "download"], { cwd: workspaceDir });

    // Debug: show what we got
    const allFiles = listAllFiles(workspaceDir);
    console.log(
      "[debug] workspace contents after setup:",
      JSON.stringify(allFiles, null, 2),
    );
  });

  afterAll(async () => {
    if (workspaceId) deleteWorkspace(cli, workspaceId);
    if (workspaceDir) {
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    await teardownTestTable();
  });

  describe("download", () => {
    it("should download files from the workspace", () => {
      const result = cli.run(["files", "download"], { cwd: workspaceDir });
      expect(result.exitCode).toBe(0);
    });

    it("should download exactly 3 JSON record files matching the test data", () => {
      const allFiles = listAllFiles(workspaceDir);
      console.log(
        "[debug] workspace contents after download:",
        JSON.stringify(allFiles, null, 2),
      );

      const jsonFiles = findJsonFiles(workspaceDir);
      expect(jsonFiles).toHaveLength(3);

      const records = jsonFiles.map((f) =>
        JSON.parse(fs.readFileSync(f, "utf-8")),
      );
      const titles = records
        .map((r: Record<string, unknown>) => r.title)
        .sort();
      expect(titles).toEqual([
        "Small Teams and Big AI: The New Startup Advantage",
        "The Rise of AI-Powered Development Tools",
        "Why Software Companies Are Rethinking Technical Debt",
      ]);
    });

    it("should have correct field values in downloaded records", () => {
      const jsonFiles = findJsonFiles(workspaceDir);
      const records = jsonFiles.map((f) =>
        JSON.parse(fs.readFileSync(f, "utf-8")),
      );

      const aiPost = records.find(
        (r: Record<string, unknown>) =>
          r.title === "The Rise of AI-Powered Development Tools",
      );
      expect(aiPost).toBeDefined();
      expect(aiPost.author).toBe("Sarah Chen");
      expect(aiPost.publish_status).toBe("published");
      expect(aiPost.content).toContain("AI-powered development tools");
    });
  });

  describe("upload", () => {
    it("should upload with no local changes (no-op)", () => {
      const result = cli.run(["files", "upload"], { cwd: workspaceDir });
      expect(result.exitCode).toBe(0);
    });
  });

  describe("round-trip", () => {
    it("should handle local edit → accept → upload → download cycle", () => {
      // Post-slice-F flow (see docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture.md):
      // working-tree edits are "unreviewed" and must be `accept`ed into
      // accepted-patches.json before `files upload` will ship them. `files
      // download` refuses while any unreviewed edits exist, so the accept
      // step is also a prerequisite for the post-upload re-sync.
      const jsonFiles = findJsonFiles(workspaceDir);
      expect(jsonFiles.length).toBeGreaterThan(0);

      // Pick the draft post and change its publish_status
      const records = jsonFiles.map((f) => ({
        path: f,
        data: JSON.parse(fs.readFileSync(f, "utf-8")) as Record<
          string,
          unknown
        >,
      }));
      const draft = records.find((r) => r.data.publish_status === "draft")!;
      expect(draft).toBeDefined();

      const modified = { ...draft.data, publish_status: "published" };
      fs.writeFileSync(draft.path, JSON.stringify(modified, null, 2));

      // Accept the edit — moves it from "unreviewed" into accepted-patches.json.
      const relPath = path.relative(workspaceDir, draft.path);
      const acceptResult = cli.run(["files", "accept", relPath], {
        cwd: workspaceDir,
      });
      expect(acceptResult.exitCode).toBe(0);

      // Upload — reads accepted-patches.json and posts to /upload-patch/.
      const uploadResult = cli.run(["files", "upload"], { cwd: workspaceDir });
      expect(uploadResult.exitCode).toBe(0);

      // Download — would have been blocked if any unreviewed edits remained;
      // after accept they are approved, so the pre-flight passes.
      const downloadResult = cli.run(["files", "download"], {
        cwd: workspaceDir,
      });
      expect(downloadResult.exitCode).toBe(0);

      // The working file should still reflect the accepted edit (download
      // re-anchors accepted-patches against new main and replays them).
      const afterDownload = JSON.parse(fs.readFileSync(draft.path, "utf-8"));
      expect(afterDownload.publish_status).toBe("published");
    });
  });
});
