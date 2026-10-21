#!/usr/bin/env node
/**
 * Seed MYSQL-as-source torture tables for the Live Export audit, and the empty databases MYSQL-as-destination
 * runs export into. Connects with `local/audit-creds/mysql.env` → `connectionString` (a user that can create
 * databases; locally `mysql://root:root@127.0.0.1:3306`). Idempotent: the source database is dropped and
 * recreated on every run so content is deterministic.
 *
 * Source database `fable_qa_my_src`:
 * - `fable_qa_my_invoices` (213 rows): BIGINT UNSIGNED AUTO_INCREMENT ids above 2^53, VARCHAR / CHAR / MEDIUMTEXT
 *   (2001 and 4001 characters, emoji, CJK, RTL, quotes, tabs), INT / BIGINT extremes / BIGINT UNSIGNED max /
 *   DECIMAL(18,6) / DOUBLE / FLOAT, TINYINT(1) holding 0, 1 and 2, DATE incl. a zero date, DATETIME(6) at its
 *   limits, TIMESTAMP(3) near 1970 and 2038, ENUM incl. a comma, SET, JSON object / array / scalar, YEAR, TIME
 *   (negative), BIT(8), VARBINARY, an `ON UPDATE CURRENT_TIMESTAMP(3)` column, an FK to contacts and one to a
 *   table that is never exported, an all-empty row and 210 fillers (pagination).
 * - `fable_qa_my_contacts` (3 rows): VARCHAR, TINYINT(1), and an FK back to invoices (links both ways).
 * - `fable_qa_my_hidden` (2 rows): FK target that is never exported.
 * - `fable_qa_my_wide` (only with `--wide`): 185 INT columns, over the 180-field cap for created MySQL tables.
 *
 * Destination databases (created if missing, emptied with `--reset-dest`): `fable_qa_dest_from_airtable`,
 * `fable_qa_dest_from_supabase`, `fable_qa_dest_from_mysql`. One per source, so created table names never clash.
 *
 * Usage:
 *   node tools/live-export-audit/seeds/mysql/seed.mjs [--wide] [--reset-dest]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(path.join(REPO_ROOT, 'server/package.json'));
const mysql = require('mysql2/promise');

const flags = new Set(process.argv.slice(2));

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
const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  multipleStatements: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  dateStrings: true,
  timezone: 'Z',
});
const query = async (sql, params = []) => (await connection.query(sql, params))[0];

const SOURCE_DATABASE = 'fable_qa_my_src';
const DESTINATION_DATABASES = ['fable_qa_dest_from_airtable', 'fable_qa_dest_from_supabase', 'fable_qa_dest_from_mysql'];
/** 2^53 + 1: the first integer a float64 can't hold, so an id that survives as a number would be wrong. */
const FIRST_INVOICE_ID = '9007199254740993';

await query(`SET SESSION time_zone = '+00:00'`);
await query(`DROP DATABASE IF EXISTS ${SOURCE_DATABASE}`);
await query(`CREATE DATABASE ${SOURCE_DATABASE} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
for (const destinationDatabase of DESTINATION_DATABASES) {
  if (flags.has('--reset-dest')) await query(`DROP DATABASE IF EXISTS ${destinationDatabase}`);
  await query(`CREATE DATABASE IF NOT EXISTS ${destinationDatabase} CHARACTER SET utf8mb4`);
}
await query(`USE ${SOURCE_DATABASE}`);

await query(`
  CREATE TABLE fable_qa_my_hidden (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL
  ) ENGINE = InnoDB;
  CREATE TABLE fable_qa_my_contacts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(120),
    vip TINYINT(1),
    favorite_invoice_id BIGINT UNSIGNED NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE = InnoDB;
  CREATE TABLE fable_qa_my_invoices (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    notes MEDIUMTEXT,
    short_code VARCHAR(20),
    fixed_code CHAR(5),
    qty INT,
    big_qty BIGINT,
    big_unsigned BIGINT UNSIGNED,
    amount DECIMAL(18,6),
    ratio DOUBLE,
    approx FLOAT,
    paid TINYINT(1),
    flag_byte TINYINT(1),
    due DATE,
    created_at DATETIME(6),
    shipped_at TIMESTAMP(3) NULL,
    status ENUM('Draft','Sent','Paid, with comma'),
    tags SET('alpha','beta','gamma'),
    meta JSON,
    fiscal_year YEAR,
    duration TIME,
    bits BIT(8),
    raw VARBINARY(16),
    site VARCHAR(500),
    contact_id BIGINT UNSIGNED NULL,
    hidden_id BIGINT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fable_qa_my_invoices_contact_fk FOREIGN KEY (contact_id)
      REFERENCES fable_qa_my_contacts (id) ON DELETE SET NULL,
    CONSTRAINT fable_qa_my_invoices_hidden_fk FOREIGN KEY (hidden_id)
      REFERENCES fable_qa_my_hidden (id) ON DELETE SET NULL
  ) ENGINE = InnoDB AUTO_INCREMENT = ${FIRST_INVOICE_ID};
  ALTER TABLE fable_qa_my_contacts
    ADD CONSTRAINT fable_qa_my_contacts_favorite_invoice_fk FOREIGN KEY (favorite_invoice_id)
      REFERENCES fable_qa_my_invoices (id) ON DELETE SET NULL;
`);

await query(`INSERT INTO fable_qa_my_hidden (name) VALUES ('Ghost target (table not exported)'), ('Ghost 2')`);
const hiddenGhostId = (await query(`SELECT id FROM fable_qa_my_hidden ORDER BY id LIMIT 1`))[0].id;
await query(
  `INSERT INTO fable_qa_my_contacts (name, email, vip) VALUES
   ('Alice 完全 🎯', 'alice@example.com', 1),
   ('Bob "quoted, comma"', 'bob@example.com', 0),
   ('Carol مرحبا', 'carol@example.com', NULL)`,
);
const contactIdByName = Object.fromEntries(
  (await query(`SELECT id, name FROM fable_qa_my_contacts`)).map((row) => [row.name.split(' ')[0], row.id]),
);

const LONG_2001 = 'x'.repeat(1992) + ' END-2001';
const LONG_4001 = 'y'.repeat(3992) + ' END-4001';
const RICH_MD = '# Heading\n\n**bold** *italic* [link](https://example.com)\n\n- one\n- two\n\n```js\nconst a = 1;\n```';
const INVOICE_COLUMNS = [
  'name', 'notes', 'short_code', 'fixed_code', 'qty', 'big_qty', 'big_unsigned', 'amount', 'ratio', 'approx', 'paid',
  'flag_byte', 'due', 'created_at', 'shipped_at', 'status', 'tags', 'meta', 'fiscal_year', 'duration', 'bits', 'raw',
  'site', 'contact_id', 'hidden_id',
];
const insertInvoice = (valueByColumn) =>
  query(`INSERT INTO fable_qa_my_invoices (${INVOICE_COLUMNS.join(', ')}) VALUES (?)`, [
    INVOICE_COLUMNS.map((column) => valueByColumn[column] ?? null),
  ]);

await insertInvoice({
  name: 'Torture ☂️ 中文 עברית "quotes" <b>&amp;</b>\ttab',
  notes: `${RICH_MD}\n\n${LONG_2001}`,
  short_code: 'SC-"q",c',
  fixed_code: 'ab',
  qty: 0,
  big_qty: '9223372036854775807',
  big_unsigned: '18446744073709551615',
  amount: '-1234567.123456',
  ratio: 0.1 + 0.2,
  approx: 3.14159,
  paid: 1,
  flag_byte: 2,
  due: '2026-12-31',
  created_at: '9999-12-31 23:59:59.999999',
  shipped_at: '2038-01-19 03:14:07.999',
  status: 'Paid, with comma',
  tags: 'alpha,gamma',
  meta: JSON.stringify({ k: [1, 2], nested: { s: 'v', n: null }, unicode: '✓', big: 12345678901234567890 }),
  fiscal_year: 2026,
  duration: '-838:59:59',
  bits: Buffer.from([0b10100101]),
  raw: Buffer.from('fable_qa raw', 'utf8'),
  site: 'https://example.com/x?a=1&b="q"',
  contact_id: contactIdByName.Alice,
  hidden_id: hiddenGhostId,
});
await insertInvoice({ name: 'All-empty invoice' });
await insertInvoice({
  name: 'Long-4001 + single link',
  notes: LONG_4001,
  short_code: '',
  fixed_code: '',
  qty: -7,
  big_qty: '-9223372036854775808',
  big_unsigned: '0',
  amount: '0.000001',
  ratio: -0.0,
  approx: 1e30,
  paid: 0,
  flag_byte: 0,
  due: '1000-01-01',
  created_at: '1000-01-01 00:00:00.000000',
  shipped_at: '1970-01-01 00:00:01.000',
  status: 'Draft',
  tags: '',
  meta: JSON.stringify([]),
  fiscal_year: 1901,
  duration: '00:00:00.5',
  site: '',
  contact_id: contactIdByName.Bob,
});
// WordPress-style zero date: only a lax sql_mode lets MySQL store it.
await query(`SET SESSION sql_mode = ''`);
await insertInvoice({ name: 'Zero-date invoice', due: '0000-00-00', created_at: '0000-00-00 00:00:00', meta: '"just a string"' });
await query(`SET SESSION sql_mode = DEFAULT`);
for (let fillerNumber = 1; fillerNumber <= 210; fillerNumber++) {
  const dayOfMonth = String((fillerNumber % 28) + 1).padStart(2, '0');
  await insertInvoice({
    name: `Filler invoice ${String(fillerNumber).padStart(3, '0')}`,
    short_code: `F${fillerNumber}`,
    qty: fillerNumber,
    big_qty: String(fillerNumber * 1000),
    amount: (fillerNumber * 1.25).toFixed(2),
    ratio: fillerNumber / 8,
    paid: fillerNumber % 2,
    due: `2026-05-${dayOfMonth}`,
    shipped_at: `2026-05-${dayOfMonth} 12:00:00.000`,
    status: fillerNumber % 3 === 0 ? 'Draft' : 'Sent',
    tags: fillerNumber % 5 === 0 ? 'alpha' : null,
  });
}
const tortureInvoiceId = (await query(`SELECT id FROM fable_qa_my_invoices WHERE name LIKE 'Torture %'`))[0].id;
const longInvoiceId = (await query(`SELECT id FROM fable_qa_my_invoices WHERE name LIKE 'Long-4001 %'`))[0].id;
await query(`UPDATE fable_qa_my_contacts SET favorite_invoice_id = ? WHERE id IN (?, ?)`, [
  tortureInvoiceId,
  contactIdByName.Alice,
  contactIdByName.Carol,
]);
await query(`UPDATE fable_qa_my_contacts SET favorite_invoice_id = ? WHERE id = ?`, [longInvoiceId, contactIdByName.Bob]);

if (flags.has('--wide')) {
  const wideColumns = Array.from({ length: 185 }, (_, index) => `c${String(index + 1).padStart(3, '0')} INT`);
  await query(`CREATE TABLE fable_qa_my_wide (id BIGINT AUTO_INCREMENT PRIMARY KEY, ${wideColumns.join(', ')})`);
  await query(`INSERT INTO fable_qa_my_wide (c001, c185) VALUES (1, 185), (2, 370)`);
}

const expectedCounts = {
  fable_qa_my_invoices: 214,
  fable_qa_my_contacts: 3,
  fable_qa_my_hidden: 2,
  ...(flags.has('--wide') ? { fable_qa_my_wide: 2 } : {}),
};
const counts = {};
for (const table of Object.keys(expectedCounts)) {
  counts[table] = Number((await query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);
}
const [firstInvoice] = await query(`SELECT MIN(id) AS id FROM fable_qa_my_invoices`);
await connection.end();
console.log('seeded:', JSON.stringify(counts), 'first invoice id:', firstInvoice.id);
if (JSON.stringify(counts) !== JSON.stringify(expectedCounts) || firstInvoice.id !== FIRST_INVOICE_ID) {
  throw new Error(`unexpected seed: expected ${JSON.stringify(expectedCounts)} from id ${FIRST_INVOICE_ID}`);
}
console.log('read-back verification OK');
