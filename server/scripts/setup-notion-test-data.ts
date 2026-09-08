/**
 * Provision the Notion databases + sample data that the Notion connector
 * integration tests need, so `server/test/integration/notion-connector.spec.ts`
 * (and, with a parent page, `notion-create-schema.spec.ts`) can run end-to-end.
 * This is the automated form of the manual steps in
 * `server/test/integration/notion-setup.md`.
 *
 * What it creates under a root page you own (all discovered by exact title, so
 * the specs find them):
 *
 *   - Database "Scratch Integration Test Linked" (title `Name`) + rows
 *     `Linked A` / `Linked B` / `Linked C` — the relation target.
 *   - Database "Scratch Integration Test" with every property the specs assert:
 *     Name (title), Description (rich_text), Priority (select), Tags
 *     (multi_select), Estimate (number), Due Date (date), Done (checkbox),
 *     Owner Email (email), Link (url), Linked Items (relation → the Linked DB),
 *     Attachments (files), Linked Count (rollup over Linked Items), Score
 *     (formula `length(prop("Name"))`), and Status.
 *   - 3 seed rows (Done true/false + Priority mix, as the smoke filter tests
 *     require) plus the preserved `[Do Not Touch] Roundtrip Fixture` row
 *     (Done=false, Priority=Low — load-bearing for those same filters).
 *
 * Idempotent: every step looks the resource up by title first and only creates
 * what's missing, so re-running is safe.
 *
 * ── The one property the API can't create ──
 * Notion's public API cannot create a `status`-type property (it's UI-only).
 * The script tries anyway; if Notion rejects it, it falls back to creating
 * `Status` as a `select` so the suite still runs, and prints a WARNING. For
 * true status-type fidelity in the snapshot, delete that select and add a real
 * Status property in the Notion UI.
 *
 * ── Prerequisites (one-time, in the Notion UI) ──
 *   1. Create the internal integration + API key (notion-setup.md step 2).
 *   2. Create a page to hold the test databases and SHARE it with the
 *      integration (••• → Connections → add it). Child databases inherit that
 *      connection, so nothing else needs sharing. Copy that page's id.
 *
 * ── Run (from server/) ──
 *   npx ts-node scripts/setup-notion-test-data.ts <rootPageId> [apiKey]
 * Both fall back to server/.env.integration: rootPageId ← NOTION_TEST_PARENT_PAGE_ID,
 * apiKey ← NOTION_API_KEY. Passing the key on the CLI leaks it into shell
 * history — prefer .env.integration.
 *
 * After it finishes, set NOTION_TEST_PARENT_PAGE_ID=<rootPageId> in
 * server/.env.integration to also enable notion-create-schema.spec.ts, then:
 *   yarn test:integration -- notion-connector
 */

import axios, { AxiosInstance, isAxiosError } from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

const NOTION_API_BASE = 'https://api.notion.com/v1';
// Match the connector's pinned version (DEFAULT_NOTION_API_VERSION) so the
// created shapes are exactly what the tests pull.
const NOTION_VERSION = '2026-03-11';

const PRIMARY_DB_TITLE = 'Scratch Integration Test';
const LINKED_DB_TITLE = 'Scratch Integration Test Linked';
const ROUNDTRIP_FIXTURE_TITLE = '[Do Not Touch] Roundtrip Fixture';
const LINKED_ROW_TITLES = ['Linked A', 'Linked B', 'Linked C'] as const;
const STATUS_OPTIONS = ['Not started', 'In progress', 'Done'] as const;

// ─── Minimal response shapes (we read only what we need) ────────────────────

interface RichTextSpan {
  plain_text?: string;
}
interface DataSourceSearchResult {
  object: string;
  id: string;
  title?: RichTextSpan[];
}
interface SearchResponse {
  results: DataSourceSearchResult[];
  has_more: boolean;
  next_cursor: string | null;
}
interface CreateDatabaseResponse {
  id: string;
  data_sources: Array<{ id: string; name?: string }>;
}
interface DataSourceResponse {
  id: string;
  properties: Record<string, { id: string; name: string; type: string }>;
}
interface TitlePropertyValue {
  title?: RichTextSpan[];
}
interface QueryResponse {
  results: Array<{ id: string; properties: Record<string, TitlePropertyValue> }>;
  has_more: boolean;
  next_cursor: string | null;
}
interface CreatePageResponse {
  id: string;
}

// Notion property configs and page-property values are heterogeneous; a loose
// record (never `any`) keeps the payload builders readable.
type NotionPropertyConfig = Record<string, unknown>;
type NotionPropertyValue = Record<string, unknown>;

// Which kind of property `Status` ended up as, so seed rows write the right shape.
type StatusKind = 'status' | 'select' | null;

// ─── Sample data definitions ────────────────────────────────────────────────

interface SeedRow {
  name: string;
  description?: string;
  status?: string;
  priority?: 'Low' | 'Medium' | 'High';
  tags?: string[];
  estimate?: number;
  dueInDays?: number;
  done?: boolean;
  email?: string;
  link?: string;
  linked?: string; // title of a row in the Linked DB
}

// 3 seed rows + the fixture. Constraints the smoke suite enforces: at least one
// Done=true (A, C) and one Done=false (B, fixture); a Priority mix including
// non-Low (A, B) and Low (C, fixture).
const SEED_ROWS: SeedRow[] = [
  {
    name: 'Seed Page A',
    description: 'Short rich text',
    status: 'In progress',
    priority: 'High',
    tags: ['backend'],
    estimate: 3,
    dueInDays: 7,
    done: true,
    email: 'a@example.com',
    link: 'https://example.com',
    linked: 'Linked A',
  },
  {
    name: 'Seed Page B',
    priority: 'Medium',
    tags: ['frontend', 'backend'],
    estimate: 5,
    done: false,
    email: 'b@example.com',
    link: 'https://example.com/b',
    linked: 'Linked B',
  },
  {
    name: 'Seed Page C',
    description: 'Plain note',
    status: 'Done',
    priority: 'Low',
    estimate: 1,
    done: true,
  },
];

const FIXTURE_ROW: SeedRow = {
  name: ROUNDTRIP_FIXTURE_TITLE,
  description: 'Roundtrip fixture baseline',
  done: false,
  priority: 'Low',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract a bare 32-hex Notion id from a raw id or a page URL (dashes optional). */
function normalizeNotionId(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '');
  // A URL's trailing id is the last 32 hex chars; a bare id is exactly 32.
  if (hex.length < 32) return null;
  return hex.slice(-32).toLowerCase();
}

function titleText(spans: RichTextSpan[] | undefined): string {
  return (spans ?? []).map((s) => s.plain_text ?? '').join('');
}

function describeNotionError(error: unknown): string {
  if (isAxiosError(error)) {
    const body = error.response?.data as { code?: string; message?: string } | undefined;
    if (body?.message) return `${body.code ?? 'error'}: ${body.message}`;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** POST /search, paging through data sources, and return the one titled `title`. */
async function findDataSourceIdByTitle(http: AxiosInstance, title: string): Promise<string | null> {
  let cursor: string | undefined = undefined;
  do {
    const body: Record<string, unknown> = {
      query: title,
      filter: { property: 'object', value: 'data_source' },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const { data } = await http.post<SearchResponse>('/search', body);
    const match = data.results.find((r) => r.object === 'data_source' && titleText(r.title) === title);
    if (match) return match.id;
    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
  } while (cursor);
  return null;
}

/** Collect the set of row titles already present in a data source (by title prop name). */
async function existingRowTitles(
  http: AxiosInstance,
  dataSourceId: string,
  titlePropName: string,
): Promise<Set<string>> {
  const titles = new Set<string>();
  let cursor: string | undefined = undefined;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const { data } = await http.post<QueryResponse>(`/data_sources/${dataSourceId}/query`, body);
    for (const row of data.results) {
      titles.add(titleText(row.properties[titlePropName]?.title));
    }
    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
  } while (cursor);
  return titles;
}

async function createDatabase(
  http: AxiosInstance,
  parentPageId: string,
  title: string,
  properties: Record<string, NotionPropertyConfig>,
): Promise<string> {
  const { data } = await http.post<CreateDatabaseResponse>('/databases', {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: title } }],
    initial_data_source: { properties },
  });
  const dataSourceId = data.data_sources[0]?.id;
  if (!dataSourceId) throw new Error(`created database "${title}" returned no data source`);
  return dataSourceId;
}

async function createRow(
  http: AxiosInstance,
  dataSourceId: string,
  properties: Record<string, NotionPropertyValue>,
): Promise<string> {
  const { data } = await http.post<CreatePageResponse>('/pages', {
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties,
  });
  return data.id;
}

/** Build the seed/fixture row's Notion property values, skipping anything undefined. */
function buildRowProperties(
  row: SeedRow,
  linkedRowIds: Map<string, string>,
  statusKind: StatusKind,
): Record<string, NotionPropertyValue> {
  const props: Record<string, NotionPropertyValue> = {
    Name: { title: [{ text: { content: row.name } }] },
  };
  if (row.description !== undefined) props.Description = { rich_text: [{ text: { content: row.description } }] };
  if (row.priority !== undefined) props.Priority = { select: { name: row.priority } };
  if (row.tags !== undefined) props.Tags = { multi_select: row.tags.map((name) => ({ name })) };
  if (row.estimate !== undefined) props.Estimate = { number: row.estimate };
  if (row.dueInDays !== undefined) {
    const due = new Date(Date.now() + row.dueInDays * 86_400_000).toISOString().slice(0, 10);
    props['Due Date'] = { date: { start: due } };
  }
  if (row.done !== undefined) props.Done = { checkbox: row.done };
  if (row.email !== undefined) props['Owner Email'] = { email: row.email };
  if (row.link !== undefined) props.Link = { url: row.link };
  if (row.status !== undefined && statusKind !== null) {
    props.Status = statusKind === 'status' ? { status: { name: row.status } } : { select: { name: row.status } };
  }
  if (row.linked !== undefined) {
    const linkedId = linkedRowIds.get(row.linked);
    if (linkedId) props['Linked Items'] = { relation: [{ id: linkedId }] };
  }
  return props;
}

/**
 * Ensure a single "risky" property exists on the primary data source, adding it
 * via PATCH when missing. Returns true if the property is present afterward,
 * false if creation was rejected (so the caller can warn + record a manual step).
 */
async function ensureProperty(
  http: AxiosInstance,
  dataSourceId: string,
  existing: DataSourceResponse['properties'],
  name: string,
  config: NotionPropertyConfig,
): Promise<boolean> {
  if (existing[name]) {
    console.log(`  ${name} → already present`);
    return true;
  }
  try {
    await http.patch(`/data_sources/${dataSourceId}`, { properties: { [name]: config } });
    console.log(`  ${name} → created`);
    return true;
  } catch (error) {
    console.log(`  ${name} → could NOT be created (${describeNotionError(error)})`);
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  dotenv.config({ path: path.join(__dirname, '../.env.integration') });

  const args = process.argv.slice(2);
  const rootPageIdRaw = args[0] ?? process.env.NOTION_TEST_PARENT_PAGE_ID;
  const apiKey = args[1] ?? process.env.NOTION_API_KEY;

  if (!apiKey) {
    console.error('NOTION_API_KEY is not set (in server/.env.integration or as the 2nd argument).');
    process.exit(1);
  }
  if (!rootPageIdRaw) {
    console.error(
      'Root page id is required — pass it as the 1st argument or set NOTION_TEST_PARENT_PAGE_ID in ' +
        'server/.env.integration. It must be a page you own that is SHARED with the integration.',
    );
    process.exit(1);
  }
  const rootPageId = normalizeNotionId(rootPageIdRaw);
  if (!rootPageId) {
    console.error(`Could not parse a Notion page id from "${rootPageIdRaw}" (expected 32 hex chars, or a page URL).`);
    process.exit(1);
  }

  const http = axios.create({
    baseURL: NOTION_API_BASE,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });

  console.log('• Validating token...');
  try {
    await http.post<SearchResponse>('/search', { page_size: 1, filter: { property: 'object', value: 'data_source' } });
  } catch (error) {
    console.error(`  Token rejected by Notion: ${describeNotionError(error)}`);
    process.exit(1);
  }

  console.log(`• Checking the root page ${rootPageId} is shared with the integration...`);
  try {
    await http.get(`/pages/${rootPageId}`);
  } catch (error) {
    console.error(
      `  Cannot access the root page (${describeNotionError(error)}). Open it in Notion → ••• → Connections → ` +
        `add your integration, then re-run. Child databases inherit that connection.`,
    );
    process.exit(1);
  }

  // ── Linked (relation-target) database ──
  console.log(`• Ensuring database "${LINKED_DB_TITLE}"...`);
  let linkedDataSourceId = await findDataSourceIdByTitle(http, LINKED_DB_TITLE);
  if (linkedDataSourceId) {
    console.log(`  already exists (data source ${linkedDataSourceId})`);
  } else {
    linkedDataSourceId = await createDatabase(http, rootPageId, LINKED_DB_TITLE, { Name: { title: {} } });
    console.log(`  created (data source ${linkedDataSourceId})`);
  }

  console.log(`• Ensuring rows in "${LINKED_DB_TITLE}"...`);
  const linkedRowIds = new Map<string, string>();
  {
    const present = await existingRowTitles(http, linkedDataSourceId, 'Name');
    // Re-query to capture ids of existing rows so relations can point at them.
    let cursor: string | undefined = undefined;
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const { data } = await http.post<QueryResponse>(`/data_sources/${linkedDataSourceId}/query`, body);
      for (const row of data.results) {
        const t = titleText(row.properties.Name?.title);
        if ((LINKED_ROW_TITLES as readonly string[]).includes(t)) linkedRowIds.set(t, row.id);
      }
      cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
    } while (cursor);

    for (const title of LINKED_ROW_TITLES) {
      if (present.has(title)) {
        console.log(`  ${title} → already present`);
        continue;
      }
      const id = await createRow(http, linkedDataSourceId, { Name: { title: [{ text: { content: title } }] } });
      linkedRowIds.set(title, id);
      console.log(`  ${title} → created`);
    }
  }

  // ── Primary database ──
  console.log(`• Ensuring database "${PRIMARY_DB_TITLE}"...`);
  let primaryDataSourceId = await findDataSourceIdByTitle(http, PRIMARY_DB_TITLE);
  if (primaryDataSourceId) {
    console.log(`  already exists (data source ${primaryDataSourceId})`);
  } else {
    // The always-creatable "safe" set. Risky types (files/rollup/formula/status)
    // are added separately below so one rejection can't fail the whole create.
    const safeProperties: Record<string, NotionPropertyConfig> = {
      Name: { title: {} },
      Description: { rich_text: {} },
      Priority: { select: { options: [{ name: 'Low' }, { name: 'Medium' }, { name: 'High' }] } },
      Tags: { multi_select: { options: [{ name: 'backend' }, { name: 'frontend' }, { name: 'infra' }] } },
      Estimate: { number: { format: 'number' } },
      'Due Date': { date: {} },
      Done: { checkbox: {} },
      'Owner Email': { email: {} },
      Link: { url: {} },
      'Linked Items': {
        relation: { data_source_id: linkedDataSourceId, type: 'single_property', single_property: {} },
      },
    };
    primaryDataSourceId = await createDatabase(http, rootPageId, PRIMARY_DB_TITLE, safeProperties);
    console.log(`  created (data source ${primaryDataSourceId})`);
  }

  // ── Risky properties (added individually, each fail-soft) ──
  console.log('• Ensuring derived / API-limited properties on the primary database...');
  const { data: primaryDs } = await http.get<DataSourceResponse>(`/data_sources/${primaryDataSourceId}`);
  const existingProps = primaryDs.properties;

  await ensureProperty(http, primaryDataSourceId, existingProps, 'Attachments', { files: {} });
  await ensureProperty(http, primaryDataSourceId, existingProps, 'Linked Count', {
    rollup: { relation_property_name: 'Linked Items', rollup_property_name: 'Name', function: 'count' },
  });
  await ensureProperty(http, primaryDataSourceId, existingProps, 'Score', {
    formula: { expression: 'length(prop("Name"))' },
  });

  // Status: Notion's API usually cannot create a real `status` property. Try it,
  // then fall back to `select` so the suite still runs.
  const manualSteps: string[] = [];
  let statusKind: StatusKind = null;
  if (existingProps.Status) {
    statusKind = existingProps.Status.type === 'status' ? 'status' : 'select';
    console.log(`  Status → already present (type: ${existingProps.Status.type})`);
  } else {
    const madeReal = await ensureProperty(http, primaryDataSourceId, {}, 'Status', { status: {} });
    if (madeReal) {
      statusKind = 'status';
    } else {
      const madeSelect = await ensureProperty(http, primaryDataSourceId, {}, 'Status', {
        select: { options: STATUS_OPTIONS.map((name) => ({ name })) },
      });
      if (madeSelect) {
        statusKind = 'select';
        manualSteps.push(
          "Status was created as a `select` (Notion's API cannot create a real `status` property). The suite " +
            'passes as-is; for true status-type coverage in the snapshot, delete the Status select and add a real ' +
            'Status property (default options) in the Notion UI, then regenerate the snapshot.',
        );
      } else {
        manualSteps.push(
          'Status could not be created at all. Add a `Status` property named "Status" in the Notion UI — the ' +
            'property-coverage test requires it to exist.',
        );
      }
    }
  }

  // ── Seed rows + preserved fixture ──
  console.log(`• Ensuring seed rows + fixture in "${PRIMARY_DB_TITLE}"...`);
  const presentPrimary = await existingRowTitles(http, primaryDataSourceId, 'Name');
  for (const row of [...SEED_ROWS, FIXTURE_ROW]) {
    if (presentPrimary.has(row.name)) {
      console.log(`  ${row.name} → already present`);
      continue;
    }
    await createRow(http, primaryDataSourceId, buildRowProperties(row, linkedRowIds, statusKind));
    console.log(`  ${row.name} → created`);
  }

  // ── Summary ──
  console.log('\n✓ Notion test data is ready.');
  console.log(`  Primary DB:  "${PRIMARY_DB_TITLE}" (data source ${primaryDataSourceId})`);
  console.log(`  Linked DB:   "${LINKED_DB_TITLE}" (data source ${linkedDataSourceId})`);
  console.log('\nNext steps:');
  console.log(`  1. In server/.env.integration set NOTION_TEST_PARENT_PAGE_ID=${rootPageId}`);
  console.log('     (enables notion-create-schema.spec.ts, which creates throwaway DBs under that page).');
  console.log('  2. Run:  yarn test:integration -- notion-connector');
  if (manualSteps.length > 0) {
    console.log('\n⚠ Manual follow-up:');
    for (const step of manualSteps) console.log(`  - ${step}`);
  }
}

main().catch((error) => {
  console.error(`\nFailed: ${describeNotionError(error)}`);
  process.exit(1);
});
