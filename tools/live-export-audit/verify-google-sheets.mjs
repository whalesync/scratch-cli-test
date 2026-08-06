#!/usr/bin/env node
/**
 * Read published records back out of GOOGLE SHEETS using Google's own API.
 *
 * The audit's prime directive: a routine that reports `completed` proves nothing —
 * runs report success even when every record was rejected. This reads the destination
 * spreadsheet directly so source→destination comparisons rest on what the sheet
 * actually holds.
 *
 * Auth: mints an access token from the refresh token in `server/.env.integration`
 * (GOOGLE_SHEETS_CLIENT_ID/SECRET/REFRESH_TOKEN — the same creds the live
 * integration suite uses). Never prints the token.
 *
 * Usage:
 *   node tools/live-export-audit/verify-google-sheets.mjs --spreadsheet <id|url> --list
 *   node tools/live-export-audit/verify-google-sheets.mjs --spreadsheet <id|url> --sheet <title|gid> [--rows 10] [--json]
 *   node tools/live-export-audit/verify-google-sheets.mjs --spreadsheet <id|url> --sheet <gid> --find <substring>
 */
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

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = readEnvFile(path.join(REPO_ROOT, 'server/.env.integration'));
for (const key of ['GOOGLE_SHEETS_CLIENT_ID', 'GOOGLE_SHEETS_CLIENT_SECRET', 'GOOGLE_SHEETS_REFRESH_TOKEN']) {
  if (!env[key]) {
    console.error(`Missing ${key} in server/.env.integration`);
    process.exit(1);
  }
}

const spreadsheetArg = args.spreadsheet;
if (!spreadsheetArg) {
  console.error('--spreadsheet <id|url> is required');
  process.exit(1);
}
const urlMatch = String(spreadsheetArg).match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{10,})/);
const SPREADSHEET_ID = urlMatch ? urlMatch[1] : spreadsheetArg;

async function mintAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_SHEETS_CLIENT_ID,
      client_secret: env.GOOGLE_SHEETS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_SHEETS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const token = await mintAccessToken();

async function sheetsApi(endpoint, params = {}) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${endpoint} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const structure = await sheetsApi('', { fields: 'properties(title),sheets(properties(sheetId,title,gridProperties))' });

if (args.list || !args.sheet) {
  console.log(`Spreadsheet: ${structure.properties?.title} (${SPREADSHEET_ID})`);
  for (const sheet of structure.sheets ?? []) {
    const p = sheet.properties;
    console.log(`  gid=${p.sheetId}\t${p.title}\t(${p.gridProperties?.rowCount}x${p.gridProperties?.columnCount})`);
  }
  process.exit(0);
}

const target = (structure.sheets ?? [])
  .map((s) => s.properties)
  .find((p) => String(p.sheetId) === String(args.sheet) || p.title === args.sheet);
if (!target) {
  console.error(`No sheet matching "${args.sheet}"`);
  process.exit(1);
}

const quoted = `'${target.title.replace(/'/g, "''")}'`;
const values = await sheetsApi(`/values/${encodeURIComponent(quoted)}`, {
  valueRenderOption: 'UNFORMATTED_VALUE',
  dateTimeRenderOption: 'SERIAL_NUMBER',
});
const rows = values.values ?? [];
const [header, ...dataRows] = rows;

if (args.find) {
  const needle = String(args.find);
  const hits = dataRows.filter((row) => row.some((cell) => String(cell).includes(needle)));
  console.log(`${hits.length} row(s) matching "${needle}" in ${target.title}:`);
  for (const row of hits) {
    console.log(JSON.stringify(Object.fromEntries(header.map((h, i) => [h, row[i] ?? null]))));
  }
  process.exit(0);
}

const limit = Number(args.rows ?? 10);
console.log(`Sheet "${target.title}" (gid ${target.sheetId}): ${dataRows.length} data row(s), header: ${JSON.stringify(header)}`);
const shown = dataRows.slice(0, limit);
for (const row of shown) {
  if (args.json) console.log(JSON.stringify(Object.fromEntries(header.map((h, i) => [h, row[i] ?? null]))));
  else console.log(row.map((c) => String(c).slice(0, 40)).join(' | '));
}
if (dataRows.length > shown.length) console.log(`… ${dataRows.length - shown.length} more`);
