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
        name,
      ]);
      workspaceId = created.id;

      const list = cli.json<{ workbooks: Array<{ id: string; name: string }> }>(
        ["workspaces", "list"],
      );
      expect(list.workbooks.some((ws) => ws.id === workspaceId)).toBe(true);
    });
  });

  describe("delete", () => {
    it("should delete a workspace", () => {
      const name = uniqueName("ws");
      const created = cli.json<{ id: string }>([
        "workspaces",
        "create",
        name,
      ]);
      const id = created.id;

      cli.run(["workspaces", "delete", id], { noJson: true });

      const result = cli.run(["workspaces", "show", id], { expectError: true });
      expect(result.exitCode).not.toBe(0);
      workspaceId = ""; // already deleted
    });
  });
});
