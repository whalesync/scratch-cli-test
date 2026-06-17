// Bootstrap the Scratch side of the Webflow CMS/SEO demo (DEV-10438).
//
// Idempotent find-or-create of ONE persistent demo workbook + Webflow connection + linked
// folder on the Scratch server, then a full pull. Re-running reuses everything (no dupes).
//
// Pairs with seed.ts/reset.ts (which seed/reset the Webflow SERVICE via the raw API). This
// file only drives the Scratch CLI. No publish happens here — the only publish is the
// presenter, live in Scratch Desktop.
//
// Run:  SCRATCH_URL=<prod-url> node demos/webflow-cms-seo/bootstrap.ts
// (omit SCRATCH_URL if the installed scratchmd already defaults to prod)
//
// Prereqs: scratchmd on PATH, `scratchmd auth login` done once, WEBFLOW_API_KEY in
// server/.env.integration. NOT yet run-tested against a live server — see plan T1.4/T1.8.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get_webflow_api_key } from '../shared/env.ts';
import {
  assert_cli_authenticated,
  find_available_table_id_by_display_name,
  find_or_create_connection,
  find_or_create_linked_folder,
  find_or_create_workbook,
  init_workbook_local_checkout,
  pull_linked_folder_full,
} from '../shared/scratchmd.ts';
import { DEMO_BLOG_COLLECTION_DISPLAY_NAME } from './constants.ts';

const DEMO_WORKBOOK_NAME = 'Webflow CMS-SEO Demo';
const DEMO_WEBFLOW_CONNECTION_NAME = 'Webflow (Demo)';
const DEMO_LINKED_FOLDER_NAME = 'Blog Posts';

// Local working copy the CLI materializes for files/pull operations (gitignored).
const WORKBOOK_LOCAL_CHECKOUT_DIRECTORY = resolve(import.meta.dirname, '..', '.scratch-checkout');

export interface DemoWorkbookTopology {
  workbook_id: string;
  connection_id: string;
  linked_folder_id: string;
  checkout_directory: string;
}

// Ensure the workbook + connection + linked folder + local checkout all exist. Idempotent;
// does NOT pull.
export function ensure_demo_workbook_topology(): DemoWorkbookTopology {
  assert_cli_authenticated();

  const workbook = find_or_create_workbook(DEMO_WORKBOOK_NAME);
  console.log(`Workbook: ${workbook.name} (${workbook.id})`);

  const connection = find_or_create_connection(workbook.id, 'WEBFLOW', DEMO_WEBFLOW_CONNECTION_NAME, {
    apiKey: get_webflow_api_key(),
  });
  console.log(`Connection: ${connection.displayName} (${connection.id})`);

  const table_id = find_available_table_id_by_display_name(
    workbook.id,
    connection.id,
    DEMO_BLOG_COLLECTION_DISPLAY_NAME,
  );
  const linked_folder = find_or_create_linked_folder(workbook.id, connection.id, table_id, DEMO_LINKED_FOLDER_NAME);
  console.log(`Linked folder: ${linked_folder.name} (${linked_folder.id})`);

  // Materialize (and register) the local checkout so `linked pull` has a download target.
  init_workbook_local_checkout(workbook.id, WORKBOOK_LOCAL_CHECKOUT_DIRECTORY);
  console.log(`Local checkout: ${WORKBOOK_LOCAL_CHECKOUT_DIRECTORY}`);

  return {
    workbook_id: workbook.id,
    connection_id: connection.id,
    linked_folder_id: linked_folder.id,
    checkout_directory: WORKBOOK_LOCAL_CHECKOUT_DIRECTORY,
  };
}

// First-time / ensure-pulled: topology + full pull.
export function bootstrap_webflow_demo(): DemoWorkbookTopology {
  console.log('== Bootstrapping Webflow CMS/SEO demo (Scratch side) ==\n');
  const topology = ensure_demo_workbook_topology();
  console.log('Pulling (full)...');
  pull_linked_folder_full(topology.workbook_id, topology.linked_folder_id);
  console.log(`\nBootstrap complete. Open "${DEMO_WORKBOOK_NAME}" in Scratch Desktop.`);
  return topology;
}

// Reset the WORKBOOK back to the pulled baseline: discard leftover edits, then re-pull.
// (The Webflow SERVICE is reset separately by reset.ts/seed.ts; run that first.)
export function reset_demo_workbook_to_baseline(): DemoWorkbookTopology {
  // The Webflow SERVICE is reset to link-free separately (reset.ts/seed.ts, run first). Here
  // we just re-pull so the workbook's records match. We never edit via the CLI, so the CLI
  // checkout stays clean and the pull never refuses — no discard needed. (Edits made live in
  // Scratch Desktop are reverted by the service reset + this re-pull, which Desktop syncs.)
  const topology = ensure_demo_workbook_topology();
  console.log('Re-pulling (full) into the workbook...');
  pull_linked_folder_full(topology.workbook_id, topology.linked_folder_id);
  return topology;
}

const this_module_is_run_directly = process.argv[1] === fileURLToPath(import.meta.url);
if (this_module_is_run_directly) {
  bootstrap_webflow_demo();
}
