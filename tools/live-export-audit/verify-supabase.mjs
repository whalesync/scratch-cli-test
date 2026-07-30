#!/usr/bin/env node
/**
 * Read published records back out of SUPABASE using plain SQL against the project.
 *
 * Same rule as the Notion verifier: a routine that reports `completed` proves nothing, so
 * source→destination comparisons must rest on what the destination actually holds.
 *
 * Supabase is the narrow/relational half of the destination pair — scalar columns and real
 * FK constraints — so this also reports column types and any foreign keys, which is how we
 * tell a genuine relation from a flattened text field.
 *
 * Usage:
 *   node tools/live-export-audit/verify-supabase.mjs --tables            # list audit tables
 *   node tools/live-export-audit/verify-supabase.mjs --table Customers --match fable_qa_
 */
import { execFileSync } from 'node:child_process';
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

const supabaseEnv = readEnvFile(path.join(REPO_ROOT, 'local/audit-creds/supabase.env'));
const CONNECTION_STRING = supabaseEnv.connectionString;
if (!CONNECTION_STRING) {
  console.error('No connectionString in local/audit-creds/supabase.env');
  process.exit(1);
}
const SCHEMA = args.schema || 'public';

function sql(statement) {
  return execFileSync('psql', [CONNECTION_STRING, '-t', '-A', '-F', '', '-c', statement], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const rowsOf = (raw) => (raw ? raw.split('\n').map((line) => line.split('')) : []);

if (args.tables || !args.table) {
  const tables = rowsOf(sql(
    `select table_name, (select count(*) from information_schema.columns c where c.table_name = t.table_name and c.table_schema = '${SCHEMA}')
     from information_schema.tables t where table_schema = '${SCHEMA}' and table_type = 'BASE TABLE' order by table_name;`,
  ));
  console.log(JSON.stringify(tables.map(([name, columns]) => ({ name, columns: Number(columns) })), null, 1));
  if (!args.table) process.exit(0);
}

const table = args.table;

// Column types — the narrow destination's answer to "did this land as a real type?"
const columns = rowsOf(sql(
  `select column_name, data_type from information_schema.columns
   where table_schema = '${SCHEMA}' and table_name = '${table}' order by ordinal_position;`,
));

// Real foreign-key constraints — the discriminator between a relation and flattened text.
const foreignKeys = rowsOf(sql(
  `select kcu.column_name, ccu.table_name, ccu.column_name
   from information_schema.table_constraints tc
   join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
   join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name
   where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = '${SCHEMA}' and tc.table_name = '${table}';`,
));

const total = Number(sql(`select count(*) from "${SCHEMA}"."${table}";`));

let matchedRows = [];
if (args.match) {
  const escaped = String(args.match).replace(/'/g, "''");
  const textColumns = columns.filter(([, type]) => type === 'text' || type.includes('char')).map(([name]) => name);
  const predicate = textColumns.map((c) => `coalesce("${c}",'') like '%${escaped}%'`).join(' or ') || 'false';
  const raw = sql(
    `select row_to_json(t) from (select * from "${SCHEMA}"."${table}" where ${predicate} limit ${Number(args.limit || 10)}) t;`,
  );
  matchedRows = raw ? raw.split('\n').map((line) => JSON.parse(line)) : [];
}

console.log(JSON.stringify({
  table,
  totalRows: total,
  columnTypes: Object.fromEntries(columns.map(([name, type]) => [name, type])),
  foreignKeys: foreignKeys.map(([column, refTable, refColumn]) => ({ column, references: `${refTable}.${refColumn}` })),
  matched: matchedRows.length,
  rows: matchedRows,
}, null, 1));
