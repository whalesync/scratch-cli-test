#!/usr/bin/env node
/**
 * Read published records back out of NOTION using Notion's own API.
 *
 * The audit's prime directive: a routine that reports `completed` proves nothing —
 * runs report success even when every record was rejected. This reads the destination
 * service directly so source→destination comparisons rest on what Notion actually holds.
 *
 * Usage:
 *   node tools/live-export-audit/verify-notion.mjs --db-title "Customers" --match fable_qa_
 *   node tools/live-export-audit/verify-notion.mjs --list
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const notionEnv = readEnvFile(path.join(REPO_ROOT, 'local/audit-creds/notion.env'));
const NOTION_KEY = notionEnv.apiKey;
const PARENT_ID = args.parent || notionEnv.DEST_PARENT_ID;
const NOTION_VERSION = args['notion-version'] || '2026-03-11';

async function notion(method, endpoint, body) {
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`Notion ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

/** Flatten a Notion property value to something comparable against the source. */
function readProperty(property) {
  if (!property) return undefined;
  switch (property.type) {
    case 'title':
    case 'rich_text':
      return (property[property.type] ?? []).map((span) => span.plain_text).join('');
    case 'number': return property.number;
    case 'checkbox': return property.checkbox;
    case 'select': return property.select?.name ?? null;
    case 'multi_select': return (property.multi_select ?? []).map((o) => o.name);
    case 'date': return property.date?.start ?? null;
    case 'url': return property.url;
    case 'email': return property.email;
    case 'phone_number': return property.phone_number;
    case 'relation': return (property.relation ?? []).map((r) => r.id);
    case 'people': return (property.people ?? []).map((p) => p.id);
    case 'formula': return property.formula?.[property.formula?.type];
    default: return `<${property.type}>`;
  }
}

// Notion's 2025+ API splits a database into data sources; page queries go to the data source.
// The QA parent page accumulates databases from every past audit run (100+, with duplicate
// titles across services), so paginate fully and prefer addressing by --db-id.
async function listDatabasesUnderParent() {
  const found = [];
  let cursor;
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (cursor) query.set('start_cursor', cursor);
    const children = await notion('GET', `/blocks/${PARENT_ID}/children?${query}`);
    found.push(...(children.results ?? []).filter((b) => b.type === 'child_database'));
    cursor = children.has_more ? children.next_cursor : undefined;
  } while (cursor);
  return found;
}

let target;
if (args['db-id']) {
  target = { id: args['db-id'], child_database: { title: args['db-title'] ?? args['db-id'] } };
} else {
  const databases = await listDatabasesUnderParent();
  if (args.list || !args['db-title']) {
    console.log(JSON.stringify(databases.map((d, i) => ({ index: i, id: d.id, title: d.child_database?.title })), null, 1));
    if (!args['db-title']) process.exit(0);
  }
  // Titles repeat across audits — take the LAST match, which is the most recently created.
  const matches = databases.filter(
    (d) => (d.child_database?.title ?? '').toLowerCase() === String(args['db-title']).toLowerCase(),
  );
  if (matches.length === 0) {
    console.error(`No child database titled "${args['db-title']}" under ${PARENT_ID}.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`NOTE: ${matches.length} databases titled "${args['db-title']}" — using the last (most recent). Pass --db-id to disambiguate.`);
  }
  target = matches[matches.length - 1];
}

const database = await notion('GET', `/databases/${target.id}`);
const dataSourceId = database.data_sources?.[0]?.id ?? target.id;

// Page through every row.
const pages = [];
let cursor;
do {
  const body = { page_size: 100 };
  if (cursor) body.start_cursor = cursor;
  const page = await notion('POST', `/data_sources/${dataSourceId}/query`, body);
  pages.push(...(page.results ?? []));
  cursor = page.has_more ? page.next_cursor : undefined;
} while (cursor);

const schema = database.data_sources?.[0]
  ? (await notion('GET', `/data_sources/${dataSourceId}`)).properties
  : database.properties;

const matchNeedle = args.match ? String(args.match) : null;
const rows = pages
  .map((p) => {
    const values = {};
    for (const [name, property] of Object.entries(p.properties ?? {})) values[name] = readProperty(property);
    return { id: p.id, archived: p.archived ?? p.in_trash ?? false, values };
  })
  .filter((r) => !matchNeedle || JSON.stringify(r.values).includes(matchNeedle));

console.log(JSON.stringify({
  database: args['db-title'],
  databaseId: target.id,
  dataSourceId,
  totalPages: pages.length,
  matched: rows.length,
  propertyTypes: Object.fromEntries(Object.entries(schema ?? {}).map(([k, v]) => [k, v.type])),
  rows: args.full ? rows : rows.slice(0, Number(args.limit || 5)),
}, null, 1));
