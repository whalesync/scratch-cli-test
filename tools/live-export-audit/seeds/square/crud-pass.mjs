#!/usr/bin/env node
/**
 * One round of source-side changes for the SQUARE Live Export audit's CRUD gate (/test-live-export Phase 4).
 * Run it against the seeded sandbox (see seed.mjs), then re-run the audit with `--workbook <wkb_…> --rerun` and
 * check each change reached the destination.
 *
 * - edits 2 customers: one's note gets a new ~4,100-character body, the other's company name changes;
 * - creates 1 customer whose name no earlier pass used (it carries this run's timestamp);
 * - deletes 1 seeded customer that no gift card or subscription links to (the next seed run recreates it);
 * - loads $7.77 onto the first gift card, which adds a gift card activity and changes the card's balance.
 *
 * Prints the ids it touched as JSON, so the destination check can look them up.
 *
 * Usage: node tools/live-export-audit/seeds/square/crud-pass.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const envText = readFileSync(join(repoRoot, 'local', 'audit-creds', 'square.env'), 'utf8');
const accessToken = envText.match(/^apiKey=(.*)$/m)?.[1]?.trim();
if (!accessToken) throw new Error('local/audit-creds/square.env has no apiKey');

const SANDBOX_BASE_URL = 'https://connect.squareupsandbox.com';
const SQUARE_VERSION = '2026-09-16';
const runStamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);

async function square(method, path, body) {
  const response = await fetch(SANDBOX_BASE_URL + path, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(json.errors ?? json).slice(0, 600)}`);
  return json;
}

async function listAll(path, recordsKey) {
  const records = [];
  let cursor;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const page = await square('GET', `${path}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ''}`);
    records.push(...(page[recordsKey] ?? []));
    cursor = page.cursor;
  } while (cursor);
  return records;
}

const customers = (await listAll('/v2/customers?limit=100', 'customers'))
  .filter((customer) => customer.reference_id?.startsWith('fable_qa-customer-'))
  .sort((a, b) => a.reference_id.localeCompare(b.reference_id, undefined, { numeric: true }));
const giftCards = await listAll('/v2/gift-cards?limit=200', 'gift_cards');
const subscriptionsPage = await square('POST', '/v2/subscriptions/search', { limit: 100 });
const linkedCustomerIds = new Set([
  ...giftCards.flatMap((giftCard) => giftCard.customer_ids ?? []),
  ...(subscriptionsPage.subscriptions ?? []).map((subscription) => subscription.customer_id),
]);

const [noteEditTarget, companyEditTarget] = customers.filter((customer) => !linkedCustomerIds.has(customer.id));
const deleteTarget = customers.filter((customer) => !linkedCustomerIds.has(customer.id)).at(-1);

const longNote = `fable_qa CRUD pass ${runStamp}\n${'Quarterly review — “quoted”, <b>html</b>, 東京, 🧾. '.repeat(80)}`.slice(0, 4100);
await square('PUT', `/v2/customers/${noteEditTarget.id}`, { note: longNote, version: noteEditTarget.version });
await square('PUT', `/v2/customers/${companyEditTarget.id}`, {
  company_name: `fable_qa Edited Co ${runStamp}`,
  version: companyEditTarget.version,
});

const { customer: createdCustomer } = await square('POST', '/v2/customers', {
  idempotency_key: `fable_qa-crud-create-${runStamp}`,
  given_name: 'fable_qa CRUD',
  family_name: `Created ${runStamp}`,
  email_address: `fable_qa+crud-${runStamp}@example.com`,
  reference_id: `fable_qa-crud-${runStamp}`,
});

await square('DELETE', `/v2/customers/${deleteTarget.id}`);

const loadedGiftCard = giftCards.find((giftCard) => giftCard.state === 'ACTIVE');
const { gift_card_activity: loadActivity } = await square('POST', '/v2/gift-cards/activities', {
  idempotency_key: `fable_qa-crud-load-${runStamp}`,
  gift_card_activity: {
    type: 'LOAD',
    location_id: (await square('GET', '/v2/locations')).locations[0].id,
    gift_card_id: loadedGiftCard.id,
    load_activity_details: {
      amount_money: { amount: 777, currency: loadedGiftCard.balance_money.currency },
      buyer_payment_instrument_ids: ['fable_qa-external-payment'],
    },
  },
});

console.log(
  JSON.stringify(
    {
      editedNoteCustomerId: noteEditTarget.id,
      editedCompanyCustomerId: companyEditTarget.id,
      createdCustomerId: createdCustomer.id,
      deletedCustomerId: deleteTarget.id,
      loadedGiftCardId: loadedGiftCard.id,
      loadedGiftCardBalanceBefore: loadedGiftCard.balance_money.amount,
      createdGiftCardActivityId: loadActivity.id,
    },
    null,
    2,
  ),
);
