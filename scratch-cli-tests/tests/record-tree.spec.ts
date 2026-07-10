import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScratchCli } from "../src/cli";

const cli = new ScratchCli();

interface RecordTreeNode {
  name: string;
  file: string;
  kind: "record" | "folder";
  id?: string;
  parentKind?: string;
  parentId?: string;
  url?: string;
  children: RecordTreeNode[];
}

interface RecordTreeResult {
  folder: string;
  totalRecords: number;
  parseErrors: string[];
  roots: RecordTreeNode[];
}

/**
 * `record-tree` derives a folder's parent/child forest from the dot-paths its
 * schema declares under `recordTree` (e.g. the Notion Page Tree table), plus
 * sibling data folders embedded inside records (matched by remote table id).
 * It is a purely local command — marker, cached schema, and record files on
 * disk — so the fixture is a synthetic workspace with no server round-trip.
 */
describe("Record tree", () => {
  let workspaceDir: string;
  const CONN = "my-conn";
  const FOLDER = `${CONN}/pages`;

  const writeJson = (relPath: string, value: unknown) => {
    const absolutePath = path.join(workspaceDir, relPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify(value));
  };

  beforeAll(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-tree-ws-"));
    // Minimal workspace marker so the CLI's workspace discovery accepts the dir.
    fs.mkdirSync(path.join(workspaceDir, ".scratch"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, ".scratch", ".scratchmd"),
      [
        'version: "3"',
        "workbook:",
        "  id: wkb_record_tree_fixture",
        "  name: record-tree-fixture",
        "  orgId: org_test",
        "  serverUrl: http://localhost:3010",
        '  initializedAt: "2026-01-01T00:00:00Z"',
        "connections: []",
        "",
      ].join("\n"),
    );

    // The tree-declaring folder's cached schema.
    writeJson(`.scratch/connections/scratch/${CONN}/pages/schema.json`, {
      idPath: "id",
      recordTree: {
        parentIdPath: "parent.page_id",
        parentKindPath: "parent.type",
        recordUrlPath: "url",
      },
    });
    // A sibling folder (synced database) referenced from inside a page record.
    writeJson(`.scratch/connections/scratch/${CONN}/db1/schema.json`, {
      id: { wsId: "db", remoteId: ["db-id-1", "ds-id-1"] },
      remoteWebUrl: "https://example.com/db1",
    });

    writeJson(`${CONN}/pages/root-page.json`, {
      id: "r1",
      parent: { type: "workspace", workspace: true },
      url: "https://example.com/r1",
    });
    writeJson(`${CONN}/pages/child-a.json`, {
      id: "c1",
      parent: { type: "page_id", page_id: "r1" },
      url: "https://example.com/c1",
      page_content: [
        // The embedded sibling: object id == the sibling's remote table id,
        // parent.page_id == the containing page.
        { id: "db-id-1", parent: { type: "page_id", page_id: "c1" }, type: "child_database" },
      ],
    });
    writeJson(`${CONN}/pages/grandchild.json`, {
      id: "g1",
      parent: { type: "page_id", page_id: "c1" },
    });
  });

  afterAll(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("derives the forest with node kinds, urls, and embedded sibling folders", () => {
    const result = cli.json<RecordTreeResult>([
      "record-tree",
      "--workspace",
      workspaceDir,
      "--folder",
      FOLDER,
    ]);

    expect(result.folder).toBe(FOLDER);
    expect(result.totalRecords).toBe(3);
    expect(result.parseErrors).toEqual([]);
    expect(result.roots).toHaveLength(1);

    const root = result.roots[0];
    expect(root).toMatchObject({
      name: "root-page",
      file: "root-page.json",
      kind: "record",
      parentKind: "workspace",
      url: "https://example.com/r1",
    });
    expect(root.children.map((child) => child.name)).toEqual(["child-a"]);

    const childA = root.children[0];
    expect(childA.parentId).toBe("r1");
    // Record children come first, then the embedded sibling folder.
    expect(childA.children.map((child) => [child.name, child.kind])).toEqual([
      ["grandchild", "record"],
      ["db1", "folder"],
    ]);
    const embeddedFolderNode = childA.children[1];
    expect(embeddedFolderNode).toMatchObject({
      file: `${CONN}/db1`,
      id: "db-id-1",
      url: "https://example.com/db1",
      parentId: "c1",
    });
  });

  it("fails with a clear error for a folder whose schema declares no record tree", () => {
    writeJson(`.scratch/connections/scratch/${CONN}/flat/schema.json`, { idPath: "id" });
    fs.mkdirSync(path.join(workspaceDir, CONN, "flat"), { recursive: true });

    const result = cli.run(
      ["record-tree", "--workspace", workspaceDir, "--folder", `${CONN}/flat`],
      { expectError: true },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not declare a record tree");
  });
});
