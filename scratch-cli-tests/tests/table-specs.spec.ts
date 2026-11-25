import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ScratchCli } from "../src/cli";
import { deleteWorkspace, uniqueName } from "../src/helpers";
import { setupTestTable, teardownTestTable } from "../src/postgres";
import { Client } from "pg";
import { scratchApi, scratchApiGet } from "../src/scratch-api";

// DEV-13025: scratchmd fills its table-spec cache
// (`.scratch/connections/scratch/<connection>/<folder>/schema.json` and
// `views/default.json`) from `GET /cli/v1/workbooks/:id/table-specs`, which
// reads Postgres, instead of copying the connection repo's git `.scratch/`
// mirror. These tests pin the bytes on disk to the server's, and cover every
// flow that refreshes the cache. Run them against a server with
// TABLE_SPEC_GIT_MIRROR_ENABLED=false to prove nothing depends on the git copies.

const cli = new ScratchCli();
const postgresUrl = process.env.DATABASE_URL;
const describeIfPostgres = postgresUrl ? describe : describe.skip;

type TableSpecArtifact =
  | { status: "present"; sha256: string; content?: string }
  | { status: "absent" }
  | { status: "unreadable"; reason: string };

interface TableSpecsListing {
  formatVersion: number;
  connectorAccounts: Array<{
    connectorAccountId: string;
    dataFolders: Array<{
      dataFolderId: string;
      path: string;
      tableSpec: TableSpecArtifact;
      defaultView: TableSpecArtifact;
    }>;
  }>;
}

interface TableSpecCacheRefresh {
  status: "refreshed" | "failed" | "unsupported-format" | "skipped";
  schemaFilesWritten: number;
  defaultViewFilesWritten: number;
  filesDeleted: number;
  foldersWithChangedTableSpec: string[];
  foldersWithUnreadableServerSpec: string[];
  error: string | null;
}

const PRODUCTS_TABLE = "integration_table_specs_products";

describeIfPostgres(
  "table specs come from the server, not git (DEV-13025)",
  () => {
    let workspaceId: string;
    let connectionId: string;
    let blogFolderId: string;
    let workspaceDir: string;
    let connDirName: string;

    function connectionCacheDir(): string {
      return path.join(
        workspaceDir,
        ".scratch",
        "connections",
        "scratch",
        connDirName,
      );
    }

    /** A folder's cache directory: `/` is the connection cache root. */
    function folderCacheDir(folderPath: string): string {
      return path.join(
        connectionCacheDir(),
        ...folderPath.split("/").filter(Boolean),
      );
    }

    function workspaceRelativeFolderKey(folderPath: string): string {
      const sub = folderPath.replace(/^\/+/, "");
      return sub ? `${connDirName}/${sub}` : connDirName;
    }

    async function listing(): Promise<TableSpecsListing> {
      return scratchApiGet<TableSpecsListing>(
        `/cli/v1/workbooks/${workspaceId}/table-specs?connectorAccountId=${connectionId}`,
      );
    }

    async function blogFolder() {
      const folder = (await listing()).connectorAccounts[0].dataFolders.find(
        (f) => f.dataFolderId === blogFolderId,
      );
      if (!folder) throw new Error("the blog folder isn't in the listing");
      return folder;
    }

    /** Every listed file is on disk byte for byte, and every absent one isn't. */
    async function expectCacheMatchesServer(): Promise<void> {
      for (const folder of (await listing()).connectorAccounts[0].dataFolders) {
        const files: Array<[string, TableSpecArtifact]> = [
          [
            path.join(folderCacheDir(folder.path), "schema.json"),
            folder.tableSpec,
          ],
          [
            path.join(folderCacheDir(folder.path), "views", "default.json"),
            folder.defaultView,
          ],
        ];
        for (const [filePath, artifact] of files) {
          if (artifact.status === "present") {
            expect(fs.readFileSync(filePath, "utf-8")).toBe(artifact.content);
          } else if (artifact.status === "absent") {
            expect(fs.existsSync(filePath)).toBe(false);
          }
        }
      }
    }

    beforeAll(async () => {
      await setupTestTable();
      const pg = new Client({ connectionString: postgresUrl });
      await pg.connect();
      try {
        await pg.query(`DROP TABLE IF EXISTS ${PRODUCTS_TABLE} CASCADE`);
        await pg.query(
          `CREATE TABLE ${PRODUCTS_TABLE} (id SERIAL PRIMARY KEY, name TEXT, price NUMERIC)`,
        );
      } finally {
        await pg.end();
      }

      const workbook = await scratchApi<{ id: string }>("POST", "/workbook", {
        name: uniqueName("table-specs"),
      });
      workspaceId = workbook.id;
      const connection = await scratchApi<{ id: string }>(
        "POST",
        `/workbooks/${workspaceId}/connections`,
        {
          service: "POSTGRES",
          userProvidedParams: { connectionString: postgresUrl },
        },
      );
      connectionId = connection.id;
      const tableList = await scratchApi<{
        tables: Array<{ id: { remoteId: string[] }; displayName: string }>;
      }>("GET", `/workbooks/${workspaceId}/connections/${connectionId}/tables`);
      const blogTable = tableList.tables.find(
        (t) => t.displayName === "integration_blog_posts",
      );
      if (!blogTable)
        throw new Error("integration_blog_posts is not available");
      const blogFolderResult = await scratchApi<{ id: string }>(
        "POST",
        "/data-folder/create",
        {
          name: blogTable.displayName,
          workbookId: workspaceId,
          connectorAccountId: connectionId,
          tableId: blogTable.id.remoteId,
        },
      );
      blogFolderId = blogFolderResult.id;

      const parentDir = path.join(cli.home, "test-table-specs");
      fs.mkdirSync(parentDir, { recursive: true });
      const initResult = cli.json<{
        directory: string;
        tableSpecCacheRefresh: TableSpecCacheRefresh;
      }>(["workspaces", "init", workspaceId], { cwd: parentDir });
      workspaceDir = path.join(parentDir, initResult.directory);
      expect(initResult.tableSpecCacheRefresh.status).toBe("refreshed");

      const marker = YAML.parse(
        fs.readFileSync(
          path.join(workspaceDir, ".scratch", ".scratchmd"),
          "utf-8",
        ),
      );
      connDirName = marker.connections[0].dirName;

      cli.run(["linked", "--workspace", workspaceId, "pull", blogFolderId], {
        cwd: workspaceDir,
      });
      cli.run(["files", "download"], { cwd: workspaceDir });
    });

    afterAll(async () => {
      if (workspaceId) deleteWorkspace(cli, workspaceId);
      if (workspaceDir)
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      await teardownTestTable();
      const pg = new Client({ connectionString: postgresUrl });
      await pg.connect();
      try {
        await pg.query(`DROP TABLE IF EXISTS ${PRODUCTS_TABLE} CASCADE`);
      } finally {
        await pg.end();
      }
    });

    it("writes each folder's table spec and default view exactly as the server stores them", async () => {
      const folder = await blogFolder();
      expect(folder.tableSpec.status).toBe("present");
      await expectCacheMatchesServer();
    });

    it("repairs a hand-edited table spec on a download that pulls nothing, and reports the folder", async () => {
      const folder = await blogFolder();
      const schemaPath = path.join(folderCacheDir(folder.path), "schema.json");
      fs.writeFileSync(schemaPath, '{"editedByHand":true}\n');

      const result = cli.json<{
        status: string;
        tableSpecCacheRefresh: TableSpecCacheRefresh;
      }>(["files", "download"], { cwd: workspaceDir });

      expect(result.status).toBe("up_to_date");
      expect(result.tableSpecCacheRefresh.status).toBe("refreshed");
      expect(result.tableSpecCacheRefresh.schemaFilesWritten).toBe(1);
      expect(result.tableSpecCacheRefresh.foldersWithChangedTableSpec).toEqual([
        workspaceRelativeFolderKey(folder.path),
      ]);
      await expectCacheMatchesServer();
    });

    it("leaves every file alone when nothing changed", () => {
      const result = cli.json<{ tableSpecCacheRefresh: TableSpecCacheRefresh }>(
        ["files", "download"],
        { cwd: workspaceDir },
      );
      expect(result.tableSpecCacheRefresh).toMatchObject({
        status: "refreshed",
        schemaFilesWritten: 0,
        defaultViewFilesWritten: 0,
        filesDeleted: 0,
      });
    });

    it("refreshes the table specs on a --skip-folder-index download too", async () => {
      const folder = await blogFolder();
      fs.rmSync(path.join(folderCacheDir(folder.path), "schema.json"));

      cli.run(["files", "download", "--skip-folder-index"], {
        cwd: workspaceDir,
      });

      await expectCacheMatchesServer();
    });

    it("keeps validation.json and named views through a download and a post-publish reconcile", async () => {
      // The full-tree materialize behind reconcile-after-publish used to delete
      // every cache file git doesn't track, including custom validators.
      const folder = await blogFolder();
      const validationPath = path.join(
        folderCacheDir(folder.path),
        "validation.json",
      );
      const namedViewPath = path.join(
        folderCacheDir(folder.path),
        "views",
        "my-view.json",
      );
      const validationConfig =
        '[{"validator":"enforce_schema"},{"validator":"length","field":"title","params":{"min":1}}]\n';
      fs.writeFileSync(validationPath, validationConfig);
      fs.mkdirSync(path.dirname(namedViewPath), { recursive: true });
      fs.writeFileSync(namedViewPath, '{"columns":[]}\n');

      cli.run(["files", "download"], { cwd: workspaceDir });
      const reconcileResult = cli.json<{
        tableSpecCacheRefresh: TableSpecCacheRefresh;
      }>(["files", "reconcile-after-publish", "--connection", connectionId], {
        cwd: workspaceDir,
      });

      expect(reconcileResult.tableSpecCacheRefresh.status).toBe("refreshed");
      expect(fs.readFileSync(validationPath, "utf-8")).toBe(validationConfig);
      expect(fs.readFileSync(namedViewPath, "utf-8")).toBe('{"columns":[]}\n');
      await expectCacheMatchesServer();

      const skippedResult = cli.json<{
        tableSpecCacheRefresh: TableSpecCacheRefresh;
      }>(
        [
          "files",
          "reconcile-after-publish",
          "--connection",
          connectionId,
          "--skip-table-spec-refresh",
        ],
        { cwd: workspaceDir },
      );
      expect(skippedResult.tableSpecCacheRefresh.status).toBe("skipped");
    });

    it("refresh-table-specs repairs a deleted cache, and only for the connection asked for", async () => {
      fs.rmSync(connectionCacheDir(), { recursive: true, force: true });

      const repaired = cli.json<{
        tableSpecCacheRefresh: TableSpecCacheRefresh;
      }>(["files", "refresh-table-specs", "--connection", connectionId], {
        cwd: workspaceDir,
      });

      expect(repaired.tableSpecCacheRefresh.status).toBe("refreshed");
      expect(repaired.tableSpecCacheRefresh.schemaFilesWritten).toBeGreaterThan(
        0,
      );
      await expectCacheMatchesServer();

      const unknownConnection = cli.run(
        [
          "files",
          "refresh-table-specs",
          "--connection",
          "coa_not_in_this_workspace",
        ],
        { cwd: workspaceDir, expectError: true },
      );
      expect(unknownConnection.exitCode).not.toBe(0);
    });

    it("linked add writes the new folder's table spec, and linked remove prunes it", async () => {
      const tables = cli.json<Array<{ id: string; displayName: string }>>([
        "linked",
        "--workspace",
        workspaceId,
        "available",
        connectionId,
      ]);
      const productsTable = tables.find(
        (t) => t.displayName === PRODUCTS_TABLE,
      );
      if (!productsTable) throw new Error(`${PRODUCTS_TABLE} is not available`);
      const linked = cli.json<{ id: string }>(
        [
          "linked",
          "--workspace",
          workspaceId,
          "add",
          "--connection-id",
          connectionId,
          ...productsTable.id.split(",").flatMap((p) => ["--table-id", p]),
          "--name",
          PRODUCTS_TABLE,
        ],
        { cwd: workspaceDir },
      );

      const productsFolder = (
        await listing()
      ).connectorAccounts[0].dataFolders.find(
        (f) => f.dataFolderId === linked.id,
      );
      if (!productsFolder)
        throw new Error("the new folder isn't in the listing");
      expect(productsFolder.tableSpec.status).toBe("present");
      const productsSchemaPath = path.join(
        folderCacheDir(productsFolder.path),
        "schema.json",
      );
      await expectCacheMatchesServer();
      expect(fs.existsSync(productsSchemaPath)).toBe(true);

      cli.run(
        ["linked", "--workspace", workspaceId, "remove", linked.id, "--yes"],
        {
          noJson: true,
          cwd: workspaceDir,
        },
      );

      expect(fs.existsSync(productsSchemaPath)).toBe(false);
      await expectCacheMatchesServer();
    });
  },
);
