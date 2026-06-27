import { execFileSync } from 'child_process';
import { lstatSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Builds, on disk, a minimal but real Scratch workspace that reproduces the DEV-10609 accept bug:
 * a single connection whose `accepted-patches.json` already holds an accepted Update edit on
 * record **B**, plus an unreviewed working edit on record **A**. Accepting **A** used to crash in
 * `scratchmd files accept` because the approved-state replay applied B's patch against a `main`
 * read that was narrowed to A only (base `Null` → "path traverses non-container"). The desktop UI
 * then swallowed the non-zero exit, so the click did nothing.
 *
 * The fixture is the exact on-disk shape the CLI expects (see scratch-git-2 `WorkspaceLayout`):
 *   <workspace>/
 *     .scratch/.scratchmd                                  ← workspace marker (v3)
 *     .scratch/connections/<conn>/accepted-patches.json    ← B's accepted edit
 *     .repos/<coa>.git                                     ← bare repo, `main` = {A0, B0}
 *     <conn>/Records/{A,B}.json                            ← linked worktree (A edited, B = accepted value)
 *
 * Validated independently: `scratchmd files accept <conn>/Records/A.json` exits 0 against this
 * fixture with the fix, and crashes without it.
 */

export interface AcceptBugWorkspace {
  /** Absolute path to the workspace root (the dir that holds `.scratch/.scratchmd`). */
  workspacePath: string;
  workbookId: string;
  connectorAccountId: string;
  connectionDirName: string;
  /** Folder (table) directory name within the connection, e.g. `Records`. */
  folderName: string;
  /** Display name of record A's title field value, for grid assertions. */
  recordAName: string;
  /** CLI path of record A (`<conn>/Records/A.json`), the one the user approves. */
  recordACliPath: string;
  /** Absolute path to the connection's accepted-patches.json (assert A lands here). */
  acceptedPatchesPath: string;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'e2e',
  GIT_AUTHOR_EMAIL: 'e2e@whalesync.com',
  GIT_COMMITTER_NAME: 'e2e',
  GIT_COMMITTER_EMAIL: 'e2e@whalesync.com',
  // Isolate from the developer's global/system git config so the fixture is deterministic.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(args: string[], cwd?: string): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });
}

function recordJson(id: string, name: string, body: string): string {
  return JSON.stringify({ id, fieldData: { name, body } }, null, 2) + '\n';
}

/**
 * Create the fixture under `rootDir` (a fresh temp dir the caller owns and cleans up).
 * Returns the identifiers the spec needs to register, mock, navigate, and assert.
 */
export function buildAcceptBugWorkspace(rootDir: string): AcceptBugWorkspace {
  const workbookId = 'wkb_E2EACCEPT01';
  const connectorAccountId = 'coa_E2EACCEPT01';
  const orgId = 'org_E2EACCEPT01';
  const connectionDirName = 'TestConn';
  const folderName = 'Records';
  const recordAName = 'Alpha';

  const workspacePath = join(rootDir, 'E2E Accept Fixture');
  const bareRepo = join(workspacePath, '.repos', `${connectorAccountId}.git`);
  const worktree = join(workspacePath, connectionDirName);
  const connScratchDir = join(workspacePath, '.scratch', 'connections', connectionDirName);

  mkdirSync(join(workspacePath, '.repos'), { recursive: true });
  mkdirSync(connScratchDir, { recursive: true });

  // Bare repo with `main` = {Records/A.json: a0, Records/B.json: b0}.
  git(['init', '--bare', '-q', '-b', 'main', bareRepo]);
  const seed = join(rootDir, 'seed');
  git(['init', '-q', '-b', 'main', seed]);
  mkdirSync(join(seed, folderName), { recursive: true });
  writeFileSync(join(seed, folderName, 'A.json'), recordJson('A', recordAName, 'a0'));
  writeFileSync(join(seed, folderName, 'B.json'), recordJson('B', 'Bravo', 'b0'));
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'init'], seed);
  git(['push', '-q', bareRepo, 'main'], seed);

  // Linked worktree checked out at `main` (its `.git` is a file pointer).
  git(['--git-dir=' + bareRepo, 'worktree', 'add', '-q', worktree, 'main']);
  if (!lstatSync(join(worktree, '.git')).isFile()) {
    throw new Error('expected the connection worktree `.git` to be a linked-worktree file pointer');
  }

  // Working edits: A is unreviewed (a0 → a1); B matches its accepted patch value (b0 → b1).
  writeFileSync(join(worktree, folderName, 'A.json'), recordJson('A', recordAName, 'a1-edited'));
  writeFileSync(join(worktree, folderName, 'B.json'), recordJson('B', 'Bravo', 'b1-accepted'));

  // Workspace marker (v3).
  writeFileSync(
    join(workspacePath, '.scratch', '.scratchmd'),
    `version: '3'
workbook:
  id: ${workbookId}
  name: E2E Accept Fixture
  orgId: ${orgId}
  serverUrl: https://test-api.scratch.md
  initializedAt: 2026-01-01T00:00:00+00:00
connections:
- id: ${connectorAccountId}
  displayName: ${connectionDirName}
  service: AIRTABLE
  repoPath: ${orgId}/${workbookId}/${connectorAccountId}
  dirName: ${connectionDirName}
  structureVersion: 1
`,
  );

  // The unrelated accepted edit on record B that triggered the crash.
  const acceptedPatchesPath = join(connScratchDir, 'accepted-patches.json');
  writeFileSync(
    acceptedPatchesPath,
    JSON.stringify(
      {
        version: 2,
        patches: [
          {
            path: `${folderName}/B.json`,
            kind: 'update',
            patch: [{ op: 'add', path: '/fieldData/body', value: 'b1-accepted' }],
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );

  return {
    workspacePath,
    workbookId,
    connectorAccountId,
    connectionDirName,
    folderName,
    recordAName,
    recordACliPath: `${connectionDirName}/${folderName}/A.json`,
    acceptedPatchesPath,
  };
}

/** YAML for `~/.scratchmd/workspaces.yaml` registering this one local workspace. */
export function workspaceRegistryYaml(ws: AcceptBugWorkspace): string {
  return `version: '1'
workspaces:
- id: ${JSON.stringify(ws.workbookId)}
  path: ${JSON.stringify(ws.workspacePath)}
`;
}

/** Minimal server `GET /workbook/:id` (and list) payload matching the on-disk fixture. */
export function workspaceDetailMock(ws: AcceptBugWorkspace): Record<string, unknown> {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: ws.workbookId,
    name: 'E2E Accept Fixture',
    createdAt: now,
    updatedAt: now,
    version: 1,
    isPendingDelete: false,
    managedBy: null,
    userId: 'user_e2e',
    organizationId: 'org_E2EACCEPT01',
    dataFolders: [
      {
        id: 'dfo_E2EACCEPT01',
        createdAt: now,
        updatedAt: now,
        name: ws.folderName,
        workbookId: ws.workbookId,
        connectorAccountId: ws.connectorAccountId,
        connectorDisplayName: ws.connectionDirName,
        connectorService: 'AIRTABLE',
        path: `/${ws.connectionDirName}/${ws.folderName}`,
        remoteWebUrl: null,
        lock: null,
        version: 1,
        tableId: ['tbl_e2e'],
        isAssetTable: false,
        options: null,
        schedules: [],
        lastFullPullAt: now,
        lastIncrementalPullAt: null,
        recordCount: 2,
        incrementalPullSupport: 'NOT_SUPPORTED',
      },
    ],
  };
}
