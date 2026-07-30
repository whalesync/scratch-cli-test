#!/usr/bin/env node
/**
 * Clone an existing OAuth ConnectorAccount into a brand-new workbook.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Live Export audit harness (`audit.mjs`) resolves `--source-connection` with
 * `GET /workbooks/<wb>/connections/<coa>`, so an adopted connection must live in the
 * workbook being audited. For an OAuth-only source (QuickBooks, YouTube, …) the harness
 * cannot mint its own session, which normally forces the audit to run *inside* whatever
 * workbook the human connected through the UI.
 *
 * That is undesirable when the connected workbook is someone's scratch space: the audit
 * creates data folders, syncs, routines and publish plans, and pollutes it. This tool
 * copies just the credential material into a disposable audit workbook, so the audit
 * never touches the original.
 *
 * It mirrors exactly what `OAuthService.createOAuthAccount` and `DevToolsService`
 * do — same row shape, same `getDefaultRepoPath` convention, same `initRepo` call.
 * (`DevToolsService.import` deliberately BLANKS OAuth credentials and marks the account
 * FAILED so a human re-authenticates; that's right for sharing a workbook between
 * people, but defeats the purpose here, so we copy the encrypted blob verbatim.)
 *
 * The `encryptedCredentials` blob is copied as-is — it is never decrypted here, and the
 * same `ENCRYPTION_MASTER_KEY` decrypts it in the clone. `extras` is copied verbatim too,
 * which for QuickBooks preserves BOTH `realmId` and the load-bearing `sandbox` flag.
 *
 * LOCAL DEV ONLY. Writes directly to the local Postgres.
 *
 * Usage:
 *   node tools/live-export-audit/clone-oauth-connection.mjs \
 *     --from coa_XXXXXXXXXX --name "QA QUICKBOOKS -> NOTION"
 *
 * Prints `{"workbookId":"wkb_…","connectionId":"coa_…"}` on stdout.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
}

const sourceConnectionId = args.from;
const workbookName = args.name || `QA clone of ${sourceConnectionId}`;
if (!sourceConnectionId) {
  console.error('--from coa_… is required');
  process.exit(1);
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const spinnerEnv = readEnvFile(path.join(REPO_ROOT, 'local/audit-creds/_spinner.env'));
const SPINNER_BASE = process.env.SPINNER_API_URL || spinnerEnv.SPINNER_API_URL || 'http://localhost:3010';
const SPINNER_TOKEN = process.env.SPINNER_API_TOKEN || spinnerEnv.SPINNER_API_TOKEN;
const GIT_API_BASE = process.env.SCRATCH_GIT_API_URL || 'http://localhost:3100';

// Read DATABASE_URL out of server/.env so we hit whatever DB the running server uses.
const serverEnv = readEnvFile(path.join(REPO_ROOT, 'server/.env'));
const databaseUrl = process.env.DATABASE_URL || serverEnv.DATABASE_URL;
if (!databaseUrl) {
  console.error('No DATABASE_URL in env or server/.env');
  process.exit(1);
}

// Prisma's DATABASE_URL carries `?schema=public`, which libpq rejects as an unknown
// query parameter — strip the query string before handing the URI to psql.
const psqlUri = databaseUrl.split('?')[0];

function psql(sql) {
  return execFileSync('psql', [psqlUri, '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}

// nanoid-compatible id: same alphabet and length as packages/shared-types/src/ids.ts
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_RANDOM_LENGTH = 10;
function createId(prefix) {
  const bytes = randomBytes(ID_RANDOM_LENGTH * 2);
  let out = '';
  for (let i = 0; out.length < ID_RANDOM_LENGTH; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return prefix + out;
}

async function spinnerApi(method, p, body) {
  const res = await fetch(SPINNER_BASE + p, {
    method,
    headers: { Authorization: `API-Token ${SPINNER_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// 1. Read the donor connection.
const donorJson = psql(
  `select row_to_json(t) from (select "userId", service, "authType", "encryptedCredentials", extras, "oauthAppVersion", modifier from "ConnectorAccount" where id = '${sourceConnectionId}') t;`,
);
if (!donorJson) {
  console.error(`No ConnectorAccount ${sourceConnectionId}`);
  process.exit(1);
}
const donor = JSON.parse(donorJson);

// 2. Create the destination workbook through the real API (so permissions/repos are set up properly).
const workbook = await spinnerApi('POST', '/workbook', { name: workbookName });
const workbookId = workbook.id;
const organizationId = psql(`select "organizationId" from "Workbook" where id = '${workbookId}';`);

// 3. Insert the cloned connector account, mirroring OAuthService.createOAuthAccount's row shape.
const newConnectionId = createId('coa_');
const repoPath = [organizationId, workbookId, newConnectionId].join('/');
const esc = (v) => (v === null || v === undefined ? 'NULL' : `'${JSON.stringify(v).replace(/'/g, "''")}'`);
const escText = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

psql(
  `insert into "ConnectorAccount"
     (id, "userId", "workbookId", service, "displayName", "authType", "oauthAppVersion",
      "repoPath", "encryptedCredentials", extras, "healthStatus", "healthStatusLastCheckedAt",
      "createdAt", "updatedAt", modifier)
   values
     ('${newConnectionId}', ${escText(donor.userId)}, '${workbookId}', ${escText(donor.service)},
      ${escText(`qa-source-${donor.service} (cloned from ${sourceConnectionId})`)},
      ${escText(donor.authType)}, ${donor.oauthAppVersion ?? 'NULL'},
      '${repoPath}', ${esc(donor.encryptedCredentials)}::jsonb, ${esc(donor.extras)}::jsonb,
      'OK', now(), now(), now(), ${escText(donor.modifier)});`,
);

// 4. Init the git repo for the new connection (idempotent server-side).
const encodedRepoId = repoPath.split('/').map(encodeURIComponent).join('%2F');
const initRes = await fetch(`${GIT_API_BASE}/api/repo/manage/${encodedRepoId}/init`, { method: 'POST' });
if (!initRes.ok) {
  console.error(`WARN: initRepo ${repoPath} -> ${initRes.status} ${(await initRes.text()).slice(0, 300)}`);
}

// 5. Prove the clone works end-to-end through the product's own connection test.
const test = await spinnerApi('POST', `/workbooks/${workbookId}/connections/${newConnectionId}/test`, {});

console.log(JSON.stringify({ workbookId, connectionId: newConnectionId, repoPath, extras: donor.extras, test }));
