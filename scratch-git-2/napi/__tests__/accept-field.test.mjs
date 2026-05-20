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
    join(scratchRoot, 'workspace.yaml'),
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

test('acceptField round-trip writes the patch entry', async () => {
  const native = loadNative();
  const { workspaceDir, scratchRoot } = makeFixture();

  const result = await native.acceptField(
    workspaceDir,
    CONN,
    'Companies/rec_acme.json',
    'industry',
    'SaaS',
  );

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

test('acceptField throws LOCK_BUSY when the workspace lock is held by a live PID', async () => {
  const native = loadNative();
  const { workspaceDir, scratchRoot } = makeFixture();

  // Mimic another process holding the lock by writing the lock file with the
  // current PID. workspace_lock checks liveness via kill(0); the current PID
  // is alive, so it gives up after ~100ms and returns Busy.
  const lockPath = join(scratchRoot, 'lock');
  writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });

  // napi-rs 2.x sets `err.code` to the Status enum name and won't let Rust
  // override it. Our binding encodes the custom code as a message prefix
  // (`LOCK_BUSY: <human description>`); the desktop's TS shim parses that.
  await assert.rejects(
    () =>
      native.acceptField(
        workspaceDir,
        CONN,
        'Companies/rec_acme.json',
        'industry',
        'SaaS',
      ),
    (err) => err.message.startsWith('LOCK_BUSY:'),
  );
});
