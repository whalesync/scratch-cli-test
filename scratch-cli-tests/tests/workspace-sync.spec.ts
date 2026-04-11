import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ScratchCli } from "../src/cli";
import {
  deleteWorkspace,
  TEST_CONNECTOR_SERVICE,
  uniqueName,
} from "../src/helpers";
import {
  setupTestTable,
  teardownTestTable,
  setupProductsTable,
  teardownProductsTable,
} from "../src/postgres";

const cli = new ScratchCli();
const postgresUrl = process.env.DATABASE_URL;

const describeIfPostgres = postgresUrl ? describe : describe.skip;

/** Read the workspace marker YAML and return the parsed object. */
function readWorkspaceMarker(workspaceDir: string): Record<string, unknown> {
  const markerPath = path.join(workspaceDir, ".scratch", ".scratchmd");
  const content = fs.readFileSync(markerPath, "utf-8");
  return YAML.parse(content);
}

/** Recursively list all non-hidden directories directly under a directory. */
function listConnectionDirs(workspaceDir: string): string[] {
  return fs
    .readdirSync(workspaceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
}

/** Recursively find all .json record files under a directory (skipping dot-dirs). */
function findJsonFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
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

describeIfPostgres("Workspace sync on download", () => {
  let workspaceId: string;
  let workspaceDir: string;
  let connectionId1: string;
  let connectionId2: string;
  let linkedFolderId1: string;
  let linkedFolderId2: string;
  let connDirName1: string;
  let connDirName2: string;

  beforeAll(async () => {
    await setupTestTable();
    await setupProductsTable();

    // 1. Create workspace
    const ws = cli.json<{ id: string }>([
      "workspaces",
      "create",
      uniqueName("sync"),
    ]);
    workspaceId = ws.id;

    // 2. Add two database connections
    const conn1 = cli.json<{ id: string }>([
      "connections",
      "--workspace",
      workspaceId,
      "add",
      "--service",
      TEST_CONNECTOR_SERVICE,
      "--param",
      `connectionString=${postgresUrl}`,
      "--name",
      "BlogDB",
    ]);
    connectionId1 = conn1.id;

    const conn2 = cli.json<{ id: string }>([
      "connections",
      "--workspace",
      workspaceId,
      "add",
      "--service",
      TEST_CONNECTOR_SERVICE,
      "--param",
      `connectionString=${postgresUrl}`,
      "--name",
      "ProductDB",
    ]);
    connectionId2 = conn2.id;

    // 3. Init the workspace locally
    const parentDir = path.join(cli.home, "test-sync-workspace");
    fs.mkdirSync(parentDir, { recursive: true });
    const initResult = cli.json<{ directory: string }>(
      ["workspaces", "init", workspaceId],
      { cwd: parentDir },
    );
    workspaceDir = path.join(parentDir, initResult.directory);
    console.log("[debug] workspaceDir:", workspaceDir);

    // 4. Link tables for both connections
    const tables1 = cli.json<Array<{ id: string; displayName: string }>>([
      "linked",
      "--workspace",
      workspaceId,
      "available",
      connectionId1,
    ]);
    const blogTable = tables1.find(
      (t) => t.displayName === "integration_blog_posts",
    )!;
    const linked1 = cli.json<{ id: string }>(
      [
        "linked",
        "--workspace",
        workspaceId,
        "add",
        "--connection-id",
        connectionId1,
        ...blogTable.id.split(",").flatMap((p: string) => ["--table-id", p]),
        "--name",
        blogTable.displayName,
      ],
      { cwd: workspaceDir },
    );
    linkedFolderId1 = linked1.id;

    const tables2 = cli.json<Array<{ id: string; displayName: string }>>([
      "linked",
      "--workspace",
      workspaceId,
      "available",
      connectionId2,
    ]);
    const productsTable = tables2.find(
      (t) => t.displayName === "integration_products",
    )!;
    const linked2 = cli.json<{ id: string }>(
      [
        "linked",
        "--workspace",
        workspaceId,
        "add",
        "--connection-id",
        connectionId2,
        ...productsTable.id
          .split(",")
          .flatMap((p: string) => ["--table-id", p]),
        "--name",
        productsTable.displayName,
      ],
      { cwd: workspaceDir },
    );
    linkedFolderId2 = linked2.id;

    // 5. Pull data and download files
    cli.run(["linked", "--workspace", workspaceId, "pull", linkedFolderId1], {
      cwd: workspaceDir,
    });
    cli.run(["linked", "--workspace", workspaceId, "pull", linkedFolderId2], {
      cwd: workspaceDir,
    });
    cli.run(["files", "download"], { cwd: workspaceDir });

    // Record the connection directory names from the marker
    const marker = readWorkspaceMarker(workspaceDir) as {
      connections: Array<{ id: string; dirName: string }>;
    };
    connDirName1 = marker.connections.find(
      (c) => c.id === connectionId1,
    )!.dirName;
    connDirName2 = marker.connections.find(
      (c) => c.id === connectionId2,
    )!.dirName;

    console.log("[debug] connDirName1:", connDirName1);
    console.log("[debug] connDirName2:", connDirName2);
    console.log("[debug] connection dirs:", listConnectionDirs(workspaceDir));
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
    await teardownProductsTable();
  });

  it("should start with both connections initialized", () => {
    const dirs = listConnectionDirs(workspaceDir);
    expect(dirs).toContain(connDirName1);
    expect(dirs).toContain(connDirName2);

    const marker = readWorkspaceMarker(workspaceDir) as {
      connections: Array<{ id: string }>;
    };
    expect(marker.connections).toHaveLength(2);
  });

  describe("--on-delete=remove (delete removed connection)", () => {
    it("should remove local files when a connection is deleted on the server", () => {
      // Remove connection 1 on the server
      cli.run(
        [
          "connections",
          "--workspace",
          workspaceId,
          "remove",
          connectionId1,
          "--yes",
        ],
        { noJson: true },
      );

      // Download with --on-delete=remove
      const result = cli.json<{
        status: string;
        connectionsRemoved?: string[];
      }>(["files", "download", "--on-delete", "remove"], {
        cwd: workspaceDir,
      });

      // Sync result should report the removal
      expect(result.connectionsRemoved).toBeDefined();
      expect(result.connectionsRemoved).toContain(connDirName1);

      // Connection 1 directory should be gone
      const dirs = listConnectionDirs(workspaceDir);
      expect(dirs).not.toContain(connDirName1);

      // Connection 2 directory should still be present
      expect(dirs).toContain(connDirName2);

      // Marker should only contain connection 2
      const marker = readWorkspaceMarker(workspaceDir) as {
        connections: Array<{ id: string }>;
      };
      expect(marker.connections).toHaveLength(1);
      expect(marker.connections[0].id).toBe(connectionId2);
    });
  });

  describe("--on-delete=keep (detach removed connection)", () => {
    it("should detach a removed connection, preserving files but removing from marker", () => {
      // Record files before removal
      const conn2Dir = path.join(workspaceDir, connDirName2);
      const filesBefore = findJsonFiles(conn2Dir);
      expect(filesBefore.length).toBeGreaterThan(0);

      // Remove connection 2 on the server
      cli.run(
        [
          "connections",
          "--workspace",
          workspaceId,
          "remove",
          connectionId2,
          "--yes",
        ],
        { noJson: true },
      );

      // Download with --on-delete=keep
      const result = cli.json<{
        status: string;
        connectionsDetached?: string[];
      }>(["files", "download", "--on-delete", "keep"], {
        cwd: workspaceDir,
      });

      // Sync result should report the detachment
      expect(result.connectionsDetached).toBeDefined();
      expect(result.connectionsDetached).toContain(connDirName2);

      // Connection 2 directory should still exist with files preserved
      expect(fs.existsSync(conn2Dir)).toBe(true);
      const filesAfter = findJsonFiles(conn2Dir);
      expect(filesAfter).toHaveLength(filesBefore.length);

      // A detached .scratchmd marker should exist in the connection dir
      const detachedMarkerPath = path.join(conn2Dir, ".scratchmd");
      expect(fs.existsSync(detachedMarkerPath)).toBe(true);
      const detachedMarker = YAML.parse(
        fs.readFileSync(detachedMarkerPath, "utf-8"),
      );
      expect(detachedMarker.detached).toBe(true);

      // Workspace marker should have no connections left
      const marker = readWorkspaceMarker(workspaceDir) as {
        connections: Array<{ id: string }>;
      };
      expect(marker.connections).toHaveLength(0);
    });
  });

  describe("adding a new connection after init", () => {
    let connectionId3: string;
    let connDirName3: string;

    it("should set up a new connection on download when one is added on the server", async () => {
      // Re-create the blog posts table connection under a new name
      await setupTestTable();
      const conn3 = cli.json<{ id: string }>([
        "connections",
        "--workspace",
        workspaceId,
        "add",
        "--service",
        TEST_CONNECTOR_SERVICE,
        "--param",
        `connectionString=${postgresUrl}`,
        "--name",
        "NewBlogDB",
      ]);
      connectionId3 = conn3.id;

      // Link the blog_posts table to the new connection
      const tables = cli.json<Array<{ id: string; displayName: string }>>([
        "linked",
        "--workspace",
        workspaceId,
        "available",
        connectionId3,
      ]);
      const blogTable = tables.find(
        (t) => t.displayName === "integration_blog_posts",
      )!;
      const linked = cli.json<{ id: string }>(
        [
          "linked",
          "--workspace",
          workspaceId,
          "add",
          "--connection-id",
          connectionId3,
          ...blogTable.id.split(",").flatMap((p: string) => ["--table-id", p]),
          "--name",
          blogTable.displayName,
        ],
        { cwd: workspaceDir },
      );

      // Pull data for the new connection
      cli.run(["linked", "--workspace", workspaceId, "pull", linked.id], {
        cwd: workspaceDir,
      });

      // Download — should pick up the new connection
      const result = cli.json<{
        status: string;
        connectionsAdded?: string[];
      }>(["files", "download", "--on-delete", "remove"], {
        cwd: workspaceDir,
      });

      // Sync result should report the addition
      expect(result.connectionsAdded).toBeDefined();
      expect(result.connectionsAdded!.length).toBe(1);
      connDirName3 = result.connectionsAdded![0];

      // New connection directory should exist with downloaded files
      const newConnDir = path.join(workspaceDir, connDirName3);
      expect(fs.existsSync(newConnDir)).toBe(true);

      const jsonFiles = findJsonFiles(newConnDir);
      expect(jsonFiles.length).toBeGreaterThan(0);

      // Marker should include the new connection
      const marker = readWorkspaceMarker(workspaceDir) as {
        connections: Array<{ id: string }>;
      };
      expect(marker.connections.some((c) => c.id === connectionId3)).toBe(true);
    });
  });
});
