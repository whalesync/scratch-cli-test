// Reset the Webflow CMS/SEO demo (DEV-10438).
//
// Teardown primitive: deletes ALL items in the "Blog Posts (Demo)" collection so the
// next seed re-creates the link-free baseline. Operates at the Webflow API level and is
// strictly SCOPED to the demo collection (found by slug) — it never touches Recipes,
// Menu Items, or any other collection on the site.
//
// The full "reset to baseline" is reset.ts followed by seed.ts (ready.ts will wrap both).
//
// Run:  node demos/webflow-cms-seo/reset.ts
// Also drop the collection itself:  DEMO_RESET_DROP_COLLECTION=1 node demos/webflow-cms-seo/reset.ts

import { fileURLToPath } from 'node:url';
import {
  delete_collection_item,
  list_all_collection_items,
  list_collections,
  publish_site,
  resolve_demo_site_id,
} from '../shared/webflow.ts';
import { DEMO_BLOG_COLLECTION_SLUG } from './constants.ts';

async function reset_demo_blog_collection(options: { publish?: boolean } = {}): Promise<void> {
  // Publish by default so deleted items leave the live site too; DEMO_SKIP_PUBLISH=1 opts out.
  const should_publish_site = options.publish ?? process.env.DEMO_SKIP_PUBLISH !== '1';
  const site_id = await resolve_demo_site_id();
  const collections = await list_collections(site_id);
  const demo_collection = collections.find((collection) => collection.slug === DEMO_BLOG_COLLECTION_SLUG);

  if (!demo_collection) {
    console.log(`Nothing to reset: no "${DEMO_BLOG_COLLECTION_SLUG}" collection on site ${site_id}.`);
    return;
  }

  const items = await list_all_collection_items(demo_collection.id);
  console.log(`Deleting ${items.length} item(s) from "${demo_collection.displayName}"...`);
  let deleted_count = 0;
  for (const item of items) {
    await delete_collection_item(demo_collection.id, item.id);
    deleted_count += 1;
    console.log(`  deleted: ${String(item.fieldData?.slug ?? item.id)}`);
  }

  console.log(`Reset complete. deleted=${deleted_count}`);

  if (should_publish_site && deleted_count > 0) {
    console.log('Publishing site so deleted items leave the live .webflow.io site...');
    await publish_site(site_id);
  }

  if (process.env.DEMO_RESET_DROP_COLLECTION === '1') {
    console.log(
      'DEMO_RESET_DROP_COLLECTION=1 set, but collection-drop is intentionally left manual for now ' +
        '(deleting a collection is rarely needed and is harder to undo). Delete it in the Webflow UI if required.',
    );
  }
}

// Only run when invoked directly (`node reset.ts`), not when imported by another script.
const this_module_is_run_directly = process.argv[1] === fileURLToPath(import.meta.url);
if (this_module_is_run_directly) {
  await reset_demo_blog_collection();
}

export { reset_demo_blog_collection };
