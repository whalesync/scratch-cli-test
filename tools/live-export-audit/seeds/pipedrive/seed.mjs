#!/usr/bin/env node
/**
 * Idempotent torture-data seeder for the PIPEDRIVE Live Export audit
 * (/test-live-export). Creates/updates `fable_qa_*` custom fields and records on
 * a BURNER Pipedrive account; re-runs upsert rather than duplicate.
 *
 * Usage: node tools/live-export-audit/seeds/pipedrive/seed.mjs [--verify-only]
 * Credentials: local/audit-creds/pipedrive.env → apiKey=...
 *
 * Coverage (see LIVE_EXPORT_AUDIT.md for the table rationale):
 * - deals: every custom-field type Pipedrive offers, system monetary value,
 *   won/lost status, long text (2001 / >4000 chars), extreme numbers/dates,
 *   enum/set with 0/1/3 selections (labels contain commas/quotes/unicode),
 *   FKs → persons/organizations (exported) and stage/pipeline (NOT exported).
 * - persons: multi-value emails/phones (0/1/3, labels with commas), birthday
 *   1900-01-01, unicode names, org_id FK, 210 pagination records.
 * - organizations: system address composite, unicode, custom people FK → persons.
 * - leads: v1 UUID entity, value {amount,currency}, label_ids, flat custom fields.
 * - notes: HTML content (bold/italic/link/list/img/code), >4000-char body,
 *   parents deal/person/org/lead, pinned flags.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const envText = readFileSync(join(repoRoot, 'local', 'audit-creds', 'pipedrive.env'), 'utf8');
const apiKey = envText.match(/^apiKey=(.*)$/m)?.[1]?.trim();
if (!apiKey) throw new Error('apiKey missing from local/audit-creds/pipedrive.env');

const BASE = 'https://api.pipedrive.com';
const VERIFY_ONLY = process.argv.includes('--verify-only');

let lastRequestAt = 0;
async function api(method, path, body) {
  // Throttle to ~4 req/s; retry on 429.
  const now = Date.now();
  const wait = Math.max(0, lastRequestAt + 250 - now);
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'x-api-token': apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const retryAfterSeconds = parseInt(res.headers.get('retry-after') ?? '2', 10) || 2;
      await new Promise((r) => setTimeout(r, retryAfterSeconds * 1000));
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }
  throw new Error(`${method} ${path}: rate-limited 6x, giving up`);
}

/** Page through a v2 cursor list endpoint. */
async function listAllV2(path) {
  const out = [];
  let cursor;
  do {
    const q = `${path}${path.includes('?') ? '&' : '?'}limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await api('GET', q);
    out.push(...(res.data ?? []));
    cursor = res.additional_data?.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

/** Page through a v1 offset list endpoint. */
async function listAllV1(path) {
  const out = [];
  let start = 0;
  for (;;) {
    const q = `${path}${path.includes('?') ? '&' : '?'}limit=500&start=${start}`;
    const res = await api('GET', q);
    out.push(...(res.data ?? []));
    const pag = res.additional_data?.pagination;
    if (!pag?.more_items_in_collection) break;
    start = pag.next_start;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Custom fields (v1 *Fields endpoints create; shapes read back on v2)
// ---------------------------------------------------------------------------

const DEAL_FIELD_DEFS = [
  { name: 'fable_qa_varchar', field_type: 'varchar' },
  { name: 'fable_qa_text', field_type: 'text' },
  { name: 'fable_qa_double', field_type: 'double' },
  { name: 'fable_qa_monetary', field_type: 'monetary' },
  { name: 'fable_qa_date', field_type: 'date' },
  { name: 'fable_qa_daterange', field_type: 'daterange' },
  { name: 'fable_qa_time', field_type: 'time' },
  { name: 'fable_qa_timerange', field_type: 'timerange' },
  { name: 'fable_qa_enum', field_type: 'enum', options: [{ label: 'Opt A' }, { label: 'Opt, B' }, { label: 'émoji 🚀 opt' }] },
  {
    name: 'fable_qa_set',
    field_type: 'set',
    options: [{ label: 'Tag One' }, { label: 'Tag, Two' }, { label: '"Quoted" Tag' }, { label: '多语言标签' }],
  },
  { name: 'fable_qa_address', field_type: 'address' },
  { name: 'fable_qa_phone', field_type: 'phone' },
  { name: 'fable_qa_org', field_type: 'org' },
  { name: 'fable_qa_people', field_type: 'people' },
];
const PERSON_FIELD_DEFS = [
  { name: 'fable_qa_p_set', field_type: 'set', options: [{ label: 'P One' }, { label: 'P Two' }, { label: 'P Three' }] },
  { name: 'fable_qa_p_date', field_type: 'date' },
];
const ORG_FIELD_DEFS = [
  { name: 'fable_qa_o_text', field_type: 'text' },
  { name: 'fable_qa_o_people', field_type: 'people' },
];

async function ensureCustomFields(fieldsEndpoint, defs) {
  const existing = await listAllV1(`/v1/${fieldsEndpoint}`);
  const byName = new Map(existing.map((f) => [f.name, f]));
  const keyByName = {};
  for (const def of defs) {
    let field = byName.get(def.name);
    if (!field && !VERIFY_ONLY) {
      const created = await api('POST', `/v1/${fieldsEndpoint}`, def);
      field = created.data;
      console.log(`  created ${fieldsEndpoint} field ${def.name} (${def.field_type}) key=${field.key}`);
    }
    if (!field) throw new Error(`field ${def.name} missing on ${fieldsEndpoint}`);
    keyByName[def.name] = field.key;
    // Options carry ids we need for enum/set writes.
    if (field.options) keyByName[`${def.name}__options`] = field.options;
  }
  return keyByName;
}

// ---------------------------------------------------------------------------
// 2. Record upsert helpers
// ---------------------------------------------------------------------------

async function upsertV2(collection, existingByName, name, payload) {
  const found = existingByName.get(name);
  if (VERIFY_ONLY) return found;
  if (found) {
    const res = await api('PATCH', `/api/v2/${collection}/${found.id}`, payload);
    return res.data;
  }
  const res = await api('POST', `/api/v2/${collection}`, payload);
  console.log(`  created ${collection} "${name}" id=${res.data.id}`);
  return res.data;
}

const LONG_2001 = 'A'.repeat(1000) + ' α— ' + 'B'.repeat(996) + 'E';
if (LONG_2001.length !== 2001) throw new Error(`LONG_2001 is ${LONG_2001.length}`);
const LONG_4500 = ('Lorem ipsum dolor sit amet, ω-consectetur "adipiscing" elit — <b>4500</b>.\n'.repeat(62) + 'X'.repeat(64)).slice(0, 4500);
const UNICODE_TORTURE = '🚀汉字 عربي ℤ​zero​width "quotes" <b>&amp;</b>\tTAB';

async function main() {
  console.log('== fields ==');
  const dealKeys = await ensureCustomFields('dealFields', DEAL_FIELD_DEFS);
  const personKeys = await ensureCustomFields('personFields', PERSON_FIELD_DEFS);
  const orgKeys = await ensureCustomFields('organizationFields', ORG_FIELD_DEFS);

  const enumOptions = dealKeys['fable_qa_enum__options'] ?? [];
  const setOptions = dealKeys['fable_qa_set__options'] ?? [];
  const personSetOptions = personKeys['fable_qa_p_set__options'] ?? [];
  const optionId = (options, label) => {
    const opt = options.find((o) => o.label === label);
    if (!opt) throw new Error(`option ${label} not found in ${JSON.stringify(options)}`);
    return opt.id;
  };

  // -------------------------------------------------------------------------
  console.log('== organizations ==');
  const orgsExisting = new Map((await listAllV2('/api/v2/organizations')).map((o) => [o.name, o]));
  const orgAlpha = await upsertV2('organizations', orgsExisting, 'fable_qa_org_alpha', { name: 'fable_qa_org_alpha' });
  const orgBeta = await upsertV2('organizations', orgsExisting, 'fable_qa_org_beta', { name: 'fable_qa_org_beta' });
  const orgUnicode = await upsertV2('organizations', orgsExisting, 'fable_qa_org_九龍 مؤسسة 🚀', {
    name: 'fable_qa_org_九龍 مؤسسة 🚀',
  });
  const orgEmpty = await upsertV2('organizations', orgsExisting, 'fable_qa_org_empty', { name: 'fable_qa_org_empty' });
  const orgAddr = await upsertV2('organizations', orgsExisting, 'fable_qa_org_addr', {
    name: 'fable_qa_org_addr',
    address: { value: '1600 Amphitheatre Parkway, Mountain View, CA 94043, USA' },
  });

  // -------------------------------------------------------------------------
  console.log('== persons ==');
  const personsExistingList = await listAllV2('/api/v2/persons');
  const personsExisting = new Map(personsExistingList.map((p) => [p.name, p]));

  const personEmpty = await upsertV2('persons', personsExisting, 'fable_qa_person_empty', {
    name: 'fable_qa_person_empty',
  });
  const personUnicode = await upsertV2('persons', personsExisting, `fable_qa_person_${UNICODE_TORTURE}`, {
    name: `fable_qa_person_${UNICODE_TORTURE}`,
  });
  const personEmails = await upsertV2('persons', personsExisting, 'fable_qa_person_emails3', {
    name: 'fable_qa_person_emails3',
    emails: [
      { value: 'fable.qa+one@example.com', label: 'work', primary: true },
      { value: 'fable_qa.two@example.com', label: 'home, secondary', primary: false },
      { value: 'fable-qa-three@sub.example.co.jp', label: 'その他', primary: false },
    ],
    phones: [{ value: '+1 (555) 010-0001', label: 'work', primary: true }],
  });
  const personPhones = await upsertV2('persons', personsExisting, 'fable_qa_person_phones', {
    name: 'fable_qa_person_phones',
    phones: [
      { value: '+44 20 7946 0958', label: 'work', primary: true },
      { value: '555-0102;ext=42', label: 'ext, comma', primary: false },
      { value: '+81-3-0000-0000', label: '携帯', primary: false },
    ],
  });
  // `birthday` writes are 403 on this account (contact sync disabled), so the
  // extreme-past date lives in the custom person date field instead.
  const personBirthday = await upsertV2('persons', personsExisting, 'fable_qa_person_birthday', {
    name: 'fable_qa_person_birthday',
    custom_fields: { [personKeys['fable_qa_p_date']]: '1900-01-01' },
  });
  const personOrg = await upsertV2('persons', personsExisting, 'fable_qa_person_org', {
    name: 'fable_qa_person_org',
    org_id: orgAlpha.id,
    custom_fields: {
      [personKeys['fable_qa_p_set']]: [optionId(personSetOptions, 'P One'), optionId(personSetOptions, 'P Three')],
      [personKeys['fable_qa_p_date']]: '2031-02-28',
    },
  });
  const personTarget = await upsertV2('persons', personsExisting, 'fable_qa_person_target', {
    name: 'fable_qa_person_target',
    org_id: orgBeta.id,
  });

  // Pagination fleet: 210 minimal persons.
  const fleetNames = Array.from({ length: 210 }, (_, i) => `fable_qa_person_p${String(i + 1).padStart(3, '0')}`);
  let fleetCreated = 0;
  for (const name of fleetNames) {
    if (!personsExisting.has(name)) {
      if (VERIFY_ONLY) throw new Error(`missing fleet person ${name}`);
      const res = await api('POST', '/api/v2/persons', { name });
      personsExisting.set(name, res.data);
      fleetCreated++;
    }
  }
  console.log(`  pagination fleet: ${fleetNames.length} total, ${fleetCreated} newly created`);

  // Point the org custom-people FK at a person (orgs → persons direction).
  await upsertV2('organizations', orgsExisting, 'fable_qa_org_alpha', {
    name: 'fable_qa_org_alpha',
    custom_fields: {
      [orgKeys['fable_qa_o_text']]: 'line one\nline two\t"quoted, comma" &amp; <i>html</i>',
      [orgKeys['fable_qa_o_people']]: personOrg.id,
    },
  });

  // -------------------------------------------------------------------------
  console.log('== deals ==');
  // Stage/pipeline FK-out-of-export case: use whatever stages exist (default pipeline).
  const stages = await listAllV2('/api/v2/stages');
  if (stages.length === 0) throw new Error('no stages in account');
  const secondStage = stages[Math.min(1, stages.length - 1)];

  const dealsExisting = new Map((await listAllV2('/api/v2/deals')).map((d) => [d.title, d]));
  const cf = (obj) => ({ custom_fields: obj });

  await upsertV2('deals', dealsExisting, 'fable_qa_deal_empty', { title: 'fable_qa_deal_empty' });
  await upsertV2('deals', dealsExisting, `fable_qa_deal_${UNICODE_TORTURE}`, {
    title: `fable_qa_deal_${UNICODE_TORTURE}`,
    ...cf({ [dealKeys['fable_qa_varchar']]: UNICODE_TORTURE }),
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_longtext_2001', {
    title: 'fable_qa_deal_longtext_2001',
    ...cf({ [dealKeys['fable_qa_text']]: LONG_2001 }),
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_longtext_4500', {
    title: 'fable_qa_deal_longtext_4500',
    ...cf({ [dealKeys['fable_qa_text']]: LONG_4500, [dealKeys['fable_qa_varchar']]: 'x'.repeat(255) }),
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_numbers', {
    title: 'fable_qa_deal_numbers',
    value: 0,
    currency: 'USD',
    // probability omitted — rejected unless deal probability is enabled on the pipeline
    ...cf({
      [dealKeys['fable_qa_double']]: 0.30000000000000004,
      [dealKeys['fable_qa_monetary']]: { value: 1234567.89, currency: 'EUR' },
    }),
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_bignum', {
    title: 'fable_qa_deal_bignum',
    value: 98765432.1,
    currency: 'JPY',
    ...cf({ [dealKeys['fable_qa_double']]: 9007199254740993 }),
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_negative', {
    title: 'fable_qa_deal_negative',
    value: -123.45,
    currency: 'USD',
    ...cf({ [dealKeys['fable_qa_double']]: -0.001, [dealKeys['fable_qa_monetary']]: { value: -999.99, currency: 'GBP' } }),
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_dates', {
    title: 'fable_qa_deal_dates',
    expected_close_date: '2999-12-31',
    ...cf({
      [dealKeys['fable_qa_date']]: '1900-01-01',
      // v2 write shape for range fields is {value, until} (probed live; a
      // {start_date,end_date} object is rejected with ERR_SCHEMA_VALIDATION_FAILED).
      [dealKeys['fable_qa_daterange']]: { value: '2026-01-01', until: '2026-12-31' },
      [dealKeys['fable_qa_time']]: { value: '23:59:59' },
      [dealKeys['fable_qa_timerange']]: { value: '09:00:00', until: '17:30:00' },
    }),
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_enumset0', {
    title: 'fable_qa_deal_enumset0',
    // Pipedrive rejects `[]` for a set field ("Use null to clear the field"),
    // so the zero-element case is null — the API's own empty representation.
    ...cf({ [dealKeys['fable_qa_set']]: null }),
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_enumset1', {
    title: 'fable_qa_deal_enumset1',
    ...cf({
      [dealKeys['fable_qa_enum']]: optionId(enumOptions, 'Opt, B'),
      [dealKeys['fable_qa_set']]: [optionId(setOptions, 'Tag One')],
    }),
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_enumset3', {
    title: 'fable_qa_deal_enumset3',
    ...cf({
      [dealKeys['fable_qa_enum']]: optionId(enumOptions, 'émoji 🚀 opt'),
      [dealKeys['fable_qa_set']]: [
        optionId(setOptions, 'Tag, Two'),
        optionId(setOptions, '"Quoted" Tag'),
        optionId(setOptions, '多语言标签'),
      ],
    }),
  });
  const dealLinked = await upsertV2('deals', dealsExisting, 'fable_qa_deal_linked', {
    title: 'fable_qa_deal_linked',
    org_id: orgAlpha.id,
    person_id: personOrg.id,
    stage_id: secondStage.id,
    ...cf({ [dealKeys['fable_qa_org']]: orgBeta.id, [dealKeys['fable_qa_people']]: personTarget.id }),
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_won', {
    title: 'fable_qa_deal_won',
    value: 5000,
    currency: 'USD',
    status: 'won',
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_lost', {
    title: 'fable_qa_deal_lost',
    status: 'lost',
    lost_reason: 'fable_qa: lost for "reasons, many"',
  });
  await upsertV2('deals', dealsExisting, 'fable_qa_deal_addr_phone', {
    title: 'fable_qa_deal_addr_phone',
    ...cf({
      [dealKeys['fable_qa_address']]: { value: 'Plaza de España, 28008 Madrid, Spain' },
      [dealKeys['fable_qa_phone']]: '+34 915 000 000',
    }),
  });

  // -------------------------------------------------------------------------
  console.log('== leads ==');
  const leadLabels = (await api('GET', '/v1/leadLabels')).data ?? [];
  const leadsExisting = new Map((await listAllV1('/v1/leads?archived_status=all')).map((l) => [l.title, l]));
  const upsertLead = async (title, payload) => {
    const found = leadsExisting.get(title);
    if (VERIFY_ONLY) return found;
    if (found) return (await api('PATCH', `/v1/leads/${found.id}`, payload)).data;
    const res = await api('POST', '/v1/leads', { title, ...payload });
    console.log(`  created lead "${title}" id=${res.data.id}`);
    return res.data;
  };

  const leadFull = await upsertLead('fable_qa_lead_full', {
    person_id: personEmails.id,
    value: { amount: 42000.5, currency: 'EUR' },
    expected_close_date: '2027-06-30',
    label_ids: leadLabels.slice(0, 2).map((l) => l.id),
    [dealKeys['fable_qa_varchar']]: 'lead flat custom varchar, with "quotes"',
    [dealKeys['fable_qa_double']]: 3.14159265358979,
    [dealKeys['fable_qa_date']]: '2026-02-29',
  });
  await upsertLead('fable_qa_lead_unicode 🚀九龍 عربي', { person_id: personUnicode.id });
  await upsertLead('fable_qa_lead_org', { organization_id: orgUnicode.id });
  await upsertLead('fable_qa_lead_min', { person_id: personEmpty.id });

  // -------------------------------------------------------------------------
  console.log('== notes ==');
  const notesExisting = await listAllV1('/v1/notes');
  const noteByMarker = (marker) => notesExisting.find((n) => (n.content ?? '').includes(marker));
  const upsertNote = async (marker, payload) => {
    const found = noteByMarker(marker);
    if (VERIFY_ONLY) return found;
    if (found) return (await api('PUT', `/v1/notes/${found.id}`, payload)).data;
    const res = await api('POST', '/v1/notes', payload);
    console.log(`  created note ${marker} id=${res.data.id}`);
    return res.data;
  };

  await upsertNote('fable_qa_note_rich', {
    deal_id: dealLinked.id,
    content:
      '<p>fable_qa_note_rich</p><h1>Heading 1</h1><h2>Heading 2</h2><p><b>bold</b> <i>italic</i> <u>underline</u> ' +
      '<a href="https://example.com/fable?a=1&b=2">a link</a></p><ul><li>one</li><li>two, with comma</li></ul>' +
      '<ol><li>first</li><li>"second"</li></ol><img src="https://static.scratch.md/connector-icons/pipedrive.svg" alt="img">' +
      '<pre><code>const x = "code block"; // 🚀</code></pre>',
  });
  await upsertNote('fable_qa_note_long', {
    person_id: personEmails.id,
    content: `<p>fable_qa_note_long</p><p>${LONG_4500.replaceAll('<b>', '&lt;b&gt;')}</p>`,
  });
  await upsertNote('fable_qa_note_unicode', {
    org_id: orgUnicode.id,
    content: `<p>fable_qa_note_unicode ${UNICODE_TORTURE.replaceAll('<', '&lt;')}</p><p>line2\nline3</p>`,
  });
  await upsertNote('fable_qa_note_lead', { lead_id: leadFull.id, content: '<p>fable_qa_note_lead on a lead</p>' });
  await upsertNote('fable_qa_note_pinned', {
    deal_id: dealLinked.id,
    pinned_to_deal_flag: 1,
    content: '<p>fable_qa_note_pinned — plain-ish text</p>',
  });

  // -------------------------------------------------------------------------
  console.log('== read-back verification ==');
  const dealsNow = (await listAllV2('/api/v2/deals')).filter((d) => d.title.startsWith('fable_qa_'));
  const personsNow = (await listAllV2('/api/v2/persons')).filter((p) => p.name.startsWith('fable_qa_'));
  const orgsNow = (await listAllV2('/api/v2/organizations')).filter((o) => o.name.startsWith('fable_qa_'));
  const leadsNow = (await listAllV1('/v1/leads')).filter((l) => l.title.startsWith('fable_qa_'));
  const notesNow = (await listAllV1('/v1/notes')).filter((n) => (n.content ?? '').includes('fable_qa_note_'));

  const summary = {
    deals: dealsNow.length,
    persons: personsNow.length,
    organizations: orgsNow.length,
    leads: leadsNow.length,
    notes: notesNow.length,
  };
  console.log(JSON.stringify(summary));

  const assert = (cond, msg) => {
    if (!cond) throw new Error(`VERIFY FAIL: ${msg}`);
  };
  assert(summary.deals >= 15, `deals ${summary.deals} < 15`);
  assert(summary.persons >= 217, `persons ${summary.persons} < 217`);
  assert(summary.organizations >= 5, `organizations ${summary.organizations} < 5`);
  assert(summary.leads >= 4, `leads ${summary.leads} < 4`);
  assert(summary.notes >= 5, `notes ${summary.notes} < 5`);

  const longDeal = dealsNow.find((d) => d.title === 'fable_qa_deal_longtext_2001');
  assert(longDeal?.custom_fields?.[dealKeys['fable_qa_text']]?.length === 2001, 'longtext_2001 custom text length');
  const enum3 = dealsNow.find((d) => d.title === 'fable_qa_deal_enumset3');
  assert((enum3?.custom_fields?.[dealKeys['fable_qa_set']] ?? []).length === 3, 'enumset3 has 3 set values');
  const linked = dealsNow.find((d) => d.title === 'fable_qa_deal_linked');
  assert(linked?.org_id === orgAlpha.id && linked?.person_id === personOrg.id, 'deal_linked FK ids');
  const emailsPerson = personsNow.find((p) => p.name === 'fable_qa_person_emails3');
  assert((emailsPerson?.emails ?? []).length === 3, 'person_emails3 has 3 emails');
  const leadFullNow = leadsNow.find((l) => l.title === 'fable_qa_lead_full');
  assert(leadFullNow?.value?.amount === 42000.5, 'lead_full monetary amount');
  console.log('VERIFY OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
