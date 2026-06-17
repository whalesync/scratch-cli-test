// One-command "get the demo ready" orchestrator for the Webflow CMS/SEO demo (DEV-10438).
//
// Runs reset -> seed so the integration-test Webflow site is in the known, link-free
// baseline. Run this a few minutes before a demo call.
//
// NOTE: the Scratch side (create workbook + Webflow connection + pull into Scratch
// Desktop) is bootstrap.ts and is not wired yet — see plan T1.4. Until then, connect the
// "Blog Posts (Demo)" collection in Scratch manually after running this.
//
// Run:  node demos/webflow-cms-seo/ready.ts

import { fileURLToPath } from 'node:url';
import { publish_site, resolve_demo_site_id } from '../shared/webflow.ts';
import { reset_demo_workbook_to_baseline } from './bootstrap.ts';
import { reset_demo_blog_collection } from './reset.ts';
import { seed_demo_blog_posts } from './seed.ts';

async function ready_webflow_cms_seo_demo(): Promise<void> {
  console.log('== Webflow CMS/SEO demo: get ready ==\n');

  // 1. Reset the Webflow SERVICE to the link-free baseline (raw API; works without the stack).
  //    Suppress the per-step publishes here and do ONE site publish at the end (avoids racing
  //    two async publishes on the shared site).
  await reset_demo_blog_collection({ publish: false });
  console.log('');
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
