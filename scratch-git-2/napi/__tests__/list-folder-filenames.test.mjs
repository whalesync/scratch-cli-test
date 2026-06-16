// Smoke test for the listFolderFilenames napi binding (D5).
//
// Mirrors the fixture and runner conventions used by accept-field.test.mjs:
// build a real workspace + bare repo, exercise the binding from JS, assert
// the returned filename list. Run with `node --test __tests__/` from the
// napi crate root after building the `.node` addon.

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
    throw new Error(
      `${filename} not found. Build it first via scratch-desktop/scripts/build-native.sh.`,
    );
  }
  return require(path);
}

const REPO_ID = 'conn1';
const CONN = 'HubSpot';

function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'napi-listfn-'));
  const bareRepo = join(tmp, '.repos', `${REPO_ID}.git`);
  const scratchRoot = join(tmp, '.scratch');
  const sourceDir = join(tmp, 'source');

  mkdirSync(scratchRoot, { recursive: true });
  mkdirSync(join(bareRepo, '..'), { recursive: true });
  mkdirSync(sourceDir, { recursive: true });

  const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: 'pipe' });
  git(sourceDir, 'init');
  git(sourceDir, 'checkout -b main');
  // Seed two records on main; one nested file to verify non-recursive scoping.
  mkdirSync(join(sourceDir, 'Companies/nested'), { recursive: true });
  writeFileSync(join(sourceDir, 'Companies/rec_acme.json'), JSON.stringify({ name: 'Acme' }, null, 2));
  writeFileSync(join(sourceDir, 'Companies/rec_widget.json'), JSON.stringify({ name: 'Widget' }, null, 2));
  writeFileSync(join(sourceDir, 'Companies/nested/rec_deep.json'), JSON.stringify({ deep: true }, null, 2));
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

function writePatchFile(scratchRoot, patches) {
  writeFileSync(
    join(scratchRoot, 'connections', CONN, 'accepted-patches.json'),
    JSON.stringify({ patches }, null, 2),
  );
}

test('listFolderFilenames returns sorted union of main + accepted-patches Create entries', async () => {
  const native = loadNative();
  const { workspaceDir, scratchRoot } = makeFixture();

  // Seed: main has rec_acme + rec_widget; accepted-patches has a Create
  // (rec_new — not on main), an Update (rec_acme — already on main), and a
  // Delete (rec_widget — already on main). The union of filenames should be
  // [rec_acme, rec_new, rec_widget] sorted.
  writePatchFile(scratchRoot, [
    { path: 'Companies/rec_new.json', kind: 'create', patch: { name: 'New Co' } },
    { path: 'Companies/rec_acme.json', kind: 'update', patch: { industry: 'SaaS' } },
    { path: 'Companies/rec_widget.json', kind: 'delete', patch: null },
  ]);

  const names = await native.listFolderFilenames(workspaceDir, CONN, 'Companies');
  assert.deepEqual(names, ['rec_acme.json', 'rec_new.json', 'rec_widget.json']);
});

test('listFolderFilenames is non-recursive — subfolder files excluded', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  // Top-level Companies/ has rec_acme + rec_widget; Companies/nested/ has rec_deep.
  const top = await native.listFolderFilenames(workspaceDir, CONN, 'Companies');
  assert.deepEqual(top, ['rec_acme.json', 'rec_widget.json']);

  const nested = await native.listFolderFilenames(workspaceDir, CONN, 'Companies/nested');
  assert.deepEqual(nested, ['rec_deep.json']);
});

test('listFolderFilenames returns empty array for a folder with no records', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  // The fixture doesn't seed any "Empty" folder — neither main nor patch
  // file has entries there.
  const names = await native.listFolderFilenames(workspaceDir, CONN, 'Empty');
  assert.deepEqual(names, []);
});

test('listFolderFilenames throws UNKNOWN_CONNECTION for a missing connection', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  await assert.rejects(
    () => native.listFolderFilenames(workspaceDir, 'NoSuchConn', 'Companies'),
    (err) => err.message.startsWith('UNKNOWN_CONNECTION:'),
  );
});
