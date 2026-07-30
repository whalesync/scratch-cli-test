#!/usr/bin/env node
/**
 * Phase 4 CRUD pass for the QuickBooks Live Export audit.
 *
 * Applies ONE round of source-side changes through QuickBooks' own API, so the same
 * mutation can then be replayed into every destination workbook with `audit.mjs --rerun`:
 *
 *   EDIT   fable_qa_c03_control_chars  — CompanyName (short scalar)
 *   EDIT   fable_qa_INV03              — PrivateNote (the 4000-char long-text field)
 *   CREATE fable_qa_c09_crud_created   — a new Customer
 *   DELETE fable_qa_c01_minimal        — deactivated; QBO has no hard delete for name-list
 *                                        entities, and its deactivate ALSO renames the record
 *                                        to "<name> (deleted)" and drops it out of the default
 *                                        `SELECT *` scope — so from the pull's point of view it
 *                                        simply vanishes. That is exactly the delete signal we
 *                                        want to prove mirrors to the destinations.
 *
 * Idempotent-ish: re-running re-applies the same edits (values carry a marker, not a
 * timestamp, so a second run is a genuine no-op) and skips create/delete when already done.
 *
 * Usage:
 *   node tools/live-export-audit/seeds/quickbooks/crud-pass.mjs --connection coa_XXXXXXXXXX
 *   node tools/live-export-audit/seeds/quickbooks/crud-pass.mjs --connection coa_X --verify
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
if (!qbo.sandbox) {
  console.error('REFUSING to mutate a PRODUCTION QuickBooks company.');
  process.exit(1);
}

const EDITED_COMPANY_NAME = 'CRUD PASS edited company name';
const EDITED_PRIVATE_NOTE = 'CRUD PASS edited long note — ' + 'x'.repeat(3000);
const CREATED_CUSTOMER = 'fable_qa_c09_crud_created';
const DELETED_CUSTOMER = 'fable_qa_c01_minimal';

const findOne = async (entity, field, value) =>
  (await qbo.query(`SELECT * FROM ${entity} WHERE ${field} = '${String(value).replace(/'/g, "\\'")}'`))[0] ?? null;

if (args.verify) {
  const state = {
    editedCustomer: (await findOne('Customer', 'DisplayName', 'fable_qa_c03_control_chars'))?.CompanyName ?? null,
    editedInvoiceNoteLength: (await findOne('Invoice', 'DocNumber', 'fable_qa_INV03'))?.PrivateNote?.length ?? null,
    createdCustomerExists: !!(await findOne('Customer', 'DisplayName', CREATED_CUSTOMER)),
    deletedCustomerStillActive: !!(await findOne('Customer', 'DisplayName', DELETED_CUSTOMER)),
  };
  console.log(JSON.stringify(state, null, 1));
  process.exit(0);
}

// ── EDIT 1: a short scalar on a name-list entity ─────────────────────────────
const customerToEdit = await findOne('Customer', 'DisplayName', 'fable_qa_c03_control_chars');
if (customerToEdit) {
  await qbo.write('Customer', {
    Id: customerToEdit.Id,
    SyncToken: customerToEdit.SyncToken,
    sparse: true,
    DisplayName: customerToEdit.DisplayName,
    CompanyName: EDITED_COMPANY_NAME,
  });
  console.error(`EDIT   Customer ${customerToEdit.Id} CompanyName -> "${EDITED_COMPANY_NAME}"`);
}

// ── EDIT 2: the long-text field on a transaction entity ──────────────────────
// A sparse update replaces each supplied top-level field wholesale, so Line must be
// re-sent in full even though only PrivateNote is changing.
const invoiceToEdit = await findOne('Invoice', 'DocNumber', 'fable_qa_INV03');
if (invoiceToEdit) {
  await qbo.write('Invoice', {
    Id: invoiceToEdit.Id,
    SyncToken: invoiceToEdit.SyncToken,
    sparse: true,
    PrivateNote: EDITED_PRIVATE_NOTE,
    Line: invoiceToEdit.Line,
  });
  console.error(`EDIT   Invoice ${invoiceToEdit.Id} PrivateNote -> ${EDITED_PRIVATE_NOTE.length} chars`);
}

// ── CREATE ───────────────────────────────────────────────────────────────────
const alreadyCreated = await findOne('Customer', 'DisplayName', CREATED_CUSTOMER);
if (alreadyCreated) {
  console.error(`CREATE skipped — ${CREATED_CUSTOMER} already exists (${alreadyCreated.Id})`);
} else {
  const created = await qbo.write('Customer', {
    DisplayName: CREATED_CUSTOMER,
    CompanyName: 'Created during the CRUD pass',
    PrimaryEmailAddr: { Address: 'fable-qa+c09@example.com' },
  });
  console.error(`CREATE Customer ${created.Id} ${CREATED_CUSTOMER}`);
}

// ── DELETE (deactivate — QBO's only delete for name-list entities) ───────────
const customerToDelete = await findOne('Customer', 'DisplayName', DELETED_CUSTOMER);
if (!customerToDelete) {
  console.error(`DELETE skipped — ${DELETED_CUSTOMER} is already inactive/renamed`);
} else {
  await qbo.write('Customer', {
    Id: customerToDelete.Id,
    SyncToken: customerToDelete.SyncToken,
    sparse: true,
    DisplayName: customerToDelete.DisplayName,
    Active: false,
  });
  console.error(`DELETE Customer ${customerToDelete.Id} ${DELETED_CUSTOMER} -> Active=false`);
}

const activeCustomers = await qbo.query('SELECT COUNT(*) FROM Customer');
console.log(JSON.stringify({
  editedCompanyName: EDITED_COMPANY_NAME,
  editedPrivateNoteLength: EDITED_PRIVATE_NOTE.length,
  createdCustomer: CREATED_CUSTOMER,
  deletedCustomer: DELETED_CUSTOMER,
  activeCustomersNow: (await qbo.query('SELECT * FROM Customer MAXRESULTS 1000')).length,
}, null, 1));
