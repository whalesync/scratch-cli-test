// Smoke test for the review/validation stats napi bindings added for the
// folder-tree "needs review" / "approved" dots (Slice 2 of the
// folder-tree-review-approved-dots plan).
//
// Exercises the real JS → Rust → JS round trip for `refreshFolder`,
// `getReviewStats`, and `getValidationStats` against a hand-built workspace +
// bare repo, plus the `INTERNAL:` error-message mapping. Mirrors the fixture
// and runner conventions in accept-field.test.mjs. Run with
// `node --test __tests__/` from the napi crate root after building the
// `.node` addon (CI runs scratch-desktop/scripts/build-native.sh first).

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

// Builds a workspace whose `HubSpot` connection has one record (rec_acme) on
// the `main` branch of a bare repo, matching accept-field.test.mjs. Returns
// both the workspace root and the `.scratch` root.
function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'napi-reviewstats-'));
  const bareRepo = join(tmp, '.repos', `${REPO_ID}.git`);
  const scratchRoot = join(tmp, '.scratch');
  const sourceDir = join(tmp, 'source');

  mkdirSync(scratchRoot, { recursive: true });
  mkdirSync(join(bareRepo, '..'), { recursive: true });
  mkdirSync(sourceDir, { recursive: true });

  const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: 'pipe' });
  git(sourceDir, 'init');
  git(sourceDir, 'checkout -b main');
  mkdirSync(join(sourceDir, 'Companies'), { recursive: true });
  writeFileSync(join(sourceDir, 'Companies/rec_acme.json'), JSON.stringify({ name: 'Acme', industry: 'Other' }, null, 2));
  git(sourceDir, 'add -A');
  git(sourceDir, '-c user.name=Test -c user.email=t@t commit -m seed');

  git(tmp, `clone --bare "${sourceDir}" "${bareRepo}"`);

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
  return { workspaceDir: tmp, scratchRoot };
}

function writeWorking(workspaceDir, recordRelPath, body) {
  const fp = join(workspaceDir, CONN, recordRelPath);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, body);
}

test('refreshFolder then getReviewStats reports unreviewed + approved counts for the folder', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  // rec_acme: working differs from published (industry Other → SaaS), no
  // accepted patch → unapprovedChanges (counts toward `unreviewed`).
  writeWorking(workspaceDir, 'Companies/rec_acme.json', JSON.stringify({ name: 'Acme', industry: 'SaaS' }, null, 2));

  // rec_new: a brand-new record accepted as a Create patch. Working == approved
  // so it's NOT unreviewed, but it has a patch entry → approvedChanges (counts
  // toward `approved`).
  writeWorking(workspaceDir, 'Companies/rec_new.json', JSON.stringify({ name: 'New Co' }, null, 2));
  await native.acceptField(workspaceDir, CONN, 'Companies/rec_new.json', 'name');

  // refreshFolder indexes the folder (no DB exists yet → seeds from working +
  // main) and returns the smart-refresh counts.
  const refreshResult = await native.refreshFolder(workspaceDir, `${CONN}/Companies`);
  assert.equal(typeof refreshResult.base_refreshed, 'number');
  assert.equal(typeof refreshResult.columns_refreshed, 'number');
  assert.ok(refreshResult.base_refreshed >= 2, `expected >=2 base refreshes, got ${refreshResult.base_refreshed}`);

  const stats = await native.getReviewStats(workspaceDir);
  const companies = stats.find((s) => s.connection === CONN && s.folder_path === 'Companies');
  assert.ok(companies, `expected a Companies entry, got ${JSON.stringify(stats)}`);
  assert.equal(companies.unreviewed, 1);
  assert.equal(companies.approved, 1);
});

test('getReviewStats returns an empty array for an unindexed workspace', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  // No working files written, no refresh run — the connection root doesn't
  // even exist on disk yet, so there are no folders to aggregate.
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
