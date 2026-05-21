// Smoke test for the napi binding. Exercises JS → Rust → JS round trip:
// build a real workspace + bare repo, call `acceptField`, reopen
// `accepted-patches.json`, assert the entry shape.
//
// Uses Node's built-in test runner (no `vitest` dep on the napi crate). Run
// from this directory with `node --test __tests__/`. The spec calls for
// vitest; deferring that to slice H.3 when the desktop consumes the binding
// — at that point the desktop's existing vitest suite is the natural home.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadNative() {
  // Match the desktop loader's dev-path resolution: the prebuilt .node lives
  // next to the napi crate's Cargo.toml. CI runs `napi build --release` (or
  // `scratch-desktop/scripts/build-native.sh`) before the tests.
  const platform = process.platform;
  const arch = process.arch;
  const abi = platform === 'linux' ? '-gnu' : '';
  const filename = `scratchmd-native.${platform}-${arch}${abi}.node`;
  const path = join(__dirname, '..', filename);
  if (!existsSync(path)) {
    throw new Error(
      `${filename} not found. Build it first: \`cd scratch-git-2/napi && napi build --release --platform --manifest-path ./Cargo.toml -p scratchmd-native\` and copy the resulting .dylib to ${filename}`,
    );
  }
  return require(path);
}

const REPO_ID = 'conn1';
const CONN = 'HubSpot';

function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'napi-test-'));
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

// Caller-writes-working-file-first: acceptField reads the field value from
// the working file at <workspace>/<conn>/<recordRelPath>. Each test that
// exercises a non-default value writes that working file first.
function writeWorking(workspaceDir, recordRelPath, body) {
  const fp = join(workspaceDir, CONN, recordRelPath);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, body);
}

test('acceptField round-trip writes the patch entry', async () => {
  const native = loadNative();
  const { workspaceDir, scratchRoot } = makeFixture();

  writeWorking(
    workspaceDir,
    'Companies/rec_acme.json',
    JSON.stringify({ name: 'Acme', industry: 'SaaS' }, null, 2),
  );

  const result = await native.acceptField(workspaceDir, CONN, 'Companies/rec_acme.json', 'industry');

  assert.equal(result.workspacePath, 'HubSpot/Companies/rec_acme.json');
  assert.equal(result.patchesChanged, true);
  assert.equal(result.workingChanged, false);
  assert.equal(result.effect, 'PatchUpserted');

  const patchPath = join(scratchRoot, 'connections', CONN, 'accepted-patches.json');
  const file = JSON.parse(readFileSync(patchPath, 'utf8'));
  assert.equal(file.patches.length, 1);
  assert.equal(file.patches[0].path, 'Companies/rec_acme.json');
  assert.equal(file.patches[0].kind, 'update');
  assert.deepEqual(file.patches[0].patch, { industry: 'SaaS' });
});

test('discardField drops patch entry and restores working file from main', async () => {
  const native = loadNative();
  const { workspaceDir, scratchRoot } = makeFixture();

  // Accept first so there's a patch entry to discard.
  writeWorking(
    workspaceDir,
    'Companies/rec_acme.json',
    JSON.stringify({ name: 'Acme', industry: 'SaaS' }, null, 2),
  );
  await native.acceptField(workspaceDir, CONN, 'Companies/rec_acme.json', 'industry');
  const patchPath = join(scratchRoot, 'connections', CONN, 'accepted-patches.json');
  assert.equal(JSON.parse(readFileSync(patchPath, 'utf8')).patches.length, 1);

  const result = await native.discardField(workspaceDir, CONN, 'Companies/rec_acme.json', 'industry');
  assert.equal(result.workspacePath, 'HubSpot/Companies/rec_acme.json');
  assert.equal(result.patchesChanged, true);
  assert.equal(result.workingChanged, true);
  assert.equal(result.effect, 'PatchDropped');

  // Patch file emptied (entry dropped).
  assert.equal(JSON.parse(readFileSync(patchPath, 'utf8')).patches.length, 0);

  // Working file now matches main's industry value (Other).
  const workingPath = join(workspaceDir, CONN, 'Companies/rec_acme.json');
  const obj = JSON.parse(readFileSync(workingPath, 'utf8'));
  assert.equal(obj.industry, 'Other');
});

test('acceptField throws LOCK_BUSY when the workspace lock is held by a live PID', async () => {
  const native = loadNative();
  const { workspaceDir, scratchRoot } = makeFixture();

  writeWorking(
    workspaceDir,
    'Companies/rec_acme.json',
    JSON.stringify({ name: 'Acme', industry: 'SaaS' }, null, 2),
  );

  // Mimic another process holding the lock by writing the lock file with the
  // current PID. workspace_lock checks liveness via kill(0); the current PID
  // is alive, so it gives up after ~100ms and returns Busy.
  const lockPath = join(scratchRoot, 'lock');
  writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });

  // napi-rs 2.x sets `err.code` to the Status enum name and won't let Rust
  // override it. Our binding encodes the custom code as a message prefix
  // (`LOCK_BUSY: <human description>`); the desktop's TS shim parses that.
  await assert.rejects(
    () => native.acceptField(workspaceDir, CONN, 'Companies/rec_acme.json', 'industry'),
    (err) => err.message.startsWith('LOCK_BUSY:'),
  );
});

test('readFolderBlobs returns published + approved for every record in the folder', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  // Seed:
  //   - Companies/rec_acme.json exists on main (industry=Other).
  //   - User accepted industry=SaaS for it (Update entry).
  //   - User created Companies/rec_new.json (Create entry).
  writeWorking(
    workspaceDir,
    'Companies/rec_acme.json',
    JSON.stringify({ name: 'Acme', industry: 'SaaS' }, null, 2),
  );
  await native.acceptField(workspaceDir, CONN, 'Companies/rec_acme.json', 'industry');

  writeWorking(
    workspaceDir,
    'Companies/rec_new.json',
    JSON.stringify({ name: 'Brand New' }, null, 2),
  );
  await native.acceptField(workspaceDir, CONN, 'Companies/rec_new.json', 'name');

  const blobs = await native.readFolderBlobs(workspaceDir, CONN, 'Companies');

  // Sorted by filename. acme first, new second.
  assert.equal(blobs.length, 2);
  assert.equal(blobs[0].filename, 'rec_acme.json');
  assert.equal(blobs[1].filename, 'rec_new.json');

  // rec_acme.json: published has industry=Other; approved has industry=SaaS.
  const acmePublished = JSON.parse(blobs[0].published);
  const acmeApproved = JSON.parse(blobs[0].approved);
  assert.equal(acmePublished.industry, 'Other');
  assert.equal(acmeApproved.industry, 'SaaS');
  assert.equal(acmeApproved.name, 'Acme');

  // rec_new.json: not on main → published is nullish; approved has the
  // Create body. napi-rs encodes `Option::None` as JS `undefined`, not
  // `null` — accept both via `== null`.
  assert.ok(blobs[1].published == null, `expected published nullish, got ${blobs[1].published}`);
  const newApproved = JSON.parse(blobs[1].approved);
  assert.equal(newApproved.name, 'Brand New');
});

test('readFolderBlobs is non-recursive — subfolder files are excluded', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  // The fixture only seeds Companies/rec_acme.json directly under Companies/.
  // Add a Create entry for a path one level deeper to confirm it's filtered.
  writeWorking(
    workspaceDir,
    'Companies/nested/rec_deep.json',
    JSON.stringify({ x: 1 }, null, 2),
  );
  await native.acceptField(workspaceDir, CONN, 'Companies/nested/rec_deep.json', 'x');

  const blobs = await native.readFolderBlobs(workspaceDir, CONN, 'Companies');
  const names = blobs.map((b) => b.filename);
  assert.ok(names.includes('rec_acme.json'));
  assert.ok(!names.includes('rec_deep.json'));
  assert.ok(!names.some((n) => n.includes('nested')));

  // Asking for the nested folder explicitly returns the deep record.
  const nested = await native.readFolderBlobs(workspaceDir, CONN, 'Companies/nested');
  assert.equal(nested.length, 1);
  assert.equal(nested[0].filename, 'rec_deep.json');
});

test('readFolderBlobsFiltered returns only the requested filenames', async () => {
  const native = loadNative();
  const { workspaceDir } = makeFixture();

  // Seed a Create entry alongside the existing main record so the folder has
  // two records to filter against.
  writeWorking(
    workspaceDir,
    'Companies/rec_new.json',
    JSON.stringify({ name: 'New' }, null, 2),
  );
  await native.acceptField(workspaceDir, CONN, 'Companies/rec_new.json', 'name');

  // Whole-folder read = 2 entries.
  const all = await native.readFolderBlobs(workspaceDir, CONN, 'Companies');
  assert.equal(all.length, 2);

  // Filter to just the main-tree record.
  const onlyAcme = await native.readFolderBlobsFiltered(workspaceDir, CONN, 'Companies', [
    'rec_acme.json',
  ]);
  assert.equal(onlyAcme.length, 1);
  assert.equal(onlyAcme[0].filename, 'rec_acme.json');

  // Filter to a name that doesn't exist → empty (no error).
  const missing = await native.readFolderBlobsFiltered(workspaceDir, CONN, 'Companies', [
    'nonexistent.json',
  ]);
  assert.equal(missing.length, 0);

  // Empty filter → empty (the "page is empty" short-circuit).
  const empty = await native.readFolderBlobsFiltered(workspaceDir, CONN, 'Companies', []);
  assert.equal(empty.length, 0);

  // Multi-filename filter → both present.
  const both = await native.readFolderBlobsFiltered(workspaceDir, CONN, 'Companies', [
    'rec_acme.json',
    'rec_new.json',
  ]);
  assert.equal(both.length, 2);
});
