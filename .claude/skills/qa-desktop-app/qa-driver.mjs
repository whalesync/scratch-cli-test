// =============================================================================
// Scratch Desktop — live QA driver (Playwright `_electron`).
//
// Launches the BUILT Electron app with a seeded REAL session against the
// deployed test backend, stubs ONLY the native folder-picker dialog, and drives
// the full journey: boot -> auth -> download -> browse grids -> edit -> publish
// -> verify. Captures screenshots, timings, every >=400 response, and a findings
// log. Everything except the OS folder dialog is real (real scratchmd CLI/napi,
// real test-api.scratch.md, real publish to the test external services).
//
// Reads its config from env (with safe defaults). Resolves electron + the built
// main entry from scratch-desktop, so it runs from anywhere:
//   node .claude/skills/qa-desktop-app/qa-driver.mjs
// (or copy it into scratch-desktop/ and `node qa-driver.mjs` there).
//
// Honors these env vars (all optional):
//   TESTING_ACCOUNT_API_KEY   token (else read from scratch-desktop/.env.e2e)
//   TESTING_ACCOUNT_EMAIL     seeded display email (default testing@whalesync.com)
//   QA_API_URL                backend (default https://test-api.scratch.md)
//   QA_WORKBOOK_ID            target workbook to download/open (default: first /workbook)
//   QA_NO_RESET=1             keep prior userdata/download (default: reset for a clean run)
//   QA_NO_PUBLISH=1           skip the real publish step (read-only run)
// =============================================================================
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root = four levels up from .claude/skills/qa-desktop-app/. Falls back to
// scanning upward for a `scratch-desktop` dir if the layout ever changes.
function findRepoRoot(start) {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'scratch-desktop', 'package.json'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return join(start, '..', '..', '..', '..');
}
const REPO_ROOT = findRepoRoot(__dirname);
const DESKTOP = join(REPO_ROOT, 'scratch-desktop');
const MAIN_ENTRY = join(DESKTOP, 'out', 'main', 'index.js');
const SCRATCHMD = join(REPO_ROOT, 'scratch-git-2', 'target', 'debug', 'scratchmd');

// Resolve @playwright/test and the electron binary from scratch-desktop so the
// script is location-independent.
const requireFromDesktop = createRequire(join(DESKTOP, 'package.json'));
const { _electron: electron } = await import('@playwright/test');
let ELECTRON_PATH;
try { ELECTRON_PATH = requireFromDesktop('electron'); } catch { ELECTRON_PATH = undefined; }

const QA_DIR = join(REPO_ROOT, '.context', 'qa');
const SHOTS = join(QA_DIR, 'shots');
const USER_DATA_DIR = join(QA_DIR, 'userdata');
const PARENT_FOLDER = join(QA_DIR, 'workspaces');
const LOG_PATH = join(QA_DIR, 'session.log.json');

if (!existsSync(MAIN_ENTRY)) {
  console.error(`Built main entry not found: ${MAIN_ENTRY}\n` +
    `Build first:  cd scratch-desktop && VITE_SCRATCH_API_URL=https://test-api.scratch.md VITE_SCRATCH_WEB_URL=https://test.scratch.md yarn build\n` +
    `Then stage the napi addon:  node scripts/build-native.cjs && mkdir -p out/scratch-git-2/napi && cp ../scratch-git-2/napi/scratchmd-native.*.node out/scratch-git-2/napi/`);
  process.exit(1);
}

const RESET = process.env.QA_NO_RESET !== '1';
if (RESET) for (const d of [USER_DATA_DIR, PARENT_FOLDER]) rmSync(d, { recursive: true, force: true });
for (const d of [SHOTS, USER_DATA_DIR, PARENT_FOLDER]) mkdirSync(d, { recursive: true });

// --- env / token (GOTCHA: .env.e2e values are quote-wrapped — STRIP QUOTES) ---
function parseEnvFile(p) {
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const envFile = parseEnvFile(join(DESKTOP, '.env.e2e'));
const API_TOKEN = process.env.TESTING_ACCOUNT_API_KEY || envFile.TESTING_ACCOUNT_API_KEY;
const EMAIL = process.env.TESTING_ACCOUNT_EMAIL || envFile.TESTING_ACCOUNT_EMAIL || 'testing@whalesync.com';
const API_URL = process.env.QA_API_URL || 'https://test-api.scratch.md';
if (!API_TOKEN) { console.error('No TESTING_ACCOUNT_API_KEY (env or scratch-desktop/.env.e2e)'); process.exit(1); }

// Pick the target workbook node-side so we click the right card and select the
// right registry entry (GOTCHA: the CLI registry is GLOBAL — it also lists other
// accounts' on-disk workspaces; never trust reg[0]).
let WB_NAME = 'workspace', WB_ID = process.env.QA_WORKBOOK_ID || null;
try {
  const r = await fetch(`${API_URL}/workbook`, { headers: { Authorization: `API-Token ${API_TOKEN}` } });
  if (r.status === 401) console.error('WARNING: /workbook returned 401 — your token is being rejected (quote-wrapped? expired?).');
  const wbs = await r.json();
  const wb = WB_ID ? wbs.find((w) => w.id === WB_ID) : wbs[0];
  if (wb) { WB_NAME = wb.name || WB_NAME; WB_ID = wb.id; }
  console.log(`Target workbook: ${WB_ID} "${WB_NAME}" (account has ${Array.isArray(wbs) ? wbs.length : '?'} workbook(s))`);
} catch (e) { console.error('Could not list /workbook:', e.message); }
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cardRe = new RegExp(escapeRe(WB_NAME), 'i');

// --- bookkeeping -------------------------------------------------------------
const findings = [], badResponses = [], timings = {};
let shotN = 0;
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (m) => console.log(`[${ts()}] ${m}`);
function note(sev, area, msg) { findings.push({ sev, area, msg }); log(`  ⚑ ${sev.toUpperCase()} [${area}] ${msg}`); }
async function shot(page, name) {
  const f = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  try { await page.screenshot({ path: f }); log(`  📸 ${name}`); } catch (e) { log(`  (shot failed: ${e.message})`); }
}
async function step(name, fn) {
  const s = Date.now(); log(`▶ ${name}`);
  try { const r = await fn(); timings[name] = Date.now() - s; log(`  ✓ ${name} (${timings[name]}ms)`); return r; }
  catch (e) { timings[name] = Date.now() - s; note('error', 'driver', `step "${name}" threw: ${e.message}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The test seam authenticates the RENDERER but NOT the scratchmd CLI, and the
// app reads CLI creds from the real ~/.scratchmd (macOS Electron ignores $HOME).
// So CLI server-ops — cloning a NEW workspace (download) and publish/upload —
// fail "Not authenticated" unless the CLI is logged in for test-api. Opt in with
// QA_AUTH_CLI=1 to log ~/.scratchmd into the test account (this REPLACES your
// CLI login token; re-run `scratchmd auth login` afterward to restore it).
// Equals-form: the token can start with '-' (clap would treat it as a flag).
if (process.env.QA_AUTH_CLI === '1') {
  try {
    execFileSync(SCRATCHMD, ['auth', 'set-credentials', `--apiToken=${API_TOKEN}`, `--email=${EMAIL}`, '--expiresAt=2099-01-01T00:00:00Z'],
      { env: { ...process.env, SCRATCH_URL: API_URL }, stdio: 'ignore' });
    log('authed ~/.scratchmd for test-api (QA_AUTH_CLI=1) — restore later with `scratchmd auth login`');
  } catch (e) { note('warn', 'auth', `CLI auth failed: ${e.message}`); }
}

// --- launch (stub ONLY the native folder picker) -----------------------------
const app = await electron.launch({
  ...(ELECTRON_PATH ? { executablePath: ELECTRON_PATH } : {}),
  args: [MAIN_ENTRY],
  env: {
    ...process.env,
    SCRATCH_URL: API_URL,
    SCRATCH_DESKTOP_USER_DATA_DIR: USER_DATA_DIR,        // throwaway profile
    SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE: '1',
    SCRATCH_DESKTOP_SCRATCHMD_BINARY: SCRATCHMD,         // repo CLI (unpackaged-only)
    SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON: JSON.stringify({
      apiToken: API_TOKEN, email: EMAIL, tokenExpiresAt: '2099-01-01T00:00:00Z', serverUrl: API_URL,
    }),
  },
});
await app.evaluate(async ({ dialog }, folder) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  dialog.showOpenDialogSync = () => [folder];
}, PARENT_FOLDER);

const page = await app.firstWindow();
// Diagnostics that caught the quote-wrapped-token bug: log every >=400 response,
// and confirm the /users/current request actually carries an Authorization header.
page.on('response', (resp) => {
  const s = resp.status();
  if (s >= 400 && !/posthog/.test(resp.url())) { badResponses.push({ s, url: resp.url() }); log(`  ⚠ HTTP ${s} ${resp.request().method()} ${resp.url()}`); }
});
page.on('request', (req) => {
  if (req.url().includes('/users/current')) { const a = req.headers()['authorization']; log(`  REQ /users/current auth=${a ? `present(${a.slice(0, 11)}… len${a.length})` : 'MISSING'}`); }
});
page.on('pageerror', (e) => note('error', 'console', `uncaught: ${e.message.slice(0, 160)}`));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const isLogin = () => page.getByRole('button', { name: 'Log in', exact: false }).isVisible().catch(() => false);
const routeHash = () => ev(() => location.hash || location.pathname);

// Wait for a real settled state (login / home / workspace) — NEVER fixed sleeps,
// and NEVER `.textContent()` on a maybe-absent selector (it blocks 30s).
async function settle(maxMs = 15000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (await isLogin()) return 'login';
    const home = await page.getByText(/Your Workspaces|Create your first workspace|Download a workspace|In the cloud/i).first().isVisible().catch(() => false);
    if (home) return 'home';
    if (/workspace\//.test(await routeHash())) return 'workspace';
    await sleep(400);
  }
  return 'unknown';
}

// === SESSION =================================================================
await step('boot + auth gate', async () => {
  await page.waitForLoadState('domcontentloaded');
  const state = await settle();
  log(`  settled on: ${state}`);
  if (state === 'login') note('error', 'auth', 'Landed on LOGIN despite a seeded session. Token rejected (a 401 cleared creds). FIRST suspect your harness: is the token quote-wrapped? does /workbook 401 via curl? Run `yarn test:e2e:live` as a canary.');
  await shot(page, 'home');
});

let WS = null;
await step('download + open the target workbook', async () => {
  if (await isLogin()) { note('warn', 'download', 'on login screen; cannot drive download'); return; }
  const dlStart = Date.now();
  const inReg = async () => (await ev(() => window.scratchDesktop.getWorkspacesRegistry())).some((r) => r.id === WB_ID);
  // 1) Try the real UI: click the workbook card.
  await page.getByRole('button', { name: cardRe }).first().click({ timeout: 5000 }).catch(() => {});
  // 2) Give the UI path a moment to register the target; otherwise download it
  //    deterministically via the real initWorkspace IPC (clone into PARENT_FOLDER).
  for (let i = 0; i < 10 && WB_ID && !(await inReg()); i++) await sleep(1000);
  if (WB_ID && !(await inReg())) {
    note('info', 'download', `card path didn't register ${WB_ID}; downloading via initWorkspace IPC`);
    await ev(([id, folder]) => window.scratchDesktop.initWorkspace(id, folder), [WB_ID, PARENT_FOLDER]).catch((e) => note('warn', 'download', `initWorkspace failed: ${e.message}`));
  }
  // 3) Resolve by ID — registry fileCount is lazily 0 (gotcha #12), so don't gate on it.
  let reg = [];
  for (let i = 0; i < 60; i++) { reg = await ev(() => window.scratchDesktop.getWorkspacesRegistry()); if (reg.find((r) => r.id === WB_ID)) break; await sleep(1000); }
  timings['download_wall_ms'] = Date.now() - dlStart;
  const chosen = reg.find((r) => r.id === WB_ID) || reg.find((r) => r.fileCount > 0) || reg[0];
  WS = chosen ? { id: chosen.id, path: chosen.path } : null;
  note('info', 'download', `download wall ${(timings['download_wall_ms'] / 1000).toFixed(1)}s; opened ${WS?.id}`);
  if (WS && WB_ID && WS.id !== WB_ID) note('warn', 'download', `could not open target ${WB_ID}; fell back to ${WS.id} (${WS.path}) — a DIFFERENT account's local workspace`);
  if (WS) await ev((id) => { window.location.hash = `#/workspace/${id}`; }, WS.id).catch(() => {}); // show it for screenshots
  await sleep(3000);
  await shot(page, 'workspace-open');
});

if (!WS) { const reg = await ev(() => window.scratchDesktop.getWorkspacesRegistry()).catch(() => []); const c = reg.find((r) => r.id === WB_ID) || reg[0]; WS = c ? { id: c.id, path: c.path } : null; }
log(`WS = ${JSON.stringify(WS)}`);

if (WS) {
  let folders = [];
  await step('inventory: folders + review/validation stats', async () => {
    folders = await ev((p) => window.scratchFiles.listFolders(p), WS.path);
    const review = await ev((p) => window.scratchFiles.getReviewStats(p), WS.path).catch((e) => ({ err: e.message }));
    const validation = await ev((p) => window.scratchFiles.getValidationStats(p), WS.path).catch((e) => ({ err: e.message }));
    log(`  ${folders.length} folders (${folders.filter((f) => f.fileCount > 0).length} non-empty)`);
    log(`  reviewStats=${JSON.stringify(review).slice(0, 300)}`);
    log(`  validationStats=${JSON.stringify(validation).slice(0, 400)}`);
    // Flag connectors with 100% validation-error rate (likely schema noise).
    if (Array.isArray(validation)) for (const v of validation) if (v.records > 0 && v.errors >= v.records) note('warn', 'validation', `${v.connection}/${v.folder_path}: ${v.errors}/${v.records} records fail enforce_schema (possible schema noise)`);
    writeFileSync(join(QA_DIR, 'inventory.json'), JSON.stringify({ folders, review, validation }, null, 2));
  });

  await step('browse folder grids (data correctness; grid is canvas — read via IPC)', async () => {
    for (const f of folders.filter((f) => f.fileCount > 0).slice(0, 12)) {
      const s = Date.now();
      const g = await ev(([fp, wp]) => window.scratchFiles.readDiffGridData(fp, wp, { offset: 0, limit: 25 }), [f.path, WS.path]).catch((e) => ({ err: e.message }));
      const ms = Date.now() - s;
      if (g.err) { note('warn', 'grid', `readDiffGridData failed ${f.path}: ${g.err}`); continue; }
      log(`  ${f.path.split('/').slice(-2).join('/')}: ${g.summary.total} rows · ${g.columns.length} cols · ${ms}ms`);
      if (ms > 1500) note('warn', 'perf', `slow grid read ${f.path}: ${ms}ms (${g.summary.total} rows, ${g.columns.length} cols)`);
      if (g.invalidJsonFiles.length) note('warn', 'data', `${g.invalidJsonFiles.length} invalid-JSON record(s) in ${f.path}`);
      if (g.columns.length > 150) note('info', 'ux', `${f.path.split('/').pop()}: ${g.columns.length} columns (very wide grid)`);
    }
  });

  const target = folders.find((f) => f.fileCount > 0);
  let editTarget = null;
  await step(`edit a field in ${target?.path?.split('/').pop()} (cell-edit IPC auto-APPROVES; not "unreviewed")`, async () => {
    if (!target) return;
    const g = await ev(([fp, wp]) => window.scratchFiles.readDiffGridData(fp, wp, { offset: 0, limit: 5 }), [target.path, WS.path]);
    const row = g.rows[0];
    if (!row) { note('info', 'edit', `no rows in ${target.path}`); return; }
    const col = g.columns.find((c) => { const v = row[c.id]; return typeof v === 'string' && v.length < 120 && !/(^|\.)id$/i.test(c.id) && !/url|email|domain|createdAt|updatedAt/i.test(c.id); }) || g.columns.find((c) => typeof row[c.id] === 'string');
    if (!col) { note('info', 'edit', `no editable string column in ${target.path}`); return; }
    const filename = row.__filename, oldVal = String(row[col.id] ?? '');
    const newVal = `${oldVal} ~QA${new Date().toISOString().slice(11, 19)}`.slice(0, 200);
    editTarget = { folder: target.path, filename, field: col.id, oldVal };
    const s = Date.now();
    const res = await ev(([fp, wp, fn, fld, v]) => window.scratchFiles.acceptFieldEditFromInputText(fp, wp, fn, fld, v), [target.path, WS.path, filename, col.id, newVal]).catch((e) => ({ err: e.message }));
    if (res?.err) { note('error', 'edit', `cell edit failed: ${res.err} (napi addon staged in out/scratch-git-2/napi/ ?)`); return; }
    log(`  edited ${filename}.${col.id} in ${Date.now() - s}ms`);
    const after = await ev(([fp, wp, fn]) => window.scratchFiles.readDiffRecordData(fp, wp, fn), [target.path, WS.path, filename]);
    // Cell edit goes straight to the approved/"unpublished" bucket, NOT __changedFields. This is BY DESIGN.
    log(`  after: __rowStatus=${after?.row?.__rowStatus} unpublished=${JSON.stringify(after?.row?.__unpublishedFields)}`);
    await ev(([wp, paths]) => window.scratchDesktop.refreshPaths(wp, paths), [WS.path, [target.path]]).catch(() => {});
  });

  if (process.env.QA_NO_PUBLISH !== '1') {
    await step('publish (real backend — async; do NOT assert instant completion)', async () => {
      const s = Date.now(); let usedUI = false;
      if (!(await isLogin())) {
        const btn = page.getByRole('button', { name: /publish all/i }).first();
        if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await sleep(1200); await shot(page, 'publish-modal'); const c = page.getByRole('button', { name: /^publish/i }).last(); if (await c.isVisible().catch(() => false)) { await c.click().catch(() => {}); usedUI = true; } }
      }
      if (!usedUI) { note('info', 'publish', 'driving publish via upload IPC (UI button unavailable)'); const up = await ev((p) => window.scratchDesktop.uploadWorkspaceChanges(p), WS.path).catch((e) => ({ err: e.message })); log(`  upload -> ${JSON.stringify(up).slice(0, 240)}`); }
      // The external publish is a server plan/run job; the local "unpublished" flag
      // clears only after reconcile/re-pull. A bounded wait here is informational.
      for (let i = 0; i < 10; i++) { await sleep(2000); if (await page.getByText(/published|success|up to date/i).first().isVisible().catch(() => false)) break; }
      timings['publish_wall_ms'] = Date.now() - s;
      note('info', 'publish', `publish flow ${(timings['publish_wall_ms'] / 1000).toFixed(1)}s (usedUI=${usedUI}); external publish is async — confirm via reconcile/re-pull, not an immediate read`);
      await shot(page, 'after-publish');
    });
  }
}

const _401 = badResponses.filter((b) => b.s === 401);
if (_401.length) note('error', 'auth', `${_401.length} request(s) 401'd: ${[...new Set(_401.map((b) => b.url))].join(' | ')}`);
writeFileSync(LOG_PATH, JSON.stringify({ timings, findings, badResponses, WS, target: WB_ID }, null, 2));
log('\n==================== FINDINGS ====================');
for (const f of findings) log(`  [${f.sev}] (${f.area}) ${f.msg}`);
log('==================== TIMINGS =====================');
for (const [k, v] of Object.entries(timings)) log(`  ${k}: ${v}ms`);
log(`Artifacts: ${QA_DIR}`);
await sleep(600);
await app.close().catch(() => {});
process.exit(0);
