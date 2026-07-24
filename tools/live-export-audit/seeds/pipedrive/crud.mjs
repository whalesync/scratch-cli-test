#!/usr/bin/env node
/**
 * Phase-4 CRUD pass for the PIPEDRIVE Live Export audit: one round of
 * source-side changes done via Pipedrive's own API, replayed into each
 * destination workbook with `audit.mjs --workbook <wkb> --rerun`.
 *
 * Actions (idempotent-ish — safe to run once per audit round):
 *   - edit fable_qa_deal_longtext_2001: append marker to fable_qa_text (long-text edit)
 *     and retitle to fable_qa_deal_longtext_2001 (unchanged) with updated varchar marker
 *   - edit fable_qa_person_emails3: change primary email + name suffix
 *   - create fable_qa_deal_crud_created
 *   - delete fable_qa_deal_lost
 *
 * Usage: node tools/live-export-audit/seeds/pipedrive/crud.mjs [--round <n>]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const envText = readFileSync(join(repoRoot, 'local', 'audit-creds', 'pipedrive.env'), 'utf8');
const apiKey = envText.match(/^apiKey=(.*)$/m)?.[1]?.trim();
if (!apiKey) throw new Error('apiKey missing');

const round = process.argv.includes('--round') ? process.argv[process.argv.indexOf('--round') + 1] : '1';
const BASE = 'https://api.pipedrive.com';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'x-api-token': apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

async function listAllV2(path) {
  const out = [];
  let cursor;
  do {
    const q = `${path}?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await api('GET', q);
    out.push(...(res.data ?? []));
    cursor = res.additional_data?.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

const deals = await listAllV2('/api/v2/deals');
const persons = await listAllV2('/api/v2/persons');
const byTitle = (t) => deals.find((d) => d.title === t);

const dealFields = (await api('GET', '/v1/dealFields?limit=500')).data;
const textKey = dealFields.find((f) => f.name === 'fable_qa_text')?.key;
const varcharKey = dealFields.find((f) => f.name === 'fable_qa_varchar')?.key;
if (!textKey || !varcharKey) throw new Error('fable_qa deal fields missing');

// 1. Edit touching a long-text field.
const longDeal = byTitle('fable_qa_deal_longtext_2001');
if (!longDeal) throw new Error('fable_qa_deal_longtext_2001 not found');
const currentText = longDeal.custom_fields?.[textKey] ?? '';
const strippedText = currentText.replace(/ \[crud-r\d+\]$/, '');
await api('PATCH', `/api/v2/deals/${longDeal.id}`, {
  custom_fields: { [textKey]: `${strippedText} [crud-r${round}]`, [varcharKey]: `edited in crud round ${round}` },
});
console.log(`edited deal ${longDeal.id} (longtext + varchar marker r${round})`);

// 2. Edit a person: primary email + name marker.
const person = persons.find((p) => p.name.startsWith('fable_qa_person_emails3'));
if (!person) throw new Error('fable_qa_person_emails3 not found');
await api('PATCH', `/api/v2/persons/${person.id}`, {
  name: `fable_qa_person_emails3 (crud r${round})`,
  emails: [
    { value: `fable.qa+crud${round}@example.com`, label: 'work', primary: true },
    { value: 'fable_qa.two@example.com', label: 'home, secondary', primary: false },
  ],
});
console.log(`edited person ${person.id} (emails + name r${round})`);

// 3. Create.
const createdTitle = `fable_qa_deal_crud_created_r${round}`;
if (!byTitle(createdTitle)) {
  const created = await api('POST', '/api/v2/deals', {
    title: createdTitle,
    value: 777.77,
    currency: 'USD',
    custom_fields: { [varcharKey]: `created in crud round ${round} 🚀` },
  });
  console.log(`created deal ${created.data.id} "${createdTitle}"`);
} else {
  console.log(`create skipped — "${createdTitle}" already exists`);
}

// 4. Delete.
const toDelete = byTitle('fable_qa_deal_lost');
if (toDelete) {
  await api('DELETE', `/api/v2/deals/${toDelete.id}`);
  console.log(`deleted deal ${toDelete.id} "fable_qa_deal_lost"`);
} else {
  console.log('delete skipped — fable_qa_deal_lost already gone');
}
console.log('CRUD round complete');
