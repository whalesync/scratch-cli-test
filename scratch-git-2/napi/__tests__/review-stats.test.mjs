// Smoke test for the review/validation stats napi bindings that back the
// folder-tree "needs review" / "approved" dots.
//
// Exercises the real JS → Rust → JS round trip for `getReviewStats` and
// `getValidationStats` against a hand-built workspace. `getReviewStats` derives
// its counts live from `gix status` + `accepted-patches.json` (DEV-10327), so
// the connection directory must be a real git worktree on `main` — no
// persisted index, no `refreshFolder` step. Mirrors the fixture conventions in
// accept-field.test.mjs. Run with `node --test __tests__/` from the napi crate
// root after building the `.node` addon (CI runs
// scratch-desktop/scripts/build-native.sh first).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadNative() {
  const platform = process.platform;
  const arch = process.arch;
  const abi = platform === 'linux' ? '-gnu' : '';
  const filename = `scratchmd-native.${platform}-${arch}${abi}.node`;
  const path = join(__dirname, '..', filename);
  if (!existsSync(path)) {
    throw new Error(`${filename} not found. Build it first via scratch-desktop/scripts/build-native.sh.`);
  }
  return require(path);
}

const REPO_ID = 'conn1';
const CONN = 'HubSpot';

// Builds a workspace whose `HubSpot` connection is a real git worktree on
// `main` at `<tmp>/HubSpot`, with one committed record (rec_acme). A bare repo
// cloned from it lives at `<tmp>/.repos/conn1.git` — the layout
// `collect_review_stats` resolves via the workspace marker. Returns the
// workspace root.
function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'napi-reviewstats-'));
  const bareRepo = join(tmp, '.repos', `${REPO_ID}.git`);
  const scratchRoot = join(tmp, '.scratch');
  const worktree = join(tmp, CONN);

  mkdirSync(scratchRoot, { recursive: true });
  mkdirSync(join(bareRepo, '..'), { recursive: true });
  mkdirSync(worktree, { recursive: true });

  const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: 'pipe' });
  // The connection dir IS the worktree: init on main, commit the seed record,
  // then clone a bare repo from it (gix status compares the worktree to its
  // index; collect_review_stats reads `main` blobs from the bare repo).
  git(worktree, 'init -q -b main');
  mkdirSync(join(worktree, 'Companies'), { recursive: true });
  writeFileSync(
    join(worktree, 'Companies/rec_acme.json'),
    JSON.stringify({ name: 'Acme', industry: 'Other' }, null, 2),
  );
  git(worktree, 'add -A');
  git(worktree, '-c user.name=Test -c user.email=t@t commit -q -m seed');
  git(worktree, `clone -q --bare . "${bareRepo}"`);

  writeFileSync(
    join(scratchRoot, '.scratchmd'),
    `version: "3"
workbook:
  id: wkb_test
  name: Test
  orgId: org_test
  serverUrl: http://localhost
  initializedAt: 2026-01-01T00:00:00Z
connections:
  - id: conn_test
    displayName: ${CONN}
    service: AIRTABLE
    repoPath: ${REPO_ID}
    dirName: ${CONN}
`,
  );
  mkdirSync(join(scratchRoot, 'connections', CONN), { recursive: true });
  return { workspaceDir: tmp };
}

function writeWorking(workspaceDir, recordRelPath, body) {
  const fp = join(workspaceDir, CONN, recordRelPath);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, body);
}

test('getReviewStats reports unreviewed + approved counts derived from git', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  // rec_acme: working differs from main (industry Other → SaaS), no accepted
  // patch → an unreviewed working-tree edit (counts toward `unreviewed`).
  writeWorking(workspaceDir, 'Companies/rec_acme.json', JSON.stringify({ name: 'Acme', industry: 'SaaS' }, null, 2));

  // rec_new: a brand-new record accepted as a Create patch. Working == approved
  // so it's NOT unreviewed, but it has a patch entry → counts toward `approved`.
  writeWorking(workspaceDir, 'Companies/rec_new.json', JSON.stringify({ name: 'New Co' }, null, 2));
  await native.acceptField(workspaceDir, CONN, 'Companies/rec_new.json', 'name');

  const stats = await native.getReviewStats(workspaceDir);
  const companies = stats.find((s) => s.connection === CONN && s.folder_path === 'Companies');
  assert.ok(companies, `expected a Companies entry, got ${JSON.stringify(stats)}`);
  assert.equal(companies.unreviewed, 1);
  assert.equal(companies.approved, 1);
});

test('getReviewStats returns an empty array for a clean workspace', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  // No working changes and no accepted patches → nothing to report.
  const stats = await native.getReviewStats(workspaceDir);
  assert.ok(Array.isArray(stats));
  assert.equal(stats.length, 0);
});

test('getReviewStats rejects with INTERNAL: when the workspace marker is missing', async () => {
  const native = loadNative();
  const emptyDir = mkdtempSync(join(tmpdir(), 'napi-reviewstats-nomarker-'));

  await assert.rejects(
    () => native.getReviewStats(emptyDir),
    (err) => err.message.startsWith('INTERNAL:'),
  );
});

test('getValidationStats returns an empty array when no validation index exists', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  // Marker present but no `.repos/<conn>.db` yet → the connection is skipped
  // leniently rather than erroring. This is the migrated-from-shell-out path.
  const stats = await native.getValidationStats(workspaceDir);
  assert.ok(Array.isArray(stats));
  assert.equal(stats.length, 0);
});

test('getValidationStats rejects with INTERNAL: when the workspace marker is missing', async () => {
  const native = loadNative();
  const emptyDir = mkdtempSync(join(tmpdir(), 'napi-valstats-nomarker-'));

  await assert.rejects(
    () => native.getValidationStats(emptyDir),
    (err) => err.message.startsWith('INTERNAL:'),
  );
});
