/**
 * Idempotent seed script for the Framer connector's live/integration test fixtures.
 *
 * Framer has no delete-collection API, so the integration suite round-trips ITEMS
 * inside two durable fixture collections this script provisions:
 *
 *   - "Tags"        — a foreign-key target, with items `design` and `engineering`.
 *   - "Field Types" — one field of every Framer CMS field type (string, formattedText,
 *                     number, boolean, date, link, color, enum, image, file,
 *                     collectionReference → Tags, multiCollectionReference → Tags).
 *
 * Re-running heals a partially-seeded or wiped account (find-or-create collection,
 * add only missing fields). It does NOT seed test items — the suite creates and
 * cleans those up per run.
 *
 * Run (needs FRAMER_PROJECT_URL + FRAMER_API_KEY in server/.env.integration):
 *   cd server && npx tsx scripts/bootstrap-framer-test-data.ts
 *
 * `framer-api` is ESM; run it with a loader that supports ESM (tsx / node ESM).
 */
import { type Collection, type CreateField, connect } from 'framer-api';

// Load server/.env.integration when present (Node 20.12+/22 has loadEnvFile).
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env.integration');
  } catch {
    // Fall back to whatever is already in the environment.
  }
}

const projectUrl = process.env.FRAMER_PROJECT_URL;
const apiKey = process.env.FRAMER_API_KEY;
if (!projectUrl || !apiKey) {
  throw new Error('FRAMER_PROJECT_URL and FRAMER_API_KEY are required (set them in server/.env.integration)');
}

type ItemFieldData = Record<string, { type: string; value: unknown }>;

async function findOrCreate(framer: Awaited<ReturnType<typeof connect>>, name: string): Promise<Collection> {
  const existing = (await framer.getCollections()).find((c) => c.name === name);
  if (existing) {
    console.log(`= collection "${name}" [${existing.id}]`);
    return existing;
  }
  const created = await framer.createCollection(name);
  console.log(`+ created collection "${name}" [${created.id}]`);
  return created;
}

async function ensureFields(collection: Collection, specs: CreateField[]): Promise<void> {
  const existingNames = new Set((await collection.getFields()).map((f) => f.name.toLowerCase()));
  const toCreate = specs.filter((s) => !existingNames.has(s.name.toLowerCase()));
  if (toCreate.length > 0) {
    await collection.addFields(toCreate);
    console.log(`  + added fields: ${toCreate.map((f) => `${f.name}:${f.type}`).join(', ')}`);
  }
}

async function upsertItem(collection: Collection, slug: string, fieldData: ItemFieldData): Promise<void> {
  const existing = (await collection.getItems()).find((i) => i.slug === slug);
  const item = { ...(existing ? { id: existing.id } : {}), slug, fieldData };
  await collection.addItems([item as unknown as Parameters<Collection['addItems']>[0][number]]);
  console.log(`  ${existing ? '~' : '+'} item "${slug}"`);
}

async function main(): Promise<void> {
  const framer = await connect(projectUrl!, apiKey!);
  try {
    // Tags collection — the FK target.
    const tags = await findOrCreate(framer, 'Tags');
    await ensureFields(tags, [{ type: 'string', name: 'Name' }]);
    const tagNameId = (await tags.getFields()).find((f) => f.name === 'Name')!.id;
    await upsertItem(tags, 'design', { [tagNameId]: { type: 'string', value: 'Design' } });
    await upsertItem(tags, 'engineering', { [tagNameId]: { type: 'string', value: 'Engineering' } });

    // Field Types collection — one field of every type.
    const fieldTypes = await findOrCreate(framer, 'Field Types');
    await ensureFields(fieldTypes, [
      { type: 'string', name: 'Title' },
      { type: 'formattedText', name: 'Body' },
      { type: 'number', name: 'Count' },
      { type: 'boolean', name: 'Active' },
      { type: 'date', name: 'When' },
      { type: 'link', name: 'Website' },
      { type: 'color', name: 'Brand' },
      { type: 'enum', name: 'Stage', cases: [{ name: 'Draft' }, { name: 'Review' }, { name: 'Live' }] },
      { type: 'image', name: 'Hero' },
      { type: 'file', name: 'Attachment', allowedFileTypes: ['pdf', 'txt'] },
      { type: 'collectionReference', name: 'Primary Tag', collectionId: tags.id },
      { type: 'multiCollectionReference', name: 'Tags', collectionId: tags.id },
    ]);

    console.log('\n✅ Framer test fixtures ready.');
  } finally {
    await framer.disconnect();
  }
}

main().catch((error) => {
  console.error('Bootstrap failed:', error);
  process.exit(1);
});
