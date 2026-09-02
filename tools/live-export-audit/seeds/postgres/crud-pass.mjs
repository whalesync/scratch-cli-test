#!/usr/bin/env node
/**
 * Source-side CRUD pass for the POSTGRES-as-source Live Export audit (Phase 4 of
 * /test-live-export): via SQL, edit 2 invoices (one touching a long-text field),
 * create 1 invoice, delete 1 invoice. Run AFTER the first harness run, then replay
 * with `audit.mjs --workbook <wkb> --rerun`. The created record's name carries a
 * timestamp tag so every pass is a genuine create.
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
const CRUD_TAG =
  process.env.CRUD_TAG ||
  new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const client = new Client({ connectionString: env.connectionString });
await client.connect();

const before = Number(
  (await client.query("SELECT count(*)::int AS n FROM fable_qa_pg_invoices"))
    .rows[0].n,
);
const LONG_2001_EDITED = "z".repeat(1985) + " END-2001-EDITED";

const edited1 = await client.query(
  `UPDATE fable_qa_pg_invoices SET qty = 2002, status = 'Draft', notes = $1, updated_at = now()
   WHERE name = 'Filler invoice 002' RETURNING id, name, qty, status`,
  [`edited by crud-pass ${CRUD_TAG}`],
);
const edited2 = await client.query(
  `UPDATE fable_qa_pg_invoices SET notes = $1, amount = '-99.5', tags = ARRAY['beta'], updated_at = now()
   WHERE name LIKE 'Torture %' RETURNING id, name, amount, tags, length(notes) AS notes_len`,
  [LONG_2001_EDITED],
);
const created = await client.query(
  `INSERT INTO fable_qa_pg_invoices (id, name, qty, big_qty, amount, ratio, paid, shipped_at, status, tags, short_code)
   VALUES (gen_random_uuid(), $1, 42, '42000', '3.500000', 0.5, true, '2026-09-01T12:34:56Z', 'Sent', ARRAY['alpha','beta'], 'CRUD')
   RETURNING id, name`,
  [`CRUD created invoice ${CRUD_TAG}`],
);
const deleted = await client.query(
  `DELETE FROM fable_qa_pg_invoices WHERE id = (
     SELECT id FROM fable_qa_pg_invoices WHERE name ~ '^Filler invoice [0-9]+$' ORDER BY name DESC LIMIT 1
   ) RETURNING id, name`,
);
const after = Number(
  (await client.query("SELECT count(*)::int AS n FROM fable_qa_pg_invoices"))
    .rows[0].n,
);
await client.end();

const summary = {
  tag: CRUD_TAG,
  edited: [...edited1.rows, ...edited2.rows],
  created: created.rows,
  deleted: deleted.rows,
  countBefore: before,
  countAfter: after,
};
console.log(JSON.stringify(summary, null, 2));
if (
  edited1.rowCount !== 1 ||
  edited2.rowCount !== 1 ||
  created.rowCount !== 1 ||
  deleted.rowCount !== 1 ||
  after !== before
) {
  throw new Error("CRUD pass did not apply as expected");
}
console.log("read-back verification OK");
