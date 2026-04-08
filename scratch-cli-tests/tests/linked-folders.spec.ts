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

describeIfPostgres("Linked Folders", () => {
  let workspaceId: string;
  let connectionId: string;
  let linkedFolderId: string;
  let workspaceDir: string;

  beforeAll(async () => {
    await setupTestTable();

    // Create workspace and init locally — linked add auto-downloads files
    // so it must run from inside the workspace directory
    const ws = cli.json<{ id: string }>([
      "workspaces",
      "create",
      uniqueName("linked"),
    ]);
    workspaceId = ws.id;

    const parentDir = path.join(cli.home, "test-linked-workspace");
    fs.mkdirSync(parentDir, { recursive: true });
    const initResult = cli.json<{ directory: string }>(
      ["workspaces", "init", workspaceId],
      { cwd: parentDir },
    );
    workspaceDir = path.join(parentDir, initResult.directory);
    console.log("[debug] workspaceDir:", workspaceDir);

    // Add database connection
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

  describe("available", () => {
    it("should list available tables from the connection", () => {
      const result = cli.json<Array<{ id: string; displayName: string }>>([
        "linked",
        "--workspace",
        workspaceId,
        "available",
        connectionId,
      ]);
      expect(result.length).toBeGreaterThan(0);
      expect(
        result.some((t) => t.displayName === "integration_blog_posts"),
      ).toBe(true);
    });
  });

  describe("add", () => {
    it("should link the integration_blog_posts table to the workspace", () => {
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
      expect(blogPostsTable).toBeDefined();

      // Table ID from `available` is comma-joined (e.g. "public,table_name").
      // The `add` endpoint expects each part as a separate --table-id arg.
      const tableIdParts = blogPostsTable.id.split(",");
      const result = cli.json<{ id: string; name: string }>(
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
      linkedFolderId = result.id;
      expect(result.name).toBe("integration_blog_posts");
    });
  });

  describe("list", () => {
    it("should list linked folders grouped by connector", () => {
      const result = cli.json<Array<{ dataFolders: Array<{ id: string }> }>>([
        "linked",
        "--workspace",
        workspaceId,
        "list",
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
      }>(["linked", "--workspace", workspaceId, "show", linkedFolderId]);
      expect(result.id).toBe(linkedFolderId);
      expect(typeof result.creates).toBe("number");
    });
  });

  describe("pull", () => {
    it("should pull data from the remote and complete successfully", () => {
      const result = cli.run(
        ["linked", "--workspace", workspaceId, "pull", linkedFolderId],
        { cwd: workspaceDir },
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("remove", () => {
    it("should unlink a folder from the workspace", () => {
      cli.run(
        [
          "linked",
          "--workspace",
          workspaceId,
          "remove",
          linkedFolderId,
          "--yes",
        ],
        {
          noJson: true,
          cwd: workspaceDir,
        },
      );

      const list = cli.json<Array<{ dataFolders: Array<{ id: string }> }>>([
        "linked",
        "--workspace",
        workspaceId,
        "list",
      ]);
      const allFolders = list.flatMap((g) => g.dataFolders);
      expect(allFolders.some((f) => f.id === linkedFolderId)).toBe(false);
    });
  });
});
