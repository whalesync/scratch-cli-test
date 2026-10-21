#!/usr/bin/env node
/**
 * Source-side CRUD pass for the MYSQL-as-source Live Export audit (Phase 4 of /test-live-export): via SQL, edit 2
 * invoices (one touching the long-text `notes`), create 1 invoice, delete 1 filler. Run AFTER the first harness run,
 * then replay with `audit.mjs --workbook <wkb> --rerun`. The created record's name carries a timestamp tag so every
 * pass is a genuine create.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(path.join(REPO_ROOT, 'server/package.json'));
const mysql = require('mysql2/promise');

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = readEnvFile(path.join(REPO_ROOT, 'local/audit-creds', process.env.MYSQL_AUDIT_CREDS || 'mysql.env'));
const url = new URL(env.connectionString);
const CRUD_TAG = process.env.CRUD_TAG || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: 'fable_qa_my_src',
  supportBigNumbers: true,
  bigNumberStrings: true,
  dateStrings: true,
  timezone: 'Z',
});
const query = async (sql, params = []) => (await connection.query(sql, params))[0];
const countInvoices = async () => Number((await query('SELECT COUNT(*) AS n FROM fable_qa_my_invoices'))[0].n);

const countBefore = await countInvoices();
const LONG_2001_EDITED = 'z'.repeat(1985) + ' END-2001-EDITED';

const edited1 = await query(
  `UPDATE fable_qa_my_invoices SET qty = 2002, status = 'Draft', notes = ? WHERE name = 'Filler invoice 002'`,
  [`edited by crud-pass ${CRUD_TAG}`],
);
const edited2 = await query(
  `UPDATE fable_qa_my_invoices SET notes = ?, amount = '-99.5', tags = 'beta' WHERE name LIKE 'Torture %'`,
  [LONG_2001_EDITED],
);
const created = await query(
  `INSERT INTO fable_qa_my_invoices (name, qty, big_qty, amount, ratio, paid, shipped_at, status, tags, short_code)
   VALUES (?, 42, 42000, '3.500000', 0.5, 1, '2026-09-01 12:34:56.000', 'Sent', 'alpha,beta', 'CRUD')`,
  [`CRUD created invoice ${CRUD_TAG}`],
);
const [lastFiller] = await query(
  `SELECT id, name FROM fable_qa_my_invoices WHERE name REGEXP '^Filler invoice [0-9]+$' ORDER BY name DESC LIMIT 1`,
);
const deleted = await query(`DELETE FROM fable_qa_my_invoices WHERE id = ?`, [lastFiller.id]);
const countAfter = await countInvoices();
await connection.end();

const summary = {
  tag: CRUD_TAG,
  edited: ['Filler invoice 002', 'Torture …'],
  created: { id: created.insertId, name: `CRUD created invoice ${CRUD_TAG}` },
  deleted: lastFiller,
  countBefore,
  countAfter,
};
console.log(JSON.stringify(summary, null, 2));
if (
  edited1.affectedRows !== 1 ||
  edited2.affectedRows !== 1 ||
  created.affectedRows !== 1 ||
  deleted.affectedRows !== 1 ||
  countAfter !== countBefore
) {
  throw new Error('CRUD pass did not apply as expected');
}
console.log('read-back verification OK');
