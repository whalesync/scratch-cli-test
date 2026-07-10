import { execFileSync } from 'child_process';
import { lstatSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Builds, on disk, a real Scratch workspace with a configurable set of records in one folder, so a
 * review spec can request exactly the mix it needs (e.g. two unreviewed records to exercise the
 * drawer stepper + Approve-next auto-advance, plus an already-approved one). It generalizes the
 * single-record `accept-bug-workspace.ts` shape to N records; `accept-bug-workspace.ts` is left alone
 * (it is pinned to the DEV-10609 regression).
 *
 * Per-record state:
 *   - `modified`  — in `main` at its published value, worktree carries an unreviewed edit.
 *   - `created`   — absent from `main`, present only in the worktree (an unreviewed new record).
 *   - `approved`  — a new record whose creation is approved: absent from `main`, present in the worktree,
 *                   with a `create`-kind `accepted-patches.json` entry carrying the full content. It sits
 *                   on the approved side of the ladder, counting as `unpublished` in the review
 *                   `filterCounts`. NOTE: a hermetic fixture that was never pulled has no folder-index
 *                   baseline, so every record's `__rowStatus` is `added` regardless of approval; the
 *                   fully-approved `addedUnpublished` row status only appears once the app's own approve
 *                   updates the index. So `approved` here is "counts as approved", not the `addedUnpublished`
 *                   row status.
 *
 * On-disk layout (the exact shape the CLI expects — see scratch-git-2 `WorkspaceLayout`):
 *   <workspace>/
 *     .scratch/.scratchmd                                  ← workspace marker (v3)
 *     .scratch/connections/<conn>/accepted-patches.json    ← approved records' patches
 *     .repos/<coa>.git                                     ← bare repo, `main` = published records
 *     <conn>/Records/<id>.json                             ← linked worktree (edits applied)
 */

export type ReviewRecordState = 'modified' | 'approved' | 'created';

export interface ReviewRecordSpec {
  /** Record id + filename stem (e.g. `R1` → `R1.json`). */
  id: string;
  /** Title-field (`name`) value, used for grid/drawer assertions. */
  name: string;
  state: ReviewRecordState;
}

export interface ReviewSurfaceWorkspace {
  workspacePath: string;
  workbookId: string;
  connectorAccountId: string;
  connectionDirName: string;
  /** Folder (table) directory name within the connection, e.g. `Records`. */
  folderName: string;
  /** Absolute path to the connection's accepted-patches.json. */
  acceptedPatchesPath: string;
  records: ReviewRecordSpec[];
  /** CLI path of a record (`<conn>/Records/<id>.json`). */
  recordCliPath: (id: string) => string;
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

const publishedBody = (id: string) => `${id}-published`;
const editedBody = (id: string) => `${id}-edited`;
const approvedBody = (id: string) => `${id}-approved`;
const createdBody = (id: string) => `${id}-new`;

/**
 * Create the fixture under `rootDir` (a fresh temp dir the caller owns and cleans up). Records are
 * laid out in the order given, which is the order the drawer stepper walks them.
 */
export function buildReviewSurfaceWorkspace(rootDir: string, records: ReviewRecordSpec[]): ReviewSurfaceWorkspace {
  const workbookId = 'wkb_E2EREVIEW01';
  const connectorAccountId = 'coa_E2EREVIEW01';
  const orgId = 'org_E2EREVIEW01';
  const connectionDirName = 'TestConn';
  const folderName = 'Records';

  const workspacePath = join(rootDir, 'E2E Review Fixture');
  const bareRepo = join(workspacePath, '.repos', `${connectorAccountId}.git`);
  const worktree = join(workspacePath, connectionDirName);
  const connScratchDir = join(workspacePath, '.scratch', 'connections', connectionDirName);

  mkdirSync(join(workspacePath, '.repos'), { recursive: true });
  mkdirSync(connScratchDir, { recursive: true });

  // Bare repo whose `main` holds the PUBLISHED value of every record that exists remotely. Only
  // `modified` records have a remote/published counterpart; `created` and `approved` are new records
  // (no main blob — an accepted `create` is what makes `approved` fully-approved).
  git(['init', '--bare', '-q', '-b', 'main', bareRepo]);
  const seed = join(rootDir, 'seed');
  git(['init', '-q', '-b', 'main', seed]);
  mkdirSync(join(seed, folderName), { recursive: true });
  const publishedRecords = records.filter((record) => record.state === 'modified');
  for (const record of publishedRecords) {
    writeFileSync(
      join(seed, folderName, `${record.id}.json`),
      recordJson(record.id, record.name, publishedBody(record.id)),
    );
  }
  git(['add', '-A'], seed);
  // `--allow-empty` so a fixture of only new (created/approved) records still has a `main` to branch from.
  git(['commit', '-q', '--allow-empty', '-m', 'init'], seed);
  git(['push', '-q', bareRepo, 'main'], seed);

  // Linked worktree checked out at `main` (its `.git` is a file pointer).
  git(['--git-dir=' + bareRepo, 'worktree', 'add', '-q', worktree, 'main']);
  if (!lstatSync(join(worktree, '.git')).isFile()) {
    throw new Error('expected the connection worktree `.git` to be a linked-worktree file pointer');
  }

  // Working edits per record: modified → unreviewed edit against main; approved → a new file plus a
  // `create`-kind accepted patch (counts on the approved side of the ladder); created → a new (untracked) file.
  const acceptedPatches: { path: string; kind: string; patch: unknown }[] = [];
  for (const record of records) {
    const filePath = join(worktree, folderName, `${record.id}.json`);
    if (record.state === 'modified') {
      writeFileSync(filePath, recordJson(record.id, record.name, editedBody(record.id)));
    } else if (record.state === 'approved') {
      const content = recordJson(record.id, record.name, approvedBody(record.id));
      writeFileSync(filePath, content);
      // A `create`-kind patch carries the full record content (REVIEW_MODEL.md): the record's creation
      // is approved, so it counts as `unpublished` in the review filterCounts (see the fixture-level note
      // above on why its `__rowStatus` is still `added` in a hermetic, never-pulled fixture).
      acceptedPatches.push({
        path: `${folderName}/${record.id}.json`,
        kind: 'create',
        patch: JSON.parse(content) as unknown,
      });
    } else {
      writeFileSync(filePath, recordJson(record.id, record.name, createdBody(record.id)));
    }
  }

  // Workspace marker (v3).
  writeFileSync(
    join(workspacePath, '.scratch', '.scratchmd'),
    `version: '3'
workbook:
  id: ${workbookId}
  name: E2E Review Fixture
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

  const acceptedPatchesPath = join(connScratchDir, 'accepted-patches.json');
  writeFileSync(acceptedPatchesPath, JSON.stringify({ version: 2, patches: acceptedPatches }, null, 2) + '\n');

  return {
    workspacePath,
    workbookId,
    connectorAccountId,
    connectionDirName,
    folderName,
    acceptedPatchesPath,
    records,
    recordCliPath: (id: string) => `${connectionDirName}/${folderName}/${id}.json`,
  };
}

/** YAML for `~/.scratchmd/workspaces.yaml` registering this one local workspace. */
export function reviewWorkspaceRegistryYaml(ws: ReviewSurfaceWorkspace): string {
  return `version: '1'
workspaces:
- id: ${JSON.stringify(ws.workbookId)}
  path: ${JSON.stringify(ws.workspacePath)}
`;
}

/** Minimal server `GET /workbook/:id` (and list) payload matching the on-disk fixture. */
export function reviewWorkspaceDetailMock(ws: ReviewSurfaceWorkspace): Record<string, unknown> {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: ws.workbookId,
    name: 'E2E Review Fixture',
    createdAt: now,
    updatedAt: now,
    version: 1,
    isPendingDelete: false,
    managedBy: null,
    userId: 'user_e2e',
    organizationId: 'org_E2EREVIEW01',
    dataFolders: [
      {
        id: 'dfo_E2EREVIEW01',
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
        recordCount: ws.records.length,
        incrementalPullSupport: 'NOT_SUPPORTED',
      },
    ],
  };
}
