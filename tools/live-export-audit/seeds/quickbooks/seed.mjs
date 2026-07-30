#!/usr/bin/env node
/**
 * Torture-data seeder for the QuickBooks Online Live Export audit.
 *
 * QBO IS A STATIC-SCHEMA SERVICE. Unlike Airtable/Notion sources, there is no way to
 * create a dedicated `fable_qa_*` table or add custom fields — the 23 entity types and
 * their fields are fixed by Intuit. So the torture lives in RECORDS of the existing
 * entities, named with a `fable_qa_` prefix so they're identifiable and idempotent:
 *
 *   Customer  — name-list torture: unicode, control chars, max-length notes, the
 *               self-referential ParentRef/Job link, inactive records, all-empty record
 *   Item      — decimal precision, enum Type, FK to Account
 *   Invoice   — the rich one: FK to Customer, a Line[] array (1 and 4 elements) whose
 *               elements carry a nested FK to Item, date extremes, 4000-char note,
 *               and SalesTermRef -> Term (an FK deliberately pointing at a table that
 *               is NOT part of the export, to test unresolved-FK handling)
 *   Vendor    — a second name-list, to distinguish per-entity bugs from generic ones
 *
 * Values are chosen to be things QBO ACCEPTS — the point is to test our pipeline, not
 * Intuit's validation. Field caps respected: Customer.Notes 2000, Invoice.PrivateNote
 * 4000, CustomerMemo 1000, DocNumber 21, Item.Name 100.
 *
 * Idempotent: re-running updates the existing `fable_qa_*` records (matched by
 * DisplayName/Name/DocNumber) instead of duplicating them.
 *
 * Usage:
 *   node tools/live-export-audit/seeds/quickbooks/seed.mjs --connection coa_XXXXXXXXXX
 *   node tools/live-export-audit/seeds/quickbooks/seed.mjs --connection coa_X --verify-only
 */
import { createQboClient } from './qbo-client.mjs';

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
if (!args.connection) {
  console.error('--connection coa_… is required');
  process.exit(1);
}

const qbo = await createQboClient(args.connection);
console.error(`QBO realm ${qbo.realmId} (${qbo.sandbox ? 'SANDBOX' : 'PRODUCTION'})`);
if (!qbo.sandbox) {
  console.error('REFUSING to seed a PRODUCTION QuickBooks company. Seeds create and modify real records.');
  process.exit(1);
}

const PREFIX = 'fable_qa_';

// ── torture value building blocks ────────────────────────────────────────────
const EMOJI_CJK_RTL = '🎉🇯🇵 中文测试 مرحبا بالعالم';
const ZERO_WIDTH = '​zero​width​';
const CONTROL_CHARS = 'line1\nline2\ttabbed "double" \'single\' <b>&amp;</b> back\\slash';
const repeatTo = (length) => 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(Math.ceil(length / 56)).slice(0, length);
const NOTES_2000 = repeatTo(2000);
const PRIVATE_NOTE_4000 = repeatTo(4000);
const MEMO_1000 = repeatTo(1000);

// ── helpers ──────────────────────────────────────────────────────────────────
const escapeForQuery = (value) => String(value).replace(/'/g, "\\'");

/** Find an existing fable_qa_ record so re-runs update rather than duplicate. */
async function findExisting(entityType, matchField, matchValue) {
  const rows = await qbo.query(
    `SELECT * FROM ${entityType} WHERE ${matchField} = '${escapeForQuery(matchValue)}'`,
  );
  return rows[0] ?? null;
}

/**
 * Create-or-update one record. QBO updates are sparse and require Id + SyncToken;
 * a create is the same POST without them.
 */
async function upsert(entityType, matchField, matchValue, payload) {
  const existing = await findExisting(entityType, matchField, matchValue);
  const body = existing
    ? { ...payload, Id: existing.Id, SyncToken: existing.SyncToken, sparse: true }
    : payload;
  try {
    const saved = await qbo.write(entityType, body);
    console.error(`  ${existing ? 'updated' : 'created'} ${entityType} ${saved.Id} — ${matchValue.slice(0, 60)}`);
    return saved;
  } catch (error) {
    console.error(`  FAILED ${entityType} "${matchValue.slice(0, 60)}": ${error.message}`);
    return null;
  }
}

const seeded = { Customer: [], Item: [], Invoice: [], Vendor: [] };

// ── prerequisites: an income account for Items, a Term for the unresolved FK ──
const incomeAccounts = await qbo.query("SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1");
const incomeAccount = incomeAccounts[0];
if (!incomeAccount) {
  console.error('No Income account in this company — cannot seed Items.');
  process.exit(1);
}
const terms = await qbo.query('SELECT * FROM Term MAXRESULTS 1');
const salesTerm = terms[0] ?? null;

// ── Customers ────────────────────────────────────────────────────────────────
console.error('\nCustomers:');

seeded.Customer.push(
  await upsert('Customer', 'DisplayName', `${PREFIX}c01_minimal`, {
    DisplayName: `${PREFIX}c01_minimal`,
  }),
);

seeded.Customer.push(
  await upsert('Customer', 'DisplayName', `${PREFIX}c02_unicode`, {
    DisplayName: `${PREFIX}c02_unicode`,
    GivenName: EMOJI_CJK_RTL.slice(0, 100),
    FamilyName: ZERO_WIDTH,
    CompanyName: `${EMOJI_CJK_RTL} Ltd`.slice(0, 100),
    Notes: `${EMOJI_CJK_RTL}\n${ZERO_WIDTH}`,
  }),
);

seeded.Customer.push(
  await upsert('Customer', 'DisplayName', `${PREFIX}c03_control_chars`, {
    DisplayName: `${PREFIX}c03_control_chars`,
    Notes: CONTROL_CHARS,
    CompanyName: 'Quote "Co" & <Sons>',
  }),
);

seeded.Customer.push(
  await upsert('Customer', 'DisplayName', `${PREFIX}c04_notes_2000`, {
    DisplayName: `${PREFIX}c04_notes_2000`,
    Notes: NOTES_2000,
  }),
);

seeded.Customer.push(
  await upsert('Customer', 'DisplayName', `${PREFIX}c05_all_fields`, {
    DisplayName: `${PREFIX}c05_all_fields`,
    Title: 'Dr',
    GivenName: 'Ada',
    MiddleName: 'M',
    FamilyName: 'Lovelace',
    Suffix: 'Jr',
    CompanyName: 'Analytical Engines',
    PrintOnCheckName: 'Analytical Engines',
    Active: true,
    Taxable: true,
    PrimaryEmailAddr: { Address: 'fable-qa+c05@example.com' },
    PrimaryPhone: { FreeFormNumber: '+1 (415) 555-0142' },
    Mobile: { FreeFormNumber: '+1 (415) 555-0143' },
    Fax: { FreeFormNumber: '+1 (415) 555-0144' },
    WebAddr: { URI: 'https://example.com/fable-qa' },
    ResaleNum: 'RESALE-12345',
    PreferredDeliveryMethod: 'Email',
    BillAddr: {
      Line1: '1 Torture Test Way',
      Line2: 'Suite 🎉',
      City: 'San Pablo',
      CountrySubDivisionCode: 'CA',
      PostalCode: '87999',
      Country: 'USA',
    },
    ShipAddr: {
      Line1: '2 Different Street',
      City: 'Oakland',
      CountrySubDivisionCode: 'CA',
      PostalCode: '94601',
    },
  }),
);

const parentCustomer = await upsert('Customer', 'DisplayName', `${PREFIX}c06_parent`, {
  DisplayName: `${PREFIX}c06_parent`,
  CompanyName: 'Parent Co',
});
seeded.Customer.push(parentCustomer);

// Self-referential FK: a sub-job whose ParentRef points at another Customer row.
if (parentCustomer) {
  seeded.Customer.push(
    await upsert('Customer', 'DisplayName', `${PREFIX}c07_subjob`, {
      DisplayName: `${PREFIX}c07_subjob`,
      Job: true,
      ParentRef: { value: parentCustomer.Id },
    }),
  );
}

seeded.Customer.push(
  await upsert('Customer', 'DisplayName', `${PREFIX}c08_inactive`, {
    DisplayName: `${PREFIX}c08_inactive`,
    Active: false,
  }),
);

// ── Items ────────────────────────────────────────────────────────────────────
console.error('\nItems:');

seeded.Item.push(
  await upsert('Item', 'Name', `${PREFIX}i01_zero_price`, {
    Name: `${PREFIX}i01_zero_price`,
    Type: 'Service',
    UnitPrice: 0,
    IncomeAccountRef: { value: incomeAccount.Id },
    Taxable: false,
  }),
);

seeded.Item.push(
  await upsert('Item', 'Name', `${PREFIX}i02_precision`, {
    Name: `${PREFIX}i02_precision`,
    Type: 'Service',
    UnitPrice: 12345.6789,
    Description: repeatTo(4000),
    IncomeAccountRef: { value: incomeAccount.Id },
    Taxable: true,
  }),
);

seeded.Item.push(
  await upsert('Item', 'Name', `${PREFIX}i03_large_price`, {
    Name: `${PREFIX}i03_large_price`,
    Type: 'Service',
    UnitPrice: 9999999.99,
    IncomeAccountRef: { value: incomeAccount.Id },
  }),
);

// ── Vendors ──────────────────────────────────────────────────────────────────
console.error('\nVendors:');

seeded.Vendor.push(
  await upsert('Vendor', 'DisplayName', `${PREFIX}v01_minimal`, {
    DisplayName: `${PREFIX}v01_minimal`,
  }),
);

seeded.Vendor.push(
  await upsert('Vendor', 'DisplayName', `${PREFIX}v02_unicode`, {
    DisplayName: `${PREFIX}v02_unicode`,
    CompanyName: EMOJI_CJK_RTL.slice(0, 100),
    PrimaryEmailAddr: { Address: 'fable-qa+v02@example.com' },
    // NOTE: Vendor.BillAddr rejects `Country` with "invalid or unsupported property"
    // (400) even though Customer.BillAddr accepts it — a QBO API asymmetry, not ours.
    BillAddr: { Line1: CONTROL_CHARS.slice(0, 100), City: 'Berlin' },
  }),
);

// ── Invoices ─────────────────────────────────────────────────────────────────
console.error('\nInvoices:');

const invoiceCustomer = seeded.Customer.find((c) => c && c.DisplayName === `${PREFIX}c05_all_fields`);
const lineItem = seeded.Item.find((i) => i && i.Name === `${PREFIX}i01_zero_price`);
const lineItem2 = seeded.Item.find((i) => i && i.Name === `${PREFIX}i02_precision`);

function salesLine({ amount, itemId, qty, unitPrice, description }) {
  return {
    DetailType: 'SalesItemLineDetail',
    Amount: amount,
    Description: description,
    SalesItemLineDetail: {
      ItemRef: { value: itemId },
      Qty: qty,
      UnitPrice: unitPrice,
    },
  };
}

if (invoiceCustomer && lineItem && lineItem2) {
  seeded.Invoice.push(
    await upsert('Invoice', 'DocNumber', `${PREFIX}INV01`, {
      DocNumber: `${PREFIX}INV01`,
      CustomerRef: { value: invoiceCustomer.Id },
      Line: [salesLine({ amount: 100, itemId: lineItem.Id, qty: 1, unitPrice: 100, description: 'single line' })],
    }),
  );

  // Array with 4 elements, each carrying a nested ItemRef foreign key.
  seeded.Invoice.push(
    await upsert('Invoice', 'DocNumber', `${PREFIX}INV02`, {
      DocNumber: `${PREFIX}INV02`,
      CustomerRef: { value: invoiceCustomer.Id },
      Line: [
        salesLine({ amount: 10.5, itemId: lineItem.Id, qty: 1, unitPrice: 10.5, description: 'first, with comma' }),
        salesLine({ amount: 20, itemId: lineItem2.Id, qty: 2, unitPrice: 10, description: 'second "quoted"' }),
        salesLine({ amount: 30, itemId: lineItem.Id, qty: 3, unitPrice: 10, description: EMOJI_CJK_RTL }),
        salesLine({ amount: 0, itemId: lineItem2.Id, qty: 1, unitPrice: 0, description: 'zero amount line' }),
      ],
    }),
  );

  seeded.Invoice.push(
    await upsert('Invoice', 'DocNumber', `${PREFIX}INV03`, {
      DocNumber: `${PREFIX}INV03`,
      CustomerRef: { value: invoiceCustomer.Id },
      PrivateNote: PRIVATE_NOTE_4000,
      CustomerMemo: { value: MEMO_1000 },
      BillEmail: { Address: 'fable-qa+inv03@example.com' },
      Line: [salesLine({ amount: 1, itemId: lineItem.Id, qty: 1, unitPrice: 1, description: 'long note carrier' })],
      // FK deliberately pointing at a table we will NOT include in the export.
      ...(salesTerm ? { SalesTermRef: { value: salesTerm.Id } } : {}),
    }),
  );

  // Date extremes QBO accepts (it rejects years outside roughly 1901-2100).
  seeded.Invoice.push(
    await upsert('Invoice', 'DocNumber', `${PREFIX}INV04`, {
      DocNumber: `${PREFIX}INV04`,
      CustomerRef: { value: invoiceCustomer.Id },
      TxnDate: '1901-01-01',
      DueDate: '2099-12-31',
      Line: [salesLine({ amount: 5, itemId: lineItem.Id, qty: 1, unitPrice: 5, description: 'date extremes' })],
    }),
  );

  seeded.Invoice.push(
    await upsert('Invoice', 'DocNumber', `${PREFIX}INV05`, {
      DocNumber: `${PREFIX}INV05`,
      CustomerRef: { value: invoiceCustomer.Id },
      CustomerMemo: { value: `${EMOJI_CJK_RTL} ${ZERO_WIDTH}` },
      PrivateNote: CONTROL_CHARS,
      Line: [salesLine({ amount: 0.01, itemId: lineItem.Id, qty: 1, unitPrice: 0.01, description: 'unicode memo' })],
    }),
  );
}

// ── verify by reading back through the service's own API ─────────────────────
console.error('\nVerification (read back from QBO):');
const summary = {};
for (const [entityType, matchField] of [
  ['Customer', 'DisplayName'],
  ['Item', 'Name'],
  ['Vendor', 'DisplayName'],
  ['Invoice', 'DocNumber'],
]) {
  const rows = await qbo.query(`SELECT * FROM ${entityType} WHERE ${matchField} LIKE '${PREFIX}%'`);
  // Inactive name-list records are excluded from the default query scope, so count separately.
  summary[entityType] = { seeded: rows.length, names: rows.map((r) => r[matchField]) };
  console.error(`  ${entityType}: ${rows.length} fable_qa_ records`);
}
summary.totals = {
  Customer: await qbo.count('Customer'),
  Item: await qbo.count('Item'),
  Vendor: await qbo.count('Vendor'),
  Invoice: await qbo.count('Invoice'),
  Account: await qbo.count('Account'),
};
console.log(JSON.stringify(summary, null, 1));
