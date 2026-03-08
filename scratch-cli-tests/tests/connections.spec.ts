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

describeIfPostgres("Connections", () => {
  let workspaceId: string;
  let connectionId: string;

  beforeAll(async () => {
    await setupTestTable();
    const ws = cli.json<{ id: string }>([
      "workspaces",
      "create",
      "--name",
      uniqueName("conn"),
    ]);
    workspaceId = ws.id;
  });

  afterAll(async () => {
    if (workspaceId) deleteWorkspace(cli, workspaceId);
    await teardownTestTable();
  });

  describe("add", () => {
    it("should create a connection", () => {
      const result = cli.json<{ id: string; service: string }>([
        "connections",
        "add",
        "--workspace",
        workspaceId,
        "--service",
        TEST_CONNECTOR_SERVICE,
        "--param",
        `connectionString=${postgresUrl}`,
        "--name",
        uniqueName("conn"),
      ]);
      connectionId = result.id;
      expect(result.service).toBe(TEST_CONNECTOR_SERVICE);
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
      expect(result.service).toBe(TEST_CONNECTOR_SERVICE);
    });
  });

  describe("remove", () => {
    it("should remove a connection", () => {
      cli.run(
        [
          "connections",
          "remove",
          connectionId,
          "--workspace",
          workspaceId,
          "--yes",
        ],
        { noJson: true },
      );

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
