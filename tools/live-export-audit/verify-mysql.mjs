#!/usr/bin/env node
/**
 * Read published records back out of a MYSQL (or MariaDB) destination with plain SQL.
 *
 * Same rule as the Notion and Supabase verifiers: a routine that reports `completed` proves nothing, so
 * source→destination comparisons must rest on what the destination actually holds.
 *
 * MySQL is a narrow/relational destination — scalar columns and real FK constraints — so this reports each
 * column's exact `COLUMN_TYPE` and nullability, the table's engine, charset and comment (Scratch marks the
 * tables it creates with `live_export:<ref>`), and the foreign keys with their constraint names.
 *
 * Connects with mysql2 from server/node_modules (there's no `mysql` client on the host, and the connection may
 * be a managed server, not a local container). The connection string comes from `local/audit-creds/mysql.env`
 * (`connectionString=mysql://user:pass@host:port[/database]`), or the file named by `--creds`.
 *
 * Usage:
 *   node tools/live-export-audit/verify-mysql.mjs --databases
 *   node tools/live-export-audit/verify-mysql.mjs --database fable_qa_my_dest --tables
 *   node tools/live-export-audit/verify-mysql.mjs --database fable_qa_my_dest --table Invoices --match fable_qa_ --limit 5
 *   node tools/live-export-audit/verify-mysql.mjs --creds mysql-mariadb.env --database fable_qa_my_dest --tables
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(REPO_ROOT, 'server/package.json'));
const mysql = require('mysql2/promise');

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

const credsFile = path.join(REPO_ROOT, 'local/audit-creds', args.creds || 'mysql.env');
const env = readEnvFile(credsFile);
if (!env.connectionString) {
  console.error(`No connectionString in ${credsFile}`);
  process.exit(1);
}

/** mysql2 ignores `ssl-mode` in a URL, so parse it here: REQUIRED/VERIFY_* → TLS, DISABLED → plain. */
function connectionOptions(connectionString) {
  const url = new URL(connectionString);
  const sslMode = (url.searchParams.get('ssl-mode') || url.searchParams.get('sslmode') || '').toUpperCase();
  const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  const useTls = sslMode ? sslMode !== 'DISABLED' : !isLocal;
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.length > 1 ? decodeURIComponent(url.pathname.slice(1)) : undefined,
    ...(useTls ? { ssl: { rejectUnauthorized: sslMode.startsWith('VERIFY') } } : {}),
    // Exact text for DECIMAL / BIGINT / dates: the point is to see what MySQL stored.
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    timezone: 'Z',
  };
}

const connection = await mysql.createConnection(connectionOptions(env.connectionString));
const query = async (sql, params = []) => (await connection.query(sql, params))[0];

try {
  if (args.databases) {
    const databases = await query(
      `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY SCHEMA_NAME`,
    );
    console.log(JSON.stringify(databases.map((row) => row.name), null, 1));
    process.exit(0);
  }

  const database = args.database || env.DEST_PARENT_ID || connectionOptions(env.connectionString).database;
  if (!database) {
    console.error('Pass --database <name> (or put the database in the connection string).');
    process.exit(1);
  }

  if (args.tables || !args.table) {
    const tables = await query(
      `SELECT t.TABLE_NAME AS name, t.ENGINE AS engine, t.TABLE_COMMENT AS comment,
              (SELECT COUNT(*) FROM information_schema.COLUMNS c
               WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME) AS columns
       FROM information_schema.TABLES t
       WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE' ORDER BY t.TABLE_NAME`,
      [database],
    );
    for (const table of tables) {
      table.rows = Number((await query('SELECT COUNT(*) AS n FROM ??.??', [database, table.name]))[0].n);
      table.columns = Number(table.columns);
    }
    console.log(JSON.stringify({ database, tables }, null, 1));
    if (!args.table) process.exit(0);
  }

  const table = args.table;
  const [tableRow] = await query(
    `SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment
     FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [database, table],
  );
  if (!tableRow) {
    console.error(`No table "${table}" in "${database}".`);
    process.exit(1);
  }

  // Column types — the narrow destination's answer to "did this land as a real type?"
  const columns = await query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS columnKey,
            EXTRA AS extra, CHARACTER_SET_NAME AS charset
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [database, table],
  );

  // Real foreign-key constraints — the discriminator between a relation and flattened text.
  const foreignKeys = await query(
    `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS columnName, k.REFERENCED_TABLE_NAME AS referencedTable,
            k.REFERENCED_COLUMN_NAME AS referencedColumn, r.DELETE_RULE AS onDelete
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r
       ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY k.COLUMN_NAME`,
    [database, table],
  );

  const totalRows = Number((await query('SELECT COUNT(*) AS n FROM ??.??', [database, table]))[0].n);

  let rows = [];
  if (args.match) {
    const textColumns = columns.filter((column) => /char|text/i.test(column.type)).map((column) => column.name);
    if (textColumns.length > 0) {
      const predicate = textColumns.map(() => 'COALESCE(??, \'\') LIKE ?').join(' OR ');
      const params = [database, table, ...textColumns.flatMap((name) => [name, `%${args.match}%`])];
      rows = await query(`SELECT * FROM ??.?? WHERE ${predicate} LIMIT ${Number(args.limit || 10)}`, params);
    }
  } else if (args.limit) {
    rows = await query(`SELECT * FROM ??.?? ORDER BY id LIMIT ${Number(args.limit)}`, [database, table]);
  }

  console.log(JSON.stringify({
    database,
    table,
    engine: tableRow.engine,
    collation: tableRow.collation,
    comment: tableRow.comment,
    totalRows,
    columns: Object.fromEntries(
      columns.map((column) => [
        column.name,
        `${column.type}${column.nullable === 'NO' ? ' NOT NULL' : ''}${column.columnKey === 'PRI' ? ' PRIMARY KEY' : ''}${column.extra ? ` ${column.extra}` : ''}`,
      ]),
    ),
    foreignKeys: foreignKeys.map((fk) => ({
      constraint: fk.name,
      column: fk.columnName,
      references: `${fk.referencedTable}.${fk.referencedColumn}`,
      onDelete: fk.onDelete,
    })),
    matched: rows.length,
    rows,
  }, null, 1));
} finally {
  await connection.end();
}
