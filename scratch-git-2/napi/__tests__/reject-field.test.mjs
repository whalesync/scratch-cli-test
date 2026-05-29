// Integration test for the napi `rejectField` binding. The strict invariant
// from `docs/REVIEW_MODEL.md` is that Reject restores the working file to the
// approved value WITHOUT mutating `accepted-patches.json`. The stacked test
// (approved patch entry + further unreviewed edit on top) is the critical
// case that locks the invariant in.
//
// Run from this directory with `node --test reject-field.test.mjs`. The
// binary must already be built (see `scratch-desktop/scripts/build-native.sh`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
    throw new Error(
      `${filename} not found. Build it first with scratch-desktop/scripts/build-native.sh.`,
    );
  }
  return require(path);
}

const REPO_ID = 'conn1';
const CONN = 'HubSpot';

function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'napi-reject-test-'));
  const bareRepo = join(tmp, '.repos', `${REPO_ID}.git`);
  const scratchRoot = join(tmp, '.scratch');
  const sourceDir = join(tmp, 'source');

  mkdirSync(scratchRoot, { recursive: true });
  mkdirSync(join(bareRepo, '..'), { recursive: true });
  mkdirSync(sourceDir, { recursive: true });

  const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: 'pipe' });
  git(sourceDir, 'init');
  git(sourceDir, 'checkout -b main');
  writeFileSync(join(sourceDir, '.scratch-seed'), 'init');
  mkdirSync(join(sourceDir, 'Companies'), { recursive: true });
  writeFileSync(
    join(sourceDir, 'Companies/rec_acme.json'),
    JSON.stringify({ name: 'Acme', industry: 'Other' }, null, 2),
  );
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

function readPatches(scratchRoot) {
  const patchPath = join(scratchRoot, 'connections', CONN, 'accepted-patches.json');
  if (!existsSync(patchPath)) return { patches: [] };
  return JSON.parse(readFileSync(patchPath, 'utf8'));
}

test('rejectField on an unreviewed-only field restores working to main and leaves patches untouched', async () => {
  const native = loadNative();
  const { workspaceDir, scratchRoot } = makeFixture();

  // Write an unreviewed edit (industry SaaS, while main has industry=Other)
  // WITHOUT accepting it. accepted-patches.json should start empty and stay empty.
  writeWorking(
    workspaceDir,
    'Companies/rec_acme.json',
    JSON.stringify({ name: 'Acme', industry: 'SaaS' }, null, 2),
  );
  assert.equal(readPatches(scratchRoot).patches.length, 0);

  const result = await native.rejectField(workspaceDir, CONN, 'Companies/rec_acme.json', 'industry');

  assert.equal(result.workspacePath, 'HubSpot/Companies/rec_acme.json');
  assert.equal(result.patchesChanged, false);
  assert.equal(result.workingChanged, true);
  assert.equal(result.effect, 'WorkingRestored');

  // Working file now matches main's industry value.
  const workingPath = join(workspaceDir, CONN, 'Companies/rec_acme.json');
  const obj = JSON.parse(readFileSync(workingPath, 'utf8'));
  assert.equal(obj.industry, 'Other');
  assert.equal(obj.name, 'Acme');

  // Strict invariant: accepted-patches.json was never touched.
  assert.equal(readPatches(scratchRoot).patches.length, 0);
});

test('rejectField on a stacked state restores working to the approved value and leaves the patch entry intact', async () => {
  const native = loadNative();
  const { workspaceDir, scratchRoot } = makeFixture();

  // Step 1: approve industry=SaaS (main has Other → approved becomes SaaS).
  writeWorking(
    workspaceDir,
    'Companies/rec_acme.json',
    JSON.stringify({ name: 'Acme', industry: 'SaaS' }, null, 2),
  );
  await native.acceptField(workspaceDir, CONN, 'Companies/rec_acme.json', 'industry');
  const after1 = readPatches(scratchRoot);
  assert.equal(after1.patches.length, 1);
  assert.deepEqual(after1.patches[0].patch, { industry: 'SaaS' });

  // Step 2: user makes a further unreviewed edit on top of approved
  // (industry=Aerospace). Patch entry still says SaaS.
  writeWorking(
    workspaceDir,
    'Companies/rec_acme.json',
    JSON.stringify({ name: 'Acme', industry: 'Aerospace' }, null, 2),
  );

  // Step 3: Reject. Working should snap back to the approved value (SaaS),
  // NOT to main (Other), and the patch entry should be unchanged.
  const result = await native.rejectField(workspaceDir, CONN, 'Companies/rec_acme.json', 'industry');

  assert.equal(result.patchesChanged, false);
  assert.equal(result.workingChanged, true);
  assert.equal(result.effect, 'WorkingRestored');

  const workingPath = join(workspaceDir, CONN, 'Companies/rec_acme.json');
  const obj = JSON.parse(readFileSync(workingPath, 'utf8'));
  assert.equal(obj.industry, 'SaaS', 'working file must hold the approved value after reject');

  // The strict invariant: the patch entry survives unchanged.
  const after3 = readPatches(scratchRoot);
  assert.equal(after3.patches.length, 1);
  assert.deepEqual(after3.patches[0].patch, { industry: 'SaaS' });
});

test('rejectField is a NoOp when the working value already matches approved', async () => {
  const native = loadNative();
  const { workspaceDir, scratchRoot } = makeFixture();

  // Working file matches main's value — nothing unreviewed for `industry`.
  writeWorking(
    workspaceDir,
    'Companies/rec_acme.json',
    JSON.stringify({ name: 'Acme', industry: 'Other' }, null, 2),
  );

  const result = await native.rejectField(workspaceDir, CONN, 'Companies/rec_acme.json', 'industry');

  assert.equal(result.patchesChanged, false);
  assert.equal(result.workingChanged, false);
  assert.equal(result.effect, 'NoOp');

  // Patches file remains empty.
  assert.equal(readPatches(scratchRoot).patches.length, 0);
});

test('rejectField is a NoOp when the working file is missing on disk', async () => {
  const native = loadNative();
  const { workspaceDir, scratchRoot } = makeFixture();

  // No working file exists at <workspace>/HubSpot/Companies/rec_missing.json.
  const result = await native.rejectField(workspaceDir, CONN, 'Companies/rec_missing.json', 'industry');

  assert.equal(result.patchesChanged, false);
  assert.equal(result.workingChanged, false);
  assert.equal(result.effect, 'NoOp');
  assert.equal(readPatches(scratchRoot).patches.length, 0);
});
