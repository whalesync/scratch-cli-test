// Seed the Attio CRM-cleanup demo baseline (DEV-10438).
//
// Full teardown + recreate (NOT an in-place upsert): the demo structurally mutates the graph
// (deletes loser companies, repoints FKs), so the only reliable reset is to delete the demo's
// own records and rebuild them, re-wiring the People/Deal foreign keys by fixture key -> fresh
// Attio record id each run. Attio has no slug-uniqueness trap (unlike Webflow), so
// delete+recreate is clean.
//
// SCOPING: teardown deletes ONLY records whose name is in the fixture name sets. It never does
// a blanket "delete all companies", so it can't touch real workspace data or the Attio
// integration-test suite's records that share this workspace.
//
// No AI is involved here — this is deterministic, deliberately-flawed baseline content (blank
// industry/location to enrich; duplicate clusters to merge). The live demo is where the AI
// enriches + merges on top.
//
// Run:  node demos/attio-crm-cleanup/seed.ts

import { fileURLToPath } from 'node:url';
import {
  attio_value,
  create_record,
  delete_record,
  list_workspace_members,
  query_all_records,
  record_id,
  type AttioRecord,
  type AttioValues,
} from '../shared/attio.ts';
import { COMPANIES_OBJECT_SLUG, DEALS_OBJECT_SLUG, PEOPLE_OBJECT_SLUG } from './constants.ts';
import {
  ALL_DEMO_COMPANY_NAMES,
  ALL_DEMO_DEAL_NAMES,
  ALL_DEMO_PERSON_NAMES,
  ALL_SEEDED_COMPANIES,
  DEMO_DEALS,
  DEMO_PEOPLE,
  type SeededCompany,
} from './fixtures.ts';

// Attio stores a company/deal name under `name[0].value` and a person's under `name[0].full_name`.
const company_or_deal_name = (record: AttioRecord): string => String((record.values?.name?.[0] as any)?.value ?? '');
const person_full_name = (record: AttioRecord): string => String((record.values?.name?.[0] as any)?.full_name ?? '');

// Delete every demo-owned record (matched by name against the fixtures). Idempotent: a fresh
// workspace deletes nothing. Deals + People first, then Companies (tidy; the order isn't
// required — Attio auto-clears references to a deleted record).
async function teardown_demo_records(): Promise<{ companies: number; people: number; deals: number }> {
  const [companies, people, deals] = await Promise.all([
    query_all_records(COMPANIES_OBJECT_SLUG),
    query_all_records(PEOPLE_OBJECT_SLUG),
    query_all_records(DEALS_OBJECT_SLUG),
  ]);

  const demo_deals = deals.filter((record) => ALL_DEMO_DEAL_NAMES.has(company_or_deal_name(record)));
  const demo_people = people.filter((record) => ALL_DEMO_PERSON_NAMES.has(person_full_name(record)));
  const demo_companies = companies.filter((record) => ALL_DEMO_COMPANY_NAMES.has(company_or_deal_name(record)));

  for (const record of demo_deals) await delete_record(DEALS_OBJECT_SLUG, record_id(record));
  for (const record of demo_people) await delete_record(PEOPLE_OBJECT_SLUG, record_id(record));
  for (const record of demo_companies) await delete_record(COMPANIES_OBJECT_SLUG, record_id(record));

  return { companies: demo_companies.length, people: demo_people.length, deals: demo_deals.length };
}

function company_seed_values(company: SeededCompany): AttioValues {
  // name + domain (survivors/standalones) + any one "combine" field a loser carries.
  // Industry (`categories`) and location (`primary_location`) are LEFT BLANK on purpose —
  // the enrich beat fills them from the domain.
  const values: AttioValues = { name: attio_value.text(company.name) };
  if (company.domain) values.domains = attio_value.domain(company.domain);
  if (company.employee_range) values.employee_range = attio_value.select(company.employee_range);
  if (company.funding_raised_usd != null) values.funding_raised_usd = attio_value.currency(company.funding_raised_usd);
  if (company.foundation_date) values.foundation_date = attio_value.date(company.foundation_date);
  return values;
}

async function seed_demo_crm_data(): Promise<void> {
  console.log('== Attio CRM-cleanup demo: seed baseline ==\n');

  const removed = await teardown_demo_records();
  console.log(`Teardown (idempotent): removed companies=${removed.companies} people=${removed.people} deals=${removed.deals}`);

  const members = await list_workspace_members();
  const owner_actor_id = members[0]?.id?.workspace_member_id;
  if (!owner_actor_id) throw new Error('No Attio workspace member found to own the seeded deals.');

  // 1. Companies — build fixture key -> fresh Attio record id for FK wiring.
  const company_id_by_key = new Map<string, string>();
  for (const company of ALL_SEEDED_COMPANIES) {
    const created = await create_record(COMPANIES_OBJECT_SLUG, company_seed_values(company));
    company_id_by_key.set(company.key, record_id(created));
  }
  console.log(`Created ${company_id_by_key.size} companies (${ALL_SEEDED_COMPANIES.length} fixtures).`);

  const resolve_company = (company_key: string): string => {
    const id = company_id_by_key.get(company_key);
    if (!id) throw new Error(`Fixture references unknown company_key "${company_key}"`);
    return id;
  };

  // 2. People — most point at loser variants (the FK "teeth" the merge has to rescue).
  let people_created = 0;
  for (const person of DEMO_PEOPLE) {
    await create_record(PEOPLE_OBJECT_SLUG, {
      name: attio_value.personal_name(person.first_name, person.last_name),
      job_title: attio_value.text(person.job_title),
      company: attio_value.record_reference(COMPANIES_OBJECT_SLUG, resolve_company(person.company_key)),
    });
    people_created += 1;
  }
  console.log(`Created ${people_created} people.`);

  // 3. Deals — most point at loser variants too. `owner` + `stage` are required on create.
  let deals_created = 0;
  for (const deal of DEMO_DEALS) {
    await create_record(DEALS_OBJECT_SLUG, {
      name: attio_value.text(deal.name),
      stage: attio_value.status(deal.stage),
      owner: attio_value.actor_reference(owner_actor_id),
      value: attio_value.currency(deal.value_usd),
      associated_company: attio_value.record_reference(COMPANIES_OBJECT_SLUG, resolve_company(deal.company_key)),
    });
    deals_created += 1;
  }
  console.log(`Created ${deals_created} deals.`);

  console.log('\nSeed complete. Flawed baseline in Attio: blank industry/location to enrich, duplicate clusters to merge.');
}

const this_module_is_run_directly = process.argv[1] === fileURLToPath(import.meta.url);
if (this_module_is_run_directly) {
  await seed_demo_crm_data();
}

export { seed_demo_crm_data, teardown_demo_records };
