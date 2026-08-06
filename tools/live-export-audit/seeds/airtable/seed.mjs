#!/usr/bin/env node
/**
 * Seed AIRTABLE-as-source torture tables for the Live Export audit
 * (`fable_qa_at_*` in the audit base). Idempotent: tables are created only when
 * missing (Airtable has no delete-table API), and records are wiped + re-seeded
 * on every run so content is deterministic.
 *
 * Coverage: every commonly-exported field type (text/long/rich, number/currency/
 * percent, checkbox, date/dateTime, single/multi select, email/url/phone,
 * record links incl. a link to a table deliberately NOT exported), an all-empty
 * record, unicode/long-text torture values, and 210 filler invoices for
 * pagination.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = readEnvFile(path.join(REPO_ROOT, 'local/audit-creds/airtable.env'));
const TOKEN = env.apiKey;
const BASE = env.AIRTABLE_SEED_BASE_ID || 'appGoopxI4Px4dyuv';

async function at(method, endpoint, body) {
  const res = await fetch(`https://api.airtable.com/v0${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

const meta = await at('GET', `/meta/bases/${BASE}/tables`);
const tableByName = new Map(meta.tables.map((t) => [t.name, t]));

async function ensureTable(name, fields) {
  if (tableByName.has(name)) return tableByName.get(name);
  const created = await at('POST', `/meta/bases/${BASE}/tables`, { name, fields });
  tableByName.set(name, created);
  console.log('created table', name, created.id);
  return created;
}

const contacts = await ensureTable('fable_qa_at_contacts', [
  { name: 'Name', type: 'singleLineText' },
  { name: 'Email', type: 'email' },
  { name: 'Vip', type: 'checkbox', options: { color: 'greenBright', icon: 'check' } },
]);
const hidden = await ensureTable('fable_qa_at_hidden', [{ name: 'Name', type: 'singleLineText' }]);
const invoices = await ensureTable('fable_qa_at_invoices', [
  { name: 'Name', type: 'singleLineText' },
  { name: 'Notes', type: 'multilineText' },
  { name: 'Rich', type: 'richText' },
  { name: 'Amount', type: 'currency', options: { precision: 2, symbol: '$' } },
  { name: 'Qty', type: 'number', options: { precision: 0 } },
  { name: 'Precise', type: 'number', options: { precision: 8 } },
  { name: 'Ratio', type: 'percent', options: { precision: 2 } },
  { name: 'Paid', type: 'checkbox', options: { color: 'greenBright', icon: 'check' } },
  { name: 'Due', type: 'date', options: { dateFormat: { name: 'iso' } } },
  {
    name: 'Created At',
    type: 'dateTime',
    options: { timeZone: 'utc', dateFormat: { name: 'iso' }, timeFormat: { name: '24hour', format: 'HH:mm' } },
  },
  { name: 'Status', type: 'singleSelect', options: { choices: [{ name: 'Draft' }, { name: 'Sent' }, { name: 'Paid, with comma' }] } },
  { name: 'Tags', type: 'multipleSelects', options: { choices: [{ name: 'alpha' }, { name: 'beta' }, { name: 'γάμμα' }, { name: 'has, comma' }] } },
  { name: 'Contact', type: 'multipleRecordLinks', options: { linkedTableId: contacts.id } },
  { name: 'Hidden Ref', type: 'multipleRecordLinks', options: { linkedTableId: hidden.id } },
  { name: 'Site', type: 'url' },
  { name: 'Phone', type: 'phoneNumber' },
]);

/** Wipe all records of a table (deterministic re-seed). */
async function wipe(table) {
  for (;;) {
    const page = await at('GET', `/${BASE}/${encodeURIComponent(table.name)}?pageSize=100`);
    if (!page.records.length) return;
    for (let i = 0; i < page.records.length; i += 10) {
      const ids = page.records.slice(i, i + 10).map((r) => `records[]=${r.id}`).join('&');
      await at('DELETE', `/${BASE}/${encodeURIComponent(table.name)}?${ids}`);
    }
  }
}

async function createRecords(table, records) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const res = await at('POST', `/${BASE}/${encodeURIComponent(table.name)}`, {
      records: records.slice(i, i + 10).map((fields) => ({ fields })),
      typecast: true,
    });
    out.push(...res.records);
  }
  return out;
}

await wipe(invoices);
await wipe(contacts);
await wipe(hidden);

const [alice, bob, carol] = await createRecords(contacts, [
  { Name: 'Alice 完全 🎯', Email: 'alice@example.com', Vip: true },
  { Name: 'Bob "quoted, comma"', Email: 'bob@example.com' },
  { Name: 'Carol مرحبا', Email: 'carol@example.com', Vip: true },
]);
const [ghost] = await createRecords(hidden, [{ Name: 'Ghost target (table not exported)' }, { Name: 'Ghost 2' }]);

const LONG_2001 = 'x'.repeat(1992) + ' END-2001';
const LONG_4001 = 'y'.repeat(3992) + ' END-4001';

const tortureInvoices = [
  {
    Name: 'Torture ☂️ 中文 עברית "quotes" <b>&amp;</b>',
    Notes: LONG_2001,
    Rich: '# Heading\n\n**bold** *italic* [link](https://example.com)\n\n- one\n- two\n\n`code`',
    Amount: -1234.5,
    Qty: 0,
    Precise: 0.12345678,
    Ratio: 0.875,
    Paid: true,
    Due: '2026-12-31',
    'Created At': '2026-08-05T04:30:15.000Z',
    Status: 'Paid, with comma',
    Tags: ['alpha', 'has, comma', 'γάμμα'],
    Contact: [alice.id, carol.id],
    'Hidden Ref': [ghost.id],
    Site: 'https://example.com/x?a=1&b="q"',
    Phone: '+1 (555) 010-0199',
  },
  { Name: 'All-empty invoice' },
  {
    Name: 'Long-4001 + single links',
    Notes: LONG_4001,
    Qty: 9007199254740991,
    Due: '0100-01-01',
    'Created At': '9999-12-31T23:59:59.000Z',
    Tags: ['beta'],
    Contact: [bob.id],
  },
];
const fillers = Array.from({ length: 210 }, (_, i) => ({
  Name: `Filler invoice ${String(i + 1).padStart(3, '0')}`,
  Qty: i + 1,
  Amount: (i + 1) * 1.25,
  Paid: i % 2 === 0,
  Due: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
  Status: i % 3 === 0 ? 'Draft' : 'Sent',
}));
await createRecords(invoices, [...tortureInvoices, ...fillers]);

const counts = {};
for (const t of ['fable_qa_at_invoices', 'fable_qa_at_contacts', 'fable_qa_at_hidden']) {
  let n = 0, offset = '';
  do {
    const page = await at('GET', `/${BASE}/${encodeURIComponent(t)}?pageSize=100${offset ? `&offset=${offset}` : ''}`);
    n += page.records.length; offset = page.offset ?? '';
  } while (offset);
  counts[t] = n;
}
console.log('seeded:', JSON.stringify(counts));
if (counts.fable_qa_at_invoices !== 213 || counts.fable_qa_at_contacts !== 3 || counts.fable_qa_at_hidden !== 2) {
  throw new Error('unexpected counts');
}
console.log('read-back verification OK');
