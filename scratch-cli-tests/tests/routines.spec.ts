import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ScratchCli } from "../src/cli";
import { deleteWorkspace, uniqueName } from "../src/helpers";
import { scratchApiGet } from "../src/scratch-api";

const cli = new ScratchCli();

// Routines are REST-backed (DEV-12617): `scratchmd routines pull|status|push` talk to
// `/cli/v1/workbooks/:id/routines/{files,push}` and keep a local copy in `.scratch/routines/`
// plus a `.scratch/routines-state.json` manifest. No connection, config repo, or DATABASE_URL
// is needed — `workspaces init` works with zero connections and runs an initial routines pull.

interface RoutineFileChange {
  status: "added" | "modified" | "deleted";
  path: string;
}
interface RoutinesStatusResult {
  localChanges: RoutineFileChange[];
  remoteChanges: RoutineFileChange[];
  clean: boolean;
  behind: boolean;
  legacyConfigWorktreeRoutineEdits: string[];
}
interface RoutinesPushResult {
  status: "pushed" | "no_changes";
  upserts: string[];
  deletes: string[];
  versions: Record<string, number>;
  routineCount: number;
}
interface RoutinesPullResult {
  status: "up_to_date" | "updated";
  routinesAdded: string[];
  routinesModified: string[];
  routinesDeleted: string[];
  discardedLocalEdits: string[];
  routineCount: number;
  legacyConfigWorktreeRoutineEdits: string[];
}
interface RoutinesPushRefusedAsStale {
  status: "blocked_stale";
  staleFiles: {
    path: string;
    baseVersion: number | null;
    currentVersion: number | null;
  }[];
}
interface RoutinesPullRefusedBecauseOfConflicts {
  status: "conflicts";
  conflicts: { path: string; localChange: string; serverChange: string }[];
}
interface RoutinesManifestFileEntry {
  version: number;
  sha256: string;
}
interface RoutinesManifest {
  formatVersion: number;
  workbookId: string;
  files: Record<string, RoutinesManifestFileEntry>;
}
interface ServerRoutineFile {
  path: string;
  version: number;
  updatedAt: string;
  content?: string;
}

// Paths in `--json` output, the manifest, and the API are server-relative; on disk a routine
// lives under `.scratch/` (`routines/daily.yaml` → `<workspace>/.scratch/routines/daily.yaml`).
const DAILY = "routines/daily.yaml";
const WEEKLY = "routines/weekly.yaml";
const MONTHLY = "routines/monthly.yaml";

const DAILY_YAML_AS_CREATED = "name: Daily Sync\nsteps:\n  - action: pull\n";
const DAILY_YAML_AFTER_FIRST_EDIT =
  "name: Daily Sync (updated)\ncomment: edited by the routines integration test\nsteps:\n  - action: pull\n";
const DAILY_YAML_READER_EDIT_THAT_LANDS_FIRST =
  "name: Daily Sync (reader edit that lands first)\nsteps:\n  - action: pull\n";
const DAILY_YAML_WRITER_EDIT_FROM_STALE_BASE =
  "name: Daily Sync (writer edit from a stale base)\nsteps:\n  - action: pull\n";
const DAILY_YAML_READER_EDIT_WHILE_WRITER_DRAFTS_WEEKLY =
  "name: Daily Sync (reader edit while writer drafts weekly)\nsteps:\n  - action: pull\n";
const WEEKLY_YAML = "name: Weekly Sync\nsteps:\n  - action: pull\n";
const MONTHLY_YAML_CREATED_BY_READER =
  "name: Monthly Sync (reader)\nsteps:\n  - action: pull\n";
const MONTHLY_YAML_CREATED_BY_WRITER =
  "name: Monthly Sync (writer)\nsteps:\n  - action: pull\n";

const localRoutineFilePath = (
  workspaceDir: string,
  serverRelativeRoutinePath: string,
) => path.join(workspaceDir, ".scratch", serverRelativeRoutinePath);
const localRoutinesDirectory = (workspaceDir: string) =>
  path.join(workspaceDir, ".scratch", "routines");
const routinesManifestFilePath = (workspaceDir: string) =>
  path.join(workspaceDir, ".scratch", "routines-state.json");

const readRoutinesManifest = (workspaceDir: string): RoutinesManifest =>
  JSON.parse(fs.readFileSync(routinesManifestFilePath(workspaceDir), "utf-8"));
const readLocalRoutineFile = (workspaceDir: string, routinePath: string) =>
  fs.readFileSync(localRoutineFilePath(workspaceDir, routinePath), "utf-8");
const writeLocalRoutineFile = (
  workspaceDir: string,
  routinePath: string,
  yaml: string,
) => fs.writeFileSync(localRoutineFilePath(workspaceDir, routinePath), yaml);

const sha256HexOfContent = (content: string | Buffer) =>
  crypto.createHash("sha256").update(content).digest("hex");
const manifestEntryFor = (
  yaml: string,
  version: number,
): RoutinesManifestFileEntry => ({ version, sha256: sha256HexOfContent(yaml) });

async function fetchServerRoutineFiles(
  workbookId: string,
  options: { metadataOnly: boolean },
): Promise<ServerRoutineFile[]> {
  const query = options.metadataOnly ? "?metadataOnly=true" : "";
  const listing = await scratchApiGet<{ files: ServerRoutineFile[] }>(
    `/cli/v1/workbooks/${workbookId}/routines/files${query}`,
  );
  return listing.files;
}
async function fetchServerRoutineVersionByPath(
  workbookId: string,
): Promise<Record<string, number>> {
  const files = await fetchServerRoutineFiles(workbookId, {
    metadataOnly: true,
  });
  return Object.fromEntries(files.map((file) => [file.path, file.version]));
}
async function fetchServerRoutineContentByPath(
  workbookId: string,
): Promise<Record<string, string>> {
  const files = await fetchServerRoutineFiles(workbookId, {
    metadataOnly: false,
  });
  return Object.fromEntries(
    files.map((file) => [file.path, file.content ?? ""]),
  );
}

const runRoutinesStatus = (workspaceDir: string) =>
  cli.json<RoutinesStatusResult>(["routines", "status"], { cwd: workspaceDir });
const runRoutinesPull = (workspaceDir: string, extraArgs: string[] = []) =>
  cli.json<RoutinesPullResult>(["routines", "pull", ...extraArgs], {
    cwd: workspaceDir,
  });
const runRoutinesPush = (workspaceDir: string) =>
  cli.json<RoutinesPushResult>(["routines", "push"], { cwd: workspaceDir });
const runRoutinesCommandExpectingFailure = (
  workspaceDir: string,
  args: string[],
) => cli.run(["routines", ...args], { cwd: workspaceDir, expectError: true });

describe("Routines", () => {
  let workspaceId: string;
  let writerDir: string;
  let readerDir: string;
  let lateJoinerDir: string;
  const cloneParentDirsToRemove: string[] = [];

  /** Another local clone of the same workbook, used to prove changes round-trip via the server. */
  function initWorkspaceClone(label: string): string {
    const parentDir = path.join(cli.home, `routines-${label}-${uniqueName()}`);
    fs.mkdirSync(parentDir, { recursive: true });
    cloneParentDirsToRemove.push(parentDir);
    const initRun = cli.run(["workspaces", "init", workspaceId], {
      cwd: parentDir,
    });
    // The initial routines pull must never print to stdout: init's `--json` output stays one
    // JSON document (anything else goes to stderr).
    let initResult: { directory: string };
    try {
      initResult = JSON.parse(initRun.stdout);
    } catch {
      throw new Error(
        `workspaces init --json stdout is not one JSON document:\n${initRun.stdout}`,
      );
    }
    return path.join(parentDir, initResult.directory);
  }

  beforeAll(() => {
    workspaceId = cli.json<{ id: string }>([
      "workspaces",
      "create",
      uniqueName("routines"),
    ]).id;
    writerDir = initWorkspaceClone("writer");
    readerDir = initWorkspaceClone("reader");
  });

  afterAll(() => {
    if (workspaceId) deleteWorkspace(cli, workspaceId);
    for (const parentDir of cloneParentDirsToRemove) {
      try {
        fs.rmSync(parentDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("init pulls routines into .scratch/routines/ with an empty manifest, even with no connections", () => {
    for (const workspaceDir of [writerDir, readerDir]) {
      expect(fs.existsSync(localRoutinesDirectory(workspaceDir))).toBe(true);
      expect(readRoutinesManifest(workspaceDir)).toEqual({
        formatVersion: 1,
        workbookId: workspaceId,
        files: {},
      });
    }
  });

  it("starts clean, with nothing to pull", () => {
    expect(runRoutinesStatus(writerDir)).toEqual({
      localChanges: [],
      remoteChanges: [],
      clean: true,
      behind: false,
      legacyConfigWorktreeRoutineEdits: [],
    });
    expect(runRoutinesPull(writerDir)).toEqual({
      status: "up_to_date",
      routinesAdded: [],
      routinesModified: [],
      routinesDeleted: [],
      discardedLocalEdits: [],
      routineCount: 0,
      legacyConfigWorktreeRoutineEdits: [],
    });
  });

  it("creates a routine locally and pushes it as version 1", () => {
    writeLocalRoutineFile(writerDir, DAILY, DAILY_YAML_AS_CREATED);

    const status = runRoutinesStatus(writerDir);
    expect(status.localChanges).toEqual([{ status: "added", path: DAILY }]);
    expect(status.remoteChanges).toEqual([]);
    expect(status.clean).toBe(false);

    const push = runRoutinesPush(writerDir);
    expect(push.status).toBe("pushed");
    expect(push.upserts).toEqual([DAILY]);
    expect(push.deletes).toEqual([]);
    expect(push.versions).toEqual({ [DAILY]: 1 });
    expect(push.routineCount).toBe(1);
    expect(Object.keys(push)).not.toContain("head");

    expect(runRoutinesStatus(writerDir).clean).toBe(true);
  });

  it("records the pushed version and the exact content hash in the manifest, matching the server", async () => {
    expect(readRoutinesManifest(writerDir)).toEqual({
      formatVersion: 1,
      workbookId: workspaceId,
      files: { [DAILY]: manifestEntryFor(DAILY_YAML_AS_CREATED, 1) },
    });
    expect(readRoutinesManifest(writerDir).files[DAILY].sha256).toBe(
      sha256HexOfContent(
        fs.readFileSync(localRoutineFilePath(writerDir, DAILY)),
      ),
    );
    expect(await fetchServerRoutineVersionByPath(workspaceId)).toEqual({
      [DAILY]: 1,
    });
    // The YAML text round-trips byte-for-byte.
    expect(await fetchServerRoutineContentByPath(workspaceId)).toEqual({
      [DAILY]: DAILY_YAML_AS_CREATED,
    });
  });

  it("shows the new routine as a server change in another clone, then pulls it", () => {
    expect(runRoutinesStatus(readerDir)).toEqual({
      localChanges: [],
      remoteChanges: [{ status: "added", path: DAILY }],
      clean: false,
      behind: true,
      legacyConfigWorktreeRoutineEdits: [],
    });

    expect(runRoutinesPull(readerDir)).toEqual({
      status: "updated",
      routinesAdded: [DAILY],
      routinesModified: [],
      routinesDeleted: [],
      discardedLocalEdits: [],
      routineCount: 1,
      legacyConfigWorktreeRoutineEdits: [],
    });
    expect(readLocalRoutineFile(readerDir, DAILY)).toBe(DAILY_YAML_AS_CREATED);
    expect(readRoutinesManifest(readerDir).files).toEqual({
      [DAILY]: manifestEntryFor(DAILY_YAML_AS_CREATED, 1),
    });
    // Routines no longer live in the old config-worktree location.
    expect(
      fs.existsSync(path.join(readerDir, ".scratch", "workspace", "routines")),
    ).toBe(false);
    expect(runRoutinesStatus(readerDir).clean).toBe(true);
  });

  it("downloads existing routines into a newly initialized workspace", () => {
    lateJoinerDir = initWorkspaceClone("late-joiner");

    expect(readLocalRoutineFile(lateJoinerDir, DAILY)).toBe(
      DAILY_YAML_AS_CREATED,
    );
    expect(readRoutinesManifest(lateJoinerDir).files).toEqual({
      [DAILY]: manifestEntryFor(DAILY_YAML_AS_CREATED, 1),
    });
    expect(runRoutinesStatus(lateJoinerDir).clean).toBe(true);
  });

  it("refuses to push a missing routines directory as mass deletes, and pull restores it", () => {
    fs.rmSync(localRoutinesDirectory(lateJoinerDir), {
      recursive: true,
      force: true,
    });

    const refusedPush = runRoutinesCommandExpectingFailure(lateJoinerDir, [
      "push",
    ]);
    expect(refusedPush.exitCode).toBe(1);
    expect(refusedPush.stderr).toContain("nothing was pushed");
    expect(refusedPush.stderr).toContain("scratchmd routines pull");

    const pull = runRoutinesPull(lateJoinerDir);
    expect(pull.status).toBe("updated");
    expect(pull.routinesAdded).toEqual([DAILY]);
    expect(readLocalRoutineFile(lateJoinerDir, DAILY)).toBe(
      DAILY_YAML_AS_CREATED,
    );
    expect(runRoutinesStatus(lateJoinerDir).clean).toBe(true);
  });

  it("rebuilds a missing manifest and routines directory (a workspace made by an older scratchmd)", () => {
    fs.rmSync(routinesManifestFilePath(lateJoinerDir), { force: true });
    fs.rmSync(localRoutinesDirectory(lateJoinerDir), {
      recursive: true,
      force: true,
    });

    expect(runRoutinesPull(lateJoinerDir)).toEqual({
      status: "updated",
      routinesAdded: [DAILY],
      routinesModified: [],
      routinesDeleted: [],
      discardedLocalEdits: [],
      routineCount: 1,
      legacyConfigWorktreeRoutineEdits: [],
    });
    expect(readRoutinesManifest(lateJoinerDir).files).toEqual({
      [DAILY]: manifestEntryFor(DAILY_YAML_AS_CREATED, 1),
    });
  });

  it("pushes a local edit as version 2 and pulls it into another clone", async () => {
    writeLocalRoutineFile(writerDir, DAILY, DAILY_YAML_AFTER_FIRST_EDIT);
    expect(runRoutinesStatus(writerDir).localChanges).toEqual([
      { status: "modified", path: DAILY },
    ]);

    const push = runRoutinesPush(writerDir);
    expect(push.upserts).toEqual([DAILY]);
    expect(push.versions).toEqual({ [DAILY]: 2 });
    expect(readRoutinesManifest(writerDir).files).toEqual({
      [DAILY]: manifestEntryFor(DAILY_YAML_AFTER_FIRST_EDIT, 2),
    });
    expect(await fetchServerRoutineVersionByPath(workspaceId)).toEqual({
      [DAILY]: 2,
    });

    const pull = runRoutinesPull(readerDir);
    expect(pull.status).toBe("updated");
    expect(pull.routinesModified).toEqual([DAILY]);
    expect(readLocalRoutineFile(readerDir, DAILY)).toBe(
      DAILY_YAML_AFTER_FIRST_EDIT,
    );
  });

  it("reports no changes to push when local files match the manifest", () => {
    expect(runRoutinesPush(writerDir)).toEqual({
      status: "no_changes",
      upserts: [],
      deletes: [],
      versions: {},
      routineCount: 0,
    });
  });

  it("refuses a push from a stale base (409), then recovers via pull → pull --discard-local → re-push", async () => {
    writeLocalRoutineFile(
      readerDir,
      DAILY,
      DAILY_YAML_READER_EDIT_THAT_LANDS_FIRST,
    );
    expect(runRoutinesPush(readerDir).versions).toEqual({ [DAILY]: 3 });

    writeLocalRoutineFile(
      writerDir,
      DAILY,
      DAILY_YAML_WRITER_EDIT_FROM_STALE_BASE,
    );
    expect(runRoutinesStatus(writerDir)).toEqual({
      localChanges: [{ status: "modified", path: DAILY }],
      remoteChanges: [{ status: "modified", path: DAILY }],
      clean: false,
      behind: true,
      legacyConfigWorktreeRoutineEdits: [],
    });

    // The push is refused as a whole: exit 1, the stale file named, nothing saved.
    const stalePush = runRoutinesCommandExpectingFailure(writerDir, ["push"]);
    expect(stalePush.exitCode).toBe(1);
    expect(stalePush.stderr).toContain(DAILY);
    expect(stalePush.stderr).toContain("scratchmd routines pull");
    expect(JSON.parse(stalePush.stdout) as RoutinesPushRefusedAsStale).toEqual({
      status: "blocked_stale",
      staleFiles: [{ path: DAILY, baseVersion: 2, currentVersion: 3 }],
    });
    expect(await fetchServerRoutineContentByPath(workspaceId)).toEqual({
      [DAILY]: DAILY_YAML_READER_EDIT_THAT_LANDS_FIRST,
    });
    expect(readLocalRoutineFile(writerDir, DAILY)).toBe(
      DAILY_YAML_WRITER_EDIT_FROM_STALE_BASE,
    );
    expect(readRoutinesManifest(writerDir).files).toEqual({
      [DAILY]: manifestEntryFor(DAILY_YAML_AFTER_FIRST_EDIT, 2),
    });

    // A plain pull refuses too: the same file changed locally and on the server.
    const conflictingPull = runRoutinesCommandExpectingFailure(writerDir, [
      "pull",
    ]);
    expect(conflictingPull.exitCode).toBe(1);
    expect(conflictingPull.stderr).toContain(DAILY);
    expect(conflictingPull.stderr).toContain("--discard-local");
    expect(
      JSON.parse(
        conflictingPull.stdout,
      ) as RoutinesPullRefusedBecauseOfConflicts,
    ).toEqual({
      status: "conflicts",
      conflicts: [
        { path: DAILY, localChange: "modified", serverChange: "modified" },
      ],
    });
    expect(readLocalRoutineFile(writerDir, DAILY)).toBe(
      DAILY_YAML_WRITER_EDIT_FROM_STALE_BASE,
    );

    // --discard-local takes the server's version.
    expect(runRoutinesPull(writerDir, ["--discard-local"])).toEqual({
      status: "updated",
      routinesAdded: [],
      routinesModified: [DAILY],
      routinesDeleted: [],
      discardedLocalEdits: [DAILY],
      routineCount: 1,
      legacyConfigWorktreeRoutineEdits: [],
    });
    expect(readLocalRoutineFile(writerDir, DAILY)).toBe(
      DAILY_YAML_READER_EDIT_THAT_LANDS_FIRST,
    );
    expect(readRoutinesManifest(writerDir).files).toEqual({
      [DAILY]: manifestEntryFor(DAILY_YAML_READER_EDIT_THAT_LANDS_FIRST, 3),
    });

    // Re-applying the edit on top of the latest version pushes cleanly.
    writeLocalRoutineFile(
      writerDir,
      DAILY,
      DAILY_YAML_WRITER_EDIT_FROM_STALE_BASE,
    );
    expect(runRoutinesPush(writerDir).versions).toEqual({ [DAILY]: 4 });
    expect(await fetchServerRoutineVersionByPath(workspaceId)).toEqual({
      [DAILY]: 4,
    });

    const readerPull = runRoutinesPull(readerDir);
    expect(readerPull.routinesModified).toEqual([DAILY]);
    expect(readLocalRoutineFile(readerDir, DAILY)).toBe(
      DAILY_YAML_WRITER_EDIT_FROM_STALE_BASE,
    );
  });

  it("refuses to overwrite a new routine another clone created first (baseVersion: null)", async () => {
    writeLocalRoutineFile(readerDir, MONTHLY, MONTHLY_YAML_CREATED_BY_READER);
    expect(runRoutinesPush(readerDir).versions).toEqual({ [MONTHLY]: 1 });

    writeLocalRoutineFile(writerDir, MONTHLY, MONTHLY_YAML_CREATED_BY_WRITER);
    const stalePush = runRoutinesCommandExpectingFailure(writerDir, ["push"]);
    expect(stalePush.exitCode).toBe(1);
    expect(stalePush.stderr).toContain(MONTHLY);
    expect(JSON.parse(stalePush.stdout) as RoutinesPushRefusedAsStale).toEqual({
      status: "blocked_stale",
      staleFiles: [{ path: MONTHLY, baseVersion: null, currentVersion: 1 }],
    });
    expect((await fetchServerRoutineContentByPath(workspaceId))[MONTHLY]).toBe(
      MONTHLY_YAML_CREATED_BY_READER,
    );

    const pull = runRoutinesPull(writerDir, ["--discard-local"]);
    expect(pull.routinesAdded).toEqual([MONTHLY]);
    expect(pull.discardedLocalEdits).toEqual([MONTHLY]);
    expect(readLocalRoutineFile(writerDir, MONTHLY)).toBe(
      MONTHLY_YAML_CREATED_BY_READER,
    );
    expect(runRoutinesStatus(writerDir).clean).toBe(true);
  });

  it("applies a server edit while keeping an unrelated unpushed local routine", () => {
    writeLocalRoutineFile(writerDir, WEEKLY, WEEKLY_YAML);

    writeLocalRoutineFile(
      readerDir,
      DAILY,
      DAILY_YAML_READER_EDIT_WHILE_WRITER_DRAFTS_WEEKLY,
    );
    expect(runRoutinesPush(readerDir).versions).toEqual({ [DAILY]: 5 });

    const pull = runRoutinesPull(writerDir);
    expect(pull.status).toBe("updated");
    expect(pull.routinesModified).toEqual([DAILY]);
    expect(pull.routinesAdded).toEqual([]);
    expect(pull.discardedLocalEdits).toEqual([]);
    expect(readLocalRoutineFile(writerDir, DAILY)).toBe(
      DAILY_YAML_READER_EDIT_WHILE_WRITER_DRAFTS_WEEKLY,
    );
    expect(readLocalRoutineFile(writerDir, WEEKLY)).toBe(WEEKLY_YAML);
    // Use Object.keys for absence: Jest's toHaveProperty would split "routines/weekly.yaml" on
    // the dot and look up a nested key instead.
    expect(Object.keys(readRoutinesManifest(writerDir).files)).not.toContain(
      WEEKLY,
    );

    expect(runRoutinesStatus(writerDir)).toEqual({
      localChanges: [{ status: "added", path: WEEKLY }],
      remoteChanges: [],
      clean: false,
      behind: false,
      legacyConfigWorktreeRoutineEdits: [],
    });

    const push = runRoutinesPush(writerDir);
    expect(push.upserts).toEqual([WEEKLY]);
    expect(push.deletes).toEqual([]);
    expect(push.versions).toEqual({ [WEEKLY]: 1 });
  });

  it("pushes a local deletion and pulls it into another clone", async () => {
    fs.rmSync(localRoutineFilePath(writerDir, DAILY));
    expect(runRoutinesStatus(writerDir).localChanges).toEqual([
      { status: "deleted", path: DAILY },
    ]);

    const push = runRoutinesPush(writerDir);
    expect(push.status).toBe("pushed");
    expect(push.upserts).toEqual([]);
    expect(push.deletes).toEqual([DAILY]);
    expect(Object.keys(push.versions)).not.toContain(DAILY);
    expect(Object.keys(readRoutinesManifest(writerDir).files)).not.toContain(
      DAILY,
    );
    expect(
      Object.keys(await fetchServerRoutineVersionByPath(workspaceId)),
    ).not.toContain(DAILY);

    const pull = runRoutinesPull(readerDir);
    expect(pull.routinesDeleted).toEqual([DAILY]);
    expect(fs.existsSync(localRoutineFilePath(readerDir, DAILY))).toBe(false);
    expect(Object.keys(readRoutinesManifest(readerDir).files)).not.toContain(
      DAILY,
    );
  });
});
