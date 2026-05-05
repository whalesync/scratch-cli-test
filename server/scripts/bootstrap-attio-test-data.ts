/**
 * Bootstrap a small set of test data in an Attio workspace, so the
 * integration spec at server/test/integration/attio-connector.spec.ts can
 * exercise the list-pull code path end-to-end.
 *
 * This script is idempotent — every step checks for existing state first and
 * only creates what's missing. Re-running it is safe and a no-op if the
 * workspace is already bootstrapped.
 *
 * What it creates (all named with a `Spinner Test` / `spinner_test_` prefix
 * so they're easy to find and delete in the Attio UI later):
 *
 *   - On each of `companies`, `people`, `deals`: one custom attribute per
 *               universal field type — `spinner_test_<type>_field`, types
 *               text/number/checkbox/rating/select/date/currency. These are
 *               what the CRUD round-trip tests write to so every object's
 *               test record exercises every writable field type.
 *   - 3 companies : "Spinner Test Company 1/2/3"
 *   - 3 people    : "Spinner Test Person 1/2/3" (full_name)
 *   - 3 deals     : "Spinner Test Deal 1/2/3"
 *   - One list : api_slug `spinner_test_pipeline`, parent_object `deals`
 *   - One attr : api_slug `spinner_test_stage`, type `select`, options
 *                Lead / Qualified / Negotiating / Closed
 *   - 3 entries on the list pointing at the seeded deals, each tagged with a
 *                different stage
 *
 * Object-specific types (personal-name, status, actor-reference, email,
 * phone, domain, record-reference, location) are tested via the *system*
 * built-ins where they naturally live (e.g. people.name for personal-name,
 * deals.stage for status). No custom provisioning needed for those.
 *
 * Requires ATTIO_API_KEY in server/.env.integration (with read+write scopes
 * on objects, lists, and list entries).
 *
 * Run from server/:   npx ts-node scripts/bootstrap-attio-test-data.ts
 *
 * Cleanup (manual):   delete the list in the Attio UI, or
 *                     curl -X DELETE -H "Authorization: Bearer $ATTIO_API_KEY" \
 *                       https://api.attio.com/v2/lists/spinner_test_pipeline
 */

import axios, { AxiosInstance, isAxiosError } from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

const LIST_SLUG = 'spinner_test_pipeline';
const LIST_NAME = 'Spinner Test Pipeline';
const PARENT_OBJECT = 'deals';
const STAGE_ATTR_SLUG = 'spinner_test_stage';
const STAGE_ATTR_TITLE = 'Spinner Test Stage';
const STAGE_OPTIONS = ['Lead', 'Qualified', 'Negotiating', 'Closed'] as const;
const TARGET_ENTRY_COUNT = 3;
const DEAL_NAME_PREFIX = 'Spinner Test Deal';
const COMPANY_NAME_PREFIX = 'Spinner Test Company';
const PERSON_NAME_PREFIX = 'Spinner Test Person';

const STANDARD_OBJECTS = ['companies', 'people', 'deals'] as const;
type StandardObject = (typeof STANDARD_OBJECTS)[number];

/**
 * Universal field types — those we ensure exist as a custom attribute on
 * every standard object. The api_slug / title are derived as
 * `spinner_test_<type>_field` / `Spinner Test <Type>` so they're consistent
 * across all three objects, which keeps the round-trip test logic symmetric.
 *
 * `select` carries a fixed set of options too — provisioned the same way as
 * the list-scoped stage attribute (separate /options endpoint).
 */
const UNIVERSAL_TYPES = ['text', 'number', 'checkbox', 'rating', 'select', 'date', 'currency'] as const;
type UniversalType = (typeof UNIVERSAL_TYPES)[number];

const UNIVERSAL_SELECT_OPTIONS = ['Alpha', 'Beta', 'Gamma'] as const;

/**
 * Type-specific config payloads for `POST .../attributes`. Most types take an
 * empty config; rating and currency need a couple of knobs set.
 */
function configForType(type: UniversalType): Record<string, unknown> {
  switch (type) {
    case 'rating':
      // Attio ratings cap at 5 in the UI; the API accepts higher but 5 is the
      // canonical bounds.
      return { rating: { max_value: 5 } };
    case 'currency':
      return { currency: { default_currency_code: 'USD', display_type: 'symbol' } };
    default:
      return {};
  }
}

function customAttrSlug(type: UniversalType): string {
  return `spinner_test_${type.replace(/-/g, '_')}_field`;
}

function customAttrTitle(type: UniversalType): string {
  // Capitalize first letter, leave the rest.
  return `Spinner Test ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

interface AttioEnvelope<T> {
  data: T;
}

interface AttioSelf {
  workspace_id: string;
  workspace_name: string;
  authorized_by_workspace_member_id: string | null;
}

interface AttioList {
  id: { workspace_id: string; list_id: string };
  api_slug: string;
  name: string;
  parent_object: string[];
}

interface AttioAttribute {
  id: { workspace_id: string; attribute_id: string };
  api_slug: string;
  title: string;
  type: string;
}

interface AttioOption {
  id: { workspace_id: string; option_id: string };
  title: string;
}

interface AttioRecordIdTriple {
  workspace_id: string;
  object_id: string;
  record_id: string;
}

interface AttioRecord {
  id: AttioRecordIdTriple;
  values: Record<string, unknown[]>;
}

interface AttioListEntry {
  id: { workspace_id: string; list_id: string; entry_id: string };
  parent_record_id: string;
  parent_object: string;
  entry_values: Record<string, unknown[]>;
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(__dirname, '../.env.integration') });
  const apiKey = process.env.ATTIO_API_KEY;
  if (!apiKey) {
    console.error('ATTIO_API_KEY is not set in server/.env.integration');
    process.exit(1);
  }

  const http = axios.create({
    baseURL: 'https://api.attio.com',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeout: 30_000,
  });

  console.log('• Validating token...');
  // `/v2/self` returns the body unwrapped — no `data` envelope, unlike most
  // other v2 endpoints.
  const self = await http.get<AttioSelf>('/v2/self');
  const ownerMemberId = self.data.authorized_by_workspace_member_id;
  if (!ownerMemberId) {
    console.error('  Token is not associated with a workspace member — cannot satisfy `owner` on deals.');
    process.exit(1);
  }
  console.log(`  workspace=${self.data.workspace_name} owner=${ownerMemberId}`);

  console.log(`• Ensuring universal custom attributes exist on ${STANDARD_OBJECTS.join(', ')}...`);
  for (const objectSlug of STANDARD_OBJECTS) {
    await ensureUniversalCustomAttributes(http, objectSlug);
  }

  console.log(`• Ensuring list "${LIST_SLUG}" exists (parent: ${PARENT_OBJECT})...`);
  const list = await ensureList(http);
  console.log(`  list_id=${list.id.list_id}`);

  console.log(`• Ensuring attribute "${STAGE_ATTR_SLUG}" exists on the list...`);
  await ensureStageAttribute(http);

  console.log(`• Ensuring stage options exist on the attribute...`);
  await ensureStageOptions(http);

  console.log(`• Ensuring ${TARGET_ENTRY_COUNT} sample companies exist...`);
  await ensureSampleCompanies(http);

  console.log(`• Ensuring ${TARGET_ENTRY_COUNT} sample people exist...`);
  await ensureSamplePeople(http);

  console.log(`• Ensuring ${TARGET_ENTRY_COUNT} sample ${PARENT_OBJECT} records exist...`);
  const deals = await ensureSampleDeals(http, ownerMemberId);

  console.log(`• Ensuring entries exist on the list for the sample records...`);
  const existing = await listExistingEntries(http);
  const existingByParent = new Set(existing.map((e) => e.parent_record_id));

  for (let i = 0; i < deals.length; i++) {
    const deal = deals[i];
    const stage = STAGE_OPTIONS[i % STAGE_OPTIONS.length];
    if (existingByParent.has(deal.id.record_id)) {
      console.log(`  ${deal.id.record_id} → already an entry, skipping`);
      continue;
    }
    await createEntry(http, deal.id.record_id, stage);
    console.log(`  ${deal.id.record_id} → entry created with stage="${stage}"`);
  }

  console.log('Done. Re-run the integration spec to exercise the list path.');
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function ensureList(http: AxiosInstance): Promise<AttioList> {
  const response = await http.get<AttioEnvelope<AttioList[]>>('/v2/lists');
  const existing = response.data.data.find((l) => l.api_slug === LIST_SLUG);
  if (existing) {
    console.log('  found existing list — skipping create');
    return existing;
  }

  const created = await http.post<AttioEnvelope<AttioList>>('/v2/lists', {
    data: {
      name: LIST_NAME,
      api_slug: LIST_SLUG,
      parent_object: PARENT_OBJECT,
      workspace_access: 'full-access',
      workspace_member_access: [],
    },
  });
  console.log('  list created');
  return created.data.data;
}

async function ensureStageAttribute(http: AxiosInstance): Promise<AttioAttribute> {
  const response = await http.get<AttioEnvelope<AttioAttribute[]>>(`/v2/lists/${LIST_SLUG}/attributes`);
  const existing = response.data.data.find((a) => a.api_slug === STAGE_ATTR_SLUG);
  if (existing) {
    console.log('  found existing attribute — skipping create');
    return existing;
  }

  // Options for `select` attributes are managed separately via the
  // `/options` subresource — the create-attribute payload doesn't accept them
  // (it accepts the field but silently ignores it). See `ensureStageOptions`.
  const created = await http.post<AttioEnvelope<AttioAttribute>>(`/v2/lists/${LIST_SLUG}/attributes`, {
    data: {
      title: STAGE_ATTR_TITLE,
      description: 'Pipeline stage — created by the Spinner integration test bootstrap.',
      api_slug: STAGE_ATTR_SLUG,
      type: 'select',
      is_required: false,
      is_unique: false,
      is_multiselect: false,
      default_value: null,
      config: {},
    },
  });
  console.log('  attribute created');
  return created.data.data;
}

/**
 * Ensure `TARGET_ENTRY_COUNT` deals named `Spinner Test Deal N` exist. Looks
 * for them by their `name` value first; only creates the ones that aren't
 * already there. Returns the records in name-order so the caller can map
 * them to stages deterministically.
 */
/**
 * Ensure every universal field type has a custom attribute on the given
 * object. Idempotent — checks the existing attribute set first, only creates
 * what's missing. Also reconciles options on `select` attributes.
 */
async function ensureUniversalCustomAttributes(http: AxiosInstance, objectSlug: StandardObject): Promise<void> {
  const response = await http.get<AttioEnvelope<AttioAttribute[]>>(`/v2/objects/${objectSlug}/attributes`);
  const existingBySlug = new Map(response.data.data.map((a) => [a.api_slug, a] as const));

  for (const type of UNIVERSAL_TYPES) {
    const slug = customAttrSlug(type);
    if (existingBySlug.has(slug)) {
      console.log(`  ${objectSlug}.${slug} → already exists`);
    } else {
      await http.post<AttioEnvelope<AttioAttribute>>(`/v2/objects/${objectSlug}/attributes`, {
        data: {
          title: customAttrTitle(type),
          description: `Custom ${type} attribute for round-trip test coverage.`,
          api_slug: slug,
          type,
          is_required: false,
          is_unique: false,
          is_multiselect: false,
          default_value: null,
          config: configForType(type),
        },
      });
      console.log(`  ${objectSlug}.${slug} → created`);
    }

    // `select` needs its options provisioned via the /options subresource —
    // same gotcha as `ensureStageOptions` on the list. Run this whether the
    // attribute was just created or already existed, so re-running adds any
    // new desired options without duplicating existing ones.
    if (type === 'select') {
      await ensureObjectSelectOptions(http, objectSlug, slug);
    }
  }
}

async function ensureObjectSelectOptions(
  http: AxiosInstance,
  objectSlug: StandardObject,
  attrSlug: string,
): Promise<void> {
  const response = await http.get<AttioEnvelope<AttioOption[]>>(
    `/v2/objects/${objectSlug}/attributes/${attrSlug}/options`,
  );
  const existingTitles = new Set(response.data.data.map((o) => o.title));
  for (const title of UNIVERSAL_SELECT_OPTIONS) {
    if (existingTitles.has(title)) continue;
    await http.post<AttioEnvelope<AttioOption>>(`/v2/objects/${objectSlug}/attributes/${attrSlug}/options`, {
      data: { title },
    });
    console.log(`  ${objectSlug}.${attrSlug} option "${title}" → created`);
  }
}

/**
 * Attio's `select` attribute creation accepts a `config.select.options` array
 * but silently ignores it — options have to be added one at a time via
 * `POST /v2/lists/{list}/attributes/{attr}/options`. This step reconciles the
 * desired option set against whatever's currently there, adding what's missing.
 */
async function ensureStageOptions(http: AxiosInstance): Promise<void> {
  const response = await http.get<AttioEnvelope<AttioOption[]>>(
    `/v2/lists/${LIST_SLUG}/attributes/${STAGE_ATTR_SLUG}/options`,
  );
  const existingTitles = new Set(response.data.data.map((o) => o.title));

  for (const title of STAGE_OPTIONS) {
    if (existingTitles.has(title)) {
      console.log(`  ${title} → already exists, skipping`);
      continue;
    }
    await http.post<AttioEnvelope<AttioOption>>(`/v2/lists/${LIST_SLUG}/attributes/${STAGE_ATTR_SLUG}/options`, {
      data: { title },
    });
    console.log(`  ${title} → option created`);
  }
}

/**
 * Ensure `TARGET_ENTRY_COUNT` companies named `Spinner Test Company N` exist.
 * Companies have no required attributes, so we just need a name (text shape).
 */
async function ensureSampleCompanies(http: AxiosInstance): Promise<AttioRecord[]> {
  const wanted = Array.from({ length: TARGET_ENTRY_COUNT }, (_, i) => `${COMPANY_NAME_PREFIX} ${i + 1}`);

  const response = await http.post<AttioEnvelope<AttioRecord[]>>('/v2/objects/companies/records/query', {
    limit: 500,
    offset: 0,
  });
  const existingByName = new Map<string, AttioRecord>();
  for (const record of response.data.data) {
    const name = readNameValue(record);
    if (name && wanted.includes(name)) existingByName.set(name, record);
  }

  const ordered: AttioRecord[] = [];
  for (const name of wanted) {
    const found = existingByName.get(name);
    if (found) {
      console.log(`  ${name} → already exists, skipping`);
      ordered.push(found);
      continue;
    }
    const created = await http.post<AttioEnvelope<AttioRecord>>('/v2/objects/companies/records', {
      data: { values: { name: [{ value: name }] } },
    });
    console.log(`  ${name} → created (record_id=${created.data.data.id.record_id})`);
    ordered.push(created.data.data);
  }
  return ordered;
}

/**
 * Ensure `TARGET_ENTRY_COUNT` people named `Spinner Test Person N` exist.
 * People's `name` attribute is `personal-name` (not text), so the value shape
 * is `{ first_name, last_name, full_name }`.
 */
async function ensureSamplePeople(http: AxiosInstance): Promise<AttioRecord[]> {
  const targets = Array.from({ length: TARGET_ENTRY_COUNT }, (_, i) => ({
    fullName: `${PERSON_NAME_PREFIX} ${i + 1}`,
    firstName: 'Spinner',
    lastName: `TestPerson${i + 1}`,
  }));

  const response = await http.post<AttioEnvelope<AttioRecord[]>>('/v2/objects/people/records/query', {
    limit: 500,
    offset: 0,
  });
  const existingByFullName = new Map<string, AttioRecord>();
  for (const record of response.data.data) {
    const fullName = readNameValue(record);
    if (fullName) existingByFullName.set(fullName, record);
  }

  const ordered: AttioRecord[] = [];
  for (const target of targets) {
    const found = existingByFullName.get(target.fullName);
    if (found) {
      console.log(`  ${target.fullName} → already exists, skipping`);
      ordered.push(found);
      continue;
    }
    const created = await http.post<AttioEnvelope<AttioRecord>>('/v2/objects/people/records', {
      data: {
        values: {
          name: [{ first_name: target.firstName, last_name: target.lastName, full_name: target.fullName }],
        },
      },
    });
    console.log(`  ${target.fullName} → created (record_id=${created.data.data.id.record_id})`);
    ordered.push(created.data.data);
  }
  return ordered;
}

async function ensureSampleDeals(http: AxiosInstance, ownerMemberId: string): Promise<AttioRecord[]> {
  const wanted = Array.from({ length: TARGET_ENTRY_COUNT }, (_, i) => `${DEAL_NAME_PREFIX} ${i + 1}`);

  // Fetch the first 500 deals — assumes the workspace isn't huge. If it ever
  // grows beyond that we'd switch to a server-side filter, but at that point
  // the bootstrap is overkill anyway.
  const response = await http.post<AttioEnvelope<AttioRecord[]>>(`/v2/objects/${PARENT_OBJECT}/records/query`, {
    limit: 500,
    offset: 0,
  });
  const existingByName = new Map<string, AttioRecord>();
  for (const deal of response.data.data) {
    const name = readNameValue(deal);
    if (name && wanted.includes(name)) existingByName.set(name, deal);
  }

  const ordered: AttioRecord[] = [];
  for (const name of wanted) {
    const found = existingByName.get(name);
    if (found) {
      console.log(`  ${name} → already exists, skipping`);
      ordered.push(found);
      continue;
    }
    const created = await createDeal(http, name, ownerMemberId);
    console.log(`  ${name} → created (record_id=${created.id.record_id})`);
    ordered.push(created);
  }
  return ordered;
}

/**
 * The `deals` object has three required attributes — `name`, `stage`, and
 * `owner` — so we have to provide all three on creation. Stage is set by the
 * status `title` (Attio's default workspace ships with "Lead"); owner is an
 * actor reference to the workspace member who issued the token.
 */
async function createDeal(http: AxiosInstance, name: string, ownerMemberId: string): Promise<AttioRecord> {
  const response = await http.post<AttioEnvelope<AttioRecord>>(`/v2/objects/${PARENT_OBJECT}/records`, {
    data: {
      values: {
        name: [{ value: name }],
        stage: [{ status: 'Lead' }],
        owner: [{ referenced_actor_type: 'workspace-member', referenced_actor_id: ownerMemberId }],
      },
    },
  });
  return response.data.data;
}

/**
 * Pull a string `name` value out of a record. Attio returns names as either
 * `[{ value: "..." }]` (text) or `[{ full_name: "..." }]` (personal-name) —
 * deals use the text shape but we check both for resilience.
 */
function readNameValue(record: AttioRecord): string | undefined {
  const values = record.values?.name;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const first = values[0] as Record<string, unknown>;
  if (typeof first.value === 'string') return first.value;
  if (typeof first.full_name === 'string') return first.full_name;
  return undefined;
}

async function listExistingEntries(http: AxiosInstance): Promise<AttioListEntry[]> {
  const response = await http.post<AttioEnvelope<AttioListEntry[]>>(`/v2/lists/${LIST_SLUG}/entries/query`, {
    limit: 500,
    offset: 0,
  });
  return response.data.data;
}

async function createEntry(http: AxiosInstance, parentRecordId: string, stage: string): Promise<void> {
  await http.post<AttioEnvelope<AttioListEntry>>(`/v2/lists/${LIST_SLUG}/entries`, {
    data: {
      parent_record_id: parentRecordId,
      parent_object: PARENT_OBJECT,
      entry_values: {
        // `select` values are written by their option title (a plain string),
        // not by the object shape that the API returns on read.
        [STAGE_ATTR_SLUG]: [{ option: stage }],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

main().catch((error: unknown) => {
  if (isAxiosError(error)) {
    console.error('\nAttio API error:');
    console.error(`  ${error.response?.status ?? '?'} ${error.config?.method?.toUpperCase()} ${error.config?.url}`);
    console.error(`  ${JSON.stringify(error.response?.data, null, 2)}`);
  } else if (error instanceof Error) {
    console.error(`\n${error.message}`);
  } else {
    console.error('\nUnknown error', error);
  }
  process.exit(1);
});
