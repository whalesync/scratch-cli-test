// Seed the Webflow CMS/SEO demo baseline (DEV-10438).
//
// Creates a "Blog Posts (Demo)" collection (if missing) on the integration-test
// Webflow site and fills it with the deliberately link-free posts from fixtures.ts.
// No AI is involved here — this is deterministic baseline content. The live demo is
// where the AI adds internal links on top of this baseline.
//
// Idempotent: re-running skips posts whose slug already exists, so it converges to the
// same baseline instead of duplicating.
//
// Run:  node demos/webflow-cms-seo/seed.ts
// Smoke a few first:  DEMO_SEED_LIMIT=2 node demos/webflow-cms-seo/seed.ts

import { fileURLToPath } from 'node:url';
import {
  create_collection,
  create_collection_field,
  create_collection_item,
  get_collection,
  list_all_collection_items,
  list_collections,
  publish_site,
  resolve_demo_site_id,
  update_collection_item,
  type WebflowCollection,
} from '../shared/webflow.ts';
import {
  DEMO_BLOG_COLLECTION_DISPLAY_NAME,
  DEMO_BLOG_COLLECTION_SINGULAR_NAME,
  DEMO_BLOG_COLLECTION_SLUG,
} from './constants.ts';
import { DEMO_BLOG_POST_FIXTURES } from './fixtures.ts';

const POST_BODY_FIELD_DISPLAY_NAME = 'Post Body';
const TOPIC_FIELD_DISPLAY_NAME = 'Topic';

interface ResolvedDemoCollection {
  collection_id: string;
  post_body_field_slug: string;
  topic_field_slug: string;
}

async function ensure_demo_blog_collection_exists(site_id: string): Promise<ResolvedDemoCollection> {
  const existing_collections = await list_collections(site_id);
  let demo_collection: WebflowCollection | undefined = existing_collections.find(
    (collection) => collection.slug === DEMO_BLOG_COLLECTION_SLUG,
  );

  if (!demo_collection) {
    console.log(`Creating collection "${DEMO_BLOG_COLLECTION_DISPLAY_NAME}"...`);
    demo_collection = await create_collection(
      site_id,
      DEMO_BLOG_COLLECTION_DISPLAY_NAME,
      DEMO_BLOG_COLLECTION_SINGULAR_NAME,
      DEMO_BLOG_COLLECTION_SLUG,
    );
  } else {
    console.log(`Collection "${DEMO_BLOG_COLLECTION_DISPLAY_NAME}" already exists.`);
  }

  // Make sure our two custom fields exist (Name + Slug come for free).
  let collection_with_fields = await get_collection(demo_collection.id);
  const field_display_names_present = new Set(
    (collection_with_fields.fields ?? []).map((field) => field.displayName),
  );
  if (!field_display_names_present.has(POST_BODY_FIELD_DISPLAY_NAME)) {
    console.log(`Adding field "${POST_BODY_FIELD_DISPLAY_NAME}" (RichText)...`);
    await create_collection_field(demo_collection.id, 'RichText', POST_BODY_FIELD_DISPLAY_NAME);
  }
  if (!field_display_names_present.has(TOPIC_FIELD_DISPLAY_NAME)) {
    console.log(`Adding field "${TOPIC_FIELD_DISPLAY_NAME}" (PlainText)...`);
    await create_collection_field(demo_collection.id, 'PlainText', TOPIC_FIELD_DISPLAY_NAME);
  }

  // Re-read so we get the real (Webflow-assigned) slugs for our fields.
  collection_with_fields = await get_collection(demo_collection.id);
  const field_slug_by_display_name = new Map(
    (collection_with_fields.fields ?? []).map((field) => [field.displayName, field.slug]),
  );
  const post_body_field_slug = field_slug_by_display_name.get(POST_BODY_FIELD_DISPLAY_NAME);
  const topic_field_slug = field_slug_by_display_name.get(TOPIC_FIELD_DISPLAY_NAME);
  if (!post_body_field_slug || !topic_field_slug) {
    throw new Error('Demo collection is missing expected fields after creation.');
  }

  return { collection_id: demo_collection.id, post_body_field_slug, topic_field_slug };
}

async function seed_demo_blog_posts(options: { publish?: boolean } = {}): Promise<void> {
  // Publish by default so items are live (not just staged); DEMO_SKIP_PUBLISH=1 opts out.
  const should_publish_site = options.publish ?? process.env.DEMO_SKIP_PUBLISH !== '1';
  const seed_limit_raw = process.env.DEMO_SEED_LIMIT;
  const seed_limit = seed_limit_raw ? Number.parseInt(seed_limit_raw, 10) : DEMO_BLOG_POST_FIXTURES.length;
  const fixtures_to_seed = DEMO_BLOG_POST_FIXTURES.slice(0, seed_limit);

  const site_id = await resolve_demo_site_id();
  console.log(`Demo Webflow site: ${site_id}`);

  const { collection_id, post_body_field_slug, topic_field_slug } =
    await ensure_demo_blog_collection_exists(site_id);
  console.log(`Collection ready: ${collection_id} (body="${post_body_field_slug}", topic="${topic_field_slug}")`);

  // UPSERT, not create-or-skip: if a post already exists (matched by slug) we PATCH its body +
  // topic back to the link-free fixture — this is the reset (it wipes any AI-added links). Only
  // missing posts are created. We never delete, so we never hit the "slug already in database"
  // conflict that deleting a *published* item then recreating it causes.
  const existing_items = await list_all_collection_items(collection_id);
  const existing_item_by_slug = new Map(
    existing_items.map((item) => [String(item.fieldData?.slug ?? ''), item] as const).filter(([slug]) => slug),
  );

  let created_count = 0;
  let updated_count = 0;
  for (const fixture of fixtures_to_seed) {
    const baseline_field_data = {
      [post_body_field_slug]: fixture.body_html,
      [topic_field_slug]: fixture.topic,
    };
    const existing_item = existing_item_by_slug.get(fixture.slug);
    if (existing_item) {
      await update_collection_item(collection_id, existing_item.id, baseline_field_data);
      updated_count += 1;
      console.log(`  reset (update): ${fixture.slug}`);
    } else {
      await create_collection_item(collection_id, {
        name: fixture.title,
        slug: fixture.slug,
        ...baseline_field_data,
      });
      created_count += 1;
      console.log(`  created: ${fixture.slug}`);
    }
  }

  console.log(
    `\nSeed complete. created=${created_count} updated=${updated_count} total_in_collection=${existing_items.length + created_count}`,
  );

  if (should_publish_site) {
    console.log('Publishing site to the .webflow.io subdomain (so items are live, not staged)...');
    await publish_site(site_id);
    console.log('Publish requested (async on Webflow).');
  }
}

// Only run when invoked directly (`node seed.ts`), not when imported by another script.
const this_module_is_run_directly = process.argv[1] === fileURLToPath(import.meta.url);
if (this_module_is_run_directly) {
  await seed_demo_blog_posts();
}

export { seed_demo_blog_posts };
