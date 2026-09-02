#!/usr/bin/env node
/**
 * Source-side CRUD pass for the AIRTABLE-as-source Live Export audit (Phase 4 of
 * /test-live-export): via Airtable's public API, edit 2 invoices (one touching a
 * long-text field), create 1 invoice, delete 1 invoice. Run AFTER the first
 * harness run, then replay with `audit.mjs --workbook <wkb> --rerun`.
 *
 * The created record deliberately has numbers/boolean/select but NO date, so a
 * follow-up second-run check can tell date-driven churn apart from the rest.
 * Its title carries a timestamp tag so every pass is a genuine create (a title
 * the base already has would silently turn the create assertion into a no-op).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = readEnvFile(path.join(REPO_ROOT, "local/audit-creds/airtable.env"));
const TOKEN = env.apiKey;
const BASE =
  process.env.AIRTABLE_SEED_BASE_ID ||
  env.AIRTABLE_SEED_BASE_ID ||
  "appGoopxI4Px4dyuv";
const TABLE = "fable_qa_at_invoices";
const CRUD_TAG =
  process.env.CRUD_TAG ||
  new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

async function at(method, endpoint, body) {
  const res = await fetch(`https://api.airtable.com/v0${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `${method} ${endpoint} -> ${res.status}: ${(await res.text()).slice(0, 500)}`,
    );
  return res.json();
}

async function listAll() {
  const records = [];
  let offset = "";
  do {
    const page = await at(
      "GET",
      `/${BASE}/${encodeURIComponent(TABLE)}?pageSize=100${offset ? `&offset=${offset}` : ""}`,
    );
    records.push(...page.records);
    offset = page.offset ?? "";
  } while (offset);
  return records;
}

const before = await listAll();
const byName = (re) => before.find((r) => re.test(r.fields.Name ?? ""));
const filler002 = byName(/^Filler invoice 002$/);
const torture = byName(/^Torture /);
const highestFiller = before
  .filter((r) => /^Filler invoice \d+$/.test(r.fields.Name ?? ""))
  .sort((a, b) => b.fields.Name.localeCompare(a.fields.Name))[0];
if (!filler002 || !torture || !highestFiller)
  throw new Error("seed records missing — run seed.mjs first");

const LONG_2001_EDITED = "z".repeat(1985) + " END-2001-EDITED";
const updated = await at("PATCH", `/${BASE}/${encodeURIComponent(TABLE)}`, {
  records: [
    {
      id: filler002.id,
      fields: {
        Qty: 2002,
        Status: "Draft",
        Notes: `edited by crud-pass ${CRUD_TAG}`,
      },
    },
    {
      id: torture.id,
      fields: { Notes: LONG_2001_EDITED, Amount: -99.5, Tags: ["beta"] },
    },
  ],
  typecast: true,
});
const created = await at("POST", `/${BASE}/${encodeURIComponent(TABLE)}`, {
  records: [
    {
      fields: {
        Name: `CRUD created invoice ${CRUD_TAG}`,
        Qty: 42,
        Amount: 3.5,
        Precise: 0.5,
        Paid: true,
        Status: "Sent",
        Tags: ["alpha", "beta"],
        Phone: "+44 20 7946 0000",
      },
    },
  ],
  typecast: true,
});
await at(
  "DELETE",
  `/${BASE}/${encodeURIComponent(TABLE)}?records[]=${highestFiller.id}`,
);

const after = await listAll();
const summary = {
  tag: CRUD_TAG,
  edited: updated.records.map((r) => ({
    id: r.id,
    Name: r.fields.Name,
    Qty: r.fields.Qty,
    Amount: r.fields.Amount,
    NotesLen: (r.fields.Notes ?? "").length,
    Tags: r.fields.Tags,
  })),
  created: created.records.map((r) => ({ id: r.id, Name: r.fields.Name })),
  deleted: { id: highestFiller.id, Name: highestFiller.fields.Name },
  countBefore: before.length,
  countAfter: after.length,
};
console.log(JSON.stringify(summary, null, 2));
if (after.length !== before.length)
  throw new Error("expected net count unchanged (+1 create, -1 delete)");
if (
  !after.some((r) => r.id === created.records[0].id) ||
  after.some((r) => r.id === highestFiller.id)
) {
  throw new Error("read-back verification failed");
}
console.log("read-back verification OK");
