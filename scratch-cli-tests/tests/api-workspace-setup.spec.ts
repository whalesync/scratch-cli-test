import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ScratchCli } from "../src/cli";
import { deleteWorkspace, uniqueName } from "../src/helpers";
import {
  setupTestTable,
  teardownTestTable,
  setupProductsTable,
  teardownProductsTable,
} from "../src/postgres";
import { Client } from "pg";

const cli = new ScratchCli();
const postgresUrl = process.env.DATABASE_URL;
const preserveOnFailure = process.env.PRESERVE_WORKBOOK_ON_FAILURE === "true";

const describeIfPostgres = postgresUrl ? describe : describe.skip;

const serverUrl = process.env.SCRATCH_API_URL || "http://localhost:3010";
const apiKey = process.env.SCRATCH_API_KEY;

/** Call the Scratch server API directly with the test API token. */
async function scratchApi<T>(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${serverUrl}${urlPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `API-Token ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${urlPath} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
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

/** List non-hidden directories directly under a directory. */
function listVisibleDirs(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
}

describeIfPostgres(
  "API workspace setup — create workspace and link tables via REST, init and validate via CLI",
  () => {
    let workspaceId: string;
    let connectionId: string;
    let blogFolderId: string;
    let productsFolderId: string;
    let workspaceDir: string;
    let hasFailed = false;

    beforeAll(async () => {
      // 1. Seed blog posts table (with data) and products table (empty, schema only)
      await setupTestTable();

      // Create the products table structure but leave it empty
      const client = new Client({ connectionString: postgresUrl });
      await client.connect();
      try {
        await client.query(`DROP TABLE IF EXISTS integration_products CASCADE`);
        const sqlPath = path.resolve(__dirname, "../test_table_products.sql");
        const createSql = fs.readFileSync(sqlPath, "utf-8");
        await client.query(createSql);
      } finally {
        await client.end();
      }

      // 2. Create workbook via API
      const workbook = await scratchApi<{ id: string; name: string }>(
        "POST",
        "/workbook",
        { name: uniqueName("api-setup") },
      );
      workspaceId = workbook.id;

      // 3. Create Postgres connection via API
      const connection = await scratchApi<{ id: string; service: string }>(
        "POST",
        `/workbooks/${workspaceId}/connections`,
        {
          service: "POSTGRES",
          userProvidedParams: { connectionString: postgresUrl },
        },
      );
      connectionId = connection.id;

      // 4. Discover available tables via API
      const tableList = await scratchApi<{
        tables: Array<{
          id: { wsId: string; remoteId: string[] };
          displayName: string;
          disabled: boolean;
        }>;
      }>("GET", `/workbooks/${workspaceId}/connections/${connectionId}/tables`);

      const blogTable = tableList.tables.find(
        (t) => t.displayName === "integration_blog_posts",
      )!;
      const productsTable = tableList.tables.find(
        (t) => t.displayName === "integration_products",
      )!;

      // 5. Link both tables via API
      const blogFolder = await scratchApi<{ id: string; name: string }>(
        "POST",
        "/data-folder/create",
        {
          name: blogTable.displayName,
          workbookId: workspaceId,
          connectorAccountId: connectionId,
          tableId: blogTable.id.remoteId,
        },
      );
      blogFolderId = blogFolder.id;

      const productsFolder = await scratchApi<{ id: string; name: string }>(
        "POST",
        "/data-folder/create",
        {
          name: productsTable.displayName,
          workbookId: workspaceId,
          connectorAccountId: connectionId,
          tableId: productsTable.id.remoteId,
        },
      );
      productsFolderId = productsFolder.id;

      // 6. Init workspace locally (this clones the repo)
      const parentDir = path.join(cli.home, "test-api-setup");
      fs.mkdirSync(parentDir, { recursive: true });
      const initResult = cli.json<{ directory: string }>(
        ["workspaces", "init", workspaceId],
        { cwd: parentDir },
      );
      workspaceDir = path.join(parentDir, initResult.directory);
      console.log("[debug] workspaceDir:", workspaceDir);

      // 7. Pull data via CLI (handles repo + git operations reliably)
      cli.run(["linked", "--workspace", workspaceId, "pull", blogFolderId], {
        cwd: workspaceDir,
      });
      cli.run(
        ["linked", "--workspace", workspaceId, "pull", productsFolderId],
        { cwd: workspaceDir },
      );

      // 8. Download files
      cli.run(["files", "download"], { cwd: workspaceDir });
    });

    afterAll(async () => {
      const shouldPreserve = preserveOnFailure && hasFailed;
      if (shouldPreserve) {
        console.log(
          `[preserve] Keeping workbook ${workspaceId} and local dir ${workspaceDir} for inspection`,
        );
      }
      if (workspaceId && !shouldPreserve) deleteWorkspace(cli, workspaceId);
      if (workspaceDir && !shouldPreserve) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownTestTable();
      await teardownProductsTable();
    });

    describe("workspaces init", () => {
      it("should have initialized the workspace directory on disk", () => {
        try {
          expect(fs.existsSync(workspaceDir)).toBe(true);
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });
    });

    describe(".scratch metadata", () => {
      it("should create the .scratch directory with a valid workspace marker", () => {
        try {
          const scratchDir = path.join(workspaceDir, ".scratch");
          expect(fs.existsSync(scratchDir)).toBe(true);

          const markerPath = path.join(scratchDir, ".scratchmd");
          expect(fs.existsSync(markerPath)).toBe(true);

          const marker = YAML.parse(fs.readFileSync(markerPath, "utf-8"));
          expect(marker.workbook).toBeDefined();
          expect(marker.workbook.id).toBe(workspaceId);
          expect(marker.connections).toBeDefined();
          expect(marker.connections).toHaveLength(1);
          expect(marker.connections[0].id).toBe(connectionId);
          expect(marker.connections[0].service).toBe("POSTGRES");
          expect(marker.connections[0].dirName).toBeTruthy();
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });

      it("should create the connection directory with a git repo", () => {
        try {
          const marker = YAML.parse(
            fs.readFileSync(
              path.join(workspaceDir, ".scratch", ".scratchmd"),
              "utf-8",
            ),
          );
          const connDirName = marker.connections[0].dirName;
          const connDir = path.join(workspaceDir, connDirName);
          expect(fs.existsSync(connDir)).toBe(true);

          // Connection directory should contain a .git repo
          const gitDir = path.join(connDir, ".git");
          expect(fs.existsSync(gitDir)).toBe(true);
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });
    });

    describe("files download", () => {
      it("should report up_to_date when no new changes exist", () => {
        try {
          const downloadResult = cli.json<{
            filesUpdated: number;
            filesCreated: number;
            status: string;
          }>(["files", "download"], { cwd: workspaceDir });

          // Init already downloaded files, so a subsequent download is a no-op
          expect(downloadResult.status).toBe("up_to_date");
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });
    });

    describe("data folder structure", () => {
      it("should have both linked table directories under the connection directory", () => {
        try {
          const marker = YAML.parse(
            fs.readFileSync(
              path.join(workspaceDir, ".scratch", ".scratchmd"),
              "utf-8",
            ),
          );
          const connDirName = marker.connections[0].dirName;
          const connDir = path.join(workspaceDir, connDirName);

          const subdirs = listVisibleDirs(connDir);
          expect(subdirs).toContain("public");

          const schemaDir = path.join(connDir, "public");
          const tableDirs = listVisibleDirs(schemaDir);
          expect(tableDirs).toContain("integration_blog_posts");
          // Empty tables also get a materialized directory so users can create
          // new records into them.
          expect(tableDirs).toContain("integration_products");
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });

      it("should have 3 JSON record files in the blog posts folder", () => {
        try {
          const marker = YAML.parse(
            fs.readFileSync(
              path.join(workspaceDir, ".scratch", ".scratchmd"),
              "utf-8",
            ),
          );
          const connDirName = marker.connections[0].dirName;
          const blogDir = path.join(
            workspaceDir,
            connDirName,
            "public",
            "integration_blog_posts",
          );

          const jsonFiles = findJsonFiles(blogDir);
          expect(jsonFiles).toHaveLength(3);

          const records = jsonFiles.map(
            (f) =>
              JSON.parse(fs.readFileSync(f, "utf-8")) as Record<
                string,
                unknown
              >,
          );
          const titles = records.map((r) => r.title).sort();
          expect(titles).toEqual([
            "Small Teams and Big AI: The New Startup Advantage",
            "The Rise of AI-Powered Development Tools",
            "Why Software Companies Are Rethinking Technical Debt",
          ]);
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });

      it("should create an empty local directory for the empty products table", () => {
        try {
          const marker = YAML.parse(
            fs.readFileSync(
              path.join(workspaceDir, ".scratch", ".scratchmd"),
              "utf-8",
            ),
          );
          const connDirName = marker.connections[0].dirName;
          const productsDir = path.join(
            workspaceDir,
            connDirName,
            "public",
            "integration_products",
          );

          // Empty data folders are materialized as empty directories so users
          // can create new records in them locally.
          expect(fs.existsSync(productsDir)).toBe(true);
          expect(fs.statSync(productsDir).isDirectory()).toBe(true);
          expect(fs.readdirSync(productsDir)).toHaveLength(0);
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });
    });

    describe("schema files", () => {
      it("should have a schema.json in .scratch for the blog posts data folder", () => {
        try {
          const marker = YAML.parse(
            fs.readFileSync(
              path.join(workspaceDir, ".scratch", ".scratchmd"),
              "utf-8",
            ),
          );
          const connDirName = marker.connections[0].dirName;
          const schemaPath = path.join(
            workspaceDir,
            ".scratch",
            "connections",
            "scratch",
            connDirName,
            "public",
            "integration_blog_posts",
            "schema.json",
          );

          expect(fs.existsSync(schemaPath)).toBe(true);
          const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
          expect(schema).toBeDefined();
          expect(Array.isArray(schema) || typeof schema === "object").toBe(
            true,
          );
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });

      it("should have a schema.json in .scratch for the products data folder", () => {
        try {
          const marker = YAML.parse(
            fs.readFileSync(
              path.join(workspaceDir, ".scratch", ".scratchmd"),
              "utf-8",
            ),
          );
          const connDirName = marker.connections[0].dirName;
          const schemaPath = path.join(
            workspaceDir,
            ".scratch",
            "connections",
            "scratch",
            connDirName,
            "public",
            "integration_products",
            "schema.json",
          );

          expect(fs.existsSync(schemaPath)).toBe(true);
          const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
          expect(schema).toBeDefined();
          expect(Array.isArray(schema) || typeof schema === "object").toBe(
            true,
          );
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });
    });

    describe("linked list", () => {
      it("should list both linked folders with correct metadata via CLI", () => {
        try {
          const linked = cli.json<
            Array<{
              connectorAccountId: string;
              dataFolders: Array<{
                id: string;
                name: string;
              }>;
            }>
          >(["linked", "--workspace", workspaceId, "list"]);

          const allFolders = linked.flatMap((g) => g.dataFolders);
          expect(allFolders).toHaveLength(2);

          const blogFolder = allFolders.find(
            (f) => f.name === "integration_blog_posts",
          );
          expect(blogFolder).toBeDefined();
          expect(blogFolder!.id).toBe(blogFolderId);

          const productsFolder = allFolders.find(
            (f) => f.name === "integration_products",
          );
          expect(productsFolder).toBeDefined();
          expect(productsFolder!.id).toBe(productsFolderId);
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });
    });

    describe("workspaces show", () => {
      it("should return workspace details matching what was created via API", () => {
        try {
          const ws = cli.json<{
            id: string;
            name: string;
            connectorAccounts: Array<{
              id: string;
              service: string;
              dataFolders: Array<{ id: string; name: string }>;
            }>;
          }>(["workspaces", "show", workspaceId]);

          expect(ws.id).toBe(workspaceId);
          expect(ws.connectorAccounts).toHaveLength(1);
          expect(ws.connectorAccounts[0].id).toBe(connectionId);
          expect(ws.connectorAccounts[0].service).toBe("POSTGRES");

          const folders = ws.connectorAccounts[0].dataFolders;
          expect(folders).toHaveLength(2);
          expect(folders.some((f) => f.name === "integration_blog_posts")).toBe(
            true,
          );
          expect(folders.some((f) => f.name === "integration_products")).toBe(
            true,
          );
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      });
    });
  },
);
