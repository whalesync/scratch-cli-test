// One-command "get the demo ready" orchestrator for the Webflow CMS/SEO demo (DEV-10438).
//
// Upserts the Webflow site to the known, link-free baseline (restores every post body,
// creates any missing), publishes it live, and re-pulls the Scratch workbook. Run a few
// minutes before a demo call.
//
// Run:  node demos/webflow-cms-seo/ready.ts

import { fileURLToPath } from 'node:url';
import { publish_site, resolve_demo_site_id } from '../shared/webflow.ts';
import { reset_demo_workbook_to_baseline } from './bootstrap.ts';
import { seed_demo_blog_posts } from './seed.ts';

async function ready_webflow_cms_seo_demo(): Promise<void> {
  console.log('== Webflow CMS/SEO demo: get ready ==\n');

  // 1. Restore the Webflow SERVICE to the link-free baseline (raw API; works without the stack).
  //    seed is an UPSERT — it resets every existing post's body to link-free and creates any
  //    missing one, WITHOUT deleting (deleting published items then recreating hits a slug
  //    conflict). Suppress its publish; do ONE site publish at the end.
  await seed_demo_blog_posts({ publish: false });

  if (process.env.DEMO_SKIP_PUBLISH !== '1') {
    console.log('\nPublishing Webflow site to the .webflow.io subdomain (items go live)...');
    await publish_site(await resolve_demo_site_id());
  }

  // 2. Reset the Scratch WORKBOOK to match: re-pull so records track the link-free service
  //    (needs the stack). Set DEMO_SKIP_WORKBOOK_RESET=1 to do service-only (dev / no scratchmd).
  if (process.env.DEMO_SKIP_WORKBOOK_RESET === '1') {
    console.log('\nDEMO_SKIP_WORKBOOK_RESET=1 — skipping the Scratch workbook reset (service-only).');
  } else {
    console.log('\n== Resetting the Scratch workbook ==');
    reset_demo_workbook_to_baseline();
  }

  console.log('\nDemo ready: link-free baseline in the service' +
    (process.env.DEMO_SKIP_WORKBOOK_RESET === '1' ? '.' : ' and the workbook.'));
  console.log('Open "Webflow CMS-SEO Demo" in Scratch Desktop.');
}

const this_module_is_run_directly = process.argv[1] === fileURLToPath(import.meta.url);
if (this_module_is_run_directly) {
  await ready_webflow_cms_seo_demo();
}

export { ready_webflow_cms_seo_demo };
