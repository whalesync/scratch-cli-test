import fs from "node:fs";
import path from "node:path";
import { ScratchCli } from "../src/cli";
import {
  deleteWorkspace,
  TEST_CONNECTOR_SERVICE,
  uniqueName,
} from "../src/helpers";

const cli = new ScratchCli();
const postgresUrl = process.env.DATABASE_URL;

// Routines commands only touch the workbook config repo, not any record data — but
// `workspaces init` only clones that config repo once the workbook has at least one
// connector account (the local repo id is derived from a connection's repo path). So we
// add a Postgres connection purely to make the config repo materialize locally; no table,
// linked folder, or pull is needed. Hence the suite is gated on DATABASE_URL like the others.
const describeIfPostgres = postgresUrl ? describe : describe.skip;

interface RoutineFileChange {
  status: "added" | "modified" | "deleted";
  path: string;
}
interface StatusResult {
  localChanges: RoutineFileChange[];
  remoteChanges: RoutineFileChange[];
  localHead: string | null;
  remoteHead: string | null;
  clean: boolean;
  behind: boolean;
}
interface PushResult {
  status: "pushed" | "no_changes";
  upserts: string[];
  deletes: string[];
  head: string | null;
  routineCount: number;
}
interface PullResult {
  status: "up_to_date" | "updated" | "no_repo";
  routinesAdded: string[];
  routinesModified: string[];
  routinesDeleted: string[];
  oldHead: string | null;
  newHead: string | null;
}

const ROUTINE_PATH = "routines/daily.yaml";
const CREATE_YAML = "name: Daily Sync\nsteps:\n  - action: pull\n";
const UPDATE_YAML =
  "name: Daily Sync (updated)\ncomment: edited by the routines integration test\nsteps:\n  - action: pull\n";

describeIfPostgres("Routines", () => {
  let workspaceId: string;
  let writerDir: string;
  let readerDir: string;

  /** A second clone of the same workbook, used to prove a push reaches the server. */
  function initClone(label: string): string {
    const parentDir = path.join(cli.home, `routines-${label}-${uniqueName()}`);
    fs.mkdirSync(parentDir, { recursive: true });
    const initResult = cli.json<{ directory: string }>(
      ["workspaces", "init", workspaceId],
      { cwd: parentDir },
    );
    return path.join(parentDir, initResult.directory);
  }

  const writerRoutine = () =>
    path.join(writerDir, ".scratch", "workspace", ROUTINE_PATH);
  const readerRoutine = () =>
    path.join(readerDir, ".scratch", "workspace", ROUTINE_PATH);

  beforeAll(() => {
    workspaceId = cli.json<{ id: string }>([
      "workspaces",
      "create",
      uniqueName("routines"),
    ]).id;

    // A connection makes `workspaces init` clone the config repo locally (see note above).
    cli.json([
      "connections",
      "--workspace",
      workspaceId,
      "add",
      "--service",
      TEST_CONNECTOR_SERVICE,
      "--param",
      `connectionString=${postgresUrl}`,
    ]);

    writerDir = initClone("writer");
    readerDir = initClone("reader");

    // routines/ does not exist in a brand-new config repo — create the dir so the writer
    // can drop routine files into it.
    fs.mkdirSync(path.dirname(writerRoutine()), { recursive: true });
  });

  afterAll(() => {
    if (workspaceId) deleteWorkspace(cli, workspaceId);
    for (const dir of [writerDir, readerDir]) {
      if (!dir) continue;
      try {
        // dir is "<home>/routines-<label>-<unique>/<workbookDir>"; remove the unique parent.
        fs.rmSync(path.dirname(dir), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("starts with a clean, in-sync routines state", () => {
    const status = cli.json<StatusResult>(["routines", "status"], {
      cwd: writerDir,
    });
    expect(status.clean).toBe(true);
    expect(status.behind).toBe(false);
    expect(status.localChanges).toEqual([]);
  });

  it("creates a routine file locally and pushes it to the server", () => {
    fs.writeFileSync(writerRoutine(), CREATE_YAML);

    // `status` sees the new file as a local "added" change.
    const status = cli.json<StatusResult>(["routines", "status"], {
      cwd: writerDir,
    });
    expect(status.clean).toBe(false);
    expect(status.localChanges).toEqual(
      expect.arrayContaining([{ status: "added", path: ROUTINE_PATH }]),
    );

    const push = cli.json<PushResult>(["routines", "push"], { cwd: writerDir });
    expect(push.status).toBe("pushed");
    expect(push.upserts).toContain(ROUTINE_PATH);
    expect(push.deletes).toEqual([]);
    expect(push.head).toBeTruthy();

    // After the push the local worktree converges to the server and is clean again.
    const after = cli.json<StatusResult>(["routines", "status"], {
      cwd: writerDir,
    });
    expect(after.clean).toBe(true);
  });

  it("propagates the created routine to another clone via pull", () => {
    const pull = cli.json<PullResult>(["routines", "pull"], { cwd: readerDir });
    expect(pull.status).toBe("updated");
    expect(pull.routinesAdded).toContain(ROUTINE_PATH);

    expect(fs.existsSync(readerRoutine())).toBe(true);
    expect(fs.readFileSync(readerRoutine(), "utf-8")).toContain(
      "name: Daily Sync",
    );
  });

  it("updates a routine file locally and pushes the change", () => {
    fs.writeFileSync(writerRoutine(), UPDATE_YAML);

    const status = cli.json<StatusResult>(["routines", "status"], {
      cwd: writerDir,
    });
    expect(status.localChanges).toEqual(
      expect.arrayContaining([{ status: "modified", path: ROUTINE_PATH }]),
    );

    const push = cli.json<PushResult>(["routines", "push"], { cwd: writerDir });
    expect(push.status).toBe("pushed");
    expect(push.upserts).toContain(ROUTINE_PATH);
  });

  it("propagates the update to another clone via pull", () => {
    const pull = cli.json<PullResult>(["routines", "pull"], { cwd: readerDir });
    expect(pull.status).toBe("updated");
    expect(pull.routinesModified).toContain(ROUTINE_PATH);

    expect(fs.readFileSync(readerRoutine(), "utf-8")).toContain(
      "name: Daily Sync (updated)",
    );
  });

  it("reports no changes to push when the worktree is clean", () => {
    const push = cli.json<PushResult>(["routines", "push"], { cwd: writerDir });
    expect(push.status).toBe("no_changes");
    expect(push.upserts).toEqual([]);
    expect(push.deletes).toEqual([]);
  });

  it("removes a routine file locally and pushes the deletion", () => {
    fs.rmSync(writerRoutine());

    const status = cli.json<StatusResult>(["routines", "status"], {
      cwd: writerDir,
    });
    expect(status.localChanges).toEqual(
      expect.arrayContaining([{ status: "deleted", path: ROUTINE_PATH }]),
    );

    const push = cli.json<PushResult>(["routines", "push"], { cwd: writerDir });
    expect(push.status).toBe("pushed");
    expect(push.deletes).toContain(ROUTINE_PATH);
  });

  it("propagates the deletion to another clone via pull", () => {
    const pull = cli.json<PullResult>(["routines", "pull"], { cwd: readerDir });
    expect(pull.status).toBe("updated");
    expect(pull.routinesDeleted).toContain(ROUTINE_PATH);

    expect(fs.existsSync(readerRoutine())).toBe(false);
  });
});
