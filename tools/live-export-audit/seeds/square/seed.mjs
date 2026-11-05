#!/usr/bin/env node
/**
 * Idempotent test-data seeder for the SQUARE Live Export audit (/test-live-export).
 *
 * Seeds the Square SANDBOX seller that owns the token in local/audit-creds/square.env
 * (`apiKey=...`; the shared copy lives in the `square` secret of the whalesync-test-credentials
 * GCP project). Re-runs create only what is missing — everything is matched by its `fable_qa`
 * name, reference id, or invoice number — so the data set converges instead of duplicating.
 *
 * Usage: node tools/live-export-audit/seeds/square/seed.mjs [--orders 240] [--verify-only]
 *
 * Coverage, per Scratch table:
 * - locations: 2 extra locations (3 total) so the per-location walks (payments, payouts, invoices)
 *   and the 10-location batching of SearchOrders are exercised beyond the main location.
 * - catalog: 3 categories (one used as a reporting category), 2 taxes (additive + inclusive),
 *   2 discounts (percentage + fixed amount), a modifier list with 3 modifiers, and 10 items with
 *   1–3 variations each — unicode/RTL/CJK/emoji names, a ~4000-char description, a variable-priced
 *   variation (no price), SKUs, and an archived item.
 * - customers: 30 — every contact field, year-less birthdays (`0000-MM-DD`), a phone-only and a
 *   company-only customer, a >4000-char note with newlines/quotes/HTML entities.
 * - team members: 2, assigned to explicit locations.
 * - orders (default 240, so payments page past 100): spread over all 3 locations; COMPLETED via
 *   card / cash / external payments (some with tips), OPEN unpaid, DRAFT, and CANCELED; catalog
 *   and custom-amount line items, modifiers, order-level tax and discounts, ticket names, metadata.
 * - refunds: full and partial refunds of a slice of the card payments.
 * - invoices: 6 invoices on unpaid orders, 4 published and 2 left as drafts.
 * - gift cards: 4 digital cards with their activities — activated, loaded, one redeemed, one
 *   adjusted up, one deactivated — two of them linked to customers.
 * - subscriptions: one monthly plan, and 4 subscriptions to it — paid by card, invoiced by email,
 *   canceled, and starting in the future. Square creates their invoices and orders itself.
 * - payouts / payout entries: not seedable — the sandbox settles funds only on its own schedule.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const envText = readFileSync(join(repoRoot, 'local', 'audit-creds', 'square.env'), 'utf8');
const accessToken = envText.match(/^apiKey=(.*)$/m)?.[1]?.trim();
if (!accessToken) throw new Error('apiKey missing from local/audit-creds/square.env');

const SANDBOX_BASE_URL = 'https://connect.squareupsandbox.com';
const SQUARE_VERSION = '2026-09-16';
const VERIFY_ONLY = process.argv.includes('--verify-only');
const ORDER_COUNT = Number(process.argv[process.argv.indexOf('--orders') + 1]) || 240;

const log = (...parts) => console.error(new Date().toISOString().slice(11, 19), ...parts);

// ── HTTP ─────────────────────────────────────────────────────────────────────

let lastRequestStartedAt = 0;
async function square(method, path, body) {
  // ~8 requests/second, retrying on 429 with backoff (Square sends no Retry-After).
  const waitMs = Math.max(0, lastRequestStartedAt + 125 - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastRequestStartedAt = Date.now();

  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(SANDBOX_BASE_URL + path, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(json.errors ?? json).slice(0, 600)}`);
      error.status = response.status;
      throw error;
    }
    return json;
  }
  throw new Error(`${method} ${path}: rate-limited 6 times, giving up`);
}

async function listAllWithCursor(path, recordsKey, extraQuery = {}) {
  const records = [];
  let cursor;
  do {
    const query = new URLSearchParams({ ...extraQuery, ...(cursor ? { cursor } : {}) });
    const page = await square('GET', `${path}${query.size ? `?${query}` : ''}`);
    records.push(...(page[recordsKey] ?? []));
    cursor = page.cursor;
  } while (cursor);
  return records;
}

async function searchAllOrders(locationIds) {
  const orders = [];
  for (let start = 0; start < locationIds.length; start += 10) {
    let cursor;
    do {
      const page = await square('POST', '/v2/orders/search', {
        location_ids: locationIds.slice(start, start + 10),
        limit: 500,
        query: { filter: { state_filter: { states: ['OPEN', 'COMPLETED', 'CANCELED', 'DRAFT'] } } },
        ...(cursor ? { cursor } : {}),
      });
      orders.push(...(page.orders ?? []));
      cursor = page.cursor;
    } while (cursor);
  }
  return orders;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const LONG_TEXT_4000 = Array.from(
  { length: 80 },
  (_, index) => `Line ${index + 1}: “Candlelight” & <b>Vivaldi</b> — ünïcødé ✨ 日本語 مرحبا; commas, "quotes", tabs\tend.`,
)
  .join('\n')
  .slice(0, 4000);

const EXTRA_LOCATIONS = [
  {
    name: 'fable_qa Brooklyn Warehouse',
    description: 'Seeded by the Square Live Export audit — merch fulfilment.',
    address: { address_line_1: '55 Water St', locality: 'Brooklyn', administrative_district_level_1: 'NY', postal_code: '11201', country: 'US' },
    business_email: 'fable.qa+warehouse@example.com',
  },
  {
    name: 'fable_qa Café Ünïcødé ☕',
    description: 'Box office + bar. Name has accents and an emoji on purpose.',
    address: { address_line_1: '1 Ferry Building', address_line_2: 'Suite “B”', locality: 'San Francisco', administrative_district_level_1: 'CA', postal_code: '94111', country: 'US' },
  },
];

function catalogObjects(currency) {
  const money = (amount) => ({ amount, currency });
  const variation = (itemTempId, tempId, name, amount, sku) => ({
    type: 'ITEM_VARIATION',
    id: tempId,
    item_variation_data: {
      item_id: itemTempId,
      name,
      ...(amount === null ? { pricing_type: 'VARIABLE_PRICING' } : { pricing_type: 'FIXED_PRICING', price_money: money(amount) }),
      ...(sku ? { sku } : {}),
    },
  });
  const item = (tempId, name, { category, description, variations, modifierList, archived }) => ({
    type: 'ITEM',
    id: tempId,
    item_data: {
      name,
      ...(description ? { description } : {}),
      ...(category ? { categories: [{ id: category }], reporting_category: { id: category } } : {}),
      tax_ids: ['#tax-sales'],
      ...(modifierList ? { modifier_list_info: [{ modifier_list_id: modifierList, enabled: true }] } : {}),
      ...(archived ? { is_archived: true } : {}),
      variations: variations.map(([variationTempId, variationName, amount, sku]) =>
        variation(tempId, variationTempId, variationName, amount, sku),
      ),
    },
  });

  return [
    { type: 'CATEGORY', id: '#cat-tickets', category_data: { name: 'fable_qa Tickets 🎟️' } },
    { type: 'CATEGORY', id: '#cat-drinks', category_data: { name: 'fable_qa Drinks' } },
    { type: 'CATEGORY', id: '#cat-merch', category_data: { name: 'fable_qa Merch — limited "edition"' } },
    {
      type: 'TAX',
      id: '#tax-sales',
      tax_data: { name: 'fable_qa Sales Tax', calculation_phase: 'TAX_SUBTOTAL_PHASE', inclusion_type: 'ADDITIVE', percentage: '8.875', applies_to_custom_amounts: true, enabled: true },
    },
    {
      type: 'TAX',
      id: '#tax-inclusive',
      tax_data: { name: 'fable_qa GST (inclusive)', calculation_phase: 'TAX_SUBTOTAL_PHASE', inclusion_type: 'INCLUSIVE', percentage: '10', enabled: true },
    },
    { type: 'DISCOUNT', id: '#disc-percent', discount_data: { name: 'fable_qa 10% off', discount_type: 'FIXED_PERCENTAGE', percentage: '10.0' } },
    { type: 'DISCOUNT', id: '#disc-amount', discount_data: { name: 'fable_qa $5 off', discount_type: 'FIXED_AMOUNT', amount_money: money(500) } },
    {
      type: 'MODIFIER_LIST',
      id: '#ml-milk',
      modifier_list_data: {
        name: 'fable_qa Milk options',
        selection_type: 'SINGLE',
        modifiers: [
          { type: 'MODIFIER', id: '#mod-oat', modifier_data: { name: 'Oat milk', price_money: money(75) } },
          { type: 'MODIFIER', id: '#mod-almond', modifier_data: { name: 'Almond milk', price_money: money(50) } },
          { type: 'MODIFIER', id: '#mod-whole', modifier_data: { name: 'Whole milk', price_money: money(0) } },
        ],
      },
    },
    item('#item-vivaldi', 'fable_qa Candlelight: Vivaldi’s Four Seasons', {
      category: '#cat-tickets',
      description: LONG_TEXT_4000,
      variations: [
        ['#var-vivaldi-ga', 'General Admission', 4500, 'FQ-VIV-GA'],
        ['#var-vivaldi-premium', 'Premium', 8500, 'FQ-VIV-PREM'],
        ['#var-vivaldi-vip', 'VIP (front row)', 12000, 'FQ-VIV-VIP'],
      ],
    }),
    item('#item-queen', 'fable_qa Candlelight: Tribute to Queen 👑', {
      category: '#cat-tickets',
      variations: [
        ['#var-queen-ga', 'General Admission', 3900, 'FQ-QUE-GA'],
        ['#var-queen-premium', 'Premium', 6900, 'FQ-QUE-PREM'],
      ],
    }),
    item('#item-jazz', 'fable_qa 東京 Jazz Night — 日本語', {
      category: '#cat-tickets',
      variations: [['#var-jazz-ga', 'General Admission', 5500, 'FQ-JAZ-GA']],
    }),
    item('#item-arabic', 'fable_qa أمسية موسيقية (Arabic, RTL)', {
      category: '#cat-tickets',
      variations: [['#var-arabic-ga', 'General Admission', 3000, null]],
    }),
    item('#item-latte', 'fable_qa Latte', {
      category: '#cat-drinks',
      modifierList: '#ml-milk',
      variations: [
        ['#var-latte-small', 'Small', 450, 'FQ-LAT-S'],
        ['#var-latte-large', 'Large', 550, 'FQ-LAT-L'],
      ],
    }),
    item('#item-wine', 'fable_qa Glass of Wine 🍷', {
      category: '#cat-drinks',
      variations: [
        ['#var-wine-red', 'Red', 1200, 'FQ-WIN-R'],
        ['#var-wine-white', 'White', 1100, 'FQ-WIN-W'],
      ],
    }),
    item('#item-tshirt', 'fable_qa T-shirt, "Candlelight" logo', {
      category: '#cat-merch',
      variations: [
        ['#var-tshirt-s', 'S', 2500, 'FQ-TEE-S'],
        ['#var-tshirt-m', 'M', 2500, 'FQ-TEE-M'],
        ['#var-tshirt-l', 'L', 2800, 'FQ-TEE-L'],
      ],
    }),
    item('#item-program', 'fable_qa Printed Programme', {
      category: '#cat-merch',
      variations: [['#var-program', 'Regular', 800, 'FQ-PRG']],
    }),
    item('#item-donation', 'fable_qa Donation (pay what you want)', {
      variations: [['#var-donation', 'Any amount', null, null]],
    }),
    item('#item-retired', 'fable_qa Retired item (archived)', {
      category: '#cat-merch',
      archived: true,
      variations: [['#var-retired', 'Regular', 999, 'FQ-OLD']],
    }),
  ];
}

const CUSTOMER_FIXTURES = Array.from({ length: 30 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  const base = {
    reference_id: `fable_qa-customer-${number}`,
    given_name: ['Zoë', '王', 'محمد', 'Ana-María', 'Ólafur', 'Sam', 'Priya', 'Jean-Luc', 'Bertha', '🦄 Emoji'][index % 10],
    family_name: [`Tester ${number}`, '小明', 'العلي', "O'Brien", 'Þórsson', 'Smith', 'Natarajan', 'Picard', 'Doumat', 'Person'][index % 10],
    email_address: `fable.qa+customer${number}@example.com`,
    phone_number: `+1212555${String(1000 + index).slice(-4)}`,
    company_name: index % 3 === 0 ? `fable_qa Co ${number}, Ltd.` : undefined,
    address:
      index % 2 === 0
        ? { address_line_1: `${100 + index} Main St`, address_line_2: index % 4 === 0 ? 'Apt 4B' : undefined, locality: 'New York', administrative_district_level_1: 'NY', postal_code: '10001', country: 'US' }
        : undefined,
    birthday: index % 5 === 0 ? `0000-0${(index % 9) + 1}-15` : index % 5 === 1 ? `19${80 + (index % 20)}-12-31` : undefined,
    note: index === 7 ? LONG_TEXT_4000 : index % 4 === 1 ? `VIP — prefers “aisle” seats\nsecond line & <tags>` : undefined,
  };
  if (index === 28) return { reference_id: base.reference_id, phone_number: '+12125559999' }; // phone only
  if (index === 29) return { reference_id: base.reference_id, company_name: 'fable_qa Company Only Pty Ltd' }; // company only
  return base;
});

const TEAM_MEMBER_FIXTURES = [
  { reference_id: 'fable_qa-team-01', given_name: 'Box Office', family_name: 'Attendant', email_address: 'fable.qa+team01@example.com' },
  { reference_id: 'fable_qa-team-02', given_name: 'Bar', family_name: 'Tender ✨', email_address: 'fable.qa+team02@example.com' },
];

// ── Seeders ──────────────────────────────────────────────────────────────────

async function ensureLocations() {
  const existing = await listAllWithCursor('/v2/locations', 'locations');
  for (const fixture of EXTRA_LOCATIONS) {
    if (existing.some((location) => location.name === fixture.name)) continue;
    if (VERIFY_ONLY) continue;
    const { location } = await square('POST', '/v2/locations', { location: fixture });
    log('created location', location.id, fixture.name);
    existing.push(location);
  }
  return existing.sort((a, b) => a.id.localeCompare(b.id));
}

async function ensureCatalog(currency) {
  const existingItems = await listAllWithCursor('/v2/catalog/list', 'objects', { types: 'ITEM' });
  const alreadySeeded = existingItems.some((item) => item.item_data?.name?.startsWith('fable_qa '));
  if (!alreadySeeded && !VERIFY_ONLY) {
    const response = await square('POST', '/v2/catalog/batch-upsert', {
      idempotency_key: `fable_qa-catalog-${Date.now()}`,
      batches: [{ objects: catalogObjects(currency) }],
    });
    log('created catalog objects:', response.objects?.length ?? 0);
  }
  const allObjects = await listAllWithCursor('/v2/catalog/list', 'objects', {
    types: 'ITEM,ITEM_VARIATION,CATEGORY,TAX,DISCOUNT,MODIFIER_LIST',
  });
  const typeDataPropertyName = { CATEGORY: 'category_data', TAX: 'tax_data', DISCOUNT: 'discount_data', MODIFIER_LIST: 'modifier_list_data' };
  const fableQaObjectNamed = (type, name) =>
    allObjects.find((object) => object.type === type && object[typeDataPropertyName[type]]?.name === name);
  const variations = allObjects.filter(
    (object) =>
      object.type === 'ITEM_VARIATION' &&
      object.item_variation_data?.pricing_type === 'FIXED_PRICING' &&
      allObjects.some(
        (item) =>
          item.id === object.item_variation_data.item_id &&
          item.item_data?.name?.startsWith('fable_qa ') &&
          !item.item_data?.is_archived,
      ),
  );
  const milkList = fableQaObjectNamed('MODIFIER_LIST', 'fable_qa Milk options');
  return {
    variations,
    latteVariationIds: variations
      .filter((variation) => allObjects.find((item) => item.id === variation.item_variation_data.item_id)?.item_data?.name === 'fable_qa Latte')
      .map((variation) => variation.id),
    oatModifierId: milkList?.modifier_list_data?.modifiers?.find((modifier) => modifier.modifier_data?.name === 'Oat milk')?.id,
    salesTaxId: fableQaObjectNamed('TAX', 'fable_qa Sales Tax')?.id,
    percentDiscountId: fableQaObjectNamed('DISCOUNT', 'fable_qa 10% off')?.id,
    amountDiscountId: fableQaObjectNamed('DISCOUNT', 'fable_qa $5 off')?.id,
    counts: Object.fromEntries(
      ['ITEM', 'ITEM_VARIATION', 'CATEGORY', 'TAX', 'DISCOUNT', 'MODIFIER_LIST'].map((type) => [
        type,
        allObjects.filter((object) => object.type === type).length,
      ]),
    ),
  };
}

async function ensureCustomers() {
  const existing = await listAllWithCursor('/v2/customers', 'customers', { limit: '100' });
  const existingReferenceIds = new Set(existing.map((customer) => customer.reference_id));
  for (const fixture of CUSTOMER_FIXTURES) {
    if (existingReferenceIds.has(fixture.reference_id) || VERIFY_ONLY) continue;
    const body = JSON.parse(JSON.stringify(fixture)); // drops undefined fields
    const { customer } = await square('POST', '/v2/customers', { idempotency_key: `${fixture.reference_id}-v1`, ...body });
    existing.push(customer);
  }
  return existing.filter((customer) => customer.reference_id?.startsWith('fable_qa-customer-'));
}

async function ensureTeamMembers(locationIds) {
  const existing = [];
  let cursor;
  do {
    const page = await square('POST', '/v2/team-members/search', { limit: 100, ...(cursor ? { cursor } : {}) });
    existing.push(...(page.team_members ?? []));
    cursor = page.cursor;
  } while (cursor);
  for (const [index, fixture] of TEAM_MEMBER_FIXTURES.entries()) {
    if (existing.some((member) => member.reference_id === fixture.reference_id) || VERIFY_ONLY) continue;
    try {
      const { team_member: member } = await square('POST', '/v2/team-members', {
        idempotency_key: `${fixture.reference_id}-v1`,
        team_member: {
          ...fixture,
          assigned_locations: { assignment_type: 'EXPLICIT_LOCATIONS', location_ids: [locationIds[index % locationIds.length]] },
        },
      });
      existing.push(member);
    } catch (error) {
      log('WARN could not create team member', fixture.reference_id, '-', error.message);
    }
  }
  return existing;
}

/** What order #index should end up as. Deterministic, so re-runs converge. */
function orderPlan(index) {
  const slot = index % 20;
  const finalState = slot === 7 ? 'DRAFT' : slot === 13 ? 'OPEN' : slot === 17 ? 'CANCELED' : 'COMPLETED';
  const tender = ['CARD', 'CASH', 'EXTERNAL'][index % 3];
  return { finalState, tender, tipAmount: tender === 'CARD' && index % 4 === 0 ? 200 + (index % 7) * 25 : 0 };
}

function orderBody(index, { locationIds, catalog, customers, currency }) {
  const plan = orderPlan(index);
  const pick = (list, offset) => list[(index * 7 + offset) % list.length];
  const lineItems = [];
  const catalogLineCount = 1 + (index % 3);
  for (let line = 0; line < catalogLineCount; line++) {
    lineItems.push({ catalog_object_id: pick(catalog.variations, line * 3).id, quantity: String(1 + ((index + line) % 4)) });
  }
  if (index % 8 === 0 && catalog.latteVariationIds.length && catalog.oatModifierId) {
    lineItems.push({ catalog_object_id: catalog.latteVariationIds[0], quantity: '1', modifiers: [{ catalog_object_id: catalog.oatModifierId }] });
  }
  if (index % 5 === 0) {
    lineItems.push({ name: 'fable_qa custom amount — “misc”', quantity: '1', base_price_money: { amount: 1234 + index, currency } });
  }
  const discounts = [];
  if (index % 4 === 0 && catalog.percentDiscountId) discounts.push({ uid: 'fable-qa-percent', catalog_object_id: catalog.percentDiscountId, scope: 'ORDER' });
  if (index % 9 === 0 && catalog.amountDiscountId) discounts.push({ uid: 'fable-qa-amount', catalog_object_id: catalog.amountDiscountId, scope: 'ORDER' });
  const customer = index % 6 === 0 ? undefined : customers[index % customers.length];
  return {
    location_id: locationIds[index % locationIds.length],
    reference_id: `fable_qa-order-${String(index).padStart(4, '0')}`,
    ...(customer ? { customer_id: customer.id } : {}),
    ...(plan.finalState === 'DRAFT' ? { state: 'DRAFT' } : {}),
    ...(index % 10 === 3 ? { ticket_name: `Table ${index} — “window”` } : {}),
    line_items: lineItems,
    ...(catalog.salesTaxId ? { taxes: [{ uid: 'fable-qa-sales-tax', catalog_object_id: catalog.salesTaxId, scope: 'ORDER' }] } : {}),
    ...(discounts.length ? { discounts } : {}),
    metadata: { fable_qa_index: String(index), fable_qa_tender: plan.tender },
  };
}

async function payOrder(order, index, currency, teamMembers) {
  const plan = orderPlan(index);
  const amountDue = order.net_amount_due_money?.amount ?? order.total_money?.amount ?? 0;
  const amountMoney = { amount: amountDue, currency };
  const tender = {
    CARD: { source_id: 'cnon:card-nonce-ok', ...(plan.tipAmount ? { tip_money: { amount: plan.tipAmount, currency } } : {}) },
    CASH: { source_id: 'CASH', cash_details: { buyer_supplied_money: { amount: Math.ceil(amountDue / 1000) * 1000 || 1000, currency } } },
    EXTERNAL: { source_id: 'EXTERNAL', external_details: { type: 'OTHER', source: 'fable_qa box office voucher' } },
  }[plan.tender];
  const teamMember = teamMembers.find((member) => member.reference_id === 'fable_qa-team-01');
  return square('POST', '/v2/payments', {
    idempotency_key: `fable_qa-payment-${index}-v1`,
    amount_money: amountMoney,
    order_id: order.id,
    location_id: order.location_id,
    ...(order.customer_id ? { customer_id: order.customer_id } : {}),
    ...(teamMember && index % 2 === 0 ? { team_member_id: teamMember.id } : {}),
    reference_id: `fable_qa-payment-${index}`,
    note: index % 10 === 1 ? 'fable_qa note: “quoted”, comma, & ampersand\nsecond line' : undefined,
    autocomplete: true,
    ...tender,
  });
}

async function ensureOrdersAndPayments(context) {
  const existingOrders = await searchAllOrders(context.locationIds);
  const orderByReferenceId = new Map(existingOrders.map((order) => [order.reference_id, order]));
  let created = 0;
  let paid = 0;
  let canceled = 0;
  for (let index = 0; index < ORDER_COUNT; index++) {
    const plan = orderPlan(index);
    const referenceId = `fable_qa-order-${String(index).padStart(4, '0')}`;
    let order = orderByReferenceId.get(referenceId);
    if (VERIFY_ONLY) continue;
    try {
      if (!order) {
        ({ order } = await square('POST', '/v2/orders', {
          idempotency_key: `fable_qa-order-${index}-v1`,
          order: orderBody(index, context),
        }));
        created++;
      }
      if (plan.finalState === 'COMPLETED' && order.state === 'OPEN' && !(order.tenders?.length > 0)) {
        await payOrder(order, index, context.currency, context.teamMembers);
        paid++;
      } else if (plan.finalState === 'CANCELED' && order.state === 'OPEN') {
        await square('PUT', `/v2/orders/${order.id}`, {
          idempotency_key: `fable_qa-order-cancel-${index}-v1`,
          order: { location_id: order.location_id, version: order.version, state: 'CANCELED' },
        });
        canceled++;
      }
    } catch (error) {
      log('WARN order', referenceId, '-', error.message);
    }
    if ((index + 1) % 40 === 0) log(`orders: ${index + 1}/${ORDER_COUNT} (created ${created}, paid ${paid}, canceled ${canceled})`);
  }
  return { created, paid, canceled };
}

async function ensureRefunds(locationIds, currency) {
  const payments = [];
  for (const locationId of locationIds) {
    payments.push(
      ...(await listAllWithCursor('/v2/payments', 'payments', { location_id: locationId, begin_time: '2009-01-01T00:00:00Z', limit: '100' })),
    );
  }
  const cardPayments = payments
    .filter((payment) => payment.reference_id?.startsWith('fable_qa-payment-') && payment.source_type === 'CARD' && payment.status === 'COMPLETED')
    .sort((a, b) => a.reference_id.localeCompare(b.reference_id, undefined, { numeric: true }));
  let refunded = 0;
  for (const [position, payment] of cardPayments.entries()) {
    if (position % 6 !== 0 || VERIFY_ONLY) continue;
    if ((payment.refund_ids?.length ?? 0) > 0) continue;
    const isFullRefund = position % 12 === 0;
    const amount = isFullRefund ? payment.amount_money.amount : Math.max(1, Math.floor(payment.amount_money.amount / 2));
    try {
      await square('POST', '/v2/refunds', {
        idempotency_key: `fable_qa-refund-${payment.id}-v1`,
        payment_id: payment.id,
        amount_money: { amount, currency },
        reason: isFullRefund ? 'fable_qa: event cancelled — full refund' : 'fable_qa: partial refund, “seat moved”',
      });
      refunded++;
    } catch (error) {
      log('WARN refund', payment.id, '-', error.message);
    }
  }
  return { paymentCount: payments.length, refunded };
}

async function ensureInvoices(context) {
  const existingInvoices = [];
  for (const locationId of context.locationIds) {
    existingInvoices.push(...(await listAllWithCursor('/v2/invoices', 'invoices', { location_id: locationId, limit: '200' })));
  }
  const customersWithEmail = context.customers.filter((customer) => customer.email_address);
  let created = 0;
  for (let index = 0; index < 6; index++) {
    const invoiceNumber = `fable_qa-${String(index + 1).padStart(4, '0')}`;
    if (existingInvoices.some((invoice) => invoice.invoice_number === invoiceNumber) || VERIFY_ONLY) continue;
    const customer = customersWithEmail[index % customersWithEmail.length];
    const locationId = context.locationIds[index % context.locationIds.length];
    try {
      const { order } = await square('POST', '/v2/orders', {
        idempotency_key: `fable_qa-invoice-order-${index}-v1`,
        order: {
          location_id: locationId,
          reference_id: `fable_qa-invoice-order-${index}`,
          customer_id: customer.id,
          line_items: [
            { catalog_object_id: context.catalog.variations[index % context.catalog.variations.length].id, quantity: String(index + 1) },
            { name: 'fable_qa private event fee', quantity: '1', base_price_money: { amount: 25000 + index * 100, currency: context.currency } },
          ],
        },
      });
      const dueDate = new Date(Date.now() + (index + 1) * 7 * 86400000).toISOString().slice(0, 10);
      const { invoice } = await square('POST', '/v2/invoices', {
        idempotency_key: `fable_qa-invoice-${index}-v1`,
        invoice: {
          location_id: locationId,
          order_id: order.id,
          primary_recipient: { customer_id: customer.id },
          payment_requests: [{ request_type: 'BALANCE', due_date: dueDate }],
          delivery_method: 'SHARE_MANUALLY',
          accepted_payment_methods: { card: true },
          invoice_number: invoiceNumber,
          title: index === 2 ? 'fable_qa Invoice — 日本語 & “quotes”' : `fable_qa Private event #${index + 1}`,
          description: index === 3 ? LONG_TEXT_4000.slice(0, 1000) : 'Seeded by the Square Live Export audit.',
          sale_or_service_date: new Date(Date.now() - index * 86400000).toISOString().slice(0, 10),
        },
      });
      if (index < 4) {
        await square('POST', `/v2/invoices/${invoice.id}/publish`, { idempotency_key: `fable_qa-invoice-publish-${index}-v1`, version: invoice.version });
      }
      created++;
    } catch (error) {
      log('WARN invoice', invoiceNumber, '-', error.message);
    }
  }
  return { created };
}

// ── Gift cards ───────────────────────────────────────────────────────────────

const GIFT_CARD_COUNT = 4;

async function ensureGiftCards(locationIds, currency, customers) {
  if (VERIFY_ONLY) return { created: 0 };
  const existing = await listAllWithCursor('/v2/gift-cards', 'gift_cards', { limit: '200' });
  let created = 0;
  // Gift cards carry no name to match on, so the count is what converges.
  for (let index = existing.length; index < GIFT_CARD_COUNT; index++) {
    const locationId = locationIds[index % locationIds.length];
    const { gift_card: giftCard } = await square('POST', '/v2/gift-cards', {
      idempotency_key: `fable_qa-gift-card-${index}-v1`,
      location_id: locationId,
      gift_card: { type: 'DIGITAL' },
    });
    const recordActivity = (type, details) =>
      square('POST', '/v2/gift-cards/activities', {
        idempotency_key: `fable_qa-gift-card-${index}-${type}-v1`,
        gift_card_activity: { type, location_id: locationId, gift_card_id: giftCard.id, ...details },
      });
    const externalPayment = { buyer_payment_instrument_ids: ['fable_qa-external-payment'] };
    await recordActivity('ACTIVATE', {
      activate_activity_details: {
        amount_money: { amount: 5000 + index * 1000, currency },
        reference_id: `fable_qa-gift-card-${index}`,
        ...externalPayment,
      },
    });
    if (index !== 3) {
      await recordActivity('LOAD', { load_activity_details: { amount_money: { amount: 2500, currency }, ...externalPayment } });
    }
    if (index === 1) {
      await recordActivity('REDEEM', {
        redeem_activity_details: { amount_money: { amount: 1234, currency }, reference_id: 'fable_qa-redemption' },
      });
    }
    if (index === 2) {
      await recordActivity('ADJUST_INCREMENT', {
        adjust_increment_activity_details: { amount_money: { amount: 500, currency }, reason: 'COMPLIMENTARY' },
      });
    }
    if (index === 3) {
      await recordActivity('DEACTIVATE', { deactivate_activity_details: { reason: 'SUSPICIOUS_ACTIVITY' } });
    }
    if (index < 2) {
      await square('POST', `/v2/gift-cards/${giftCard.id}/link-customer`, { customer_id: customers[index].id });
    }
    created++;
  }
  return { created };
}

// ── Subscriptions ────────────────────────────────────────────────────────────

const SUBSCRIPTION_PLAN_NAME = 'fable_qa Membership';
const SUBSCRIPTION_PLAN_VARIATION_NAME = 'fable_qa Monthly Membership';

async function ensureSubscriptionPlanVariation(currency) {
  const existing = await listAllWithCursor('/v2/catalog/list', 'objects', {
    types: 'SUBSCRIPTION_PLAN,SUBSCRIPTION_PLAN_VARIATION',
  });
  const existingVariation = existing.find(
    (object) =>
      object.type === 'SUBSCRIPTION_PLAN_VARIATION' &&
      object.subscription_plan_variation_data?.name === SUBSCRIPTION_PLAN_VARIATION_NAME,
  );
  if (existingVariation) return existingVariation;
  const plan =
    existing.find((object) => object.type === 'SUBSCRIPTION_PLAN' && object.subscription_plan_data?.name === SUBSCRIPTION_PLAN_NAME) ??
    (
      await square('POST', '/v2/catalog/object', {
        idempotency_key: 'fable_qa-subscription-plan-v1',
        object: { type: 'SUBSCRIPTION_PLAN', id: '#plan', subscription_plan_data: { name: SUBSCRIPTION_PLAN_NAME } },
      })
    ).catalog_object;
  const { catalog_object: variation } = await square('POST', '/v2/catalog/object', {
    idempotency_key: 'fable_qa-subscription-plan-variation-v1',
    object: {
      type: 'SUBSCRIPTION_PLAN_VARIATION',
      id: '#variation',
      subscription_plan_variation_data: {
        name: SUBSCRIPTION_PLAN_VARIATION_NAME,
        subscription_plan_id: plan.id,
        phases: [{ cadence: 'MONTHLY', ordinal: 0, pricing: { type: 'STATIC', price_money: { amount: 1500, currency } } }],
      },
    },
  });
  return variation;
}

async function searchAllSubscriptions() {
  const subscriptions = [];
  let cursor;
  do {
    const page = await square('POST', '/v2/subscriptions/search', { limit: 100, ...(cursor ? { cursor } : {}) });
    subscriptions.push(...(page.subscriptions ?? []));
    cursor = page.cursor;
  } while (cursor);
  return subscriptions;
}

async function ensureSubscriptions(locationIds, currency, customers) {
  if (VERIFY_ONLY) return { created: 0 };
  const planVariation = await ensureSubscriptionPlanVariation(currency);
  const existing = await searchAllSubscriptions();
  // Invoiced subscriptions email the customer, so every subscriber needs an email address.
  const subscribers = customers.filter((customer) => customer.email_address).slice(2, 6);
  const inThirtyDays = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const fixtures = [
    { key: 'card', subscriber: subscribers[0], payByCard: true },
    { key: 'invoice', subscriber: subscribers[1], payByCard: false },
    { key: 'canceled', subscriber: subscribers[2], payByCard: true, cancel: true },
    { key: 'future', subscriber: subscribers[3], payByCard: false, startDate: inThirtyDays },
  ];
  let created = 0;
  for (const fixture of fixtures) {
    const alreadySubscribed = existing.some(
      (subscription) =>
        subscription.customer_id === fixture.subscriber.id && subscription.plan_variation_id === planVariation.id,
    );
    if (alreadySubscribed) continue;
    let cardId;
    if (fixture.payByCard) {
      const { cards } = await square('GET', `/v2/cards?customer_id=${fixture.subscriber.id}`);
      cardId =
        cards?.[0]?.id ??
        (
          await square('POST', '/v2/cards', {
            idempotency_key: `fable_qa-subscription-card-${fixture.key}-v1`,
            // Square's sandbox test nonce for a card that always succeeds.
            source_id: 'cnon:card-nonce-ok',
            card: { customer_id: fixture.subscriber.id, cardholder_name: fixture.subscriber.given_name ?? 'fable_qa' },
          })
        ).card.id;
    }
    const { subscription } = await square('POST', '/v2/subscriptions', {
      idempotency_key: `fable_qa-subscription-${fixture.key}-v1`,
      location_id: locationIds[0],
      plan_variation_id: planVariation.id,
      customer_id: fixture.subscriber.id,
      ...(cardId ? { card_id: cardId } : {}),
      ...(fixture.startDate ? { start_date: fixture.startDate } : {}),
    });
    if (fixture.cancel) await square('POST', `/v2/subscriptions/${subscription.id}/cancel`);
    created++;
  }
  return { created };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const locations = await ensureLocations();
const locationIds = locations.map((location) => location.id);
const currency = locations.find((location) => location.currency)?.currency ?? 'USD';
log(`locations: ${locations.length} (${currency})`);

const catalog = await ensureCatalog(currency);
log('catalog:', JSON.stringify(catalog.counts), `— ${catalog.variations.length} priced fable_qa variations`);

const customers = await ensureCustomers();
log(`customers: ${customers.length} fable_qa`);

const teamMembers = await ensureTeamMembers(locationIds);
log(`team members: ${teamMembers.length}`);

const orderResult = await ensureOrdersAndPayments({ locationIds, catalog, customers, currency, teamMembers });
log('orders this run:', JSON.stringify(orderResult));

const refundResult = await ensureRefunds(locationIds, currency);
log('refunds this run:', JSON.stringify(refundResult));

const invoiceResult = await ensureInvoices({ locationIds, catalog, customers, currency });
log('invoices this run:', JSON.stringify(invoiceResult));

const giftCardResult = await ensureGiftCards(locationIds, currency, customers);
log('gift cards this run:', JSON.stringify(giftCardResult));

const subscriptionResult = await ensureSubscriptions(locationIds, currency, customers);
log('subscriptions this run:', JSON.stringify(subscriptionResult));

// Final read-back, through the same endpoints the connector uses.
const finalOrders = await searchAllOrders(locationIds);
const stateCounts = finalOrders.reduce((counts, order) => ({ ...counts, [order.state]: (counts[order.state] ?? 0) + 1 }), {});
const finalRefunds = await listAllWithCursor('/v2/refunds', 'refunds', { begin_time: '2009-01-01T00:00:00Z', limit: '100' });
const finalInvoices = [];
for (const locationId of locationIds) {
  finalInvoices.push(...(await listAllWithCursor('/v2/invoices', 'invoices', { location_id: locationId, limit: '200' })));
}
console.log(
  JSON.stringify(
    {
      locations: locations.length,
      catalog: catalog.counts,
      customers: customers.length,
      teamMembers: teamMembers.length,
      orders: { total: finalOrders.length, byState: stateCounts },
      payments: refundResult.paymentCount,
      refunds: finalRefunds.length,
      invoices: finalInvoices.length,
      giftCards: (await listAllWithCursor('/v2/gift-cards', 'gift_cards', { limit: '200' })).length,
      giftCardActivities: (
        await listAllWithCursor('/v2/gift-cards/activities', 'gift_card_activities', {
          begin_time: '2009-01-01T00:00:00Z',
          end_time: '2100-01-01T00:00:00Z',
          limit: '100',
        })
      ).length,
      subscriptions: (await searchAllSubscriptions()).length,
    },
    null,
    2,
  ),
);
