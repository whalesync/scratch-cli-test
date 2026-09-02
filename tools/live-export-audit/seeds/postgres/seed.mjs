#!/usr/bin/env node
/**
 * Seed POSTGRES-as-source torture tables for the Live Export audit
 * (`fable_qa_pg_*` in the `public` schema of the audit database named by
 * `local/audit-creds/postgres.env` → `connectionString`). Idempotent: tables are
 * dropped and recreated on every run so content is deterministic.
 *
 * Coverage: every column family the pg connector types differently — text /
 * varchar(n) / char(n), int / bigint (> 2^53) / numeric(18,6) / double / real,
 * boolean, date / timestamp / timestamptz (sub-second, extreme years), uuid,
 * jsonb, text[] / int[] / bool[] arrays, a real FK in both directions, an FK to
 * a table deliberately NOT exported, an all-null record, unicode / long-text
 * torture values and 210 filler invoices for pagination. `updated_at` is
 * present so incremental pull can be exercised.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const require = createRequire(path.join(REPO_ROOT, "server/package.json"));
const { Client } = require("pg");

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = readEnvFile(path.join(REPO_ROOT, "local/audit-creds/postgres.env"));
const client = new Client({ connectionString: env.connectionString });
await client.connect();

const CONTACT_ALICE = "11111111-1111-4111-8111-111111111111";
const CONTACT_BOB = "22222222-2222-4222-8222-222222222222";
const CONTACT_CAROL = "33333333-3333-4333-8333-333333333333";
const HIDDEN_GHOST = "44444444-4444-4444-8444-444444444444";
const INV_TORTURE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INV_EMPTY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INV_LONG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

await client.query(`
  DROP TABLE IF EXISTS fable_qa_pg_invoices CASCADE;
  DROP TABLE IF EXISTS fable_qa_pg_contacts CASCADE;
  DROP TABLE IF EXISTS fable_qa_pg_hidden CASCADE;
  CREATE TABLE fable_qa_pg_hidden (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE fable_qa_pg_contacts (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    email varchar(120),
    vip boolean,
    favorite_invoice_id uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE fable_qa_pg_invoices (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    notes text,
    short_code varchar(20),
    fixed_code char(5),
    qty integer,
    big_qty bigint,
    amount numeric(18,6),
    ratio double precision,
    approx real,
    paid boolean,
    due date,
    created_at timestamp,
    shipped_at timestamptz,
    status text,
    tags text[],
    scores integer[],
    flags boolean[],
    meta jsonb,
    contact_id uuid REFERENCES fable_qa_pg_contacts(id) ON DELETE SET NULL,
    hidden_id uuid REFERENCES fable_qa_pg_hidden(id) ON DELETE SET NULL,
    site text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE fable_qa_pg_contacts
    ADD CONSTRAINT fable_qa_pg_contacts_favorite_invoice_fk
    FOREIGN KEY (favorite_invoice_id) REFERENCES fable_qa_pg_invoices(id) ON DELETE SET NULL;
`);

await client.query(
  `INSERT INTO fable_qa_pg_hidden (id, name) VALUES ($1, 'Ghost target (table not exported)'), (gen_random_uuid(), 'Ghost 2')`,
  [HIDDEN_GHOST],
);
await client.query(
  `INSERT INTO fable_qa_pg_contacts (id, name, email, vip) VALUES
   ($1, 'Alice 完全 🎯', 'alice@example.com', true),
   ($2, 'Bob "quoted, comma"', 'bob@example.com', false),
   ($3, 'Carol مرحبا', 'carol@example.com', null)`,
  [CONTACT_ALICE, CONTACT_BOB, CONTACT_CAROL],
);

const LONG_2001 = "x".repeat(1992) + " END-2001";
const LONG_4001 = "y".repeat(3992) + " END-4001";
const RICH_MD =
  "# Heading\n\n**bold** *italic* [link](https://example.com)\n\n- one\n- two\n\n```js\nconst a = 1;\n```";

const insertInvoice = (row) =>
  client.query(
    `INSERT INTO fable_qa_pg_invoices
     (id, name, notes, short_code, fixed_code, qty, big_qty, amount, ratio, approx, paid, due, created_at, shipped_at,
      status, tags, scores, flags, meta, contact_id, hidden_id, site)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    row,
  );

await insertInvoice([
  INV_TORTURE,
  'Torture ☂️ 中文 עברית "quotes" <b>&amp;</b>\ttab',
  RICH_MD + "\n\n" + LONG_2001,
  'SC-"q",c',
  "ab",
  0,
  "9007199254740993", // > 2^53, not representable as a float64
  "-1234567.123456",
  0.1 + 0.2,
  3.14159,
  true,
  "2026-12-31",
  "2026-08-05 04:30:15.123456",
  "2026-08-05T04:30:15.987+05:30",
  "Paid, with comma",
  ["alpha", "has, comma", '"quoted"', "γάμμα"],
  [1, 2, 3],
  [true, false],
  JSON.stringify({ k: [1, 2], nested: { s: "v", n: null }, unicode: "✓" }),
  CONTACT_ALICE,
  HIDDEN_GHOST,
  'https://example.com/x?a=1&b="q"',
]);
await insertInvoice([
  INV_EMPTY,
  "All-empty invoice",
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
]);
await insertInvoice([
  INV_LONG,
  "Long-4001 + single link + empty arrays",
  LONG_4001,
  "",
  "",
  -7,
  "-9223372036854775808",
  "0.000001",
  -0.0,
  1e30,
  false,
  "0100-01-01",
  "9999-12-31 23:59:59",
  "0001-01-01T00:00:00Z",
  "",
  [],
  [42],
  [],
  JSON.stringify([]),
  CONTACT_BOB,
  null,
  "",
]);
for (let i = 1; i <= 210; i++) {
  await insertInvoice([
    `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, "0")}`,
    `Filler invoice ${String(i).padStart(3, "0")}`,
    null,
    `F${i}`,
    null,
    i,
    String(i * 1000),
    String((i * 1.25).toFixed(2)),
    i / 8,
    null,
    i % 2 === 0,
    `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
    null,
    `2026-05-${String((i % 28) + 1).padStart(2, "0")}T12:00:00Z`,
    i % 3 === 0 ? "Draft" : "Sent",
    i % 5 === 0 ? ["alpha"] : null,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
}
await client.query(
  `UPDATE fable_qa_pg_contacts SET favorite_invoice_id = $1 WHERE id IN ($2, $3)`,
  [INV_TORTURE, CONTACT_ALICE, CONTACT_CAROL],
);
await client.query(
  `UPDATE fable_qa_pg_contacts SET favorite_invoice_id = $1 WHERE id = $2`,
  [INV_LONG, CONTACT_BOB],
);

const counts = {};
for (const t of [
  "fable_qa_pg_invoices",
  "fable_qa_pg_contacts",
  "fable_qa_pg_hidden",
]) {
  counts[t] = Number(
    (await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n,
  );
}
await client.end();
console.log("seeded:", JSON.stringify(counts));
if (
  counts.fable_qa_pg_invoices !== 213 ||
  counts.fable_qa_pg_contacts !== 3 ||
  counts.fable_qa_pg_hidden !== 2
) {
  throw new Error("unexpected counts");
}
console.log("read-back verification OK");
